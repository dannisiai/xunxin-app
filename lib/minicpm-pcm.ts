import { microphoneCaptureError, microphoneUnavailableError } from "./media-permission";

/** MiniCPM Gateway audio: mono float32 LE, 16 kHz input / 24 kHz output. */
export function encodePcm(samples: Float32Array): string {
    const bytes = new Uint8Array(samples.length * 4), view = new DataView(bytes.buffer);
    samples.forEach((sample, i) => view.setFloat32(i * 4, Number.isFinite(sample) ? Math.max(-1, Math.min(1, sample)) : 0, true));
    let binary = "";
    for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return btoa(binary);
}
export function decodePcm(base64: string, maxSamples = 24000 * 20): Float32Array {
    if (base64.length > Math.ceil(maxSamples * 4 / 3) * 4) throw new Error("收到的音频片段过大");
    const binary = atob(base64);
    if (!binary.length || binary.length % 4) throw new Error("音频不是有效的 float32 PCM");
    const bytes = Uint8Array.from(binary, c => c.charCodeAt(0)), view = new DataView(bytes.buffer);
    const result = new Float32Array(bytes.length / 4);
    if (result.length > maxSamples) throw new Error("收到的音频片段过长");
    for (let i = 0; i < result.length; i++) {
        const value = view.getFloat32(i * 4, true);
        if (!Number.isFinite(value)) throw new Error("音频包含无效采样值");
        result[i] = Math.max(-1, Math.min(1, value));
    }
    return result;
}
export function pcmToWav(chunks: Float32Array[], sampleRate: number): Blob {
    const count = chunks.reduce((n, chunk) => n + chunk.length, 0);
    const bytes = new ArrayBuffer(44 + count * 2), view = new DataView(bytes);
    const text = (offset: number, value: string) => [...value].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
    text(0, "RIFF"); view.setUint32(4, 36 + count * 2, true); text(8, "WAVE");
    text(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true);
    view.setUint16(34, 16, true); text(36, "data"); view.setUint32(40, count * 2, true);
    let offset = 44;
    for (const chunk of chunks) for (const sample of chunk) {
        const value = Math.max(-1, Math.min(1, sample));
        view.setInt16(offset, Math.round(value < 0 ? value * 32768 : value * 32767), true); offset += 2;
    }
    return new Blob([bytes], { type: "audio/wav" });
}
export async function readMiniCPMReference(file: File): Promise<string> {
    if (file.size > 8 * 1024 * 1024) throw new Error("参考音频文件不能超过 8 MB");
    const context = new OfflineAudioContext(1, 1, 16000);
    const audio = await context.decodeAudioData(await file.arrayBuffer());
    if (!audio.length || audio.duration > 10) throw new Error("请选择不超过 10 秒的清晰参考音频");
    const mono = new Float32Array(audio.length);
    for (let channel = 0; channel < audio.numberOfChannels; channel++) {
        const data = audio.getChannelData(channel);
        for (let i = 0; i < mono.length; i++) mono[i] += data[i] / audio.numberOfChannels;
    }
    return encodePcm(mono);
}

