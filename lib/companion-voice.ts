import { kvGet, kvSet, registerDynamicPrefix } from "./kv-db";
import { splitBilingualText } from "./bilingual-text";
import { requestStreamingSpeech, resolveVoiceConfig, synthesizeSpeech } from "./tts-service";
import { isQwenTts } from "./qwen-tts";
import { isPcmAudioResponse, openPcmAudioStream } from "./tts-audio-stream";

const PREFIX = "ai_phone_companion_voice_v1:";
registerDynamicPrefix(PREFIX);
export const COMPANION_VOICE_SETTINGS_EVENT = "companion-voice-settings-changed";
const MAX_AUDIO_BYTES = 4 * 1024 * 1024;
const CHUNK_SIZE = 48 * 1024;
class CompanionVoiceError extends Error {}

export function loadCompanionVoiceEnabled(appId: "douyin" | "xiaohongshu"): boolean {
  return kvGet(PREFIX + appId) === "true";
}

export function saveCompanionVoiceEnabled(appId: "douyin" | "xiaohongshu", enabled: boolean): void {
  kvSet(PREFIX + appId, String(enabled));
  window.dispatchEvent(new CustomEvent(COMPANION_VOICE_SETTINGS_EVENT, { detail: { appId, enabled } }));
}

export type CompanionVoiceBridge = {
  beginCompanionAudio?: (overlayId: string, requestId: string, length: number) => void;
  appendCompanionAudio?: (overlayId: string, requestId: string, chunk: string) => void;
  finishCompanionAudio?: (overlayId: string, requestId: string) => void;
  failCompanionAudio?: (overlayId: string, requestId: string, message: string) => void;
  setCompanionVoiceEnabled?: (appId: string, enabled: boolean) => void;
  beginCompanionPcm?: (overlayId: string, requestId: string, sampleRate: number) => boolean;
  appendCompanionPcm?: (overlayId: string, requestId: string, chunk: string) => number;
  finishCompanionPcm?: (overlayId: string, requestId: string) => void;
  stopCompanionPcm?: (overlayId: string, requestId: string) => void;
};

type VoiceRequest = { overlayId: string; requestId: string; characterId: string; appId?: string; voiceReplyEnabled?: boolean };
type Identity = { overlayId?: string; requestId?: string; appId?: string };

