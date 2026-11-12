import { NextRequest, NextResponse } from "next/server";
import { getAccountForDocument } from "@/lib/server/account-auth";
import { matchesAccountOAuthState } from "@/lib/oauth-account-scope";

/**
 * OAuth callback endpoint.
 * Authorization server redirects here with ?code=xxx&state=xxx
 * We render a simple page that posts the result back to the opener window.
 */
export async function GET(req: NextRequest) {
    const account = await getAccountForDocument(req).catch(() => null);
    if (!account) return new NextResponse("请先登录后重新授权。", { status: 401, headers: { "Cache-Control": "no-store" } });
    const code = req.nextUrl.searchParams.get("code") || "";
    const state = req.nextUrl.searchParams.get("state") || "";
    if (!matchesAccountOAuthState(state, account.id)) {
        return new NextResponse("账户已切换，请回到原账户重新授权。", { status: 409, headers: { "Cache-Control": "no-store" } });
    }
    const error = req.nextUrl.searchParams.get("error") || "";
    const callbackPayload = {
        state,
        code,
        error,
        createdAt: Date.now(),
    };

    // Return a minimal HTML page that communicates back to the opener
    const scopeId = account.id.replace(/[&<>"']/g, character => `&#${character.charCodeAt(0)};`);
    const safeJson = (value: unknown) => JSON.stringify(value).replace(/</g, "\\u003c");
    const html = `<!DOCTYPE html><html data-account-storage-scope="${scopeId}"><head><script src="/account-storage-bootstrap.js"></script><title>授权完成</title><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>
<script>
  var payload = ${safeJson(callbackPayload)};
  try {
    window.localStorage.setItem("ai_phone_mcp_oauth_callback_v1", JSON.stringify(payload));
  } catch(e) {}
  try {
    if (window.opener) {
      window.opener.postMessage({
        type: "mcp-oauth-callback",
        code: ${safeJson(code)},
        state: ${safeJson(state)},
        error: ${safeJson(error)}
      }, window.location.origin);
    }
  } catch(e) {}
  setTimeout(function() {
    try {
      if (window.opener) {
        window.close();
        return;
      }
    } catch(e) {}
    window.location.replace("/");
  }, 800);
</script>
<p>授权完成，正在返回 Float...</p>
</body></html>`;

    return new NextResponse(html, {
        headers: { "Content-Type": "text/html", "Cache-Control": "no-store" },
    });
}
