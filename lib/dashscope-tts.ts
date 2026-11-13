import type { VoiceApiConfig } from "./settings-types";

/** Match the native DashScope service, without treating paths or proxy names as hosts. */
export function isDashscopeTts(config: Pick<VoiceApiConfig, "baseUrl">): boolean {
    try {
        return /^dashscope(?:[-.][a-z0-9-]+)*\.aliyuncs\.com$/i.test(new URL(config.baseUrl || "").hostname);
    } catch { return false; }
}

type SpeechRequest = (url: string, init: RequestInit) => Promise<Response>;

/** Synthesis and the subsequent audio download share the caller's cancellation signal. */
export async function requestDashscopeAudio(
    text: string, config: VoiceApiConfig, request: SpeechRequest, signal?: AbortSignal,
): Promise<Response> {
    signal?.throwIfAborted();
    if (!isDashscopeTts(config)) throw new Error("DashScope 接口地址无效");
    if (!config.apiKey?.trim()) throw new Error("请填写 DashScope API Key");
    if (config.model?.trim().endsWith("-realtime")) {
        throw new Error("当前为文字转语音接口，请选择非 realtime 的语音合成模型");
    }
    if (config.referenceAudio?.trim()) {
        throw new Error("DashScope 原生接口需要先在服务商创建克隆音色，再填写音色 ID；请移除这里的参考音频，或使用支持参考音频的自定义接口");
    }
    const endpoint = new URL(config.baseUrl!);
    if (endpoint.username || endpoint.password || !["http:", "https:"].includes(endpoint.protocol)) {
        throw new Error("语音接口只支持不含账号密码的 HTTP(S) 地址");
    }
    endpoint.protocol = "https:";
    endpoint.pathname = "/api/v1/services/aigc/multimodal-generation/generation";
    endpoint.hash = ""; endpoint.search = "";
    const response = await request(endpoint.toString(), {
        method: "POST", signal, redirect: "error", cache: "no-store",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + config.apiKey.trim() },
        // Native Qwen-TTS takes the selected voice inside input, not parameters.
        body: JSON.stringify({
            model: config.model?.trim() || "qwen3-tts-flash",
            input: { text, voice: config.defaultVoice?.trim() || "Cherry", language_type: "Auto" },
        }),
    });
    if (!response.ok) {
        await response.body?.cancel();
        throw new Error("DashScope 语音合成失败（HTTP " + response.status + "），请检查密钥、模型和音色 ID");
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("DashScope 未返回合成结果");
    const chunks: Uint8Array[] = []; let size = 0;
    try {
        while (true) {
            signal?.throwIfAborted();
            const next = await reader.read();
            if (next.done) break;
            size += next.value.length;
            if (size > 1024 * 1024) {
                await reader.cancel();
                throw new Error("DashScope 合成结果过大");
            }
            chunks.push(next.value);
        }
    } finally { reader.releaseLock(); }
    signal?.throwIfAborted();
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    let result;
    try { result = JSON.parse(new TextDecoder().decode(bytes)); }
    catch { throw new Error("DashScope 未返回有效的合成结果"); }
    const rawUrl = result?.output?.audio?.url;
    if (result?.code || (result?.status_code && Number(result.status_code) !== 200)
        || typeof rawUrl !== "string" || !rawUrl.trim()) {
        throw new Error("DashScope 未返回音频地址，请检查模型和音色 ID 是否匹配");
    }
    let audioUrl: URL;
    try { audioUrl = new URL(rawUrl); } catch { throw new Error("DashScope 返回的音频地址无效"); }
    if (!["http:", "https:"].includes(audioUrl.protocol) || audioUrl.username || audioUrl.password) {
        throw new Error("DashScope 返回的音频地址无效");
    }
    audioUrl.protocol = "https:";
    audioUrl.hash = "";
    // The signed audio URL authorizes the download. Never forward the provider key.
    const audio = await request(audioUrl.toString(), { method: "GET", signal, redirect: "error", cache: "no-store" });
    if (!audio.ok) {
        await audio.body?.cancel();
        throw new Error("下载合成音频失败（HTTP " + audio.status + "）");
    }
    return audio;
}
