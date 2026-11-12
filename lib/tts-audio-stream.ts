export function isPcmAudioResponse(response: Response): boolean {
    return /^(?:audio\/(?:x-)?(?:pcm|wav|wave)|audio\/vnd\.wave|audio\/l16|application\/octet-stream)\b/i
        .test(response.headers.get("content-type") || "");
}

/** One reader for Web Audio and Android: strip incremental WAV headers and align S16LE samples. */
export async function openPcmAudioStream(response: Response, signal: AbortSignal) {
    if (!response.body || !isPcmAudioResponse(response)) throw new Error("语音接口未返回可播放的 PCM/WAV 流");
    const reader = response.body.getReader();
    const type = response.headers.get("content-type") || "";
    let sampleRate = Number(type.match(/\brate\s*=\s*"?(\d+)/i)?.[1] || response.headers.get("x-sample-rate") || 24000);
    let channels = Number(type.match(/\bchannels\s*=\s*"?(\d+)/i)?.[1] || 1);
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
            throw new Error("语音流需要单声道、16 位 PCM，采样率 8000–96000 Hz");
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
            if (pending !== undefined || remaining !== null && remaining > 0) throw new Error("语音流传输不完整");
            if (!total) throw new Error("语音服务返回了空音频");
        } finally { await cancel(); }
    })();
    return { sampleRate, chunks, cancel };
}
