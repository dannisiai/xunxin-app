"use client";
import { useCallback, useEffect, useState } from "react";
import { ArrowDownLeft, ArrowUpRight, Database, RefreshCw } from "lucide-react";

type ModelUsage = { model: string; input: number | null; output: number | null; cacheRead: number | null; cacheWrite: number | null };
type Billing = { balance: number | null; totalCost: number | null; models: ModelUsage[] | null; input: number | null; output: number | null; cacheRead: number | null; cacheWrite: number | null; totalTokens: number | null; accountCenterUrl?: string };
const count = (value: number) => value.toLocaleString("zh-CN");
// Match the Sub2API account center's USD-to-CNY display conversion.
const CNY_PER_USD = 6.684;
const money = (value: number) => `¥${(value * CNY_PER_USD).toFixed(6)}`;

export function RechargeCenter({ accountId }: { accountId: string }) {
  const [data, setData] = useState<Billing | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true); setError("");
    try {
      const response = await fetch("/api/account/billing", { cache: "no-store", headers: { "X-Account-Id": accountId }, signal });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || "读取失败，请重试。");
      setData(result);
    } catch (e) { if (!signal?.aborted) { setData(null); setError(e instanceof Error ? e.message : "读取失败，请重试。"); } }
    finally { if (!signal?.aborted) setLoading(false); }
  }, [accountId]);
  useEffect(() => { const controller = new AbortController(); void load(controller.signal); return () => controller.abort(); }, [load]);
  return <div className="flex flex-col gap-4">
    <div className="ui-config-card flex flex-col gap-3 p-5">
      <div className="flex items-center justify-between"><span className="menu-desc">账户余额</span><button type="button" className="ui-btn ui-btn-ghost" onClick={() => void load()} disabled={loading} aria-label="刷新余额和记录"><RefreshCw size={17} /></button></div>
      <div className="grid grid-cols-2 gap-4">
        <div className="flex flex-col gap-1"><strong className="ts-28">{data?.balance != null ? `¥${(data.balance * CNY_PER_USD).toFixed(4)}` : "—"}</strong><span className="menu-desc">当前余额</span></div>
        <div className="flex flex-col gap-1"><strong className="ts-24">{data?.totalCost != null ? money(data.totalCost) : "—"}</strong><span className="menu-desc">累计消费</span></div>
      </div>
    </div>
    {error && <p role="alert" className="text-sm" style={{ color: "var(--c-danger)" }}>{error}</p>}
    <section className="ui-config-card flex flex-col gap-4 p-5" aria-label="Token 用量汇总">
      <strong>Token 用量汇总</strong>
      {loading && !data && <span className="menu-desc">正在读取…</span>}
      {data?.models && data.models.length === 0 && <span className="menu-desc">暂无模型使用记录</span>}
      {data?.models?.map(item => <div key={item.model} className="flex flex-col gap-3 border-t border-black/10 pt-4">
        <strong className="break-all">{item.model}</strong>
        <div className="grid grid-cols-2 gap-3 text-sm">
          <span className="flex items-center gap-2"><ArrowDownLeft size={16} aria-hidden="true" />输入 {item.input != null ? count(item.input) : "—"}</span>
          <span className="flex items-center gap-2"><ArrowUpRight size={16} aria-hidden="true" />输出 {item.output != null ? count(item.output) : "—"}</span>
          <span className="flex items-center gap-2"><Database size={16} aria-hidden="true" />缓存 {item.cacheRead != null ? count(item.cacheRead) : "—"}</span>
        </div>
      </div>)}
      {!loading && data && data.models == null && <span className="menu-desc">模型用量暂时无法读取，请刷新重试。</span>}
      <div className="flex items-center justify-between gap-3 border-t border-black/10 pt-4"><strong>总消耗 Token</strong><strong>{data?.totalTokens != null ? count(data.totalTokens) : "—"}</strong></div>
    </section>
  </div>;
}
