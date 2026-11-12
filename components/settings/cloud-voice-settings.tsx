"use client";

import { useEffect, useState } from "react";
import {
    CLOUD_VOICE_UPDATED_EVENT, loadCloudVoiceSettings, saveCloudVoiceDefaultConfig, saveCloudVoiceEnabled,
} from "@/lib/cloud-voice";
import { Select, Toggle } from "@/components/ui/form";
import { VoiceSettings } from "./voice-settings";

export function CloudVoiceSettings({ accountId }: { accountId: string }) {
    const [settings, setSettings] = useState(() => loadCloudVoiceSettings(accountId));

    useEffect(() => {
        const refresh = () => setSettings(loadCloudVoiceSettings(accountId));
        refresh();
        window.addEventListener(CLOUD_VOICE_UPDATED_EVENT, refresh);
        return () => window.removeEventListener(CLOUD_VOICE_UPDATED_EVENT, refresh);
    }, [accountId]);

    return <section className="flex flex-col gap-4 border-t border-black/10 pt-5" aria-label="语音模型">
        <div className="flex items-center justify-between gap-4">
            <div className="flex min-w-0 flex-col gap-1">
                <h3 className="m-0 font-semibold">语音模型</h3>
                <p className="menu-desc">{settings.enabled ? "配置语音服务、模型和音色，用于通话和回复播报。" : "默认关闭，开启后可配置语音模型。"}</p>
            </div>
            <Toggle checked={settings.enabled} aria-label="启用语音模型" onChange={enabled => saveCloudVoiceEnabled(enabled, accountId)} />
        </div>
        {settings.enabled && <div className="flex min-w-0 flex-col gap-5">
            {settings.configs.length > 0 && <label className="flex flex-col gap-2">
                <span className="font-semibold">使用的语音方案</span>
                <Select value={settings.defaultConfigId} onChange={event => saveCloudVoiceDefaultConfig(event.target.value, accountId)}>
                    {settings.configs.map(config => <option key={config.id} value={config.id}>{config.name || config.model || config.provider || "新语音配置"}</option>)}
                </Select>
            </label>}
            <VoiceSettings key={accountId} embedded accountId={accountId} />
        </div>}
    </section>;
}
