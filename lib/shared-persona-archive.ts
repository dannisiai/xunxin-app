import { kvGet, kvSetAsync } from "./kv-db";
import { getDocumentAccountId, isAccountStorageActive } from "./account-storage";
import { SHARED_PERSONA_KEYS } from "./shared-persona-keys";
export { SHARED_ARCHIVE_CHANGED } from "./shared-persona-keys";

// Explicitly shared by device at the owner's request. Never include credentials or bindings.
const MARKER = "shared_persona_archive_hash_v1";
const LIMIT = 32 * 1024 * 1024;
let archiveQueue: Promise<unknown> = Promise.resolve();
function serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = archiveQueue.then(operation);
    archiveQueue = result.catch(() => undefined);
    return result;
}
type Bridge = {
    sharedArchivePermission(id: string): boolean;
    requestSharedArchivePermission(id: string): void;
    sharedArchiveReadStart(id: string): string;
    sharedArchiveRead(id: string, token: string, offset: string): string;
    sharedArchiveWriteStart(id: string): string;
    sharedArchiveWrite(id: string, token: string, data: string): string;
    sharedArchiveCommit(id: string, token: string): string;
};
export function sharedArchiveBridge(): Bridge | null {
    const bridge = typeof window !== "undefined" ? (window as Window & { AndroidShell?: Bridge }).AndroidShell : undefined;
    return bridge?.sharedArchiveReadStart ? bridge : null;
}
function call<T>(raw: string): T {
    const response = JSON.parse(raw);
    if (!response.ok) throw new Error(response.error || "本机存档读写失败");
    return response.value as T;
}
function assertActive() { if (!isAccountStorageActive()) throw new Error("账户已切换，请重新打开应用。"); }
export function sharedPersonaRecords(): Record<string, string | null> {
    return Object.fromEntries(SHARED_PERSONA_KEYS.map(key => [key, kvGet(key)]));
}
async function digest(value: string) {
    return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))), byte => byte.toString(16).padStart(2, "0")).join("");
}
export async function validateSharedArchive(text: string): Promise<{ records: Record<string, string | null>; hash: string }> {
    if (new TextEncoder().encode(text).length > LIMIT) throw new Error("本机存档超过 32MB。");
    const value = JSON.parse(text);
    if (value.format !== "xunxin-shared-personas" || value.version !== 1 || !value.records || typeof value.records !== "object" || Array.isArray(value.records)) throw new Error("存档格式不支持。");
    const records: Record<string, string | null> = {};
    if (Object.keys(value.records).some(key => !(SHARED_PERSONA_KEYS as readonly string[]).includes(key))) throw new Error("存档含不允许共享的设置。");
    for (const key of SHARED_PERSONA_KEYS) {
        const item = value.records[key];
        if (item !== null && typeof item !== "string") throw new Error("存档缺少资料或资料格式损坏。");
        if (item !== null) {
            const parsed = JSON.parse(item);
            if (parsed === null || typeof parsed !== "object") throw new Error("存档资料结构损坏。");
            if ((key === "ai_phone_characters_v1" || key === "ai_phone_user_identities_v1") && (!Array.isArray(parsed) || parsed.some(row => !row || typeof row.id !== "string" || typeof row.name !== "string"))) throw new Error("人设资料结构损坏。");
        }
        records[key] = item;
    }
    const hash = await digest(JSON.stringify(records));
    if (hash !== value.hash) throw new Error("存档校验失败，未载入也未覆盖原文件。");
    return { records, hash };
}
export async function readSharedArchive() {
    assertActive(); const bridge = sharedArchiveBridge(); if (!bridge) return null;
    const id = getDocumentAccountId();
    const info = JSON.parse(call<string>(bridge.sharedArchiveReadStart(id)));
    if (!info.exists) return null;
    if (!Number.isSafeInteger(info.size) || info.size < 1 || info.size > LIMIT) throw new Error("存档大小无效。");
    const bytes = new Uint8Array(info.size); let offset = 0;
    while (offset < info.size) {
        assertActive(); const chunk = atob(call<string>(bridge.sharedArchiveRead(id, info.token, String(offset))));
        if (!chunk.length || offset + chunk.length > info.size) throw new Error("存档读取不完整。");
        for (let index = 0; index < chunk.length; index++) bytes[offset + index] = chunk.charCodeAt(index);
        offset += chunk.length; await new Promise(resolve => setTimeout(resolve, 0));
    }
    return validateSharedArchive(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}
export function restoreSharedArchive(): Promise<boolean> { return serialized(restoreSharedArchiveInternal); }
async function restoreSharedArchiveInternal(): Promise<boolean> {
    const archive = await readSharedArchive();
    if (!archive || kvGet(MARKER) === archive.hash) return false;
    const firstImport = !kvGet(MARKER);
    for (const key of SHARED_PERSONA_KEYS) {
        assertActive();
        // Missing records are represented as empty collections, never as authentication state.
        let incoming = archive.records[key] ?? (key === "ai_phone_character_versions_v1" ? "{}" : "[]");
        // First adoption preserves personas that already exist in this app account.
        // Subsequent imports mirror the shared file, including intentional deletions.
        if (firstImport && kvGet(key)) incoming = mergeInitialPersonaRecords(kvGet(key)!, incoming);
        await kvSetAsync(key, incoming);
    }
    await kvSetAsync(MARKER, archive.hash);
    return true;
}
export function mergeInitialPersonaRecords(local: string, incoming: string): string {
    const previous = JSON.parse(local), shared = JSON.parse(incoming);
    if (Array.isArray(previous) && Array.isArray(shared)) {
        const merged = new Map<string, unknown>();
        for (const item of [...previous, ...shared]) {
            if (!item || typeof item.id !== "string") throw new Error("原有人设资料损坏，未覆盖存档。");
            const previousItem = merged.get(item.id) as { updatedAt?: string } | undefined;
            const older = previousItem && Number.isFinite(Date.parse(previousItem.updatedAt || "")) && Date.parse(previousItem.updatedAt || "") > Date.parse(item.updatedAt || "1970-01-01");
            if (!older) merged.set(item.id, item);
        }
        return JSON.stringify([...merged.values()]);
    }
    if (previous && shared && typeof previous === "object" && typeof shared === "object" && !Array.isArray(previous) && !Array.isArray(shared)) return JSON.stringify({ ...previous, ...shared });
    throw new Error("原有资料格式与共用存档不兼容，未覆盖存档。");
}
export function saveSharedArchive(): Promise<void> { return serialized(saveSharedArchiveInternal); }
async function saveSharedArchiveInternal(): Promise<void> {
    assertActive(); const bridge = sharedArchiveBridge(); if (!bridge) return;
    const records = sharedPersonaRecords(); const hash = await digest(JSON.stringify(records));
    const existing = await readSharedArchive();
    if (existing && existing.hash !== kvGet(MARKER)) throw new Error("本机共用存档已变化，请重新打开应用载入，未覆盖原存档。");
    if (existing?.hash === hash) return;
    const bytes = new TextEncoder().encode(JSON.stringify({ format: "xunxin-shared-personas", version: 1, savedAt: new Date().toISOString(), records, hash }));
    if (bytes.length > LIMIT) throw new Error("人设和头像超过 32MB，未覆盖原存档。");
    const id = getDocumentAccountId(); const token = call<string>(bridge.sharedArchiveWriteStart(id));
    for (let offset = 0; offset < bytes.length; offset += 192 * 1024) {
        assertActive(); let binary = "";
        for (const byte of bytes.subarray(offset, offset + 192 * 1024)) binary += String.fromCharCode(byte);
        call(bridge.sharedArchiveWrite(id, token, btoa(binary))); await new Promise(resolve => setTimeout(resolve, 0));
    }
    assertActive(); call(bridge.sharedArchiveCommit(id, token)); await kvSetAsync(MARKER, hash);
    await kvSetAsync("shared_persona_archive_saved_at_v1", new Date().toISOString());
    window.dispatchEvent(new Event("shared-persona-archive-saved"));
}

let initialization: Promise<boolean> | null = null;
export function initializeSharedArchive(): Promise<boolean> {
    if (!initialization) initialization = (async () => {
        const restored = await restoreSharedArchive();
        if (!restored) await saveSharedArchive();
        return restored;
    })().catch(error => { initialization = null; throw error; });
    return initialization;
}
export function resetSharedArchiveInitialization() { initialization = null; }
