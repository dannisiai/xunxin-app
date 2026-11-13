import type { VoiceApiConfig } from "@/lib/settings-types";
import type { VoiceCatalogEntry, VoiceCatalogResult } from "@/lib/voice-catalog-types";
import { buildVoiceProviderUrl, voiceProviderHeaders, voiceLocale } from "@/lib/voice-api";
import { proxyFetch } from "@/lib/proxy-fetch";

const PROVIDERS = new Set(["OpenAI", "Custom", "Minimax", "ElevenLabs", "GoogleCloudTTS", "AzureSpeech"]);
const MAX_ITEMS = 1000;
type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue {
    return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
}
function text(value: unknown, max = 400): string { return typeof value === "string" ? value.trim().slice(0, max) : ""; }
export function readVoiceRequestConfig(value: unknown): VoiceApiConfig {
    const raw = record(value), provider = text(raw.provider, 40);
    if (!PROVIDERS.has(provider)) throw new Error("不支持此语音服务商");
    return {
        id: "", provider, apiKey: text(raw.apiKey, 8192), baseUrl: text(raw.baseUrl, 2048),
        region: text(raw.region, 64), model: text(raw.model), defaultVoice: text(raw.defaultVoice),
        voiceLocale: text(raw.voiceLocale, 80), voiceAuthMode: raw.voiceAuthMode === "bearer" ? "bearer" : "api-key",
        quotaProjectId: text(raw.quotaProjectId, 200),
        modelListUrl: text(raw.modelListUrl, 2048), voiceListUrl: text(raw.voiceListUrl, 2048),
        enableSTT: false, enableTTS: true,
    };
}
export function safeVoiceError(error: unknown, apiKey = ""): string {
    let message = error instanceof Error ? error.message : String(error);
    if (apiKey) message = message.split(apiKey).join("[密钥已隐藏]");
    return message.slice(0, 500);
}
export function voiceDeadline(request: Request, ms: number) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    request.signal.addEventListener("abort", abort, { once: true });
    if (request.signal.aborted) abort();
    const timer = setTimeout(abort, ms);
    return { signal: controller.signal, dispose: () => { clearTimeout(timer); request.signal.removeEventListener("abort", abort); } };
}
async function readBytes(response: Response, limit: number): Promise<Uint8Array> {
    if (Number(response.headers.get("content-length")) > limit) throw new Error("服务商响应过大");
    const reader = response.body?.getReader();
    if (!reader) return new Uint8Array();
    const chunks: Uint8Array[] = []; let size = 0;
    try {
        for (;;) {
            const next = await reader.read();
            if (next.done) break;
            size += next.value.byteLength;
            if (size > limit) { await reader.cancel(); throw new Error("服务商响应过大"); }
            chunks.push(next.value);
        }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return bytes;
}
async function providerJson(url: string, init: RequestInit, signal: AbortSignal): Promise<unknown> {
    const response = await proxyFetch(url, { ...init, signal, redirect: "error" });
    const raw = new TextDecoder().decode(await readBytes(response, 5 * 1024 * 1024));
    let payload: unknown;
    try { payload = JSON.parse(raw); } catch { throw new Error("服务商未返回 JSON（HTTP " + response.status + "）"); }
    const root = record(payload), base = record(root.base_resp);
    if (!response.ok || (base.status_code !== undefined && String(base.status_code) !== "0") || root.error) {
        const detail = record(root.error);
        throw new Error(text(detail.message) || text(root.error) || text(base.status_msg) || text(root.message)
            || "服务商请求失败（HTTP " + response.status + "）");
    }
    return payload;
}
function unique(items: VoiceCatalogEntry[]): VoiceCatalogEntry[] {
    const found = new Set<string>();
    return items.filter(item => item.id && !found.has(item.id) && !!found.add(item.id)).slice(0, MAX_ITEMS);
}
function arrayAt(payload: unknown, kind: "models" | "voices"): unknown[] {
    if (Array.isArray(payload)) return payload;
    const root = record(payload), data = record(root.data);
    const candidate = root[kind] ?? data[kind] ?? root.data ?? root.result;
    if (!Array.isArray(candidate)) throw new Error("未识别到服务商返回的" + (kind === "models" ? "模型" : "音色") + "列表");
    return candidate;
}
function parseModels(payload: unknown, eleven = false): VoiceCatalogEntry[] {
    return unique(arrayAt(payload, "models").flatMap(value => {
        if (typeof value === "string") return [{ id: text(value), name: text(value) }];
        const item = record(value);
        if (eleven && item.can_do_text_to_speech === false) return [];
        const id = text(item.id ?? item.model_id ?? item.model ?? item.name);
        return id ? [{ id, name: text(item.name ?? item.display_name) || id }] : [];
    }));
}
function parseVoices(payload: unknown): VoiceCatalogEntry[] {
    return unique(arrayAt(payload, "voices").flatMap(value => {
        if (typeof value === "string") return [{ id: text(value), name: text(value) }];
        const item = record(value);
        const id = text(item.voice_id ?? item.ShortName ?? item.uri ?? item.id ?? item.name);
        const locale = text(item.Locale ?? item.locale ?? (Array.isArray(item.languageCodes) ? item.languageCodes[0] : undefined), 80);
        return id ? [{ id, name: text(item.voice_name ?? item.DisplayName ?? item.name) || id, ...(locale ? { locale } : {}) }] : [];
    }));
}
function parseMinimaxVoices(payload: unknown): VoiceCatalogEntry[] {
    const root = record(payload), data = record(root.data);
    const groups = ["system_voice", "voice_cloning", "voice_generation"];
    if (!groups.some(group => Array.isArray(root[group] ?? data[group]))) throw new Error("未识别到 MiniMax 音色列表");
    return unique(groups.flatMap(group => {
        const items = root[group] ?? data[group];
        return Array.isArray(items) ? items.flatMap(value => {
            const item = record(value), id = text(item.voice_id ?? item.id);
            const description = Array.isArray(item.description) ? item.description.map(v => text(v)).filter(Boolean).join(" / ") : text(item.description);
            return id ? [{ id, name: text(item.voice_name) || description || id, group }] : [];
        }) : [];
    }));
}
export async function fetchVoiceCatalog(config: VoiceApiConfig, signal: AbortSignal): Promise<VoiceCatalogResult> {
    const headers = voiceProviderHeaders(config);
    const result: VoiceCatalogResult = {
        models: [], voices: [], updatedAt: Date.now(), modelStatus: "unsupported", voiceStatus: "unsupported", messages: [],
    };
    const tasks: Promise<void>[] = [];
    const run = (kind: "models" | "voices", task: () => Promise<VoiceCatalogEntry[]>) => {
        tasks.push(task().then(items => {
            result[kind] = items;
            if (kind === "models") result.modelStatus = "fetched"; else result.voiceStatus = "fetched";
            if (!items.length) result.messages.push((kind === "models" ? "模型" : "音色") + "列表为空，保留已有列表和当前选择。");
        }).catch(error => {
            if (kind === "models") result.modelStatus = "error"; else result.voiceStatus = "error";
            result.messages.push((kind === "models" ? "模型" : "音色") + "拉取失败：" + safeVoiceError(error, config.apiKey));
        }));
    };
    if (["OpenAI", "Custom", "ElevenLabs"].includes(config.provider)) {
        run("models", async () => parseModels(await providerJson(buildVoiceProviderUrl(config, "models"), { headers }, signal), config.provider === "ElevenLabs"));
        if (config.provider !== "ElevenLabs") result.messages.push("模型列表可能包含非语音模型，请按服务商说明选择；当前模型保持不变。");
    } else result.messages.push(config.provider === "Minimax" ? "MiniMax 模型沿用内置列表或手动填写；本次联网获取音色。"
        : "此服务按音色选择引擎，不需要单独填写模型 ID。");
    if (config.provider === "Minimax") {
        run("voices", async () => parseMinimaxVoices(await providerJson(buildVoiceProviderUrl(config, "voices"), {
            method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ voice_type: "all" }),
        }, signal)));
    } else if (config.provider === "ElevenLabs") {
        run("voices", async () => {
            const items: VoiceCatalogEntry[] = []; const tokens = new Set<string>(); let token = "";
            for (let page = 0; page < 10; page++) {
                const url = new URL(buildVoiceProviderUrl(config, "voices"));
                url.searchParams.set("page_size", "100"); url.searchParams.set("include_total_count", "false");
                if (token) url.searchParams.set("next_page_token", token);
                const payload = await providerJson(url.toString(), { headers }, signal);
                items.push(...parseVoices(payload));
                const root = record(payload), next = text(root.next_page_token);
                if (!root.has_more || !next || tokens.has(next)) return unique(items);
                tokens.add(next); token = next;
            }
            result.messages.push("音色最多载入 1000 项，更多音色可手动填写 ID。");
            return unique(items);
        });
    } else if (["GoogleCloudTTS", "AzureSpeech"].includes(config.provider) || (config.provider === "Custom" && config.voiceListUrl?.trim())) {
        run("voices", async () => parseVoices(await providerJson(buildVoiceProviderUrl(config, "voices"), { headers }, signal)));
    } else result.messages.push(config.provider === "OpenAI" ? "OpenAI 内置音色使用官方预置列表，不标记为联网获取。"
        : "未设置音色列表地址，音色 ID 可继续手动填写。");
    await Promise.all(tasks);
    if (signal.aborted) throw new Error("拉取已取消或超时，请稍后重试");
    if (result.modelStatus !== "fetched" && result.voiceStatus !== "fetched") throw new Error(result.messages.join("；"));
    return result;
}
function xml(value: string): string {
    return value.replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[ch]!);
}
export async function synthesizeNativeVoice(textValue: string, config: VoiceApiConfig, signal: AbortSignal): Promise<Uint8Array> {
    if (!["ElevenLabs", "GoogleCloudTTS", "AzureSpeech"].includes(config.provider)) throw new Error("此接口仅用于原生语音服务商");
    if (!config.defaultVoice.trim()) throw new Error("请选择或填写音色 ID");
    const headers = voiceProviderHeaders(config);
    if (config.provider === "GoogleCloudTTS") {
        const payload = await providerJson(buildVoiceProviderUrl(config, "speech"), {
            method: "POST", headers: { ...headers, "Content-Type": "application/json" },
            body: JSON.stringify({ input: { text: textValue }, voice: { name: config.defaultVoice, languageCode: voiceLocale(config) },
                audioConfig: { audioEncoding: "MP3" } }),
        }, signal);
        const audio = text(record(payload).audioContent, 30 * 1024 * 1024);
        if (!audio || !/^[A-Za-z0-9+/=\r\n]+$/.test(audio)) throw new Error("Google Cloud TTS 未返回有效音频");
        const bytes = new Uint8Array(Buffer.from(audio, "base64"));
        if (!bytes.length) throw new Error("服务商返回了空音频");
        return bytes;
    }
    const azure = config.provider === "AzureSpeech";
    const body = azure ? '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="' + xml(voiceLocale(config)) + '"><voice name="' + xml(config.defaultVoice) + '">' + xml(textValue) + "</voice></speak>"
        : JSON.stringify({ text: textValue, model_id: config.model?.trim() || "eleven_multilingual_v2" });
    const response = await proxyFetch(buildVoiceProviderUrl(config, "speech"), {
        method: "POST", signal, redirect: "error", body, headers: {
            ...headers, "Content-Type": azure ? "application/ssml+xml" : "application/json",
            ...(azure ? { "X-Microsoft-OutputFormat": "audio-24khz-48kbitrate-mono-mp3", "User-Agent": "Xunxin" } : {}),
        },
    });
    const bytes = await readBytes(response, 20 * 1024 * 1024);
    const mime = response.headers.get("content-type") || "";
    if (!response.ok || /json|text\//i.test(mime)) {
        let message = "语音服务商请求失败（HTTP " + response.status + "）";
        try { const raw = record(JSON.parse(new TextDecoder().decode(bytes))); message = text(record(raw.error).message) || text(record(raw.detail).message) || text(raw.message) || message; } catch {}
        throw new Error(message);
    }
    if (!bytes.length) throw new Error("服务商返回了空音频");
    return bytes;
}
