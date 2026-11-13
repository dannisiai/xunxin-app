import type { VoiceApiConfig } from "./settings-types";

/** Only opt known Qwen3-TTS REST endpoints into their PCM/clone extensions. */
export function isQwenTts(config: VoiceApiConfig): boolean {
    if (config.provider !== "Custom" || config.customTtsProtocol === "minicpm") return false;
    if (!/qwen3[-_]?tts/i.test(config.model || "")) return false;
    try {
        const host = new URL(config.baseUrl || "").hostname;
        return !/(^|\.)aliyuncs\.com$/i.test(host) && !/dashscope/i.test(host);
    } catch { return false; }
}

export function requiresQwenReference(config: VoiceApiConfig): boolean {
    return isQwenTts(config) && /(?:^|[-_/\s])base(?:$|[-_/\s])/i.test(config.model || "");
}

export function qwenSpeechBody(text: string, config: VoiceApiConfig, stream: boolean) {
    const reference = config.referenceAudio?.trim();
    const transcript = config.referenceText?.trim();
    if (requiresQwenReference(config) && !reference) {
        throw new Error("Qwen3-TTS Base 需要参考音频，请先上传人声音频后再试听或合成");
    }
    return {
        // Compatible servers may require this field even for Base cloning.
        // The uploaded reference selects the voice; a stale catalog ID must not override it.
        model: config.model?.trim(), input: text, voice: reference ? "default" : config.defaultVoice?.trim() || "default",
        stream, response_format: stream ? "pcm" : "wav",
        ...(reference ? {
            task_type: "Base", ref_audio: reference,
            x_vector_only_mode: !transcript,
            ...(transcript ? { ref_text: transcript } : {}),
        } : {}),
    };
}

/** HTTP chunks can split a signed LE 16-bit sample at any byte boundary. */
export class Pcm16Decoder {
    private pending: number | undefined;
    decode(bytes: Uint8Array): Float32Array {
        const count = Math.floor((bytes.length + (this.pending === undefined ? 0 : 1)) / 2);
        const samples = new Float32Array(count);
        let offset = 0, index = 0;
        const sample = (low: number, high: number) => ((low | (high << 8)) << 16 >> 16) / 32768;
        if (this.pending !== undefined && bytes.length) {
            samples[index++] = sample(this.pending, bytes[offset++]); this.pending = undefined;
        }
        while (offset + 1 < bytes.length) {
            samples[index++] = sample(bytes[offset], bytes[offset + 1]); offset += 2;
        }
        if (offset < bytes.length) this.pending = bytes[offset];
        return samples;
    }
    finish() {
        if (this.pending !== undefined) throw new Error("语音流在一个 PCM 采样中途结束");
    }
}