/** Speak the visible reply, excluding formatting, hidden reasoning and translations. */
export function companionSpeechText(text: string): string {
  return text.replace(/<(think|thinking)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .split("\n").map(line => splitBilingualText(line)?.original || line)
    .join("\n").replace(/^[\s>#*-]+/gm, "").replace(/[*_`~]/g, "").trim();
}

/** The text request settles first; voice has its own cancellation and retry lifecycle. */
export function createCompanionVoiceReplies(getBridge: () => CompanionVoiceBridge | undefined) {
  let last: { request: VoiceRequest; text: string; audio?: Blob } | undefined;
  let active: AbortController | undefined;
  const matches = (detail?: Identity) => !detail || Boolean(last
    && (!detail.overlayId || last.request.overlayId === detail.overlayId)
    && (!detail.requestId || last.request.requestId === detail.requestId)
    && (!detail.appId || last.request.appId === detail.appId));
  const stop = (detail?: Identity, forget = false) => {
    if (!matches(detail)) return;
    active?.abort(); active = undefined;
    if (last) {
      try { getBridge()?.stopCompanionPcm?.(last.request.overlayId, last.request.requestId); } catch { /* Overlay closed. */ }
    }
    if (forget) last = undefined;
  };
  const play = async () => {
    const entry = last;
    if (!entry) return;
    active?.abort();
    const controller = active = new AbortController();
    const { signal } = controller;
    const { overlayId, requestId, characterId } = entry.request;
    try {
      const native = getBridge();
      if (!native?.beginCompanionAudio || !native.appendCompanionAudio || !native.finishCompanionAudio) {
        throw new CompanionVoiceError("请更新安卓小手机后使用语音回复。");
      }
      if (!entry.audio) {
        const config = resolveVoiceConfig(characterId, "chat");
        if (!config || config.enableTTS === false) throw new CompanionVoiceError("请先在语音设置中为角色配置并开启语音合成。");
        let audio: Blob | null;
        if (isQwenTts(config) && native.beginCompanionPcm && native.appendCompanionPcm && native.finishCompanionPcm) {
          const response = await requestStreamingSpeech(entry.text, config, signal);
          if (isPcmAudioResponse(response)) {
            const stream = await openPcmAudioStream(response, signal);
            try {
              signal.throwIfAborted();
              if (last !== entry) return;
              if (!native.beginCompanionPcm(overlayId, requestId, stream.sampleRate)) {
                throw new CompanionVoiceError("流式语音暂时无法播放，请重新开启陪伴后重试。");
              }
              for await (const chunk of stream.chunks) {
                signal.throwIfAborted();
                if (last !== entry) return;
                const encoded = btoa(String.fromCharCode(...chunk));
                while (true) {
                  signal.throwIfAborted();
                  const accepted = native.appendCompanionPcm(overlayId, requestId, encoded);
                  if (accepted === 1) break;
                  if (accepted !== 0) throw new CompanionVoiceError("流式语音已停止，请点重试重新播放。");
                  await new Promise<void>((resolve, reject) => {
                    const cancel = () => { clearTimeout(timer); reject(signal.reason); };
                    const timer = setTimeout(() => { signal.removeEventListener("abort", cancel); resolve(); }, 40);
                    signal.addEventListener("abort", cancel, { once: true });
                  });
                }
              }
              signal.throwIfAborted();
              if (last === entry) native.finishCompanionPcm(overlayId, requestId);
              return;
            } finally { await stream.cancel(); }
          }
          // Reuse the same generation if a compatible server returns a file instead of PCM.
          if (!(response.headers.get("content-type") || "").toLowerCase().startsWith("audio/")) {
            await response.body?.cancel(); throw new CompanionVoiceError("语音接口没有返回可播放的音频。");
          }
          audio = await response.blob();
        } else {
          audio = await synthesizeSpeech(entry.text, config, { signal });
        }
        signal.throwIfAborted();
        if (!audio?.size) throw new CompanionVoiceError("语音服务没有返回音频。");
        if (audio.size > MAX_AUDIO_BYTES) throw new CompanionVoiceError("回复音频过长，请使用更简短的回复。");
        entry.audio = audio;
      }
      const bytes = new Uint8Array(await entry.audio.arrayBuffer());
      signal.throwIfAborted();
      let binary = "";
      for (let offset = 0; offset < bytes.length; offset += CHUNK_SIZE) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK_SIZE));
      }
      const encoded = btoa(binary);
      if (last !== entry) return;
      native.beginCompanionAudio(overlayId, requestId, encoded.length);
      for (let offset = 0; offset < encoded.length; offset += CHUNK_SIZE) {
        signal.throwIfAborted();
        native.appendCompanionAudio(overlayId, requestId, encoded.slice(offset, offset + CHUNK_SIZE));
      }
      native.finishCompanionAudio(overlayId, requestId);
    } catch (error) {
      if (!signal.aborted && last === entry) {
        // Provider errors can contain credentials. Keep the native status user-facing.
        const message = error instanceof CompanionVoiceError
          ? error.message : "语音合成失败，文字回复已保留，可在完整对话中点重试。";
        try { getBridge()?.failCompanionAudio?.(overlayId, requestId, message); } catch { /* Host closed. */ }
      }
    } finally {
      if (active === controller) active = undefined;
    }
  };
  return {
    stop,
    reply(request: VoiceRequest, text: string) {
      stop(undefined, true);
      if (request.voiceReplyEnabled !== true) return;
      const speech = companionSpeechText(text);
      if (!speech) {
        getBridge()?.failCompanionAudio?.(request.overlayId, request.requestId, "这条回复没有可朗读的文字。");
        return;
      }
      last = { request, text: speech };
      void play();
    },
    retry(detail: Identity) { if (matches(detail)) void play(); },
  };
}
