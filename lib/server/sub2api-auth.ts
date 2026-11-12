import "server-only";

import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import type { AccountAuthConfig } from "../account-auth-types";
import { ACCOUNT_GATE_COOKIE, ACCOUNT_SESSION_COOKIE } from "../account-cookie-constants";
import { createAccountGateCookieValue } from "../account-gate-cookie";
import { applyLowReasoning } from "../llm-reasoning.mjs";
import type { AppAccount } from "./account-auth";
import { getLoginClientIp, loginLockedMinutes, recordLoginFailure } from "./login-rate-limit";
import {
  assertSub2ApiSessionSecret, deleteSub2ApiSession, newSub2ApiSessionId,
  readSub2ApiSession, withSub2ApiSessionLock, writeSub2ApiSession, type Sub2ApiSession,
} from "./sub2api-session-store";

const MAX_SESSION_SECONDS = 30 * 24 * 60 * 60;
const JSON_HEADERS = { "Cache-Control": "no-store" };
type JsonRecord = Record<string, unknown>;

export class Sub2ApiAuthError extends Error {
  constructor(message: string, readonly status = 503) { super(message); }
}

export function isSub2ApiAuthEnabled(): boolean {
  return process.env.ACCOUNT_AUTH_PROVIDER?.trim().toLowerCase() === "sub2api";
}

function baseUrl(): string {
  let url: URL;
  try { url = new URL(process.env.SUB2API_BASE_URL || ""); }
  catch { throw new Sub2ApiAuthError("请配置账号服务 SUB2API_BASE_URL。"); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash
    || !["/", "/api/v1", "/api/v1/"].includes(url.pathname)) {
    throw new Sub2ApiAuthError("账号服务必须使用 HTTPS 根地址，且不能包含凭据或查询参数。");
  }
  return url.origin;
}

function providerId(): string { return createHash("sha256").update(baseUrl()).digest("hex").slice(0, 16); }
function publicApiBaseUrl(): string {
  return `${baseUrl()}/v1`;
}
function record(value: unknown): JsonRecord { return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {}; }
function text(value: unknown, max = 254): string { return typeof value === "string" ? value.trim().slice(0, max) : ""; }
function cookie(request: Request): string {
  const value = request.headers.get("cookie")?.split(";").map(item => item.trim()).find(item => item.startsWith(`${ACCOUNT_SESSION_COOKIE}=`));
  try { return value ? decodeURIComponent(value.slice(ACCOUNT_SESSION_COOKIE.length + 1)) : ""; } catch { return ""; }
}

async function upstream(endpoint: string, options: { method?: string; body?: JsonRecord; token?: string; idempotencyKey?: string } = {}): Promise<JsonRecord> {
  const origin = baseUrl();
  let response: Response;
  let payload: JsonRecord;
  try {
    response = await fetch(`${origin}/api/v1${endpoint}`, {
      method: options.method || "GET", cache: "no-store", redirect: "error", signal: AbortSignal.timeout(10000),
      headers: { Accept: "application/json", "Accept-Language": "zh-CN", ...(options.body ? { "Content-Type": "application/json" } : {}), ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}), ...(options.idempotencyKey ? { "Idempotency-Key": options.idempotencyKey } : {}) },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    });
    // Bound public settings and upstream error responses as well as token responses.
    const reader = response.body?.getReader();
    if (!reader) throw new Error("empty response");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        size += item.value.byteLength;
        if (size > 1024 * 1024) { await reader.cancel(); throw new Error("response too large"); }
        chunks.push(item.value);
      }
    } finally { reader.releaseLock(); }
    payload = record(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  } catch { throw new Sub2ApiAuthError("无法连接账号服务，请稍后重试。"); }
  if (!response.ok || (typeof payload.code === "number" && payload.code !== 0)) {
    const code = text(payload.reason || payload.error_code || payload.code, 100);
    const message = text(payload.message, 300);
    let error = "账号服务未接受请求，请检查填写内容或稍后重试。";
    if (response.status === 401) error = "邮箱、密码或验证信息不正确，或登录已失效。";
    if (/REGISTRATION_DISABLED|registration.*disabled/i.test(`${code} ${message}`)) error = "服务器暂未开放注册，请使用已有账号登录。";
    else if (/EMAIL_EXISTS|EMAIL_ALREADY|already.*registered|already.*exists/i.test(`${code} ${message}`)) error = "该邮箱已注册，请直接登录。";
    else if (/INVITATION/i.test(`${code} ${message}`)) error = "邀请码无效、已使用或未填写。";
    else if (/VERIFY_CODE|verification code|2FA|TOTP/i.test(`${code} ${message}`)) error = "验证码无效或已过期，请重新获取或重试。";
    else if (/CAPTCHA|TURNSTILE/i.test(`${code} ${message}`)) error = "服务器要求安全验证，请在账号中心处理。";
    else if (/OLD_PASSWORD|CURRENT_PASSWORD|current password/i.test(`${code} ${message}`)) error = "当前密码不正确。";
    else if (/USER_NOT_ACTIVE|disabled|inactive/i.test(`${code} ${message}`)) error = "账号已停用，请联系管理员。";
    if (response.status === 429) error = "账号请求过于频繁，请稍后再试。";
    if (response.status >= 500) error = "账号服务暂时不可用，请稍后重试。";
    throw new Sub2ApiAuthError(error, response.status >= 400 && response.status <= 599 ? response.status : 400);
  }
  return record(payload.data);
}

