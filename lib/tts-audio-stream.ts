export const SPEECH_SYNTHESIS_TIMEOUT_MS = 240_000;

/** Only pass application-generated messages to the overlay, never raw provider errors. */
export class SpeechAudioError extends Error {}

export function speechHttpError(status: number): SpeechAudioError {
    const hint = status === 401 || status === 403 ? "请检查密钥和模型权限。"
        : status === 429 ? "请检查额度或稍后重试。"
        : status >= 400 && status < 500 ? "请检查接口地址、模型和语音协议。"
        : "请检查语音服务或稍后重试。";
    return new SpeechAudioError(`语音请求失败（HTTP ${status}），${hint}`);
}

export function isPcmAudioResponse(response: Response): boolean {
    return /^(?:audio\/(?:x-)?(?:pcm|wav|wave)|audio\/vnd\.wave|audio\/l16|application\/octet-stream)\b/i
        .test(response.headers.get("content-type") || "");
}

/** Inspect only the first 12 bytes and replay them into the same response body. */
export async function classifySpeechAudio(response: Response, signal: AbortSignal, allowRawBinary: boolean) {
    const type = (response.headers.get("content-type") || "").toLowerCase().split(";")[0].trim();
    if (type === "text/event-stream") {
        await response.body?.cancel();
        throw new SpeechAudioError("语音接口返回了 SSE 事件。请选择完整音频，或使用支持裸 PCM 的流式协议。");
    }
    if (!response.body || !(type.startsWith("audio/") || type === "application/octet-stream")) {
        await response.body?.cancel();
        throw new SpeechAudioError("语音接口没有返回可播放的音频，请检查所选协议。");
    }
    const reader = response.body.getReader();
    const prefix = new Uint8Array(12);
    const buffered: Uint8Array[] = [];
    let length = 0, ended = false, closed = false;
    const cleanup = (cancel: boolean, reason?: unknown) => {
        if (closed) return;
        closed = true;
        signal.removeEventListener("abort", abort);
        if (cancel) return reader.cancel(reason).catch(() => {}).finally(() => reader.releaseLock());
        reader.releaseLock();
    };
    const abort = () => { void cleanup(true, signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
    try {
        signal.throwIfAborted();
        while (length < prefix.length && !ended) {
            const item = await reader.read();
            signal.throwIfAborted();
            ended = item.done;
            if (!item.done && item.value.length) {
                buffered.push(item.value);
                const take = item.value.subarray(0, prefix.length - length);
                prefix.set(take, length);
                length += take.length;
            }
        }
        if (!length) throw new SpeechAudioError("语音服务返回了空音频。");
        const tag = (offset: number, size: number) => String.fromCharCode(...prefix.subarray(offset, offset + size));
        const wavType = /^audio\/(?:(?:x-)?(?:wav|wave)|vnd\.wave)$/.test(type);
        const binary = type === "application/octet-stream";
        // Prefer a declared PCM type to weak frame-sync patterns in raw samples.
        const detected = length >= 12 && ["RIFF", "RIFX", "RF64"].includes(tag(0, 4)) && tag(8, 4) === "WAVE" ? "audio/wav"
            : !binary ? undefined
            : length >= 8 && tag(4, 4) === "ftyp" ? "audio/mp4"
            : length >= 4 && tag(0, 4) === "OggS" ? "audio/ogg"
            : length >= 4 && tag(0, 4) === "fLaC" ? "audio/flac"
            : length >= 4 && tag(0, 4) === "ADIF" ? "audio/aac"
            : length >= 3 && tag(0, 3) === "ID3" ? "audio/mpeg"
            : length >= 4 && prefix[0] === 0x1a && prefix[1] === 0x45 && prefix[2] === 0xdf && prefix[3] === 0xa3 ? "audio/webm"
            : length >= 4 && prefix[0] === 0xff && (prefix[1] & 0xf6) === 0xf0 && (prefix[2] & 0x3c) < 0x34 ? "audio/aac"
            : length >= 4 && prefix[0] === 0xff && (prefix[1] & 0xe6) === 0xe2 && (prefix[1] & 0x18) !== 0x08
                && (prefix[2] & 0xf0) > 0 && (prefix[2] & 0xf0) < 0xf0 && (prefix[2] & 0x0c) !== 0x0c ? "audio/mpeg"
            : undefined;
        const pcm = !detected && isPcmAudioResponse(response) && !wavType
            && (type !== "application/octet-stream" || allowRawBinary);
        if (!detected && !pcm && binary) {
            throw new SpeechAudioError("无法识别返回的音频格式，请检查语音接口。");
        }
        if (!detected && wavType) {
            throw new SpeechAudioError("语音接口返回的 WAV 文件头无效。");
        }
        const body = new ReadableStream<Uint8Array>({
            async pull(output) {
                try {
                    signal.throwIfAborted();
                    const first = buffered.shift();
                    if (first) { output.enqueue(first); return; }
                    if (!ended) {
                        const item = await reader.read();
                        signal.throwIfAborted();
                        if (!item.done) { output.enqueue(item.value); return; }
                    }
                    cleanup(false);
                    output.close();
                } catch (error) {
                    void cleanup(true, error);
                    output.error(error);
                }
            },
            cancel(reason) { return cleanup(true, reason); },
        }, { highWaterMark: 0 });
        const headers = new Headers(response.headers);
        if (detected) headers.set("Content-Type", detected);
        return { kind: pcm ? "pcm" as const : "file" as const, response: new Response(body, { headers }) };
    } catch (error) {
        await cleanup(true, error);
        throw error;
    }
}

/** One reader for Web Audio and Android: strip incremental WAV headers and align S16LE samples. */
export async function openPcmAudioStream(response: Response, signal: AbortSignal) {
    if (!response.body || !isPcmAudioResponse(response)) throw new Error("语音接口未返回可播放的 PCM/WAV 流");
    const reader = response.body.getReader();
    const type = response.headers.get("content-type") || "";
    let sampleRate = Number(type.match(/\brate\s*=\s*"?(\d+)/i)?.[1] || response.headers.get("x-audio-sample-rate") || response.headers.get("x-sample-rate") || 24000);
    let channels = Number(type.match(/\bchannels\s*=\s*"?(\d+)/i)?.[1] || response.headers.get("x-audio-channels") || 1);
    let bits = 16, bigEndian = /^audio\/l16\b/i.test(type), remaining: number | null = null;
    let buffered: Uint8Array<ArrayBufferLike> = new Uint8Array(0), ended = false, closed = false;
    const cancel = async () => {
        if (closed) return;
        closed = true;
        signal.removeEventListener("abort", aborted);
        await reader.cancel().catch(() => {});
        reader.releaseLock();
    };
    const aborted = () => { void reader.cancel().catch(() => {}); };
    signal.addEventListener("abort", aborted, { once: true });
    const ensure = async (length: number) => {
        while (buffered.length < length && !ended) {
            signal.throwIfAborted();
            const item = await reader.read();
            signal.throwIfAborted();
            if (item.done) { ended = true; break; }
            if (!buffered.length) buffered = item.value;
            else {
                const next = new Uint8Array(buffered.length + item.value.length);
                next.set(buffered); next.set(item.value, buffered.length); buffered = next;
            }
        }
        return buffered.length >= length;
    };
    const tag = (offset = 0) => String.fromCharCode(...buffered.subarray(offset, offset + 4));
    try {
        await ensure(12);
        if (tag() === "RIFF" && tag(8) === "WAVE") {
            bigEndian = false;
            buffered = buffered.subarray(12);
            let headerBytes = 12, foundFormat = false;
            while (true) {
                if (!await ensure(8)) throw new Error("WAV 语音流头不完整");
                const name = tag(), length = new DataView(buffered.buffer, buffered.byteOffset, buffered.byteLength).getUint32(4, true);
                buffered = buffered.subarray(8); headerBytes += 8;
                if (name === "data") {
                    if (!foundFormat) throw new Error("WAV 语音流缺少音频格式");
                    // Streaming encoders commonly use zero or a sentinel until synthesis ends.
                    remaining = [0, 0x7fffffff, 0xffffffff].includes(length) ? null : length;
                    break;
                }
                const size = length + (length & 1);
                headerBytes += size;
                if (headerBytes > 65536 || !await ensure(size)) throw new Error("WAV 语音流格式异常");
                if (name === "fmt ") {
                    if (length < 16) throw new Error("WAV 语音格式不完整");
                    const view = new DataView(buffered.buffer, buffered.byteOffset, buffered.byteLength);
                    if (view.getUint16(0, true) !== 1) throw new Error("流式语音需要 16 位 PCM 音频");
                    channels = view.getUint16(2, true); sampleRate = view.getUint32(4, true); bits = view.getUint16(14, true);
                    foundFormat = true;
                }
                buffered = buffered.subarray(size);
            }
        } else if (/^audio\/(?:x-)?wav|^audio\/wave|^audio\/vnd\.wave/i.test(type)) {
            throw new Error("语音接口返回的 WAV 格式无效");
        }
        if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 96000 || channels !== 1 || bits !== 16) {
            throw new SpeechAudioError("PCM 流格式不支持：需要单声道、16 位，采样率 8000–96000 Hz。");
        }
    } catch (error) { await cancel(); throw error; }
    const chunks = (async function* () {
        let pending: number | undefined, total = 0;
        try {
            while (true) {
                signal.throwIfAborted();
                if (!buffered.length) {
                    if (ended || remaining === 0) break;
                    const item = await reader.read();
                    signal.throwIfAborted();
                    if (item.done) { ended = true; break; }
                    buffered = item.value;
                }
                let bytes = buffered;
                buffered = new Uint8Array(0);
                if (remaining !== null) { bytes = bytes.subarray(0, remaining); remaining -= bytes.length; }
                total += bytes.length;
                if (total > sampleRate * 2 * 180) throw new Error("语音流超过 180 秒上限");
                if (pending !== undefined) {
                    const next = new Uint8Array(bytes.length + 1); next[0] = pending; next.set(bytes, 1); bytes = next; pending = undefined;
                }
                if (bytes.length & 1) { pending = bytes[bytes.length - 1]; bytes = bytes.subarray(0, bytes.length - 1); }
                if (bigEndian) {
                    bytes = bytes.slice();
                    for (let i = 0; i < bytes.length; i += 2) [bytes[i], bytes[i + 1]] = [bytes[i + 1], bytes[i]];
                }
                const size = Math.floor(sampleRate / 10) * 2;
                for (let offset = 0; offset < bytes.length; offset += size) {
                    signal.throwIfAborted();
                    yield bytes.subarray(offset, offset + size);
                }
                if (remaining === 0) break;
            }
            if (pending !== undefined || remaining !== null && remaining > 0) throw new SpeechAudioError("PCM 音频传输不完整。");
            if (!total) throw new SpeechAudioError("语音服务返回了空音频。");
        } finally { await cancel(); }
    })();
    return { sampleRate, chunks, cancel };
}
