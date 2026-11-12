"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { ContentDialog } from "@/components/ui/modal";
import { fileToCompanionAvatar, loadCompanionAvatar, saveCompanionAvatar, subscribeCompanionAvatar } from "@/lib/companion-avatar";
import { getDocumentAccountId, isAccountStorageActive } from "@/lib/account-storage";
import { loadCharacters } from "@/lib/character-storage";
import { updateActiveCompanion } from "@/lib/mascot-state";

/** One editor shared by the summoned companion and both native together-watch overlays. */
export function CompanionAvatarSettings({ characterId, name }: { characterId: string; name: string }) {
    const [open, setOpen] = useState(false);
    const [uploading, setUploading] = useState(false);
    const [error, setError] = useState("");
    const input = useRef<HTMLInputElement>(null);
    const version = useRef(0);
    const avatar = useSyncExternalStore(subscribeCompanionAvatar, () => loadCompanionAvatar(characterId), () => null);
    useEffect(() => () => { version.current++; }, []);
    const close = () => { version.current++; setUploading(false); setError(""); setOpen(false); };
    const upload = async (file: File) => {
        const accountId = getDocumentAccountId();
        const current = ++version.current;
        setUploading(true); setError("");
        try {
            const dataUrl = await fileToCompanionAvatar(file);
            if (current !== version.current || accountId !== getDocumentAccountId()
                || accountId && !isAccountStorageActive() || !loadCharacters().some(item => item.id === characterId)) return;
            saveCompanionAvatar(characterId, dataUrl);
            updateActiveCompanion({ characterId, avatar: dataUrl });
        } catch {
            if (current === version.current) setError("图片读取失败，请选择不超过 20 MB 的 PNG、JPG 或 WebP 图片。");
        } finally {
            if (current === version.current) setUploading(false);
        }
    };
    return <>
        <button type="button" onClick={() => setOpen(true)}
            style={{ display: "block", padding: "4px 0", border: 0, background: "transparent", color: "#c084fc", fontSize: 11, textAlign: "left", cursor: "pointer", textDecoration: "underline" }}>
            设置悬浮头像
        </button>
        {open && createPortal(<div style={{ position: "fixed", inset: 0, zIndex: 2147483000 }}><ContentDialog title={`${name}的悬浮头像`} confirmLabel="完成" cancelLabel="" onConfirm={close} onCancel={close}>
            <p style={{ marginTop: 0, lineHeight: 1.7 }}>只为{name}设置，伴宠、一起刷抖音和小红书共用。没有设置头像时显示名字。</p>
            <div style={{ width: 88, height: 88, margin: "16px auto", borderRadius: "50%", overflow: "hidden", display: "grid", placeItems: "center", background: "var(--c-input, #F1EDE7)", color: "var(--c-text-title, #563931)", textAlign: "center", fontSize: 16, overflowWrap: "anywhere" }}>
                {avatar ? <img src={avatar} alt={`${name}的悬浮头像`} style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : <span style={{ padding: 8 }}>{name}</span>}
            </div>
            <input ref={input} type="file" accept="image/*" hidden disabled={uploading} aria-label={`为${name}上传悬浮头像`}
                onChange={event => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void upload(file); }} />
            <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "center", gap: 10 }}>
                <button type="button" className="ui-btn ui-btn-primary" disabled={uploading} onClick={() => input.current?.click()}>{uploading ? "正在处理…" : "选择头像"}</button>
                {avatar && <button type="button" className="ui-btn ui-btn-outline" disabled={uploading} onClick={() => {
                    saveCompanionAvatar(characterId, null); updateActiveCompanion({ characterId, avatar: null }); setError("");
                }}>清除头像，显示名字</button>}
            </div>
            {error && <p role="alert" style={{ color: "#a33e31", fontSize: 13 }}>{error}</p>}
        </ContentDialog></div>, document.body)}
    </>;
}