export async function getSub2ApiPublicConfig(): Promise<AccountAuthConfig> {
  assertSub2ApiSessionSecret();
  const settings = await upstream("/settings/public");
  return {
    provider: "sub2api", registrationEnabled: settings.registration_enabled === true,
    emailVerificationRequired: settings.email_verify_enabled === true,
    passwordRequired: true, codeLoginEnabled: false, invitationRequired: settings.invitation_code_enabled === true,
    emailSuffixWhitelist: Array.isArray(settings.registration_email_suffix_whitelist) ? settings.registration_email_suffix_whitelist.filter((item): item is string => typeof item === "string").slice(0, 100) : [],
    // Do not silently skip a gateway's captcha or account agreement.
    requiresAccountCenter: [settings.turnstile_enabled, settings.tencent_captcha_enabled, settings.aliyun_captcha_enabled, settings.login_agreement_enabled].some(value => value === true),
    accountCenterUrl: `${baseUrl()}/login`,
  };
}

function requireEmbeddedAuth(config: AccountAuthConfig): void {
  if (config.requiresAccountCenter) throw new Sub2ApiAuthError("账号服务启用了额外安全验证或协议确认，请在账号中心处理。", 409);
}

function toAccount(user: JsonRecord): AppAccount {
  const id = typeof user.id === "number" && Number.isSafeInteger(user.id) && user.id > 0 ? String(user.id) : "";
  const email = text(user.email).toLowerCase();
  if (!id || !email) throw new Sub2ApiAuthError("账号服务返回的用户资料不完整。", 502);
  if (user.status !== "active") throw new Sub2ApiAuthError("账号已停用，请联系管理员。", 403);
  return {
    id: `sub2api_${providerId()}_${id}`, username: email,
    displayName: text(user.username, 80) || email, status: "active",
    createdAt: text(user.created_at, 80) || undefined, updatedAt: text(user.updated_at, 80) || undefined,
  };
}

function tokenExpiry(data: JsonRecord): number {
  const seconds = Number(data.expires_in);
  if (Number.isFinite(seconds) && seconds > 0) return Date.now() + Math.min(seconds, MAX_SESSION_SECONDS) * 1000;
  // JWT claims are used only for refresh timing. /auth/me remains the authority.
  try {
    const claims = JSON.parse(Buffer.from(String(data.access_token).split(".")[1], "base64url").toString("utf8"));
    if (Number.isFinite(claims.exp)) return Math.min(claims.exp * 1000, Date.now() + MAX_SESSION_SECONDS * 1000);
  } catch { /* Opaque token: schedule an early refresh. */ }
  return Date.now() + 5 * 60 * 1000;
}

function tokens(data: JsonRecord): { accessToken: string; refreshToken: string; accessExpiresAt: number } {
  const accessToken = text(data.access_token, 8193);
  const refreshToken = text(data.refresh_token, 4097);
  if (!accessToken || accessToken.length > 8192 || refreshToken.length > 4096) throw new Sub2ApiAuthError("账号服务未返回有效会话。", 502);
  return { accessToken, refreshToken, accessExpiresAt: tokenExpiry(data) };
}

