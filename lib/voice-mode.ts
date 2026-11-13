import type { VoiceApiConfig } from "./settings-types";

export function resolveVoiceMode(_config: Pick<VoiceApiConfig, "provider" | "voiceMode">): "realtime" | "tts" {
    return "tts";
}

export function voiceSynthesisBlockReason(config: Pick<VoiceApiConfig, "enableTTS"> | null): string | null {
    if (!config) return "未找到当前角色的语音方案。请在语音设置或绑定管理中选择方案。";
    return config.enableTTS === false ? "当前语音方案已关闭合成。请在语音方案中开启「语音合成」。" : null;
}

export function isMiniCPMVoiceConfig(config: Pick<VoiceApiConfig, "provider" | "voiceMode" | "customTtsProtocol" | "realtimeProtocol">): boolean {
    return config.provider === "MiniCPMRealtime" || (config.provider === "Custom"
        && config.customTtsProtocol === "minicpm");
}

export function usesMiniCPMTts(config: VoiceApiConfig): boolean {
    return isMiniCPMVoiceConfig(config) || (config.provider === "Custom" && config.customTtsProtocol === "minicpm");
}

/** Reference-audio cloning selects the voice without a separate catalog ID. */
export function usesReferenceAudioVoice(config: VoiceApiConfig): boolean {
    return config.provider === "Custom" && !isMiniCPMVoiceConfig(config) && !!config.referenceAudio?.trim();
}

/** Only remove the former untouched, keyless auto-created sample; keep user-configured schemes. */
export function isUnusedLegacyVoicePreset(config: VoiceApiConfig): boolean {
    return config.id === "default-minimax-tts" && config.provider === "Minimax" && !config.apiKey?.trim()
        && (!config.name || config.name === "Minimax 语音")
        && (!config.baseUrl || config.baseUrl === "https://api.minimaxi.com/v1")
        && (!config.model || config.model === "speech-2.8-turbo")
        && (!config.defaultVoice || config.defaultVoice === "male-qn-qingse")
        && (config.speechSpeed === undefined || config.speechSpeed === 1)
        && (config.speechPitch === undefined || config.speechPitch === 0)
        && !config.languageBoost && !config.customVoices?.length && !config.catalog
        && !config.geminiLive && !config.openaiRealtime && !config.realtimeProtocol && !config.webSocketProtocol && !config.webSocketRealtime && !config.customTtsProtocol
        && !config.miniCPMGatewayUrl && !config.miniCPMReferencePcm && !config.miniCPMReferenceName && !config.miniCPMSaveInputAudio
        && !config.modelListUrl && !config.voiceListUrl && !config.sttModel && !config.region && !config.voiceAuthMode && !config.quotaProjectId
        && config.enableSTT !== false && config.enableTTS !== false;
}

/** Move the former standalone provider under Custom without changing IDs or character bindings. */
export function migrateLegacyVoiceConfig(config: VoiceApiConfig): VoiceApiConfig {
    if (config.provider !== "MiniCPMRealtime") return config;
    return {
        ...config,
        provider: "Custom",
        voiceMode: resolveVoiceMode(config),
        customTtsProtocol: "minicpm",
        miniCPMGatewayUrl: config.miniCPMGatewayUrl || config.baseUrl,
        baseUrl: undefined,
    };
}
