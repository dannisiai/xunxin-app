import type { RealtimeVoiceEndpoint, RealtimeVoiceProtocol } from "./settings-types";

export type CloudRealtimeProtocol = Exclude<RealtimeVoiceProtocol, "minicpm">;
export const REALTIME_DEFAULTS: Record<CloudRealtimeProtocol, Required<RealtimeVoiceEndpoint>> = {
    "openai-realtime": { apiKey: "", baseUrl: "https://api.openai.com/v1", model: "gpt-realtime-2.1", voice: "marin", transcriptionModel: "gpt-realtime-whisper" },
    "gemini-live": { apiKey: "", baseUrl: "https://generativelanguage.googleapis.com", model: "gemini-3.8-live", voice: "Aoede", transcriptionModel: "" },
};
