export const MAX_REFERENCE_AUDIO_BYTES = 20 * 1024 * 1024;
export const REFERENCE_AUDIO_ACCEPT = ".wav,.mp3,.flac,.m4a,.aac,audio/wav,audio/x-wav,audio/wave,audio/vnd.wave,audio/mpeg,audio/flac,audio/x-flac,audio/mp4,audio/x-m4a,audio/aac,audio/x-aac,audio/aacp";

export function isAndroidVoiceShell(): boolean {
    return typeof window !== "undefined" && Boolean((window as Window & { AndroidShell?: unknown }).AndroidShell);
}

export function detectAudioMime(bytes: Uint8Array): string | undefined {
    const tag = (start: number, size: number) => String.fromCharCode(...bytes.subarray(start, start + size));
    if (["RIFF", "RIFX", "RF64"].includes(tag(0, 4)) && tag(8, 4) === "WAVE") return "audio/wav";
    if (tag(0, 4) === "fLaC") return "audio/flac";
    if (tag(4, 4) === "ftyp") return "audio/mp4";
    // ADTS AAC has a 12-bit sync word and a zero layer; distinguish it from MP3.
    if (bytes[0] === 0xff && (bytes[1] & 0xf6) === 0xf0) return "audio/aac";
    if (tag(0, 4) === "ADIF") return "audio/aac";
    if (tag(0, 3) === "ID3" || (bytes[0] === 0xff && (bytes[1] & 0xe6) === 0xe2)) return "audio/mpeg";
    return undefined;
}

export async function readReferenceAudio(file: Blob): Promise<string> {
    if (!file.size) throw new Error("参考音频是空文件，请重新选择。");
    if (file.size > MAX_REFERENCE_AUDIO_BYTES) throw new Error("参考音频不能超过 20 MB，请裁剪后重试。");
    // Android document providers can report valid WAV files as generic binary.
    // Check the file header and set the MIME on the data URL sent to the gateway.
    const header = new Uint8Array(await file.slice(0, 4096).arrayBuffer());
    let mime = detectAudioMime(header);
    // AAC may have an ID3 tag before its ADTS frames. Keep its declared format
    // so the server decoder can inspect the complete file, including large tags.
    if (mime === "audio/mpeg" && String.fromCharCode(...header.subarray(0, 3)) === "ID3"
        && (/\.aac$/i.test((file as File).name || "") || /^audio\/(?:x-)?aac(?:p)?$/i.test(file.type))) mime = "audio/aac";
    if (!mime) throw new Error("未识别到有效的 WAV、MP3、FLAC、M4A 或 AAC 音频。");
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("读取参考音频失败。"));
        reader.onerror = reader.onabort = () => reject(new Error("读取参考音频失败，请重新选择文件。"));
        reader.readAsDataURL(file.slice(0, file.size, mime));
    });
}
