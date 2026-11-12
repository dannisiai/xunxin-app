import { NextResponse } from "next/server";
import { isSub2ApiAuthEnabled, logoutSub2Api } from "@/lib/server/sub2api-auth";

import { ACCOUNT_SESSION_COOKIE, deleteSessionToken, getAccountForDocument, readCookie } from "@/lib/server/account-auth";
import { ACCOUNT_GATE_COOKIE } from "@/lib/account-cookie-constants";

export async function POST(request: Request) {
  if (isSub2ApiAuthEnabled()) return logoutSub2Api(request);
  const account = await getAccountForDocument(request);
  if (account && request.headers.get("x-account-id") !== account.id) {
    return NextResponse.json({ ok: false, error: "账户已切换，请重新打开页面。" }, { status: 409 });
  }
  const token = readCookie(request, ACCOUNT_SESSION_COOKIE);
  await deleteSessionToken(token).catch(() => undefined);
  const response = NextResponse.json({ ok: true });
  response.cookies.set(ACCOUNT_SESSION_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0,
  });
  response.cookies.set(ACCOUNT_GATE_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0,
  });
  return response;
}
