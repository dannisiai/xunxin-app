import { NextResponse } from "next/server";
import type { AccountAuthConfig } from "@/lib/account-auth-types";
import { getSub2ApiPublicConfig, isSub2ApiAuthEnabled, sub2ApiErrorResponse } from "@/lib/server/sub2api-auth";

export const runtime = "nodejs";
export async function GET() {
  try {
    const config: AccountAuthConfig = isSub2ApiAuthEnabled() ? await getSub2ApiPublicConfig() : {
      provider: "supabase", registrationEnabled: true, emailVerificationRequired: true,
      passwordRequired: false, codeLoginEnabled: true, invitationRequired: false,
      emailSuffixWhitelist: [], requiresAccountCenter: false,
    };
    return NextResponse.json({ ok: true, config }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return sub2ApiErrorResponse(error); }
}
