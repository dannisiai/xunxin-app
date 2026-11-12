import { kvGet, kvRemove, kvSet, registerKvMigration } from "./kv-db";
import { getDocumentAccountId, isAccountStorageActive } from "./account-storage";

// 当前登录账号 ID 的本地副本。有些同步代码（提示词组装、桥同步的缓存判定）取不到
// React context 也等不了 /api/auth/me，但又必须按账号隔离缓存——同一台设备换账号
// 后若继续复用上一个账号的凭据缓存，会把邮件发到上一个账号的收件箱。
const ACTIVE_ACCOUNT_ID_KEY = "ai_phone_active_account_id_v1";
registerKvMigration(ACTIVE_ACCOUNT_ID_KEY);

/** 账号解析成功/登出时由 account-gate 维护；自部署模式下固定是 local_user。 */
export function saveActiveAccountId(accountId: string): void {
  if (!isAccountStorageActive() || accountId !== getDocumentAccountId()) return;
  try {
    if (accountId) kvSet(ACTIVE_ACCOUNT_ID_KEY, accountId);
    else kvRemove(ACTIVE_ACCOUNT_ID_KEY);
  } catch { /* 写不进去只会让按账号隔离的缓存失效，不影响主流程 */ }
}

/** 读不到就返回空串——调用方一律按「与缓存不匹配」处理，宁可多取一次也不复用。 */
export function loadActiveAccountId(): string {
  if (typeof window !== "undefined" && "__XUNXIN_ACCOUNT_STORAGE__" in window) return isAccountStorageActive() ? getDocumentAccountId() : "";
  try {
    return kvGet(ACTIVE_ACCOUNT_ID_KEY) || "";
  } catch {
    return "";
  }
}

export type AccountProfile = {
  id: string;
  username: string;
  displayName: string;
  status: "active" | "disabled";
  createdAt?: string;
  updatedAt?: string;
};

type AccountResponse = {
  ok?: boolean;
  account?: AccountProfile | null;
  error?: string;
  requiresTwoFactor?: boolean;
  twoFactorToken?: string;
};

/** 网络层失败（超时/断连）时返回的哨兵错误码——调用方据此走"重试"而非"登出"。 */
export const ACCOUNT_NETWORK_ERROR = "__network__";

// 切换网络（WiFi↔流量）后浏览器可能复用已死的旧连接，无超时的 fetch 会挂起
// 几十秒以上，页面卡在"正在校验账号"。统一加超时。
async function fetchWithTimeout(input: RequestInfo, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    window.clearTimeout(timer);
  }
}

export async function fetchCurrentAccount(): Promise<AccountResponse> {
  let response: Response;
  try {
    response = await fetchWithTimeout("/api/auth/me", {
      method: "GET",
      credentials: "include",
      cache: "no-store",
    }, 30000);
  } catch {
    return { ok: false, account: null, error: ACCOUNT_NETWORK_ERROR };
  }
  const data = await response.json().catch(() => ({})) as AccountResponse;
  if (!response.ok) return { ok: false, account: null, error: response.status >= 500 ? ACCOUNT_NETWORK_ERROR : data.error || "账号状态读取失败。" };
  return { ok: true, account: data.account ?? null };
}

export async function loginAccount(input: {
  username: string;
  password: string;
  emailCode?: string;
  method?: "code" | "password";
  mode?: "login" | "register";
  invitationCode?: string;
  twoFactorToken?: string;
  twoFactorCode?: string;
}): Promise<AccountResponse> {
  const response = await fetchWithTimeout("/api/auth/login", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  }, 45000);
  const data = await response.json().catch(() => ({})) as AccountResponse;
  if (data.requiresTwoFactor && data.twoFactorToken) return { ok: false, requiresTwoFactor: true, twoFactorToken: data.twoFactorToken };
  if (!response.ok || !data.ok) return { ok: false, account: null, error: data.error || "登录失败。" };
  return { ok: true, account: data.account ?? null };
}

export async function changeAccountPassword(input: {
  oldPassword: string;
  newPassword: string;
}): Promise<{ ok: boolean; error?: string; reauthenticate?: boolean }> {
  const response = await fetch("/api/auth/change-password", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  }).catch(() => null);
  if (!response) return { ok: false, error: "网络异常，请稍后再试。" };
  const data = await response.json().catch(() => ({})) as { ok?: boolean; error?: string; reauthenticate?: boolean };
  if (!response.ok || !data.ok) return { ok: false, error: data.error || "修改失败。" };
  return { ok: true, reauthenticate: data.reauthenticate };
}

export async function logoutAccount(): Promise<{ ok: boolean; error?: string; remoteRevoked?: boolean }> {
  // 确认服务端已退出后清除账号标识，让桥凭据等按账号缓存失效。
  const response = await fetchWithTimeout("/api/auth/logout", {
    method: "POST",
    credentials: "include",
  }, 30000).catch(() => null);
  if (!response) return { ok: false, error: "无法退出账号，请检查网络后重试。" };
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) return { ok: false, error: data.error || "退出失败，请稍后重试。" };
  saveActiveAccountId("");
  return { ok: true, remoteRevoked: data.remoteRevoked };
}
