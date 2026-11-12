import { Pcm16Decoder } from "./qwen-tts";
import { openPcmAudioStream } from "./tts-audio-stream";

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
    const stream = await openPcmAudioStream(response, signal);
    const rate = stream.sampleRate, decoder = new Pcm16Decoder();
    const sources = new Set<AudioBufferSourceNode>();
    let nextTime = context.currentTime, count = 0, pending: Float32Array[] = [], pendingCount = 0;
    const cancel = () => {
        for (const source of sources) { try { source.stop(); source.disconnect(); } catch {} }
        sources.clear(); void stream.cancel().catch(() => {});
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
        for await (const chunk of stream.chunks) {
            signal.throwIfAborted();
            const samples = decoder.decode(chunk);
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
        signal.removeEventListener("abort", cancel); cancel();
    }
}
