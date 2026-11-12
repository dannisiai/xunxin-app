/** Deadline covers response headers AND body; caller cancellation stays an AbortError. */
export async function fetchTtsResponse(url: string, init: RequestInit, timeoutMs = 120_000): Promise<Response> {
    const controller = new AbortController();
    const external = init.signal;
    let timedOut = false;
    const abort = () => { controller.abort(external?.reason); cleanup(); };
    const cleanup = () => { clearTimeout(timer); external?.removeEventListener("abort", abort); };
    const failure = (error: unknown) => timedOut
        ? new Error(`语音合成超时（超过 ${Math.round(timeoutMs / 1000)} 秒）`) : error;
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
                } catch (error) { cleanup(); output.error(failure(error)); }
            },
            async cancel(reason) {
                controller.abort(reason); cleanup();
                await reader.cancel(reason).catch(() => {});
            },
        });
        return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    } catch (error) { cleanup(); throw failure(error); }
}