async function freshSession(id: string, failedAccessToken?: string): Promise<Sub2ApiSession | null> {
  let session = await readSub2ApiSession(id);
  if (!session || session.provider !== providerId()) return null;
  if (session.accessExpiresAt > Date.now() + 30000 && (!failedAccessToken || session.accessToken !== failedAccessToken)) return session;
  return withSub2ApiSessionLock(id, async () => {
    session = await readSub2ApiSession(id);
    if (!session || session.provider !== providerId()) return null;
    if (session.accessExpiresAt > Date.now() + 30000 && (!failedAccessToken || session.accessToken !== failedAccessToken)) return session;
    if (!session.refreshToken) {
      if (!failedAccessToken && session.accessExpiresAt > Date.now()) return session;
      await deleteSub2ApiSession(id); return null;
    }
    try {
      const renewed = tokens(await upstream("/auth/refresh", { method: "POST", body: { refresh_token: session.refreshToken } }));
      // Keep the original absolute session lifetime; never create an immortal cookie.
      const next = { ...session, ...renewed, refreshToken: renewed.refreshToken || session.refreshToken };
      await writeSub2ApiSession(id, next);
      return next;
    } catch (error) {
      if (error instanceof Sub2ApiAuthError && [400, 401, 403].includes(error.status)) { await deleteSub2ApiSession(id); return null; }
      throw error;
    }
  });
}

async function verifiedSession(request: Request, allowUnbound = false): Promise<{ id: string; session: Sub2ApiSession; account: AppAccount } | null> {
  const bind = (account: AppAccount) => {
    if (!allowUnbound && request.headers.get("x-account-id") !== account.id) throw new Sub2ApiAuthError("账户已切换，请重新打开页面。", 409);
    return account;
  };
  const id = cookie(request);
  let session = await freshSession(id);
  if (!session) return null;
  try {
    const account = bind(toAccount(await upstream("/auth/me", { token: session.accessToken })));
    return { id, session, account };
  } catch (error) {
    if (!(error instanceof Sub2ApiAuthError) || error.status !== 401) throw error;
  }
  session = await freshSession(id, session.accessToken);
  if (!session) return null;
  try { return { id, session, account: bind(toAccount(await upstream("/auth/me", { token: session.accessToken }))) }; }
  catch (error) {
    if (error instanceof Sub2ApiAuthError && [401, 403].includes(error.status)) {
      await withSub2ApiSessionLock(id, () => deleteSub2ApiSession(id)); return null;
    }
    throw error;
  }
}

export async function getSub2ApiAccount(request: Request, allowUnbound = false): Promise<AppAccount | null> {
  try { return (await verifiedSession(request, allowUnbound))?.account || null; }
  catch (error) { if (error instanceof Sub2ApiAuthError && [401, 403].includes(error.status)) return null; throw error; }
}

function cookieOptions(request: Request, maxAge: number) {
  const url = new URL(request.url);
  const localRuntime = process.env.XUNXIN_LOCAL_RUNTIME === "1" && ["localhost", "127.0.0.1"].includes(url.hostname);
  return { httpOnly: true, sameSite: "lax" as const, secure: url.protocol === "https:" || (process.env.NODE_ENV === "production" && !localRuntime), path: "/", maxAge };
}

async function setSessionCookies(response: NextResponse, request: Request, id: string, expiresAt: number): Promise<void> {
  const maxAge = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
  response.cookies.set(ACCOUNT_SESSION_COOKIE, id, cookieOptions(request, maxAge));
  response.cookies.set(ACCOUNT_GATE_COOKIE, await createAccountGateCookieValue(id, maxAge), cookieOptions(request, maxAge));
}

function clearSessionCookies(response: NextResponse, request: Request): NextResponse {
  response.cookies.set(ACCOUNT_SESSION_COOKIE, "", cookieOptions(request, 0));
  response.cookies.set(ACCOUNT_GATE_COOKIE, "", cookieOptions(request, 0));
  return response;
}

