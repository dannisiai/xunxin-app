import { SpeechAudioError } from "./tts-audio-stream";

/** Deadline covers response headers AND body; caller cancellation stays an AbortError. */
export async function fetchTtsResponse(url: string, init: RequestInit, timeoutMs = 120_000): Promise<Response> {
    const controller = new AbortController();
    const external = init.signal;
    let timedOut = false;
    const abort = () => { controller.abort(external?.reason); cleanup(); };
    const cleanup = () => { clearTimeout(timer); external?.removeEventListener("abort", abort); };
    const failure = (error: unknown, receiving = false) => {
        if (timedOut) return new SpeechAudioError(`语音合成超时（超过 ${Math.round(timeoutMs / 1000)} 秒）`);
        if (!external?.aborted && (error instanceof TypeError || typeof DOMException !== "undefined" && error instanceof DOMException && error.name === "NetworkError")) {
            return new SpeechAudioError(receiving ? "接收语音时连接中断，请检查语音服务器和手机网络" : "无法建立语音连接，请检查接口地址、手机网络和 HTTPS 证书");
        }
        return error;
    };
    const timer = setTimeout(() => { timedOut = true; controller.abort(); cleanup(); }, timeoutMs);
    if (external?.aborted) abort(); else external?.addEventListener("abort", abort, { once: true });
    try {
        const response = await fetch(url, { ...init, signal: controller.signal });
        if (!response.body) { cleanup(); return response; }
        const reader = response.body.getReader();
        const body = new ReadableStream<Uint8Array>({
            async pull(output) {
                try {
                    const chunk = await reader.read();
                    if (chunk.done) { cleanup(); output.close(); }
                    else output.enqueue(chunk.value);
                } catch (error) { cleanup(); output.error(failure(error, true)); }
            },
            async cancel(reason) {
                controller.abort(reason); cleanup();
                await reader.cancel(reason).catch(() => {});
            },
        });
        return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    } catch (error) { cleanup(); throw failure(error); }
}
