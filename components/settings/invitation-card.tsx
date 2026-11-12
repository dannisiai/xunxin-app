"use client";

import { useEffect, useState } from "react";
import { Gift } from "lucide-react";

type Invitation = { code: string; inviteUrl: string; count: number };

export function InvitationCard({ accountId }: { accountId: string }) {
  const [data, setData] = useState<Invitation | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    setData(null); setError(""); setNotice("");
    void (async () => {
      try {
        const response = await fetch("/api/account/invitation", { credentials: "include", headers: { "X-Account-Id": accountId }, signal: controller.signal });
        const result = await response.json();
        if (!response.ok || !result.ok) throw new Error(result.error || "邀请码加载失败，请稍后重试。");
        if (!controller.signal.aborted) setData(result);
      } catch (err) {
        if (!controller.signal.aborted) setError(err instanceof Error ? err.message : "邀请码加载失败，请稍后重试。");
      }
    })();
    return () => controller.abort();
  }, [accountId, attempt]);

  async function copy(value: string, label: string) {
    try { await navigator.clipboard.writeText(value); setNotice(`${label}已复制`); }
    catch { setNotice("复制失败，请手动选择复制"); }
  }

  return <section className="app-card display-refresh-card" aria-labelledby="invitation-title">
    <div className="display-refresh-heading"><Gift size={24} aria-hidden="true" /><div><h3 id="invitation-title">邀请码</h3><p>邀请好友注册 · 已邀请 {data ? data.count : "—"} 人</p></div></div>
    {data ? <>
      <div className="flex flex-wrap items-center gap-2"><span>我的邀请码：</span><strong className="select-text break-all">{data.code}</strong><button type="button" className="ui-btn ui-btn-secondary" onClick={() => void copy(data.code, "邀请码")}>复制邀请码</button></div>
      <div className="flex flex-wrap items-center gap-2"><span className="select-text break-all text-sm">{data.inviteUrl}</span><button type="button" className="ui-btn ui-btn-secondary" onClick={() => void copy(data.inviteUrl, "邀请链接")}>复制邀请链接</button></div>
    </> : error ? <div role="alert">{error} <button type="button" className="ui-btn ui-btn-secondary" onClick={() => setAttempt(value => value + 1)}>重试</button></div> : <p>正在加载邀请码…</p>}
    {notice && <p role="status">{notice}</p>}
  </section>;
}