function requireSameOrigin(request: Request): void {
  // Custom Next.js servers can construct request.url using their bind address
  // (0.0.0.0), rather than the browser's hostname. Use the direct Host header;
  // proxy deployments should configure an explicit public origin instead.
  const url = new URL(request.url);
  let target: string;
  try {
    const configured = process.env.ACCOUNT_APP_ORIGIN?.trim();
    const candidate = new URL(configured || `${url.protocol}//${request.headers.get("host") || url.host}`);
    if (candidate.username || candidate.password || !["http:", "https:"].includes(candidate.protocol)) throw new Error("invalid origin");
    target = candidate.origin;
  } catch { throw new Sub2ApiAuthError("应用来源配置不正确。", 503); }
  const origin = request.headers.get("origin");
  const referer = request.headers.get("referer");
  let source: string | null = origin;
  if (!source && referer) {
    try { source = new URL(referer).origin; } catch { source = "invalid"; }
  }
  const changesState = !["GET", "HEAD", "OPTIONS"].includes(request.method);
  if ((source && source !== target) || request.headers.get("sec-fetch-site") === "cross-site" || (changesState && !source)) {
    throw new Sub2ApiAuthError("请求来源不匹配，请从应用内重试。", 403);
  }
}

async function body(request: Request): Promise<JsonRecord> {
  requireSameOrigin(request);
  if (!request.headers.get("content-type")?.startsWith("application/json")) throw new Sub2ApiAuthError("请求格式不正确。", 400);
  const raw = await request.text();
  if (raw.length > 16384) throw new Sub2ApiAuthError("请求内容过长。", 413);
  try { return record(JSON.parse(raw)); } catch { throw new Sub2ApiAuthError("请求格式不正确。", 400); }
}

export function sub2ApiErrorResponse(error: unknown): NextResponse {
  return NextResponse.json({ ok: false, error: error instanceof Sub2ApiAuthError ? error.message : "账号服务暂时不可用，请稍后重试。" }, { status: error instanceof Sub2ApiAuthError ? error.status : 503, headers: JSON_HEADERS });
}

export async function loginSub2Api(request: Request): Promise<NextResponse> {
  try {
    assertSub2ApiSessionSecret();
    const input = await body(request);
    const ip = getLoginClientIp(request);
    const locked = loginLockedMinutes(ip);
    if (locked) throw new Sub2ApiAuthError(`失败次数过多，请约 ${locked} 分钟后再试。`, 429);
    const config = await getSub2ApiPublicConfig();
    requireEmbeddedAuth(config);
    let result: JsonRecord;
    const tempToken = text(input.twoFactorToken, 1025);
    if (tempToken) {
      if (tempToken.length > 1024 || !/^\d{6}$/.test(text(input.twoFactorCode))) throw new Sub2ApiAuthError("请输入 6 位身份验证器验证码。", 400);
      result = await upstream("/auth/login/2fa", { method: "POST", body: { temp_token: tempToken, totp_code: text(input.twoFactorCode) } });
    } else {
      const registering = input.mode === "register";
      const email = text(input.username, 255).toLowerCase();
      // Preserve the password exactly, including deliberate leading/trailing spaces.
      const password = typeof input.password === "string" ? input.password : "";
      if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Sub2ApiAuthError("请输入有效的邮箱地址。", 400);
      if (!password || password.length > 120 || (registering && password.length < 6)) throw new Sub2ApiAuthError(registering ? "请设置 6 至 120 位密码。" : "请输入密码（最多 120 位）。", 400);
      if (registering && !config.registrationEnabled) throw new Sub2ApiAuthError("服务器暂未开放注册，请使用已有账号登录。", 403);
      if (!registering && input.method === "code") throw new Sub2ApiAuthError("此账号服务使用邮箱和密码登录。", 400);
      const code = text(input.emailCode, 20);
      if (registering && config.emailVerificationRequired && !/^\d{6}$/.test(code)) throw new Sub2ApiAuthError("请输入 6 位邮箱验证码。", 400);
      const invitation = text(input.invitationCode, 200);
      if (registering && config.invitationRequired && !invitation) throw new Sub2ApiAuthError("请填写邀请码。", 400);
      result = await upstream(registering ? "/auth/register" : "/auth/login", { method: "POST", body: { email, password, ...(registering ? { verify_code: code, invitation_code: invitation } : {}) } });
    }
    if (result.requires_2fa === true) {
      const token = text(result.temp_token, 1025);
      if (!token || token.length > 1024) throw new Sub2ApiAuthError("身份验证会话无效，请重新登录。", 502);
      return NextResponse.json({ ok: false, requiresTwoFactor: true, twoFactorToken: token }, { headers: JSON_HEADERS });
    }
    const pair = tokens(result);
    const account = toAccount(await upstream("/auth/me", { token: pair.accessToken }));
    const expiresAt = pair.refreshToken ? Date.now() + MAX_SESSION_SECONDS * 1000 : pair.accessExpiresAt;
    const id = newSub2ApiSessionId();
    await writeSub2ApiSession(id, { ...pair, expiresAt, provider: providerId() });
    const response = NextResponse.json({ ok: true, account }, { headers: JSON_HEADERS });
    await setSessionCookies(response, request, id, expiresAt);
    return response;
  } catch (error) {
    if (error instanceof Sub2ApiAuthError && [400, 401].includes(error.status)) recordLoginFailure(getLoginClientIp(request));
    return sub2ApiErrorResponse(error);
  }
}

