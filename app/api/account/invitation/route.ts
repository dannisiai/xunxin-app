import { accountInvitationSub2Api, isSub2ApiAuthEnabled } from "@/lib/server/sub2api-auth";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!isSub2ApiAuthEnabled()) return NextResponse.json({ ok: false, error: "当前账号不使用云端服务。" }, { status: 404 });
  return accountInvitationSub2Api(request);
}
