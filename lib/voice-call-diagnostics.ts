import type { VoiceApiConfig } from "./settings-types";
import { cloudAccountConfig } from "./cloud-account";

/** User-visible failures must never contain configured keys or token-bearing URLs. */
export function voiceCallError(error: unknown, config?: VoiceApiConfig | null, extraSecrets: string[] = []): string {
    let message = error instanceof Error ? error.message : typeof error === "string" ? error : "语音服务发生错误";
    const keys = [config?.apiKey, config?.webSocketRealtime?.apiKey, config?.geminiLive?.apiKey,
        config?.openaiRealtime?.apiKey, ...extraSecrets].filter((key): key is string => !!key?.trim());
    for (const key of keys.sort((a, b) => b.length - a.length)) {
        for (const value of new Set([key, key.trim(), encodeURIComponent(key.trim())])) message = message.split(value).join("[密钥已隐藏]");
    }
    message = message.replace(/([?&](?:key|api_key|token|access_token)=)[^\s&#"']+/gi, "$1[密钥已隐藏]");
    if (/^(?:failed to fetch|fetch failed|networkerror(?: when attempting to fetch resource)?\.?)$/i.test(message.trim())) {
        message = "无法连接语音服务，请检查接口地址、网络及服务端是否正在运行。";
    }
    if (error instanceof Error && error.name === "NotAllowedError") message = "麦克风权限未获得，请在系统和浏览器设置中允许麦克风后重新连接。";
    if (error instanceof Error && error.name === "NotFoundError") message = "没有找到可用麦克风，请检查输入设备后重新连接。";
    return message.trim().slice(0, 600) || "语音服务发生错误";
}

export function voiceCallConfigurationHint(config: VoiceApiConfig | null): string {
    if (!config && cloudAccountConfig()) return "当前账户暂未开通统一语音服务，可先使用文字聊天。";
    if (!config) return "当前角色未绑定语音 API，暂时只能使用文字。请在设置的绑定管理中为该角色绑定语音方案。";
    if (!config.enableTTS) return "当前语音方案已关闭语音输出，对方回复不会播放声音。";
    return "";
}

/** Extract JSON service errors, not an HTML proxy page or unbounded upstream response. */
export function voiceHttpError(status: number, raw: string, config: VoiceApiConfig, secrets: string[] = []): string {
    let detail = "";
    try {
        const data: unknown = JSON.parse(raw);
        if (data && typeof data === "object") {
            const obj = data as Record<string, unknown>, error = obj.error;
            if (typeof error === "string") detail = error;
            else if (error && typeof error === "object" && "message" in error && typeof error.message === "string") detail = error.message;
            else if (typeof obj.message === "string") detail = obj.message;
        }
    } catch { /* Proxy HTML must not be rendered as an API failure. */ }
    if (!detail) detail = status === 401 ? "密钥或短期凭据无效/已过期"
        : status === 403 ? "服务拒绝访问，请检查模型权限、区域和网关限制"
        : status === 404 ? "接口路径或模型不存在；普通聊天/TTS 中转未必支持实时连接"
        : status === 429 ? "请求受限，请检查额度或稍后重试" : "服务未返回可识别的错误信息";
    return voiceCallError(`HTTP ${status}：${detail}`, config, secrets);
}
