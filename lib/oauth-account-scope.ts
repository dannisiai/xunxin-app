const STATE_PREFIX = "xunxin-account-v1:";
const NONCE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export function createAccountOAuthState(accountId: string, nonce: string): string {
    if (!accountId || !NONCE.test(nonce)) throw new Error("请先登录后重新授权。");
    return `${STATE_PREFIX}${encodeURIComponent(accountId)}:${nonce}`;
}

export function matchesAccountOAuthState(state: string, accountId: string): boolean {
    if (!state.startsWith(STATE_PREFIX) || !accountId) return false;
    const parts = state.slice(STATE_PREFIX.length).split(":");
    return parts.length === 2 && NONCE.test(parts[1]) && parts[0] === encodeURIComponent(accountId);
}
