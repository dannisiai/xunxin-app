"use client";

import { useState } from "react";
import { Volume2 } from "lucide-react";
import { VoiceCallView, type VoiceCallPhase, type VoiceCallSubtitle } from "./voice-call-view";

/** Local development presentation. No call engine, audio capture or API requests. */
export function VoiceCallPreview() {
    const [phase, setPhase] = useState<VoiceCallPhase>("IDLE");
    const [muted, setMuted] = useState(false);
    const [inputMode, setInputMode] = useState<"voice" | "text">("text");
    const [holdToTalk, setHoldToTalk] = useState(false);
    const [recording, setRecording] = useState(false);
    const [text, setText] = useState("");
    const [volumeOpen, setVolumeOpen] = useState(false);
    const [volume, setVolume] = useState("0.65");
    const [subtitles, setSubtitles] = useState<VoiceCallSubtitle[]>([
        { id: "preview-user", role: "user", text: "你好" },
        { id: "preview-character", role: "assistant", text: "喂，你好。这么晚打电话过来……是钟表有什么问题，还是找我有事？" },
    ]);
    const showScene = (scene: "text" | "voice" | "speaking") => {
        setInputMode(scene === "text" ? "text" : "voice");
        setHoldToTalk(scene !== "text");
        setRecording(scene === "speaking");
        setPhase(scene === "speaking" ? "USER_SPEAKING" : "IDLE");
        setMuted(false);
    };
    return <main className="voicecall-preview-page">
        <p className="voicecall-preview-caption">通话界面预览 · 不会发起通话或申请麦克风</p>
        <div className="voicecall-preview-scenes" role="group" aria-label="预览状态">
            <button type="button" aria-pressed={inputMode === "text"} onClick={() => showScene("text")}>文字输入</button>
            <button type="button" aria-pressed={inputMode === "voice" && !recording} onClick={() => showScene("voice")}>语音待机</button>
            <button type="button" aria-pressed={recording} onClick={() => showScene("speaking")}>正在说话</button>
        </div>
        <div className="voicecall-preview-frame">
            <VoiceCallView name="沈淮安" phase={phase} status={phase === "ENDED" ? "通话已结束" : phase === "USER_SPEAKING" ? "正在聆听..." : muted ? "已静音" : "通话中"} duration="00:39"
                incoming={false} muted={muted} inputMode={inputMode} holdToTalk={holdToTalk} textInputOnly={false} recording={recording}
                recordingHint={recording ? "松开发送" : "按住下方麦克风说话"}
                subtitles={subtitles} collapseTranslation={true} typedText={text} onTypedTextChange={setText}
                onSubmit={() => { if (text.trim()) { setSubtitles(items => [...items, { id: `preview-${items.length}`, role: "user", text: text.trim() }]); setText(""); } }}
                onRegenerate={() => setPhase("IDLE")} onToggleMute={() => setMuted(value => !value)}
                onToggleInput={() => { setInputMode(value => value === "text" ? "voice" : "text"); setRecording(false); setPhase("IDLE"); }}
                pressHandlers={{
                    onPointerDown: event => { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); setRecording(true); setPhase("USER_SPEAKING"); },
                    onPointerUp: () => { setRecording(false); setPhase("IDLE"); },
                    onPointerCancel: () => { setRecording(false); setPhase("IDLE"); },
                    onContextMenu: event => event.preventDefault(),
                }}
                onHangup={() => setPhase("ENDED")} onAccept={() => setPhase("IDLE")} onDecline={() => setPhase("ENDED")}
                onMinimize={() => setPhase("IDLE")}
                volumeControl={<div className={`call-volume${volumeOpen ? " is-open" : ""}`} data-inline="true">
                    <button type="button" className="call-volume-btn" aria-label="角色语音音量" aria-expanded={volumeOpen} onClick={() => setVolumeOpen(value => !value)}><Volume2 size={27} /></button>
                    <span className="voicecall-action-label" aria-hidden="true">音量</span>
                    {volumeOpen && <input className="call-volume-slider" type="range" min="0" max="1" step="0.01" value={volume} onChange={event => setVolume(event.target.value)} aria-label="预览音量" />}
                </div>}
            />
        </div>
        {phase === "ENDED" && <button type="button" className="ui-btn ui-btn-soft-action" onClick={() => setPhase("IDLE")}>恢复预览</button>}
    </main>;
}