export async function meSub2Api(request: Request): Promise<NextResponse> {
  try {
    const current = await verifiedSession(request, true);
    const response = NextResponse.json({ ok: true, account: current?.account || null }, { headers: JSON_HEADERS });
    if (current) await setSessionCookies(response, request, current.id, current.session.expiresAt);
    else clearSessionCookies(response, request);
    return response;
  } catch (error) {
    const response = sub2ApiErrorResponse(error);
    return error instanceof Sub2ApiAuthError && [401, 403].includes(error.status) ? clearSessionCookies(response, request) : response;
  }
}

export async function logoutSub2Api(request: Request): Promise<NextResponse> {
  try {
    requireSameOrigin(request);
    await verifiedSession(request);
    const id = cookie(request);
    let remoteRevoked = true;
    if (/^s2a_[A-Za-z0-9_-]{43}$/.test(id)) await withSub2ApiSessionLock(id, async () => {
      const session = await readSub2ApiSession(id);
      await deleteSub2ApiSession(id);
      if (session?.provider === providerId() && session.refreshToken) {
        try { await upstream("/auth/logout", { method: "POST", body: { refresh_token: session.refreshToken } }); }
        catch { remoteRevoked = false; }
      }
    });
    return clearSessionCookies(NextResponse.json({ ok: true, remoteRevoked }, { headers: JSON_HEADERS }), request);
  } catch (error) { return sub2ApiErrorResponse(error); }
}

export async function sendSub2ApiCode(request: Request): Promise<NextResponse> {
  try {
    const input = await body(request);
    const config = await getSub2ApiPublicConfig();
    requireEmbeddedAuth(config);
    if (input.purpose !== "register" || !config.registrationEnabled || !config.emailVerificationRequired) throw new Sub2ApiAuthError("当前账号服务不需要或不支持此邮箱验证码。", 400);
    const email = text(input.email, 255).toLowerCase();
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Sub2ApiAuthError("请输入有效的邮箱地址。", 400);
    const result = await upstream("/auth/send-verify-code", { method: "POST", body: { email } });
    return NextResponse.json({ ok: true, countdown: Number(result.countdown) || 60 }, { headers: JSON_HEADERS });
  } catch (error) { return sub2ApiErrorResponse(error); }
}

export async function changeSub2ApiPassword(request: Request): Promise<NextResponse> {
  try {
    const input = await body(request);
    const current = await verifiedSession(request);
    if (!current) throw new Sub2ApiAuthError("登录已失效，请重新登录。", 401);
    const oldPassword = typeof input.oldPassword === "string" ? input.oldPassword : "";
    const newPassword = typeof input.newPassword === "string" ? input.newPassword : "";
    if (!oldPassword || oldPassword.length > 120 || newPassword.length < 6 || newPassword.length > 120 || oldPassword === newPassword) throw new Sub2ApiAuthError("请填写当前密码和 6 至 120 位不同的新密码。", 400);
    await withSub2ApiSessionLock(current.id, async () => {
      const session = await readSub2ApiSession(current.id);
      if (!session) throw new Sub2ApiAuthError("登录已失效，请重新登录。", 401);
      await upstream("/user/password", { method: "PUT", token: session.accessToken, body: { old_password: oldPassword, new_password: newPassword } });
      await deleteSub2ApiSession(current.id);
    });
    return clearSessionCookies(NextResponse.json({ ok: true, reauthenticate: true }, { headers: JSON_HEADERS }), request);
  } catch (error) { return sub2ApiErrorResponse(error); }
}

