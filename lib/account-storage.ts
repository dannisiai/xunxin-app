export type AccountStorageRuntime = {
    readonly accountId: string;
    isActive(): boolean;
    physicalName(name: string): string;
    reconcile(accountId: string): Promise<boolean>;
    invalidate(accountId?: string): Promise<void>;
    registerCleanup(cleanup: () => void | Promise<void>): () => void;
};

function runtime(): AccountStorageRuntime | undefined {
    return typeof window === "undefined" ? undefined : (window as Window & { __XUNXIN_ACCOUNT_STORAGE__?: AccountStorageRuntime }).__XUNXIN_ACCOUNT_STORAGE__;
}

export function registerAccountCleanup(cleanup: () => void | Promise<void>): () => void {
    return runtime()?.registerCleanup(cleanup) ?? (() => {});
}

/** Identity is document-owned, never loaded from an imported backup or KV record. */
export function getDocumentAccountId(): string { return runtime()?.accountId || ""; }
export function isAccountStorageActive(): boolean { return Boolean(runtime()?.accountId && runtime()?.isActive()); }
export function isCurrentAccountPushUrl(value: string): boolean {
    if (!isAccountStorageActive()) return false;
    try {
        const url = new URL(value, window.location.origin);
        return url.origin === window.location.origin && url.pathname === "/push-open"
            && url.searchParams.get("account") === getDocumentAccountId();
    } catch { return false; }
}
export function reconcileDocumentAccount(accountId: string): Promise<boolean> {
    const current = runtime();
    if (!current) return Promise.reject(new Error("账户存储保护未启动，请刷新页面。"));
    return current.reconcile(accountId);
}

/** Same-origin frames need their own realm initialized before authored scripts. */
export function scopeFrameDocument(html: string): string {
    const bootstrap = '<script src="/account-storage-bootstrap.js"></script>';
    return /^\s*<!doctype[^>]*>/i.test(html)
        ? html.replace(/^(\s*<!doctype[^>]*>)/i, `$1${bootstrap}`) : bootstrap + html;
}

export function isInternalAccountStorageName(name: string): boolean {
    return name.startsWith("__xunxin_") || name === "ai_phone_active_account_id_v1";
}
