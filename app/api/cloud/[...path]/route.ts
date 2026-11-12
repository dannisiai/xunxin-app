import { isSub2ApiAuthEnabled, proxySub2ApiModel } from "@/lib/server/sub2api-auth";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function proxy(request: Request, context: { params: Promise<{ path: string[] }> }) {
    if (!isSub2ApiAuthEnabled()) return NextResponse.json({ error: { message: "当前账号不使用云端计费。" } }, { status: 404 });
    const { path } = await context.params;
    return proxySub2ApiModel(request, `/${path.join("/")}`);
}

export const GET = proxy;
export const POST = proxy;
