"use client";

import { useState } from "react";
import { RefreshCw, List, FileEdit, AlertCircle } from "lucide-react";
import { Input } from "@/components/ui/form";
import type { VoiceApiConfig } from "@/lib/settings-types";
import { MiniCPMVoiceFields } from "./minicpm-voice-fields";
import { isMiniCPMVoiceConfig } from "@/lib/voice-mode";
import { Alert } from "@/components/ui/feedback";
import { isDashscopeTts } from "@/lib/dashscope-tts";

export function VoiceProviderFields({ config, onChange, onFetch, onCancel, fetching, message, error }: {
    config: VoiceApiConfig; onChange: (patch: Partial<VoiceApiConfig>) => void;
    onFetch: () => void; onCancel: () => void; fetching: boolean; message?: string; error?: string;
}) {
    const [manualModelInput, setManualModelInput] = useState(false);

    if (isMiniCPMVoiceConfig(config)) {
        return <MiniCPMVoiceFields key={config.id} config={config} onChange={onChange} />;
    }
    const known = ["OpenAI", "Custom", "Minimax"].includes(config.provider);
    if (!known) {
        return <p className="menu-desc">{config.provider ? "此服务商暂不支持，请选择支持的服务商。" : "请先在上方选择服务商。"}</p>;
    }
    const compatible = config.provider === "OpenAI" || config.provider === "Custom";
    const defaults: Record<string, string> = {
        OpenAI: "https://api.openai.com/v1",
        Custom: "https://your-service.example/v1",
    };

    const cachedModels = config.catalog?.models || [];
    const cachedVoices = config.catalog?.voices || [];

    return <>
        {config.provider !== "Minimax" && (
            <div className="flex flex-col gap-1">
                <label className="menu-desc ml-1">接口地址 (Base URL)</label>
                <Input
                    type="url"
                    value={config.baseUrl || ""}
                    placeholder={defaults[config.provider]}
                    onChange={event => onChange({ baseUrl: event.target.value })}
                />
            </div>
        )}
        {compatible && (
            <div className="flex flex-col gap-1">
                <div className="flex items-center justify-between">
                    <label className="menu-desc ml-1">语音模型 (TTS Model)</label>
                    <button
                        type="button"
                        onClick={fetching ? onCancel : onFetch}
                        className="inline-flex items-center gap-1 text-[11px] text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors py-0.5 px-1.5 rounded hover:bg-[var(--bg-muted)]"
                        title={fetching ? "停止拉取" : "自动从服务商拉取可用模型列表"}
                    >
                        <RefreshCw size={12} className={fetching ? "animate-spin" : ""} />
                        <span>{fetching ? "停止拉取" : "自动拉取模型"}</span>
                    </button>
                </div>

                {cachedModels.length > 0 && !manualModelInput ? (
                    <div className="flex gap-2">
                        <select
                            value={config.model || ""}
                            onChange={e => {
                                if (e.target.value === "__manual__") {
                                    setManualModelInput(true);
                                } else {
                                    onChange({ model: e.target.value });
                                }
                            }}
                            className="ui-select flex-1"
                        >
                            <option value="">请选择已拉取的模型 ({cachedModels.length} 个)...</option>
                            {config.model && !cachedModels.some(model => model.id === config.model) &&
                                <option value={config.model}>{config.model}</option>}
                            {cachedModels.map(m => (
                                <option key={m.id} value={m.id}>{m.name || m.id}</option>
                            ))}
                            <option value="__manual__">手动输入模型 ID...</option>
                        </select>
                        <button
                            type="button"
                            onClick={() => setManualModelInput(true)}
                            className="ui-icon-btn"
                            title="切换为手动输入"
                        >
                            <FileEdit size={18} />
                        </button>
                    </div>
                ) : (
                    <div className="flex gap-2">
                        <Input
                            type="text"
                            value={config.model || ""}
                            placeholder="例如: qwen3-tts-flash 或 tts-1"
                            onChange={event => onChange({ model: event.target.value })}
                            className="flex-1"
                        />
                        {cachedModels.length > 0 && (
                            <button
                                type="button"
                                onClick={() => setManualModelInput(false)}
                                className="ui-icon-btn"
                                title="切换为模型列表选择"
                            >
                                <List size={18} />
                            </button>
                        )}
                    </div>
                )}
                {message && <p className="menu-desc whitespace-pre-line" role="status">{message}</p>}
                {error && (
                    <Alert variant="danger">
                        <AlertCircle size={14} />
                        <span>{error}</span>
                    </Alert>
                )}
            </div>
        )}
        {compatible && (!config.referenceAudio || isDashscopeTts(config)) && (
            <div className="flex flex-col gap-1">
                <label className="menu-desc ml-1" htmlFor={`voice-id-${config.id}`}>音色 ID（可选）</label>
                <Input id={`voice-id-${config.id}`} value={config.defaultVoice || ""}
                    list={cachedVoices.length ? `voice-options-${config.id}` : undefined}
                    placeholder="按服务商要求填写，留空使用默认值"
                    onChange={event => onChange({ defaultVoice: event.target.value })} />
                {!!cachedVoices.length && <datalist id={`voice-options-${config.id}`}>
                    {cachedVoices.map(voice => <option key={voice.id} value={voice.id}>{voice.name}</option>)}
                </datalist>}
            </div>
        )}
    </>;
}

