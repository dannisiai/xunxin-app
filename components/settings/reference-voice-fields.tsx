"use client";

import { useEffect, useRef, useState } from "react";
import { Input } from "@/components/ui/form";
import { isAndroidVoiceShell, readReferenceAudio, REFERENCE_AUDIO_ACCEPT } from "@/lib/reference-audio";
import type { VoiceApiConfig } from "@/lib/settings-types";
import { isDashscopeTts } from "@/lib/dashscope-tts";
import { requiresQwenReference } from "@/lib/qwen-tts";

export function ReferenceVoiceFields({ config, onChange, onBusy }: {
    config: VoiceApiConfig;
    onChange: (patch: Partial<VoiceApiConfig>) => void;
    onBusy: (busy: boolean) => void;
}) {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const read = useRef(0);
    useEffect(() => () => { read.current++; onBusy(false); }, [onBusy]);

    if (isDashscopeTts(config)) return <div className="flex flex-col gap-2 text-xs">
        <p className="menu-desc m-0">此接口使用服务商音色 ID。克隆音色需先在 DashScope 创建，再将音色 ID 填在上方。</p>
        {config.referenceAudio && <>
            <p className="menu-desc m-0">已保存的参考音频不能直接用于此接口，请移除后试听，或改用支持参考音频的自定义接口。</p>
            <button type="button" className="ui-btn ui-btn-secondary"
                onClick={() => onChange({ referenceAudio: undefined, referenceAudioName: undefined })}>移除参考音频</button>
        </>}
    </div>;

    return <div className="flex flex-col gap-2 p-2.5 rounded-lg border border-[var(--border-color)] bg-[var(--card-bg)] text-xs">
        <label className="font-medium text-[var(--foreground)]" htmlFor={`voice-reference-${config.id}`}>
            {requiresQwenReference(config) ? "参考音频克隆音色（Base 模型必填）" : "参考音频克隆音色（可选）"}
        </label>
        <p className="m-0 text-[11px] text-[var(--muted-foreground)]">WAV、MP3、FLAC、M4A、AAC，最大 20 MB。合成接口需支持参考音频克隆。</p>
        <input id={`voice-reference-${config.id}`} type="file"
            // Let Android show files even if the provider did not label them as audio.
            accept={isAndroidVoiceShell() ? undefined : REFERENCE_AUDIO_ACCEPT}
            disabled={busy} className="ui-input text-xs"
            onChange={async event => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (!file) return;
                const current = ++read.current;
                setBusy(true); onBusy(true); setError("");
                try {
                    const audio = await readReferenceAudio(file);
                    if (read.current === current) onChange({ referenceAudio: audio, referenceAudioName: file.name });
                } catch (failure) {
                    if (read.current === current) setError(failure instanceof Error ? failure.message : "读取参考音频失败。");
                } finally {
                    if (read.current === current) { setBusy(false); onBusy(false); }
                }
            }} />
        {busy && <p className="menu-desc m-0" role="status">正在读取参考音频…</p>}
        {error && <p className="m-0 text-red-600" role="alert">{error}</p>}
        {config.referenceAudio && <div className="flex items-center justify-between gap-2 bg-[var(--bg-muted)] px-2 py-1.5 rounded">
            <span className="truncate text-[11px]" title={config.referenceAudioName}>{config.referenceAudioName || "已保存参考音频"}</span>
            <button type="button" className="shrink-0 text-red-500 hover:underline text-[11px]" disabled={busy}
                onClick={() => { setError(""); onChange({ referenceAudio: undefined, referenceAudioName: undefined }); }}>
                移除音频
            </button>
        </div>}
        <div className="flex flex-col gap-1">
            <label className="text-[11px] text-[var(--muted-foreground)]" htmlFor={`voice-reference-text-${config.id}`}>参考文本（可选）</label>
            <Input id={`voice-reference-text-${config.id}`} value={config.referenceText || ""}
                placeholder="参考音频中所说的文字内容" className="text-xs"
                onChange={event => onChange({ referenceText: event.target.value })} />
        </div>
    </div>;
}
