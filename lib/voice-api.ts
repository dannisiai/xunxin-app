import type { VoiceApiConfig } from "./settings-types";

export const NATIVE_VOICE_PROVIDERS = ["ElevenLabs", "GoogleCloudTTS", "AzureSpeech"] as const;

function httpUrl(raw: string): URL {
    let url: URL;
    try { url = new URL(raw); } catch { throw new Error("语音接口地址无效，请填写完整的 HTTP(S) 地址"); }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
        throw new Error("语音接口只支持不含账号密码的 HTTP(S) 地址");
    }
    url.hash = "";
    return url;
}
export function resolveCompatibleVoiceBaseUrl(config: Pick<VoiceApiConfig, "provider" | "baseUrl">): string {
    const raw = config.baseUrl?.trim() || (config.provider === "OpenAI" ? "https://api.openai.com/v1" : "");
    if (!raw) throw new Error("请填写自定义语音的接口地址");
    const url = httpUrl(raw);
    url.pathname = url.pathname.replace(/\/+$/, "").replace(/\/audio\/(speech|transcriptions)$/i, "").replace(/\/models$/i, "");
    return url.toString();
}
export function buildCompatibleVoiceUrl(baseUrl: string, endpoint: "speech" | "transcriptions"): string {
    const url = httpUrl(resolveCompatibleVoiceBaseUrl({ provider: "Custom", baseUrl }));
    url.pathname = url.pathname.replace(/\/+$/, "") + "/audio/" + endpoint;
    return url.toString();
}
function appendPath(base: string, suffix: string): string {
    const url = httpUrl(base);
    url.pathname = url.pathname.replace(/\/+$/, "") + suffix;
    return url.toString();
}
export function voiceCatalogConfig(config: VoiceApiConfig) {
    return {
        provider: config.provider, apiKey: config.apiKey, baseUrl: config.baseUrl,
        region: config.region, voiceAuthMode: config.voiceAuthMode,
        quotaProjectId: config.quotaProjectId,
        modelListUrl: config.modelListUrl, voiceListUrl: config.voiceListUrl,
    };
}
export function voiceCatalogFingerprint(config: VoiceApiConfig): string {
    return JSON.stringify({ ...voiceCatalogConfig(config), voiceMode: config.voiceMode, customTtsProtocol: config.customTtsProtocol });
}
export function resolveProviderVoiceBaseUrl(config: VoiceApiConfig): string {
    if (config.provider === "OpenAI" || config.provider === "Custom") return resolveCompatibleVoiceBaseUrl(config);
    let raw = config.baseUrl?.trim();
    if (config.provider === "Minimax") raw ||= "https://api.minimaxi.com/v1";
    else if (config.provider === "ElevenLabs") raw ||= "https://api.elevenlabs.io/v1";
    else if (config.provider === "GoogleCloudTTS") raw ||= "https://texttospeech.googleapis.com/v1";
    else if (config.provider === "AzureSpeech" && !raw) {
        const region = config.region?.trim();
        if (!region || !/^[a-z0-9-]+$/i.test(region)) throw new Error("请填写 Azure Speech 区域或自定义接口地址");
        raw = "https://" + region + ".tts.speech.microsoft.com/cognitiveservices";
    }
    if (!raw) throw new Error("不支持此语音服务商");
    const url = httpUrl(raw);
    url.pathname = url.pathname.replace(/\/+$/, "");
    if (config.provider === "GoogleCloudTTS") url.pathname = url.pathname.replace(/\/(voices|text:synthesize)$/i, "");
    if (config.provider === "AzureSpeech") {
        url.pathname = url.pathname.replace(/\/voices\/list$/i, "").replace(/\/v1$/i, "");
        if (!url.pathname) url.pathname = "/cognitiveservices";
    }
    return url.toString();
}
export function buildVoiceProviderUrl(config: VoiceApiConfig, operation: "models" | "voices" | "speech"): string {
    const base = resolveProviderVoiceBaseUrl(config);
    if (operation === "models" && ["Minimax", "GoogleCloudTTS", "AzureSpeech"].includes(config.provider)) {
        throw new Error("此服务商没有接入独立模型列表接口");
    }
    if ((operation === "models" && config.modelListUrl?.trim()) || (operation === "voices" && config.voiceListUrl?.trim())) {
        const raw = operation === "models" ? config.modelListUrl!.trim() : config.voiceListUrl!.trim();
        return httpUrl(new URL(raw, base).toString()).toString();
    }
    if (config.provider === "OpenAI" || config.provider === "Custom") {
        if (operation === "models") return appendPath(base, "/models");
        if (operation === "speech") return buildCompatibleVoiceUrl(base, "speech");
        throw new Error("请填写自定义音色列表地址；此接口没有统一的音色查询路径");
    }
    if (config.provider === "Minimax") return appendPath(base, operation === "voices" ? "/get_voice" : "/t2a_v2");
    if (config.provider === "GoogleCloudTTS") return appendPath(base, operation === "voices" ? "/voices" : "/text:synthesize");
    if (config.provider === "AzureSpeech") return appendPath(base, operation === "voices" ? "/voices/list" : "/v1");
    if (config.provider === "ElevenLabs") {
        const url = httpUrl(base);
        const root = url.pathname.replace(/\/v[12]$/i, "").replace(/\/+$/, "");
        url.pathname = root + (operation === "models" ? "/v1/models" : operation === "voices" ? "/v2/voices"
            : "/v1/text-to-speech/" + encodeURIComponent(config.defaultVoice));
        if (operation === "speech") url.searchParams.set("output_format", "mp3_44100_128");
        return url.toString();
    }
    throw new Error("不支持此语音服务商");
}
export function voiceProviderHeaders(config: VoiceApiConfig): Record<string, string> {
    const key = config.apiKey?.trim() || "";
    if (!key && config.provider !== "Custom") throw new Error("请填写服务商密钥或访问令牌");
    if (!key) return {};
    if (config.provider === "ElevenLabs") return { "xi-api-key": key };
    if (config.provider === "GoogleCloudTTS") return {
        Authorization: "Bearer " + key,
        ...(config.quotaProjectId?.trim() ? { "x-goog-user-project": config.quotaProjectId.trim() } : {}),
    };
    if (config.provider === "AzureSpeech" && config.voiceAuthMode !== "bearer") return { "Ocp-Apim-Subscription-Key": key };
    return { Authorization: "Bearer " + key };
}
export function voiceLocale(config: VoiceApiConfig): string {
    const locale = config.voiceLocale?.trim() || config.defaultVoice.match(/^[a-z]{2,3}(?:-[A-Za-z]{4})?-[A-Z]{2}/)?.[0];
    if (!locale || !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})+$/.test(locale)) {
        throw new Error("请填写语音语言代码，例如 zh-CN 或 en-US");
    }
    return locale;
}

