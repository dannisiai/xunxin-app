import { getAccountForDocument } from "@/lib/server/account-auth";

// Native declarative notifications may bypass service-worker JavaScript.
// Check their owner again before following any account-specific action.
export async function GET(request: Request) {
    const url = new URL(request.url);
    const account = await getAccountForDocument(request).catch(() => null);
    const destination = new URL(url.searchParams.get("to") || "/", url.origin);
    const allowed = account && account.id === url.searchParams.get("account")
        && destination.origin === url.origin
        && ["/", "/shortcut-run", "/personal-shortcut-run"].includes(destination.pathname);
    return new Response(null, {
        status: 302,
        headers: { Location: allowed ? destination.href : new URL("/", url.origin).href, "Cache-Control": "no-store" },
    });
}