export async function accountCredentialSub2Api(request: Request, reset: boolean): Promise<NextResponse> {
  try {
    requireSameOrigin(request);
    const current = await verifiedSession(request);
    if (!current) throw new Sub2ApiAuthError("登录已失效，请重新登录。", 401);
    if (request.headers.get("x-account-id") !== current.account.id) throw new Sub2ApiAuthError("账户已切换，请重新打开账户凭证。", 409);
    let idempotencyKey: string | undefined;
    if (reset) {
      const input = await body(request);
      idempotencyKey = text(input.idempotencyKey, 129);
      if (!/^[A-Za-z0-9_-]{16,128}$/.test(idempotencyKey)) throw new Sub2ApiAuthError("重置请求标识无效。", 400);
    }
    const key = await upstream(reset ? "/user/credential/reset" : "/user/credential", {
      token: current.session.accessToken, ...(reset ? { method: "POST", body: {}, idempotencyKey } : {}),
    });
    const secret = text(key.key, 128);
    if (!key.id) throw new Sub2ApiAuthError("云端调用凭证尚未就绪，请稍后重试。", 503);
    return NextResponse.json({ ok: true, credential: {
      key: secret, balance: Number(record(key.user).balance) || 0, status: key.status, groupId: key.group_id,
      apiBaseUrl: publicApiBaseUrl(), accountCenterUrl: baseUrl(),
    } }, { headers: JSON_HEADERS });
  } catch (error) { return sub2ApiErrorResponse(error); }
}

export async function accountGroupsSub2Api(request: Request): Promise<NextResponse> {
  try {
    const input = request.method === "POST" ? await body(request) : null;
    requireSameOrigin(request);
    const current = await verifiedSession(request);
    if (!current) throw new Sub2ApiAuthError("登录已失效，请重新登录。", 401);
    if (request.headers.get("x-account-id") !== current.account.id) throw new Sub2ApiAuthError("账户已切换，请重新打开账户凭证。", 409);
    if (input) {
      const groupId = input.groupId;
      if (typeof groupId !== "number" || !Number.isSafeInteger(groupId) || groupId <= 0) throw new Sub2ApiAuthError("请选择有效分组。", 400);
      const key = await upstream("/user/credential", { token: current.session.accessToken });
      if (typeof key.id !== "number" || !Number.isSafeInteger(key.id) || key.id <= 0) throw new Sub2ApiAuthError("账户凭证不可用。", 503);
      await upstream(`/keys/${key.id}`, { method: "PUT", token: current.session.accessToken, body: { group_id: groupId } });
      return NextResponse.json({ ok: true }, { headers: JSON_HEADERS });
    }
    const response = await fetch(`${baseUrl()}/api/v1/groups/available`, { cache: "no-store", redirect: "error", signal: AbortSignal.timeout(10000), headers: { Authorization: `Bearer ${current.session.accessToken}`, Accept: "application/json", "Accept-Language": "zh-CN" } });
    if (!response.ok) throw new Sub2ApiAuthError("无法读取可用分组，请稍后重试。", response.status);
    const payload = record(await response.json());
    if (payload.code !== 0 || !Array.isArray(payload.data)) throw new Sub2ApiAuthError("无法读取可用分组，请稍后重试。", 502);
    const groups = payload.data.map(record).filter(group => typeof group.id === "number" && Number.isSafeInteger(group.id) && group.id > 0).map(group => ({ id: group.id, name: text(group.name, 100), platform: text(group.platform, 40) }));
    return NextResponse.json({ ok: true, groups }, { headers: JSON_HEADERS });
  } catch (error) { return sub2ApiErrorResponse(error); }
}

