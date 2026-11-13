import { NextResponse } from "next/server";
import type { VoiceApiConfig } from "@/lib/settings-types";
import { buildCompatibleVoiceUrl, compatibleSpeechBody } from "@/lib/voice-api";
import { isQwenTts, qwenSpeechBody } from "@/lib/qwen-tts";
import { voiceDeadline } from "@/lib/server/voice-provider";
import { isDashscopeTts, requestDashscopeAudio } from "@/lib/dashscope-tts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;
const MAX_REQUEST = 30 * 1024 * 1024;
const MAX_AUDIO = 40 * 1024 * 1024;

function reply(error: string, status: number) {
    return NextResponse.json({ error }, { status, headers: { "Cache-Control": "no-store" } });
}
function record(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function field(raw: Record<string, unknown>, name: string, limit: number): string {
    const value = raw[name];
    if (value === undefined) return "";
    if (typeof value !== "string" || value.length > limit) throw new Error("语音配置字段无效：" + name);
    return value.trim();
}
function networkFailure(error: unknown): string {
    const root = record(error), cause = record(root.cause);
    const code = String(cause.code || root.code || "");
    if (/CERT|TLS|SSL|UNABLE_TO_VERIFY|SELF_SIGNED/i.test(code)) return "语音接口 HTTPS 证书校验失败，请检查服务器证书和手机时间";
    if (code === "ECONNREFUSED") return "语音接口拒绝连接，请检查地址、端口和服务是否启动";
    if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "无法解析语音接口地址，请检查手机网络和接口域名";
    if (/TIMEDOUT|CONNECT_TIMEOUT/.test(code)) return "连接语音接口超时，请确认手机网络能访问该地址";
    return "无法连接语音接口，请确认手机网络能访问该地址";
}
async function requestBody(request: Request): Promise<Record<string, unknown>> {
    if (Number(request.headers.get("content-length")) > MAX_REQUEST) throw new Error("参考音频过大，请使用较短的音频重新上传");
    const reader = request.body?.getReader();
    if (!reader) throw new Error("语音请求为空");
    const chunks: Uint8Array[] = []; let length = 0;
    try {
        while (true) {
            const next = await reader.read();
            if (next.done) break;
            length += next.value.length;
            if (length > MAX_REQUEST) { await reader.cancel(); throw new Error("参考音频过大，请使用较短的音频重新上传"); }
            chunks.push(next.value);
        }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return record(JSON.parse(new TextDecoder().decode(bytes)));
}

export async function POST(request: Request) {
    // This handler is never a public hosting proxy. Android bootstrap binds to
    // loopback and requires the installation cookie before Next can serve it.
    if (process.env.XUNXIN_LOCAL_RUNTIME !== "1") return reply("此语音连接方式仅用于安卓 App", 404);
    const deadline = voiceDeadline(request, 240_000);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
        let config: VoiceApiConfig, text: string, url: string, stream: boolean, qwen: boolean, speechBody: object;
        try {
            const body = await requestBody(request);
            const raw = record(body.config);
            text = field(body, "text", 20_000);
            config = {
                id: "", provider: field(raw, "provider", 40), baseUrl: field(raw, "baseUrl", 2048),
                apiKey: field(raw, "apiKey", 8192), model: field(raw, "model", 400),
                defaultVoice: field(raw, "defaultVoice", 512), referenceAudio: field(raw, "referenceAudio", 28 * 1024 * 1024),
                referenceText: field(raw, "referenceText", 20_000), enableTTS: true, enableSTT: false,
            };
            if (!text || typeof body.stream !== "boolean" || !["Custom", "OpenAI"].includes(config.provider)) {
                throw new Error("语音配置无效，请检查服务商和接口地址");
            }
            if (config.provider === "Custom" && !config.model) throw new Error("请填写自定义语音的合成模型 ID");
            if (config.provider === "OpenAI" && !config.apiKey) throw new Error("OpenAI API Key 未配置");
            stream = body.stream;
            qwen = isQwenTts(config);
            if (stream && !qwen) throw new Error("当前语音接口未启用 Qwen 流式协议");
            speechBody = qwen ? qwenSpeechBody(text, config, stream) : compatibleSpeechBody(text, config);
            url = buildCompatibleVoiceUrl(config.baseUrl || (config.provider === "OpenAI" ? "https://api.openai.com/v1" : ""), "speech");
        } catch (error) {
            deadline.dispose();
            return reply(error instanceof SyntaxError ? "语音请求格式无效" : error instanceof Error ? error.message : "语音配置无效", 400);
        }
        // Standard Node TLS verification stays enabled. Never retry synthesis:
        // a lost response can already have generated/billed an utterance.
        const upstream = isDashscopeTts(config)
            ? await requestDashscopeAudio(text, config, fetch, deadline.signal)
            : await fetch(url, {
            method: "POST", signal: deadline.signal, redirect: "error", cache: "no-store",
            headers: { "Content-Type": "application/json", ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}) },
            body: JSON.stringify(speechBody),
        });
        if (!upstream.ok) {
            await upstream.body?.cancel(); deadline.dispose();
            const hint = upstream.status === 401 || upstream.status === 403 ? "请检查 API Key 和模型权限"
                : upstream.status === 404 ? "请检查接口地址和模型 ID"
                : upstream.status === 429 ? "请检查接口配额或稍后重试"
                : upstream.status < 500 ? "请检查模型 ID、音色及参考音频格式"
                : "语音服务暂时无法处理请求";
            return reply(`语音接口返回 HTTP ${upstream.status}，${hint}`, 502);
        }
        const mime = upstream.headers.get("content-type") || "";
        if (!/^(audio\/|application\/octet-stream\b)/i.test(mime) || !upstream.body) {
            await upstream.body?.cancel(); deadline.dispose();
            return reply("语音接口未返回音频，请检查接口协议和克隆配置", 502);
        }
        if (Number(upstream.headers.get("content-length")) > MAX_AUDIO) {
            await upstream.body.cancel(); deadline.dispose(); return reply("语音响应过大，请缩短回复后重试", 502);
        }
        reader = upstream.body.getReader();
        const upstreamReader = reader;
        let closed = false;
        let length = 0;
        const finish = async (cancel: boolean, reason?: unknown) => {
            if (closed) return;
            closed = true; deadline.dispose();
            if (cancel) await upstreamReader.cancel(reason).catch(() => {});
            upstreamReader.releaseLock(); reader = undefined;
        };
        const audio = new ReadableStream<Uint8Array>({
            async pull(output) {
                try {
                    const next = await upstreamReader.read();
                    if (closed) return;
                    if (next.done) { await finish(false); output.close(); return; }
                    length += next.value.length;
                    if (length > MAX_AUDIO) throw new Error("语音响应过大");
                    output.enqueue(next.value);
                } catch {
                    if (closed) return;
                    await finish(true); output.error(new Error("语音接口在发送音频时中断，请稍后重试"));
                }
            },
            async cancel(reason) {
                await finish(true, reason);
            },
        });
        const headers = new Headers({ "Content-Type": mime, "Cache-Control": "no-store, no-transform", "X-Accel-Buffering": "no" });
        const rate = upstream.headers.get("x-sample-rate");
        if (rate && /^\d+$/.test(rate)) headers.set("X-Sample-Rate", rate);
        return new Response(audio, { headers });
    } catch (error) {
        await reader?.cancel().catch(() => {}); reader?.releaseLock();
        deadline.dispose();
        return reply(deadline.signal.aborted ? "语音请求已取消或超时"
            : error instanceof Error && /^(?:DashScope|下载合成音频|请填写 DashScope|当前为文字转语音|语音接口只支持)/.test(error.message)
                ? error.message : networkFailure(error), 502);
    }
}