export async function fetchModelsFromEndpoint(baseUrl: string, apiKey?: string, provider = "Custom"): Promise<string[]> {
    if (!baseUrl) throw new Error("请先填写接口地址");
    const modelsBase = baseUrl
        .replace(/\/+$/, "")
        .replace(/\/(chat\/completions|completions|embeddings|messages|audio\/speech|audio\/transcriptions)$/i, "");
    const modelsUrl = /\/models$/i.test(modelsBase) ? modelsBase : `${modelsBase}/models`;
    const isGoogle = provider === "Google" || baseUrl.includes("generativelanguage.googleapis.com");
    const targetUrl = isGoogle && apiKey ? `${modelsUrl}?key=${encodeURIComponent(apiKey)}` : modelsUrl;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (apiKey && !isGoogle) headers["Authorization"] = `Bearer ${apiKey}`;

    let response: Response;
    try {
        response = await fetch(targetUrl, { method: "GET", headers });
    } catch {
        response = await fetch("/api/voice/catalog", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ config: { provider: "Custom", baseUrl: modelsBase, apiKey: apiKey || "" } }),
        });
    }

    if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.error?.message || err.error || `HTTP ${response.status}`);
    }

    const data = await response.json();
    let modelNames: string[] = [];
    if (Array.isArray(data?.data)) {
        modelNames = data.data.map((m: any) => m.id || m.name).filter(Boolean);
    } else if (Array.isArray(data?.models)) {
        modelNames = data.models.map((m: any) => typeof m === "string" ? m : (m.name || m.id)).filter(Boolean);
    } else {
        throw new Error("服务商未返回模型列表");
    }
    return modelNames.map(m => m.replace(/^models\//, ""));
}
