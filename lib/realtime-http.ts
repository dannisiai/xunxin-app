/** Bounded response reader used for credentials, SDP and provider errors. */
export async function readRealtimeText(response: Response, limit = 131072): Promise<string> {
    if (Number(response.headers.get("content-length")) > limit) throw new Error("实时服务响应过大");
    const reader = response.body?.getReader();
    if (!reader) return "";
    const chunks: Uint8Array[] = []; let size = 0;
    try {
        for (;;) {
            const part = await reader.read();
            if (part.done) break;
            size += part.value.byteLength;
            if (size > limit) { await reader.cancel(); throw new Error("实时服务响应过大"); }
            chunks.push(part.value);
        }
    } finally { reader.releaseLock(); }
    const all = new Uint8Array(size); let offset = 0;
    for (const part of chunks) { all.set(part, offset); offset += part.byteLength; }
    return new TextDecoder().decode(all);
}
