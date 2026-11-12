import { Pcm16Decoder } from "./qwen-tts";

function pause(ms: number, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
        const cancel = () => { clearTimeout(timer); reject(signal.reason); };
        const timer = setTimeout(() => { signal.removeEventListener("abort", cancel); resolve(); }, ms);
        signal.addEventListener("abort", cancel, { once: true });
    });
}

/** Incremental mono S16LE playback. Bound scheduled audio instead of buffering a whole utterance. */
export async function playPcmResponse(response: Response, context: AudioContext, gain: GainNode, signal: AbortSignal): Promise<void> {
    const type = response.headers.get("content-type") || "";
    const rate = Number(type.match(/\brate\s*=\s*"?(\d+)/i)?.[1] || 24000);
    const channels = Number(type.match(/\bchannels\s*=\s*"?(\d+)/i)?.[1] || 1);
    if (rate < 8000 || rate > 96000 || channels !== 1 || !response.body) {
        await response.body?.cancel(); throw new Error("语音流的采样率或声道格式不受支持");
    }
    const reader = response.body.getReader(), decoder = new Pcm16Decoder();
    const sources = new Set<AudioBufferSourceNode>();
    let nextTime = context.currentTime, count = 0, pending: Float32Array[] = [], pendingCount = 0;
    const cancel = () => {
        for (const source of sources) { try { source.stop(); source.disconnect(); } catch {} }
        sources.clear(); void reader.cancel().catch(() => {});
    };
    const flush = async () => {
        if (!pendingCount) return;
        while (nextTime - context.currentTime > 3) await pause(40, signal);
        signal.throwIfAborted();
        if (context.state !== "running") throw new Error("音频播放已暂停，请重新开始通话或试听");
        const buffer = context.createBuffer(1, pendingCount, rate), samples = buffer.getChannelData(0);
        let offset = 0;
        for (const block of pending) { samples.set(block, offset); offset += block.length; }
        pending = []; pendingCount = 0;
        const source = context.createBufferSource(); source.buffer = buffer; source.connect(gain);
        sources.add(source);
        source.onended = () => { source.disconnect(); sources.delete(source); };
        const start = Math.max(context.currentTime + 0.04, nextTime);
        source.start(start); nextTime = start + buffer.duration;
    };
    signal.addEventListener("abort", cancel, { once: true });
    try {
        signal.throwIfAborted();
        while (true) {
            const chunk = await reader.read();
            signal.throwIfAborted();
            if (chunk.done) break;
            const samples = decoder.decode(chunk.value);
            count += samples.length;
            if (count > rate * 180) throw new Error("语音流超过 180 秒上限");
            // At most 100ms per node, even if a proxy delivers a very large HTTP chunk.
            const blockSize = Math.floor(rate / 10);
            for (let offset = 0; offset < samples.length; offset += blockSize) {
                const block = samples.subarray(offset, offset + blockSize);
                pending.push(block); pendingCount += block.length;
                if (pendingCount >= rate * 0.02) await flush();
            }
        }
        decoder.finish();
        if (!count) throw new Error("语音服务返回了空音频");
        await flush();
        while (sources.size) {
            if (context.state !== "running") throw new Error("音频播放已暂停，请重新开始通话或试听");
            await pause(40, signal);
        }
    } finally {
        signal.removeEventListener("abort", cancel); cancel(); reader.releaseLock();
    }
}
