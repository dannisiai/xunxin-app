import { NextResponse } from "next/server";
import { readVoiceRequestConfig, safeVoiceError, synthesizeNativeVoice, voiceDeadline } from "@/lib/server/voice-provider";
export const runtime = "nodejs";
export const maxDuration = 150;
export async function POST(request: Request) {
    let apiKey = "";
    const deadline = voiceDeadline(request, 120_000);
    try {
        const raw = await request.text();
        if (raw.length > 100_000) return NextResponse.json({ error: "语音请求过大" }, { status: 400 });
        const body = JSON.parse(raw);
        const config = readVoiceRequestConfig(body.config);
        apiKey = config.apiKey;
        if (typeof body.text !== "string" || !body.text.trim() || body.text.length > 20_000) {
            return NextResponse.json({ error: "请提供有效文字（最多 20000 字符）" }, { status: 400 });
        }
        const bytes = await synthesizeNativeVoice(body.text, config, deadline.signal);
        return new Response(new Uint8Array(bytes).buffer, { headers: { "Content-Type": "audio/mpeg", "Cache-Control": "no-store" } });
    } catch (error) {
        return NextResponse.json({ error: deadline.signal.aborted ? "语音请求已取消或超时" : safeVoiceError(error, apiKey) }, { status: 502 });
    } finally { deadline.dispose(); }
}