type FrameHandler = (frame: Float32Array, rms: number) => void;
/** Streaming box-filter resampler used only by the ScriptProcessor compatibility path. */
class FrameResampler {
    private sum = 0; private count = 0; private phase = 0; private samples: number[] = [];
    constructor(private rate: number, private callback: FrameHandler) {}
    push(data: Float32Array) {
        for (const sample of data) {
            this.sum += sample; this.count++; this.phase += 16000;
            if (this.phase < this.rate) continue;
            const value = this.sum / this.count;
            while (this.phase >= this.rate) {
                this.samples.push(value); this.phase -= this.rate;
                if (this.samples.length === 1600) {
                    const frame = new Float32Array(this.samples); this.samples = [];
                    this.callback(frame, Math.sqrt(frame.reduce((sum, v) => sum + v * v, 0) / frame.length));
                }
            }
            this.sum = 0; this.count = 0;
        }
    }
}
export class MiniCPMAudioIO {
    readonly context: AudioContext;
    private gain: GainNode;
    private sources = new Set<AudioBufferSourceNode>();
    private remoteSources = new Set<MediaStreamAudioSourceNode>();
    private nextTime = 0;
    private stream: MediaStream | null = null;
    private input: MediaStreamAudioSourceNode | null = null;
    private processor: AudioWorkletNode | ScriptProcessorNode | null = null;
    private silentGain: GainNode | null = null;
    private captureGeneration = 0;
    private closed = false;
    private workletLoaded = false;
    constructor(volume: number) {
        const Ctor = window.AudioContext || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!Ctor) throw new Error("当前浏览器不支持实时音频播放");
        this.context = new Ctor({ latencyHint: "interactive" });
        this.gain = this.context.createGain(); this.gain.connect(this.context.destination);
        this.setVolume(volume);
    }
    async unlock() { await this.context.resume(); if (this.context.state !== "running") throw new Error("请点击连接按钮以启用音频播放"); }
    setVolume(volume: number) { this.gain.gain.value = Number.isFinite(volume) ? Math.max(0, Math.min(1, volume)) : 1; }
    connectRemoteStream(stream: MediaStream): () => void {
        const node = this.context.createMediaStreamSource(stream);
        node.connect(this.gain); this.remoteSources.add(node);
        return () => { node.disconnect(); this.remoteSources.delete(node); };
    }
    get playing() { return this.sources.size > 0 && this.nextTime > this.context.currentTime; }
    play(samples: Float32Array) {
        if (this.closed) return;
        if (this.nextTime - this.context.currentTime > 20) throw new Error("音频播放积压超过 20 秒，请重新连接");
        const buffer = this.context.createBuffer(1, samples.length, 24000);
        buffer.copyToChannel(new Float32Array(samples), 0);
        const source = this.context.createBufferSource(); source.buffer = buffer; source.connect(this.gain);
        this.sources.add(source);
        source.onended = () => { source.disconnect(); this.sources.delete(source); };
        const start = Math.max(this.context.currentTime + 0.025, this.nextTime);
        source.start(start); this.nextTime = start + buffer.duration;
    }
    clearPlayback() {
        for (const source of this.sources) { try { source.stop(); source.disconnect(); } catch { /* already ended */ } }
        this.sources.clear(); this.nextTime = this.context.currentTime;
    }
    async startCapture(onFrame: FrameHandler, onError: (error: Error) => void) {
        this.stopCapture();
        const generation = this.captureGeneration;
        if (!navigator.mediaDevices?.getUserMedia) throw microphoneUnavailableError();
        const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
            .catch((error: unknown) => { throw microphoneCaptureError(error); });
        if (this.closed || generation !== this.captureGeneration) { stream.getTracks().forEach(track => track.stop()); return; }
        this.stream = stream;
        const active = () => !this.closed && generation === this.captureGeneration;
        stream.getAudioTracks().forEach(track => { track.onended = () => { if (active()) onError(new Error("麦克风已断开，请重新连接")); }; });
        try {
            this.input = this.context.createMediaStreamSource(stream);
            this.silentGain = this.context.createGain(); this.silentGain.gain.value = 0; this.silentGain.connect(this.context.destination);
            let worklet: AudioWorkletNode | null = null;
            if (this.context.audioWorklet) {
                try {
                    if (!this.workletLoaded) { await this.context.audioWorklet.addModule("/audio/minicpm-capture.js"); this.workletLoaded = true; }
                    if (!active()) return;
                    worklet = new AudioWorkletNode(this.context, "minicpm-capture");
                } catch { /* Older WebViews use the bounded compatibility processor below. */ }
            }
            if (!active()) return;
            if (worklet) {
                worklet.port.onmessage = event => {
                    if (!active()) return;
                    const frame = event.data?.pcm;
                    if (frame instanceof Float32Array && frame.length === 1600) onFrame(frame, Number(event.data.rms) || 0);
                };
                this.processor = worklet;
            } else {
                const processor = this.context.createScriptProcessor(4096, 1, 1);
                const resampler = new FrameResampler(this.context.sampleRate, onFrame);
                processor.onaudioprocess = event => {
                    event.outputBuffer.getChannelData(0).fill(0);
                    if (active()) resampler.push(event.inputBuffer.getChannelData(0));
                };
                this.processor = processor;
            }
            this.input.connect(this.processor); this.processor.connect(this.silentGain);
        } catch (error) {
            if (active()) this.stopCapture();
            throw error;
        }
    }
    stopCapture() {
        this.captureGeneration++;
        this.stream?.getTracks().forEach(track => { track.onended = null; track.stop(); }); this.stream = null;
        this.input?.disconnect(); this.input = null;
        if (typeof AudioWorkletNode !== "undefined" && this.processor instanceof AudioWorkletNode) { this.processor.port.onmessage = null; this.processor.port.close(); }
        else if (this.processor && "onaudioprocess" in this.processor) this.processor.onaudioprocess = null;
        this.processor?.disconnect(); this.processor = null;
        this.silentGain?.disconnect(); this.silentGain = null;
    }
    close() {
        if (this.closed) return;
        this.closed = true; this.stopCapture(); this.clearPlayback();
        this.remoteSources.forEach(node => node.disconnect()); this.remoteSources.clear(); this.gain.disconnect();
        void this.context.close().catch(() => {});
    }
}
