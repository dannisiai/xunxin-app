"use client";

import type { ButtonHTMLAttributes, CSSProperties, ReactNode, Ref } from "react";
import { ArrowUp, ChevronDown, Mic, MicOff, Phone, RotateCw } from "lucide-react";
import { BilingualTextBlock } from "./message-bubble";

export type VoiceCallPhase = "CONNECTING" | "IDLE" | "USER_SPEAKING" | "PROCESSING" | "AI_SPEAKING" | "ENDED";
export type VoiceCallSubtitle = { id: string; role: "user" | "assistant"; text: string };

type VoiceCallViewProps = {
    name: string;
    avatar?: string | null;
    backgroundImage?: string | null;
    phase: VoiceCallPhase;
    status: string;
    duration: string;
    incoming: boolean;
    muted: boolean;
    inputMode: "voice" | "text";
    holdToTalk: boolean;
    textInputOnly: boolean;
    recording: boolean;
    recordingHint?: string;
    hint?: string;
    error?: string;
    subtitles: readonly VoiceCallSubtitle[];
    interimText?: string;
    collapseTranslation: boolean;
    typedText: string;
    onTypedTextChange: (text: string) => void;
    onSubmit: () => void;
    onRegenerate: () => void;
    onToggleMute: () => void;
    onToggleInput: () => void;
    onHangup: () => void;
    onAccept: () => void;
    onDecline: () => void;
    onMinimize?: () => void;
    pressHandlers?: Pick<ButtonHTMLAttributes<HTMLButtonElement>, "onPointerDown" | "onPointerUp" | "onPointerCancel" | "onContextMenu">;
    subtitleRef?: Ref<HTMLDivElement>;
    style?: CSSProperties;
    volumeControl: ReactNode;
};

function CallAction({ label, tone = "neutral", children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & {
    label: string;
    tone?: "neutral" | "end" | "accept";
}) {
    return <div className="voicecall-action">
        <button type="button" className="voicecall-action-button" data-tone={tone} aria-label={label} {...props}>{children}</button>
        <span className="voicecall-action-label" aria-hidden="true">{label}</span>
    </div>;
}

/** Presentation only. The caller owns audio, permissions, network requests and call state. */
export function VoiceCallView(props: VoiceCallViewProps) {
    const active = props.phase !== "CONNECTING" && props.phase !== "ENDED";
    const textInput = active && props.inputMode === "text";
    return <div className="voicecall-screen call-keyboard-shift" data-phase={props.phase}
        style={props.backgroundImage ? { ...props.style, background: `url(${props.backgroundImage}) center/cover no-repeat` } : props.style}>
        <div className="voicecall-backdrop" data-adaptive-surface="decoration" data-has-image={props.backgroundImage ? "true" : undefined} />
        <div className="voicecall-body voicecall-controls">
            <header className="voicecall-header">
                {props.onMinimize && props.phase !== "ENDED" ? <button type="button" className="voicecall-minimize" onClick={props.onMinimize} aria-label="缩小通话" title="缩小通话"><ChevronDown size={22} /></button> : <span />}
                <span />
            </header>

            <div className="voicecall-identity">
                <div className="voicecall-portrait">
                    <div className="voicecall-avatar" data-speaking={props.phase === "AI_SPEAKING" ? "" : undefined}>
                        {props.avatar ? <img src={props.avatar} alt={props.name} /> : <span className="voicecall-initial">{props.name?.[0] || "?"}</span>}
                    </div>
                    {props.phase === "CONNECTING" && <><span className="voicecall-connect-ring" aria-hidden="true" /><span className="voicecall-connect-ring" aria-hidden="true" /></>}
                </div>
                <h1 className="voicecall-name">{props.name}</h1>
                <p className="voicecall-status" role="status">{active && <><span className="voicecall-duration">{props.duration}</span><span className="voicecall-status-dot" aria-hidden="true">·</span></>}{props.status}</p>
            </div>

            {(props.hint || props.error) && <div className="voicecall-notices" data-adaptive-surface="content">
                {props.hint && <p role="status">{props.hint}</p>}
                {props.error && <p role="alert">{props.error}</p>}
            </div>}

            <div ref={props.subtitleRef} className="voicecall-transcript" data-adaptive-surface="content" role="log" aria-label="通话字幕">
                {props.subtitles.map(sub => <div key={sub.id} className="call-subtitle" data-role={sub.role}>
                    <BilingualTextBlock text={sub.text} mode="plain" className="call-subtitle-bilingual" defaultExpanded={!props.collapseTranslation} />
                </div>)}
                {props.interimText && props.phase === "USER_SPEAKING" && <div className="call-subtitle" data-role="user" data-interim="">{props.interimText}</div>}
            </div>

            {textInput && <form className="voicecall-composer" onSubmit={event => { event.preventDefault(); props.onSubmit(); }}>
                <button type="button" className="call-regenerate-btn" onClick={props.onRegenerate} disabled={props.phase !== "IDLE"} aria-label="让对方重新回复" title="让对方重新回复"><RotateCw size={19} /></button>
                <div className="call-text-input-shell">
                    <input className="call-text-input" value={props.typedText} onChange={event => props.onTypedTextChange(event.target.value)}
                        aria-label="通话文字消息" placeholder={props.phase === "IDLE" ? "输入你想说的话..." : "稍等对方说完..."} disabled={props.phase !== "IDLE"} />
                    <button type="submit" className="call-text-send-btn" disabled={!props.typedText.trim() || props.phase !== "IDLE"} aria-label="发送"><ArrowUp size={20} /></button>
                </div>
            </form>}

            {active && props.holdToTalk && props.inputMode === "voice" && <p className="voicecall-recording-hint" role="status">{props.recordingHint}</p>}

            <footer className="voicecall-actions">
                {active ? <>
                    <div className="voicecall-tools">
                        {!props.textInputOnly && (props.holdToTalk ? <CallAction label={props.inputMode === "text" ? "语音" : props.recording ? "松开发送" : "按住说话"}
                            style={{ touchAction: "none" }} data-recording={props.recording ? "true" : undefined}
                            {...(props.inputMode === "voice" ? props.pressHandlers : { onClick: props.onToggleInput })}>
                            <Mic size={28} />
                        </CallAction> : <CallAction label="静音" aria-pressed={props.muted} onClick={props.onToggleMute}>{props.muted ? <MicOff size={28} /> : <Mic size={28} />}</CallAction>)}
                        {!props.textInputOnly && <CallAction label="文字" aria-pressed={props.inputMode === "text"} onClick={props.onToggleInput}><span className="voicecall-text-icon">Aa</span></CallAction>}
                        {props.volumeControl}
                    </div>
                    <div className="voicecall-end-row"><CallAction label="挂断" tone="end" onClick={props.onHangup}><Phone size={30} className="voicecall-end-icon" /></CallAction></div>
                </> : props.phase === "CONNECTING" ? <div className="voicecall-connect-actions">
                    <CallAction label={props.incoming ? "拒绝" : "取消"} tone="end" onClick={props.onDecline}><Phone size={30} className="voicecall-end-icon" /></CallAction>
                    {props.incoming && <CallAction label="接听" tone="accept" onClick={props.onAccept}><Phone size={30} /></CallAction>}
                </div> : <p className="voicecall-ended">通话已结束</p>}
            </footer>
        </div>
    </div>;
}
