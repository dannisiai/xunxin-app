"use client";
import { useEffect, useRef, useState } from "react";
import type { VoiceApiConfig } from "@/lib/settings-types";
import { readMiniCPMReference } from "@/lib/minicpm-pcm";
import { isAndroidVoiceShell } from "@/lib/reference-audio";
import { Input } from "@/components/ui/form";

export function MiniCPMVoiceFields({ config, onChange, showConnectionFields = true }: { config: VoiceApiConfig; onChange: (patch: Partial<VoiceApiConfig>) => void; showConnectionFields?: boolean }) {
    const [busy, setBusy] = useState(false), [error, setError] = useState("");
    const version = useRef(0);
    useEffect(() => () => { version.current++; }, []);
    return <div className="flex flex-col gap-3">
        {showConnectionFields && <>
        <label className="menu-desc">接口地址（必填）</label>
        <Input type="url" required value={config.miniCPMGatewayUrl || ""} placeholder="wss://你的网关/v1/realtime"
            onChange={event => onChange({ miniCPMGatewayUrl: event.target.value })} />
        <label className="menu-desc">API Key / Token（可选）</label>
        <Input type="password" autoComplete="off" value={config.apiKey || ""} placeholder="如果网关需要鉴权，请输入密钥或 Token..."
            onChange={event => onChange({ apiKey: event.target.value })} />
        <p className="menu-desc">MiniCPM 使用你填写的兼容网关地址。</p>
        <p className="menu-desc">使用 MiniCPM 语音合成功能朗读文字；由聊天 API 生成通话回复。</p>
        <p className="menu-desc">模型由你的网关加载，不使用 OpenAI 的模型名称、Voice ID 或 /models 接口。官方协议没有通用 API Key 字段，需要鉴权的网关应提供可直接连接的已授权 WS(S) 地址。</p>
        </>}
        <label className="menu-desc">参考音色（可选，不超过 10 秒、8 MB）</label>
        <input type="file" accept={isAndroidVoiceShell() ? undefined : "audio/*,.wav"} disabled={busy} className="ui-input" onChange={async event => {
            const file = event.target.files?.[0]; event.target.value = "";
            if (!file) return;
            const request = ++version.current; setBusy(true); setError("");
            try {
                const pcm = await readMiniCPMReference(file);
                if (request === version.current) onChange({ miniCPMReferencePcm: pcm, miniCPMReferenceName: file.name });
            } catch (failure) {
                if (request === version.current) setError(failure instanceof Error ? failure.message : "参考音频读取失败");
            } finally { if (request === version.current) setBusy(false); }
        }} />
        {busy && <p className="menu-desc" role="status">正在读取参考音频…</p>}
        {config.miniCPMReferencePcm && <div className="flex items-center gap-2">
            <span className="menu-desc">{config.miniCPMReferenceName || "已保存参考音色"}</span>
            <button type="button" className="ui-link-btn" onClick={() => {
                version.current++; setBusy(false);
                onChange({ miniCPMReferencePcm: undefined, miniCPMReferenceName: undefined });
            }}>移除参考音色</button>
        </div>}
        <p className="menu-desc">参考音频随配置保存在本机，连接或试听时发送给你填写的网关；不填写时使用网关的默认音色。</p>
        {error && <p className="menu-desc" role="alert">{error}</p>}
    </div>;
}
