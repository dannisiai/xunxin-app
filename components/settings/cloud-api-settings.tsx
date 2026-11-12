"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw, KeyRound } from "lucide-react";
import { useAccount } from "@/lib/account-context";
import { cloudAccountConfig, CLOUD_DEFAULT_MODEL, saveCloudAccountModel } from "@/lib/cloud-account";
import { ConfirmDialog } from "@/components/ui/modal";
import { Select } from "@/components/ui/form";
import { CloudVoiceSettings } from "./cloud-voice-settings";

type Credential = {
    key: string; balance: number; status: string; apiBaseUrl: string; groupId: number | null;
};

export function CloudApiSettings() {
    const { account } = useAccount();
    const [credential, setCredential] = useState<Credential | null>(null);
    const [models, setModels] = useState<string[]>([]);
    const [groups, setGroups] = useState<{ id: number; name: string; platform: string }[]>([]);
    const [groupBusy, setGroupBusy] = useState(false);
    const [model, setModel] = useState(() => cloudAccountConfig(account.id)?.defaultModel || CLOUD_DEFAULT_MODEL);
    const [loading, setLoading] = useState(false);
    const [resetting, setResetting] = useState(false);
    const [confirmReset, setConfirmReset] = useState(false);
    const [notice, setNotice] = useState("");
    const [error, setError] = useState("");
    const resettingRef = useRef(false);
    const resetRequest = useRef<string | null>(null);

    const load = useCallback(async (signal?: AbortSignal) => {
        setLoading(true);
        setError("");
        try {
            const response = await fetch("/api/auth/credential", { cache: "no-store", credentials: "include", signal, headers: { "X-Account-Id": account.id } });
            const data = await response.json();
            if (!response.ok || !data.ok) throw new Error(data.error || "无法读取账户凭证。");
            setCredential(data.credential);
            const groupResponse = await fetch("/api/account/groups", { cache: "no-store", signal, headers: { "X-Account-Id": account.id } });
            const groupData = await groupResponse.json();
            if (!groupResponse.ok || !groupData.ok) throw new Error(groupData.error || "无法读取可用分组。");
            const availableGroups = (groupData.groups || []) as { id: number; name: string; platform: string }[];
            setGroups(availableGroups);
            const geminiGroup = availableGroups.find(g => g.name.toLowerCase() === "gemini" || /gemini/i.test(g.name) || g.platform.toLowerCase() === "gemini");
            if (!data.credential.groupId && geminiGroup) {
                void changeGroup(geminiGroup.id);
                return;
            }
            const config = cloudAccountConfig(account.id);
            setModels([]);
            if (config && data.credential.balance > 0) {
                const modelResponse = await fetch("/api/cloud/v1/models", {
                    cache: "no-store", signal, headers: { Authorization: `Bearer ${config.apiKey}` },
                });
                const result = await modelResponse.json();
                if (!modelResponse.ok || !Array.isArray(result.data)) throw new Error(result.error?.message || "无法读取当前分组的模型，请刷新重试。");
                setModels(result.data.map((item: { id: string }) => item.id).filter(Boolean));
            }
        } catch (cause) {
            if (!signal?.aborted) setError(cause instanceof Error ? cause.message : "读取失败，请稍后重试。");
        } finally { if (!signal?.aborted) setLoading(false); }
    }, [account.id]);

    useEffect(() => {
        const controller = new AbortController();
        void load(controller.signal);
        return () => controller.abort();
    }, [load]);

    async function changeGroup(groupId: number) {
        if (groupBusy || !groupId) return;
        setGroupBusy(true); setError(""); setNotice("");
        try {
            const response = await fetch("/api/account/groups", { method: "POST", credentials: "include", headers: { "Content-Type": "application/json", "X-Account-Id": account.id }, body: JSON.stringify({ groupId }) });
            const data = await response.json();
            if (!response.ok || !data.ok) throw new Error(data.error || "切换分组失败。");
            setModels([]); setModel(CLOUD_DEFAULT_MODEL); saveCloudAccountModel(CLOUD_DEFAULT_MODEL);
            await load();
            setNotice("分组已切换，默认模型为 gemini-3.8-flash。");
        } catch (cause) { setError(cause instanceof Error ? cause.message : "切换分组失败。"); }
        finally { setGroupBusy(false); }
    }

    async function reset() {
        if (resettingRef.current) return;
        resettingRef.current = true;
        setConfirmReset(false);
        setResetting(true);
        setError("");
        setNotice("");
        resetRequest.current ||= crypto.randomUUID();
        try {
            const response = await fetch("/api/auth/credential", {
                method: "POST", credentials: "include", headers: { "Content-Type": "application/json", "X-Account-Id": account.id },
                body: JSON.stringify({ idempotencyKey: resetRequest.current }),
            });
            const data = await response.json();
            if (!response.ok || !data.ok) throw new Error(data.error || "重置失败，请重试。");
            setCredential(data.credential);
            resetRequest.current = null;
            setNotice("凭证已重置，旧密钥已失效。应用会自动使用新凭证。");
        } catch (cause) { setError(cause instanceof Error ? cause.message : "重置失败，请重试。"); }
        finally { resettingRef.current = false; setResetting(false); }
    }

    const geminiGroup = groups.find(g => g.name.toLowerCase() === "gemini" || /gemini/i.test(g.name) || g.platform.toLowerCase() === "gemini");
    const activeGroupId = credential?.groupId ?? geminiGroup?.id ?? (groups[0]?.id ?? "");

    return <div className="flex flex-col gap-5">
        <div className="flex items-center justify-between gap-3">
            <h2 className="m-0 ts-24 font-bold">模型与凭证</h2>
            <button type="button" className="ui-btn ui-btn-ghost" disabled={loading || resetting} onClick={() => void load()} aria-label="刷新模型和账户凭证">
                <RefreshCw size={18} className={loading ? "animate-spin" : ""} />
            </button>
        </div>
        {credential && credential.balance <= 0 && <p role="status" className="text-sm">余额不足，请使用兑换码或联系管理员充值。</p>}
        <div className="ui-config-card flex flex-col gap-4 p-5">
            <div className="flex items-center gap-2 font-semibold"><KeyRound size={18} /> 统一调用凭证</div>
            {credential && <>
                <span
                    className="menu-desc break-all"
                    style={{ userSelect: "none", WebkitUserSelect: "none" }}
                    onCopy={event => event.preventDefault()}
                    onCut={event => event.preventDefault()}
                    onContextMenu={event => event.preventDefault()}
                >API 密钥：{credential.key || "由服务端安全托管，应用会自动使用"}</span>
                <span
                    className="menu-desc break-all"
                    style={{ userSelect: "none", WebkitUserSelect: "none" }}
                    onCopy={event => event.preventDefault()}
                    onCut={event => event.preventDefault()}
                    onContextMenu={event => event.preventDefault()}
                >API 地址：{credential.apiBaseUrl}</span>
                <div className="flex flex-wrap gap-2">
                    <button type="button" className="ui-btn ui-btn-primary" disabled={resetting || loading} onClick={() => setConfirmReset(true)}>{resetting ? "正在重置…" : "重置凭证"}</button>
                </div>
            </>}
            <p className="menu-desc">重置后旧密钥失效；余额和历史用量会保留。</p>
        </div>
        <label className="flex flex-col gap-2">
            <span className="font-semibold">分组</span>
            <Select value={activeGroupId} disabled={loading || resetting || groupBusy} onChange={event => void changeGroup(Number(event.target.value))}>
                {credential?.groupId && !groups.some(group => group.id === credential.groupId) && <option value={credential.groupId}>当前分组</option>}
                {groups.map(group => <option key={group.id} value={group.id}>{group.name || group.platform}</option>)}
            </Select>
        </label>
        <label className="flex flex-col gap-2">
            <span className="font-semibold">选择模型</span>
            <Select value={model} disabled={!activeGroupId || loading || groupBusy} onChange={event => { setModel(event.target.value); saveCloudAccountModel(event.target.value); }}>
                <option value={CLOUD_DEFAULT_MODEL}>自动选择账户可用模型（默认 gemini-3.8-flash）</option>
                {model !== CLOUD_DEFAULT_MODEL && !models.includes(model) && <option value={model}>{model}</option>}
                {models.map(name => <option key={name} value={name}>{name}</option>)}
            </Select>
            {credential && credential.balance <= 0 && <span className="menu-desc">余额充足后可读取当前分组的模型。</span>}
        </label>
        <CloudVoiceSettings key={account.id} accountId={account.id} />
        {notice && <p role="status" className="text-sm">{notice}</p>}
        {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
        {confirmReset && <ConfirmDialog title="重置账户凭证？" message="旧凭证将失效，应用会自动使用新凭证。余额和历史用量不变。" confirmLabel="重置凭证" onConfirm={() => void reset()} onCancel={() => setConfirmReset(false)} />}
    </div>;
}