export async function accountInvitationSub2Api(request: Request): Promise<NextResponse> {
  try {
    requireSameOrigin(request);
    const current = await verifiedSession(request);
    if (!current) throw new Sub2ApiAuthError("登录已失效，请重新登录。", 401);
    if (request.headers.get("x-account-id") !== current.account.id) throw new Sub2ApiAuthError("账户已切换，请重新打开设置。", 409);
    const detail = await upstream("/user/aff", { token: current.session.accessToken });
    const code = text(detail.aff_code, 128);
    if (!code) throw new Sub2ApiAuthError("邀请码暂不可用，请稍后重试。", 503);
    const count = Number(detail.aff_count);
    return NextResponse.json({ ok: true, code, inviteUrl: `${baseUrl()}/register?aff=${encodeURIComponent(code)}`, count: Number.isSafeInteger(count) && count >= 0 ? count : 0 }, { headers: JSON_HEADERS });
  } catch (error) { return sub2ApiErrorResponse(error); }
}

async function cloudDefaultModel(origin: string, accessToken: string, embedding: boolean, signal: AbortSignal): Promise<string> {
  const response = await fetch(`${origin}/api/v1/user/managed-gateway/v1/models`, {
    cache: "no-store", redirect: "error", signal,
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
  });
  if (!response.ok) throw new Sub2ApiAuthError("无法读取账户可用模型，请在账户凭证中选择模型。", response.status);
  const payload = record(await response.json());
  const models = (Array.isArray(payload.data) ? payload.data : []).map(value => text(record(value).id, 254)).filter(Boolean);
  const suitable = models.filter(model => embedding ? /embed|bge-|m3e|text2vec|\be5\b|\bgte\b/i.test(model) : !/embed|bge-|m3e|text2vec|\be5\b|\bgte\b|dall-e|image|tts|whisper|transcri|sora|video|moderation/i.test(model));
  const preferred = embedding ? [] : ["gemini-3.8-flash", "gpt-5.4", "gpt-5.2", "gpt-4.1", "gpt-4o"];
  const selected = preferred.find(model => suitable.includes(model)) || suitable[0];
  if (!selected) throw new Sub2ApiAuthError(embedding ? "账户当前没有可用的向量模型。" : "账户当前没有可用的聊天模型，请联系管理员。", 503);
  return selected;
}

async function cloudRequestBody(request: Request): Promise<JsonRecord> {
  if (!request.headers.get("content-type")?.startsWith("application/json")) throw new Sub2ApiAuthError("请求格式不正确。", 400);
  const reader = request.body?.getReader();
  if (!reader) throw new Sub2ApiAuthError("请求内容为空。", 400);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 32 * 1024 * 1024) { await reader.cancel(); throw new Sub2ApiAuthError("请求内容超过 32MB。", 413); }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  try { return record(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
  catch { throw new Sub2ApiAuthError("请求 JSON 格式不正确。", 400); }
}

// The target origin and routes are fixed by the server. Client URLs, credentials,
// forwarding headers, and model-service keys are never accepted from the caller.
export async function proxySub2ApiModel(request: Request, path: string): Promise<Response> {
  try {
    requireSameOrigin(request);
    const permitted = request.method === "GET" ? ["/v1/models", "/v1/usage", "/v1/sub2api/billing"]
      : ["/v1/chat/completions", "/v1/responses", "/v1/embeddings", "/v1/messages", "/v1/images/generations"];
    if (!permitted.includes(path)) throw new Sub2ApiAuthError("不支持此云端接口。", 404);
    const current = await verifiedSession(request);
    if (!current) throw new Sub2ApiAuthError("登录已失效，请重新登录。", 401);
    if (request.headers.get("authorization") !== `Bearer account-session:${current.account.id}`) {
      throw new Sub2ApiAuthError("账户已切换，请重新打开当前页面。", 409);
    }
    // The remote gateway resolves the managed key after authenticating the
    // account; the key is never delivered to this device or its browser.
    const accessToken = current.session.accessToken;
    const origin = baseUrl();
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(300000)]);
    const payload = request.method === "POST" ? await cloudRequestBody(request) : undefined;
    if (payload && (!payload.model || payload.model === "__account_default__")) {
      payload.model = await cloudDefaultModel(origin, accessToken, path === "/v1/embeddings", signal);
    }
    if (payload) {
      if (path === "/v1/chat/completions") applyLowReasoning(payload, "openai-compatible", payload.model);
      else if (path === "/v1/responses") applyLowReasoning(payload, "responses", payload.model);
      else if (path === "/v1/messages") applyLowReasoning(payload, "anthropic", payload.model);
    }
    const response = await fetch(`${origin}/api/v1/user/managed-gateway${path}`, {
      method: request.method, redirect: "error", cache: "no-store", signal,
      headers: { Authorization: `Bearer ${accessToken}`, Accept: request.headers.get("accept") || "application/json", ...(payload ? { "Content-Type": "application/json" } : {}) },
      ...(payload ? { body: JSON.stringify(payload) } : {}),
    });
    if (!response.ok) {
      // Do not relay upstream error bodies that might echo sensitive headers.
      const message = response.status === 401 ? "调用凭证已更新，请重新发送。"
        : response.status === 403 ? "余额不足或当前模型未授权，请查看账户余额和账户凭证。"
        : response.status === 429 ? "账户额度或调用频率已达上限，请稍后重试。"
        : response.status === 404 ? "当前账户不支持这个模型或接口，请在账户凭证中更换模型。"
        : "云端模型暂时不可用，请稍后重试。";
      await response.body?.cancel();
      return NextResponse.json({ error: { message } }, { status: response.status, headers: JSON_HEADERS });
    }
    return new Response(response.body, { status: response.status, headers: {
      "Content-Type": response.headers.get("content-type") || "application/json",
      "Cache-Control": "no-store", "X-Accel-Buffering": "no",
      ...(path === "/v1/embeddings" && typeof payload?.model === "string" ? { "X-Embedding-Model": payload.model } : {}),
    } });
  } catch (error) {
    const message = error instanceof Sub2ApiAuthError ? error.message : "无法连接云端模型，请稍后重试。";
    return NextResponse.json({ error: { message } }, { status: error instanceof Sub2ApiAuthError ? error.status : 503, headers: JSON_HEADERS });
  }
}

