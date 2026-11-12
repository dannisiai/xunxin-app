"use client";

import { useEffect, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from "react";
import { Loader2, ArrowRight, Eye, EyeOff, X } from "lucide-react";

import { AccountProvider } from "@/lib/account-context";
import { ACCOUNT_NETWORK_ERROR, fetchCurrentAccount, loginAccount, logoutAccount, saveActiveAccountId, type AccountProfile } from "@/lib/account-client";
import { isSelfHostedModeEnabled } from "@/lib/self-hosting";
import { SplashAnimation } from "@/components/splash-animation";
import { useDialogFocus } from "@/components/ui/use-dialog-focus";
import type { AccountAuthConfig } from "@/lib/account-auth-types";
import { reconcileDocumentAccount } from "@/lib/account-storage";

type AccountGateProps = {
  children: ReactNode;
  onBack?: () => void;
  showEntryForm?: boolean;
};

type GateStatus = "checking" | "ready" | "signed-out" | "unreachable";

const SELF_HOSTED_ACCOUNT: AccountProfile = {
  id: "local_user",
  username: "local_user",
  displayName: "本地用户",
  status: "active",
};

// 内联兜底：弱网/离线下 SW 可能回退到旧 HTML，外链 CSS 拉不到（旧 hash 已 404），
// 此时全页无样式，「正在校验账号」会裸排在左上角。内联样式不依赖外部 CSS，保证居中。
const gateRootFallbackStyle: CSSProperties = {
  minHeight: "100vh",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};

const gatePanelFallbackStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: 14,
  textAlign: "center",
};

function AccountEntryFrame({ children, onBack, busy }: { children: ReactNode; onBack?: () => void; busy: boolean }) {
  const dialogRef = useRef<HTMLElement>(null);
  useDialogFocus(dialogRef, () => { if (!busy) onBack?.(); });
  return <main data-adaptive-surface="content" className="app-root splash-root">
    <section className="phone-shell-wrap splash-shell-wrap" aria-label="寻信">
      <div className="phone-case"><div className="phone-frame"><div className="phone-shell splash-phone-screen">
        <SplashAnimation />
        <div data-adaptive-surface="overlay" className="xunxin-auth-backdrop" onClick={() => { if (!busy) onBack?.(); }}>
          <section ref={dialogRef} tabIndex={-1} data-adaptive-surface="card" className="xunxin-auth-card" role="dialog" aria-modal="true" aria-labelledby="xunxin-auth-title" onClick={event => event.stopPropagation()}>
            {onBack && <button type="button" className="xunxin-auth-close" onClick={onBack} disabled={busy} aria-label="返回启动页"><X size={19} /></button>}
            {children}
          </section>
        </div>
      </div></div></div>
    </section>
  </main>;
}

