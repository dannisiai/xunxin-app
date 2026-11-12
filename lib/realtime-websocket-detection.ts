import type { RealtimeVoiceEndpoint, VoiceApiConfig } from "./settings-types";
import { REALTIME_DEFAULTS } from "./realtime-voice-defaults";

export type WebSocketProtocol = "minicpm" | "gemini-live";
export type WebSocketDetection = { protocol: WebSocketProtocol | null; error: string };

/** Previous explicit choices remain useful for reading legacy configurations, never for probing hosts. */
export function legacyWebSocketProtocol(config: Partial<VoiceApiConfig>): WebSocketProtocol {
    if (config.realtimeProtocol === "minicpm" || config.realtimeProtocol === "gemini-live") return config.realtimeProtocol;
    if (config.webSocketProtocol === "minicpm" || config.webSocketProtocol === "gemini-live") return config.webSocketProtocol;
    return config.provider === "MiniCPMRealtime" || config.miniCPMGatewayUrl || config.customTtsProtocol === "minicpm" ? "minicpm" : "gemini-live";
}
function legacyEndpoint(config: Partial<VoiceApiConfig>): RealtimeVoiceEndpoint {
    if (legacyWebSocketProtocol(config) === "minicpm") {
        return { baseUrl: config.miniCPMGatewayUrl || (config.provider === "MiniCPMRealtime" ? config.baseUrl : "") || "", model: "", apiKey: "", voice: "" };
    }
    return { ...config.geminiLive, baseUrl: config.geminiLive?.baseUrl ?? REALTIME_DEFAULTS["gemini-live"].baseUrl };
}
export function webSocketEditorEndpoint(config: Partial<VoiceApiConfig>): RealtimeVoiceEndpoint {
    return { ...(config.webSocketRealtime || legacyEndpoint(config)) };
}
function canonicalUrl(raw: string): string {
    try {
        const url = new URL(raw);
        return url.protocol + "//" + url.host + url.pathname.replace(/\/+$/, "") + url.search;
    } catch { return raw.trim(); }
}
/** Pure detection: no requests, credentials sent, microphone access, or speculative handshake. */
export function detectWebSocketProtocol(config: Partial<VoiceApiConfig>): WebSocketDetection {
    const endpoint = webSocketEditorEndpoint(config);
    const raw = endpoint.baseUrl?.trim() || "", model = endpoint.model?.trim() || "";
    const modelGemini = /(^|\/)gemini(?:[-_.]|$)/i.test(model);
    const modelMini = /(^|\/)mini[-_]?cpm(?:[-_.]|$)/i.test(model);
    const modelOpenAI = /(^|\/)(?:gpt[-_.](?:realtime|live)|openai)(?:[-_.]|$)/i.test(model);
    let url: URL | null = null;
    if (raw) {
        try { url = new URL(raw); } catch { return { protocol: null, error: "接口地址无效，请填写完整的 HTTP(S) 或 WS(S) 地址。" }; }
        if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol) || url.username || url.password) {
            return { protocol: null, error: "接口地址不支持此协议或内嵌账号密码。" };
        }
    }
    if (modelOpenAI || url?.hostname === "api.openai.com") {
        return { protocol: null, error: "当前 OpenAI 实时接入请在上方选择 WebRTC。" };
    }
    const gemini = modelGemini || url?.hostname === "generativelanguage.googleapis.com"
        || !!url?.pathname.includes("/ws/google.ai.generativelanguage.");
    const mini = modelMini || (!!url?.pathname.replace(/\/+$/, "").endsWith("/realtime") && ["audio", "chat"].includes(url.searchParams.get("mode") || ""));
    if (gemini && mini) return { protocol: null, error: "接口地址与模型类型不一致，请核对后再连接。" };
    if (gemini || mini) return { protocol: gemini ? "gemini-live" : "minicpm", error: "" };
    const legacy = legacyWebSocketProtocol(config), previous = legacyEndpoint(config);
    const hasLegacy = !!config.geminiLive || !!config.miniCPMGatewayUrl || config.provider === "MiniCPMRealtime"
        || config.realtimeProtocol === "minicpm" || config.realtimeProtocol === "gemini-live" || !!config.webSocketProtocol;
    if (!raw && !model) return { protocol: legacy, error: "" };
    if (hasLegacy && (!config.webSocketRealtime || (canonicalUrl(raw) === canonicalUrl(previous.baseUrl || "")
        && model === (previous.model?.trim() || "")))) return { protocol: legacy, error: "" };
    return { protocol: null, error: "暂无法识别这个接口。请填写 Gemini 或 MiniCPM 实时模型名，或使用可识别的接口地址。" };
}