// Billing endpoints are tied to the verified account, never a client-supplied user ID.
export async function redeemSub2Api(request: Request): Promise<NextResponse> {
  try {
    const input = await body(request);
    const current = await verifiedSession(request);
    if (!current) throw new Sub2ApiAuthError("登录已失效，请重新登录。", 401);
    if (request.headers.get("x-account-id") !== current.account.id) throw new Sub2ApiAuthError("账户已切换，请重新打开兑换码页面。", 409);
    const code = text(input.code, 257);
    if (!code || code.length > 256) throw new Sub2ApiAuthError("请输入有效的兑换码。", 400);
    await upstream("/redeem", { method: "POST", token: current.session.accessToken, body: { code } });
    return NextResponse.json({ ok: true }, { headers: JSON_HEADERS });
  } catch (error) { return sub2ApiErrorResponse(error); }
}

export async function billingSub2Api(request: Request): Promise<NextResponse> {
  try {
    requireSameOrigin(request);
    const current = await verifiedSession(request);
    if (!current) throw new Sub2ApiAuthError("登录已失效，请重新登录。", 401);
    if (request.headers.get("x-account-id") !== current.account.id) throw new Sub2ApiAuthError("账户已切换，请重新打开充值中心。", 409);
    const [profile, stats, modelStats] = await Promise.all([
      upstream("/auth/me", { token: current.session.accessToken }),
      upstream("/usage/dashboard/stats", { token: current.session.accessToken }).catch(() => null),
      upstream("/usage/dashboard/models?start_date=2000-01-01", { token: current.session.accessToken }).catch(() => null),
    ]);
    const numberOrNull = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : null;
    const models = modelStats && Array.isArray(modelStats.models)
      ? modelStats.models.map(value => {
        const row = record(value);
        return { model: text(row.model, 254), input: numberOrNull(row.input_tokens), output: numberOrNull(row.output_tokens),
          cacheRead: numberOrNull(row.cache_read_tokens), cacheWrite: numberOrNull(row.cache_creation_tokens) };
      }).filter(row => row.model) : null;
    return NextResponse.json({ ok: true, balance: numberOrNull(profile.balance), accountCenterUrl: baseUrl(), models,
      totalCost: numberOrNull(stats?.total_actual_cost), input: numberOrNull(stats?.total_input_tokens),
      output: numberOrNull(stats?.total_output_tokens), cacheRead: numberOrNull(stats?.total_cache_read_tokens),
      cacheWrite: numberOrNull(stats?.total_cache_creation_tokens), totalTokens: numberOrNull(stats?.total_tokens),
    }, { headers: JSON_HEADERS });
  } catch (error) { return sub2ApiErrorResponse(error); }
}
