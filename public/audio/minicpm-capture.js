/* Input is never monitored to the speakers. Send bounded 100 ms / 16 kHz frames. */
class MiniCPMCapture extends AudioWorkletProcessor {
    constructor() { super(); this.sum = 0; this.count = 0; this.phase = 0; this.samples = []; }
    process(inputs, outputs) {
        for (const output of outputs) for (const channel of output) channel.fill(0);
        const data = inputs[0]?.[0];
        if (!data) return true;
        for (const sample of data) {
            this.sum += sample; this.count++; this.phase += 16000;
            if (this.phase < sampleRate) continue;
            const value = this.sum / this.count;
            while (this.phase >= sampleRate) {
                this.samples.push(value); this.phase -= sampleRate;
                if (this.samples.length === 1600) {
                    const pcm = new Float32Array(this.samples); this.samples = [];
                    const rms = Math.sqrt(pcm.reduce((sum, v) => sum + v * v, 0) / pcm.length);
                    this.port.postMessage({ pcm, rms }, [pcm.buffer]);
                }
            }
            this.sum = 0; this.count = 0;
        }
        return true;
    }
}
registerProcessor("minicpm-capture", MiniCPMCapture);
