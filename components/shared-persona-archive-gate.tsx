"use client";

import { useEffect, useState, type ReactNode } from "react";
import { getDocumentAccountId, isAccountStorageActive } from "@/lib/account-storage";
import { initializeSharedArchive, resetSharedArchiveInitialization, saveSharedArchive, sharedArchiveBridge, SHARED_ARCHIVE_CHANGED } from "@/lib/shared-persona-archive";

export function SharedPersonaArchiveGate({ children }: { children: ReactNode }) {
    const [state, setState] = useState<"checking" | "permission" | "ready" | "skipped" | "error">("checking");
    const [error, setError] = useState("");
    const [attempt, setAttempt] = useState(0);
    useEffect(() => {
        const retry = () => { resetSharedArchiveInitialization(); setAttempt(value => value + 1); };
        window.addEventListener("shared-persona-rescan", retry);
        return () => window.removeEventListener("shared-persona-rescan", retry);
    }, []);
    useEffect(() => {
        let cancelled = false;
        const check = async () => {
            try {
                const bridge = sharedArchiveBridge();
                if (!bridge) { setState("ready"); return; }
                if (!bridge.sharedArchivePermission(getDocumentAccountId())) { setState("permission"); return; }
                setState("checking");
                const restored = await initializeSharedArchive();
                if (cancelled || !isAccountStorageActive()) return;
                if (restored) { window.location.reload(); return; }
                if (!cancelled) setState("ready");
            } catch (failure) { if (!cancelled) { setError(failure instanceof Error ? failure.message : "本机存档载入失败"); setState("error"); } }
        };
        void check();
        return () => { cancelled = true; };
    }, [attempt]);
    useEffect(() => {
        if (state !== "ready" || !sharedArchiveBridge()) return;
        let timer: ReturnType<typeof setTimeout>; let running = false; let pending = false; let cancelled = false;
        const save = async () => {
            if (running) { pending = true; return; }
            running = true;
            try { await saveSharedArchive(); setError(""); }
            catch (failure) { if (!cancelled) setError(failure instanceof Error ? failure.message : "本机存档保存失败"); }
            finally { running = false; if (pending && !cancelled) { pending = false; schedule(); } }
        };
        const schedule = () => { clearTimeout(timer); timer = setTimeout(() => { if (!cancelled) void save(); }, 1500); };
        const interval = setInterval(schedule, 60000);
        window.addEventListener(SHARED_ARCHIVE_CHANGED, schedule);
        return () => { cancelled = true; clearTimeout(timer); clearInterval(interval); window.removeEventListener(SHARED_ARCHIVE_CHANGED, schedule); };
    }, [state]);
    if (state === "ready" || state === "skipped") return <>{children}{error && <p data-adaptive-surface="content" role="status" className="shared-archive-status">本机共用存档：{error}</p>}</>;
    return <section data-adaptive-surface="content" className="shared-archive-gate" aria-label="本机共用人设存档">
        <h1>{state === "checking" ? "正在检查本机存档…" : "本机共用人设存档"}</h1>
        <p>本设备所有登录账号共用同一份角色、人设和头像。文件保存在“文档／XunxinLocalArchive”，卸载 App 后保留；不包含登录凭证与 API 密钥。</p>
        {state === "permission" && <><p>请在系统设置中开启文件访问权限，返回后点“继续”。无需选择文件夹。</p>
            <button className="ui-btn ui-btn-primary" onClick={() => sharedArchiveBridge()?.requestSharedArchivePermission(getDocumentAccountId())}>开启文件访问</button></>}
        {error && <p role="alert">{error}</p>}
        {state !== "checking" && <><button className="ui-btn ui-btn-outline" onClick={() => { setError(""); setAttempt(value => value + 1); }}>继续／重试</button>
            <button className="ui-btn ui-btn-ghost" onClick={() => { setError(""); setState("skipped"); }}>本次仅使用 App 内资料</button></>}
    </section>;
}