export function AccountGate({ children, onBack, showEntryForm = false }: AccountGateProps) {
  const selfHostedMode = isSelfHostedModeEnabled();
  const [status, setStatus] = useState<GateStatus>(selfHostedMode ? (showEntryForm ? "signed-out" : "ready") : "checking");
  const [account, setAccount] = useState<AccountProfile | null>(selfHostedMode && !showEntryForm ? SELF_HOSTED_ACCOUNT : null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [emailCode, setEmailCode] = useState("");
  const [loginMethod, setLoginMethod] = useState<"code" | "password">("code");
  const [sendingCode, setSendingCode] = useState(false);
  const [notice, setNotice] = useState("");
  const [mode, setMode] = useState<"register" | "login">("register");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [authConfig, setAuthConfig] = useState<AccountAuthConfig | null>(null);
  const [configError, setConfigError] = useState("");
  const [configAttempt, setConfigAttempt] = useState(0);
  const [invitationCode, setInvitationCode] = useState("");
  const [twoFactorToken, setTwoFactorToken] = useState("");
  const [twoFactorCode, setTwoFactorCode] = useState("");
  const [codeCountdown, setCodeCountdown] = useState(0);
  const cloudProvider = authConfig?.provider === "sub2api";
  const formUnavailable = !authConfig || authConfig.requiresAccountCenter || (mode === "register" && !authConfig.registrationEnabled);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 15000);
    setConfigError("");
    void fetch("/api/auth/config", { cache: "no-store", signal: controller.signal }).then(async response => {
      const result = await response.json();
      if (!response.ok || !result.ok || !result.config) throw new Error(result.error || "无法读取账号服务设置。");
      if (controller.signal.aborted) return;
      const config = result.config as AccountAuthConfig;
      setAuthConfig(config);
      if (!config.codeLoginEnabled) setLoginMethod("password");
      if (!config.registrationEnabled) setMode("login");
    }).catch(() => { if (!controller.signal.aborted) setConfigError("无法读取账号服务设置，请重试。"); })
      .finally(() => window.clearTimeout(timer));
    const onTimeout = () => setConfigError("读取账号服务设置超时，请重试。");
    controller.signal.addEventListener("abort", onTimeout);
    return () => { controller.signal.removeEventListener("abort", onTimeout); controller.abort(); window.clearTimeout(timer); };
  }, [configAttempt]);

  useEffect(() => {
    if (codeCountdown <= 0) return;
    const timer = window.setTimeout(() => setCodeCountdown(value => Math.max(0, value - 1)), 1000);
    return () => window.clearTimeout(timer);
  }, [codeCountdown]);

  async function refreshAccount() {
    if (selfHostedMode && (!showEntryForm || account?.id === SELF_HOSTED_ACCOUNT.id)) {
      if (!await reconcileDocumentAccount(SELF_HOSTED_ACCOUNT.id)) return;
      setAccount(SELF_HOSTED_ACCOUNT);
      saveActiveAccountId(SELF_HOSTED_ACCOUNT.id);
      setStatus("ready");
      setError("");
      return;
    }

    let result: Awaited<ReturnType<typeof fetchCurrentAccount>>;
    try {
      result = await fetchCurrentAccount();
    } catch {
      result = { ok: false, account: null, error: ACCOUNT_NETWORK_ERROR };
    }
    if (result.ok && result.account) {
      if (!await reconcileDocumentAccount(result.account.id)) return;
      setAccount(result.account);
      // 按账号隔离的本地缓存据此判定归属，账号一解析出来就落一份
      saveActiveAccountId(result.account.id);
      setStatus("ready");
      setError("");
      return;
    }
    // 网络层失败（超时/断连/切网）：会话 cookie 还在，不应登出——给重试入口
    if (result.error === ACCOUNT_NETWORK_ERROR) {
      setStatus("unreachable");
      return;
    }
    if (!await reconcileDocumentAccount("")) return;
    setAccount(null);
    saveActiveAccountId("");
    setStatus("signed-out");
    if (result.error && !/账号状态读取失败/.test(result.error)) setError(result.error);
  }

  useEffect(() => {
    if (selfHostedMode) {
      // The startup arrow shows the account form even when cloud accounts are optional.
      // Local use is an explicit choice; it never pretends to register a cloud account.
      if (showEntryForm) return;
      setAccount(SELF_HOSTED_ACCOUNT);
      saveActiveAccountId(SELF_HOSTED_ACCOUNT.id);
      setStatus("ready");
      setError("");
      return;
    }

    void refreshAccount();
    // 网络恢复（含 WiFi↔流量切换完成）时自动重试校验
    const onOnline = () => {
      setStatus(current => {
        if (current === "checking" || current === "unreachable") {
          void refreshAccount();
        }
        return current;
      });
    };
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selfHostedMode, showEntryForm]);

  async function enterLocalAccount() {
    if (!selfHostedMode || busy || sendingCode) return;
    if (!await reconcileDocumentAccount(SELF_HOSTED_ACCOUNT.id)) return;
    setAccount(SELF_HOSTED_ACCOUNT);
    saveActiveAccountId(SELF_HOSTED_ACCOUNT.id);
    setStatus("ready");
    setPassword("");
    setEmailCode("");
    setError("");
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || formUnavailable) return;
    setBusy(true);
    setError("");
    try {
      const result = await loginAccount({
        username,
        password,
        mode,
        emailCode: emailCode.trim(),
        method: cloudProvider ? "password" : mode === "register" ? "code" : loginMethod,
        invitationCode,
        twoFactorToken,
        twoFactorCode,
      });
      if (result.requiresTwoFactor && result.twoFactorToken) {
        setTwoFactorToken(result.twoFactorToken);
        setTwoFactorCode("");
        setPassword("");
        setNotice("请输入身份验证器中的 6 位验证码完成登录。");
        return;
      }
      if (!result.ok || !result.account) {
        setError(result.error || "登录失败。");
        return;
      }
      if (!await reconcileDocumentAccount(result.account.id)) return;
      setAccount(result.account);
      saveActiveAccountId(result.account.id);
      setStatus("ready");
      setPassword("");
      setEmailCode("");
      setTwoFactorToken("");
      setTwoFactorCode("");
    } catch {
      setError("无法连接账号服务，请检查网络后重试。");
    } finally {
      setBusy(false);
    }
  }

  async function handleSendCode() {
    if (sendingCode || codeCountdown > 0 || formUnavailable) return;
    setError("");
    setNotice("");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(username.trim())) {
      setError("请先填写有效的邮箱地址。");
      return;
    }
    setSendingCode(true);
    try {
      const response = await fetch("/api/auth/email-code", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: username, purpose: mode }), signal: AbortSignal.timeout(30000) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) setError(data.error || "发送失败，请稍后重试。");
      else { setNotice("验证码请求已提交，请检查邮箱并及时填写。"); setCodeCountdown(Math.max(1, Math.min(600, Number(data.countdown) || 60))); }
    } catch { setError("无法连接账号服务，请检查网络后重试。"); }
    finally { setSendingCode(false); }
  }

  async function handleLogout() {
    if (selfHostedMode && !showEntryForm) {
      setAccount(SELF_HOSTED_ACCOUNT);
      saveActiveAccountId(SELF_HOSTED_ACCOUNT.id);
      setStatus("ready");
      return;
    }

    if (!selfHostedMode || account?.id !== SELF_HOSTED_ACCOUNT.id) {
      const result = await logoutAccount();
      if (!result.ok) throw new Error(result.error || "退出失败，请稍后重试。");
      setNotice(result.remoteRevoked === false ? "本机已退出；服务器暂时不可达，远端会话未能撤销。" : "");
    }
    if (!await reconcileDocumentAccount("")) return;
    setAccount(null);
    saveActiveAccountId("");
    setStatus("signed-out");
    setPassword("");
    setEmailCode("");
    setTwoFactorToken("");
    setTwoFactorCode("");
  }

  function selectMode(next: "register" | "login") {
    setMode(next); setError(""); setNotice(""); setEmailCode("");
    setPassword(""); setShowPassword(false); setTwoFactorToken(""); setTwoFactorCode("");
  }

  if (status === "unreachable") {
    return (
      <main data-adaptive-surface="content" className="app-root account-gate-root" style={gateRootFallbackStyle}>
        <section className="account-gate-card account-gate-loading" style={gatePanelFallbackStyle}>
          <span>网络连接不畅，账号校验失败</span>
          <button
            type="button"
            className="account-gate-retry-btn"
            onClick={() => { setStatus("checking"); void refreshAccount(); }}
          >
            重试
          </button>
        </section>
      </main>
    );
  }

  if (status === "checking") {
    return (
      <main data-adaptive-surface="content" className="app-root account-gate-root" style={gateRootFallbackStyle}>
        <section className="account-gate-panel" aria-live="polite" style={gatePanelFallbackStyle}>
          <Loader2 className="account-gate-spinner" size={24} />
          <span>正在校验账号...</span>
        </section>
      </main>
    );
  }

  if (status === "ready" && account) {
    return (
      <AccountProvider account={account} refreshAccount={refreshAccount} logout={handleLogout}>
        {children}
      </AccountProvider>
    );
  }

  return (
    <AccountEntryFrame onBack={onBack} busy={busy || sendingCode}>
              <div className="xunxin-auth-eyebrow">XUNXIN · A LETTER FOR YOU</div>
              <h1 id="xunxin-auth-title">{mode === "register" ? "开启寻信" : "欢迎回来"}</h1>
              <div className="xunxin-auth-tabs" aria-label="选择登录或注册">
                <button type="button" disabled={busy || sendingCode || !authConfig} aria-pressed={mode === "register"} onClick={() => selectMode("register")}>注册</button>
                <button type="button" disabled={busy || sendingCode || !authConfig} aria-pressed={mode === "login"} onClick={() => selectMode("login")}>登录</button>
              </div>
              {!authConfig && !configError && <p className="xunxin-auth-subtitle" role="status">正在连接账号服务…</p>}
              {configError && <div className="xunxin-auth-error" role="alert">{configError}<button type="button" className="account-gate-retry-btn" onClick={() => setConfigAttempt(value => value + 1)}>重试</button></div>}
              {authConfig?.requiresAccountCenter && <p className="xunxin-auth-error">账号服务要求额外安全验证或协议确认，当前窗口暂不支持。<a href={authConfig.accountCenterUrl} target="_blank" rel="noopener noreferrer">打开账号中心</a></p>}
              <form className="xunxin-auth-form" onSubmit={handleSubmit} aria-busy={busy}>
                {!twoFactorToken && <>
                  {mode === "login" && authConfig && <><div className="xunxin-auth-method"><button type="button" disabled={busy || !authConfig.codeLoginEnabled} title={!authConfig.codeLoginEnabled ? "当前账号服务暂不支持验证码登录" : undefined} aria-pressed={loginMethod === "code"} onClick={() => { setLoginMethod("code"); setError(""); }}>验证码登录</button><span className="xunxin-auth-method-divider" aria-hidden="true" /><button type="button" disabled={busy} aria-pressed={loginMethod === "password"} onClick={() => { setLoginMethod("password"); setError(""); }}>密码登录</button></div></>}
                  <label>{cloudProvider || mode === "register" ? "邮箱" : "邮箱或已有账号"}<input disabled={formUnavailable || busy} type={cloudProvider || mode === "register" ? "email" : "text"} required maxLength={254} value={username} onChange={event => setUsername(event.target.value)} autoComplete="username" placeholder="请输入邮箱" /></label>
                  {((mode === "register" && authConfig?.emailVerificationRequired) || (mode === "login" && loginMethod === "code" && authConfig?.codeLoginEnabled)) && <label>邮箱验证码<span className="xunxin-code-row"><input disabled={formUnavailable || busy} required inputMode="numeric" pattern="[0-9]{6}" maxLength={6} value={emailCode} onChange={event => setEmailCode(event.target.value)} autoComplete="one-time-code" placeholder="6 位验证码" /><button type="button" disabled={sendingCode || codeCountdown > 0 || formUnavailable || busy} onClick={() => void handleSendCode()}>{sendingCode ? "发送中…" : codeCountdown > 0 ? `${codeCountdown} 秒后重试` : "获取验证码"}</button></span></label>}
                  {(mode === "register" || loginMethod === "password") && <label>{mode === "register" ? "设置密码" : "密码"}<span className="xunxin-password-field"><input disabled={formUnavailable || busy} required type={showPassword ? "text" : "password"} minLength={mode === "login" && cloudProvider ? 1 : 6} maxLength={120} value={password} onChange={event => setPassword(event.target.value)} autoComplete={mode === "register" ? "new-password" : "current-password"} placeholder={mode === "register" ? "请设置至少 6 位密码" : "请输入密码"} /><button type="button" className="xunxin-password-toggle" aria-label={showPassword ? "隐藏密码" : "显示密码"} aria-pressed={showPassword} disabled={formUnavailable || busy} onClick={() => setShowPassword(value => !value)}>{showPassword ? <EyeOff size={18} /> : <Eye size={18} />}</button></span></label>}
                  {mode === "register" && cloudProvider && <label>{authConfig?.invitationRequired ? "邀请码" : "邀请码（可选）"}<input disabled={formUnavailable || busy} required={authConfig?.invitationRequired} value={invitationCode} maxLength={200} onChange={event => setInvitationCode(event.target.value)} autoComplete="off" placeholder="请输入邀请码" /></label>}
                </>}
                {twoFactorToken && <label>身份验证器验证码<input required disabled={busy} inputMode="numeric" pattern="[0-9]{6}" maxLength={6} value={twoFactorCode} onChange={event => setTwoFactorCode(event.target.value)} autoComplete="one-time-code" placeholder="6 位动态验证码" /></label>}
                {notice && <div className="xunxin-auth-notice" role="status">{notice}</div>}
                {error && <div className="xunxin-auth-error" role="alert">{error}</div>}
                <button className="xunxin-auth-submit" type="submit" disabled={busy || sendingCode || formUnavailable}>{busy ? <Loader2 size={17} className="account-gate-spinner" /> : <>{twoFactorToken ? "验证并进入" : mode === "register" ? "注册并进入" : "登录并进入"}<ArrowRight size={17} /></>}</button>
              </form>
              {selfHostedMode && showEntryForm && !cloudProvider && <div className="xunxin-auth-local">
                <button type="button" onClick={enterLocalAccount} disabled={busy || sendingCode}>继续本地使用</button>
                <p>本地使用不会创建云端账号。</p>
              </div>}
    </AccountEntryFrame>
  );
}
