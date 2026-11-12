import { NextResponse } from "next/server";
import { fetchVoiceCatalog, readVoiceRequestConfig, safeVoiceError, voiceDeadline } from "@/lib/server/voice-provider";
export const runtime = "nodejs";
export const maxDuration = 30;
export async function POST(request: Request) {
    let apiKey = "";
    const deadline = voiceDeadline(request, 25_000);
    try {
        const raw = await request.text();
        if (raw.length > 32_768) return NextResponse.json({ error: "请求配置过大" }, { status: 400 });
        const config = readVoiceRequestConfig(JSON.parse(raw).config);
        apiKey = config.apiKey;
        return NextResponse.json(await fetchVoiceCatalog(config, deadline.signal), { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
        return NextResponse.json({ error: deadline.signal.aborted ? "拉取已取消或超时" : safeVoiceError(error, apiKey) }, { status: 502 });
    } finally { deadline.dispose(); }
}
