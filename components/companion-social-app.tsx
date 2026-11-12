"use client";

import { useCallback, useEffect, useState } from "react";
import { summonCharacterCompanion } from "@/lib/mascot-state";
import { COMPANION_APP_NAMES, companionLaunchUrl, stopAndroidCompanion, supportsAndroidCompanion, type CompanionAppId } from "@/lib/android-companion";
import { loadCompanionVoiceEnabled, saveCompanionVoiceEnabled } from "@/lib/companion-voice";
import { useCharacterList } from "@/lib/use-character-list";
import { loadCompanionAvatar } from "@/lib/companion-avatar";

export function CompanionSocialApp({ appId, onClose }: { appId: CompanionAppId; onClose: () => void }) {
  const characters = useCharacterList();
  const [selected, setSelected] = useState("");
  const [supported, setSupported] = useState(false);
  const [voiceEnabled, setVoiceEnabled] = useState(false);
  useEffect(() => { setVoiceEnabled(loadCompanionVoiceEnabled(appId)); }, [appId]);
  const close = useCallback(() => { stopAndroidCompanion(); onClose(); }, [onClose]);
  useEffect(() => {
    const back = (event: Event) => { event.preventDefault(); close(); };
    window.addEventListener("android-shell-back", back);
    return () => window.removeEventListener("android-shell-back", back);
  }, [close]);
  useEffect(() => { setSupported(supportsAndroidCompanion()); }, []);
  useEffect(() => { setSelected(""); }, [appId]);
  useEffect(() => {
    if (selected && !characters.some(item => item.id === selected)) setSelected("");
  }, [characters, selected]);
  const character = characters.find(item => item.id === selected);
  const name = COMPANION_APP_NAMES[appId];
  return (
    <div style={{ height: "100%", overflowY: "auto", background: "var(--c-panel, #FFFCF7)", padding: "calc(var(--cp-appbar-safe-top, 0px) + 20px) 20px 24px", color: "var(--c-text-title, #563931)" }}>
      <button type="button" onClick={close} style={{ border: 0, background: "none", minHeight: 44, padding: "8px 0", color: "inherit" }}>‹ 返回</button>
      <h2 style={{ fontSize: 22, margin: "24px 0 12px" }}>一起刷{name}</h2>
      <p style={{ lineHeight: 1.8 }}>带着你的 AI 伴侣打开手机里的{name}。点击悬浮头像或名字，角色会看当前屏幕并回复；长按打开完整对话。</p>
      <section aria-label="选择一起看的 AI" style={{ padding: "16px 0", borderTop: "1px solid var(--c-panel-border, #E6E0D7)" }}>
        <label htmlFor={`companion-character-${appId}`} style={{ fontWeight: 600 }}>选择一起看的 AI</label>
        <select id={`companion-character-${appId}`} value={selected} onChange={event => setSelected(event.target.value)}
          style={{ display: "block", width: "100%", margin: "12px 0 20px", padding: 12, borderRadius: 12, background: "var(--c-input, #F1EDE7)", border: "1px solid var(--c-panel-border, #E6E0D7)", color: "var(--c-text-title, #563931)" }}>
          <option value="">请先选择 AI</option>
          {characters.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
        {!characters.length && <p style={{ fontSize: 13 }}>先在「角色」里创建或导入你的 AI 伴侣。</p>}
      </section>
      <div style={{ display: "flex", alignItems: "center", gap: 16, padding: "16px 0", margin: "8px 0 20px", borderTop: "1px solid var(--c-panel-border, #E6E0D7)", borderBottom: "1px solid var(--c-panel-border, #E6E0D7)" }}>
        <div style={{ flex: 1 }}>
          <div id={`companion-voice-label-${appId}`} style={{ fontSize: 16, fontWeight: 600 }}>语音回复</div>
          <p id={`companion-voice-help-${appId}`} style={{ fontSize: 13, lineHeight: 1.7, margin: "6px 0 0", color: "var(--c-text, #85685E)" }}>开启后，点击悬浮窗会用角色配置的音色朗读回复。需要配置语音服务。</p>
        </div>
        <button type="button" role="switch" aria-checked={voiceEnabled}
          aria-labelledby={`companion-voice-label-${appId}`} aria-describedby={`companion-voice-help-${appId}`}
          onClick={() => { const enabled = !voiceEnabled; setVoiceEnabled(enabled); saveCompanionVoiceEnabled(appId, enabled); }}
          style={{ width: 52, height: 44, flexShrink: 0, padding: "7px 0", border: 0, background: "transparent", cursor: "pointer" }}>
          <span style={{ display: "block", height: 30, padding: 3, borderRadius: 18, background: voiceEnabled ? "var(--c-icon-active, #6A3F39)" : "var(--c-icon, #A79C90)", transition: "background 160ms" }}>
            <span style={{ display: "block", width: 24, height: 24, borderRadius: "50%", background: "white", boxShadow: "0 1px 3px #0002", transform: `translateX(${voiceEnabled ? 22 : 0}px)`, transition: "transform 160ms" }} />
          </span>
        </button>
      </div>
      {supported ? <>
        {character ? <a href={companionLaunchUrl(appId, character.id, character.name)}
          onClick={() => summonCharacterCompanion({ characterId: character.id, name: character.name, avatar: loadCompanionAvatar(character.id) })}
          style={{ display: "block", padding: 14, borderRadius: 14, background: "var(--c-icon-active, #6A3F39)", textAlign: "center", color: "white", textDecoration: "none" }}>
          带{character.name}打开{name}
        </a> : <p>先选择 AI，再开启一起看。</p>}
        <p style={{ fontSize: 13, lineHeight: 1.8, marginTop: 20 }}>首次打开时允许悬浮窗与屏幕共享。截图会发送给你配置的识图模型，回复同步到原有聊天。拖动悬浮头像或名字可自由移动，拖动对话窗顶部可调整位置。通知栏可随时关闭陪伴。</p>
      </> : <p role="status" style={{ lineHeight: 1.8 }}>请安装包含屏幕陪伴功能的新版安卓小手机，并在手机中安装{name}。浏览器无法在真实 App 上显示悬浮窗。</p>}
    </div>
  );
}
