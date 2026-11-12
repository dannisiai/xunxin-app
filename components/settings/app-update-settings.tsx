"use client";

import { useEffect, useState } from "react";
import { Download } from "lucide-react";
import { AppUpdatePreviewDialog } from "./app-update-preview-dialog";

type UpdateBridge = { getAppUpdateInfo?: () => string; checkForAppUpdate?: () => void };
function bridge(): UpdateBridge | undefined {
    return typeof window === "undefined" ? undefined : (window as Window & { AndroidShell?: UpdateBridge }).AndroidShell;
}

export function AppUpdateSettings({ previewVersion, onPreviewCheck }: { previewVersion?: string; onPreviewCheck?: () => void } = {}) {
    const [version, setVersion] = useState<string | null>(previewVersion ?? null);
    const [error, setError] = useState("");
    const [browserPreview, setBrowserPreview] = useState(false);
    const [showPreview, setShowPreview] = useState(false);
    useEffect(() => {
        if (previewVersion) { setBrowserPreview(false); setVersion(previewVersion); return; }
        try {
            const native = bridge();
            if (native?.getAppUpdateInfo && native.checkForAppUpdate) {
                const info: unknown = JSON.parse(native.getAppUpdateInfo());
                if (info && typeof info === "object" && "versionName" in info && typeof info.versionName === "string") {
                    setBrowserPreview(false); setVersion(info.versionName); return;
                }
            }
        } catch { /* Older Android shells and ordinary browsers retain their existing settings UI. */ }
        if (process.env.NODE_ENV === "development") { setBrowserPreview(true); setVersion("本地开发版"); }
    }, [previewVersion]);
    if (version === null) return null;
    return <><section className="g-card flex flex-col gap-3 p-4" aria-label="应用更新">
        <div className="flex items-center gap-3">
            <Download size={22} aria-hidden="true" />
            <div className="min-w-0 flex-1">
                <h3 className="font-semibold">应用更新</h3>
                <p className="menu-desc">当前版本 {version}</p>
            </div>
            <button type="button" className="ui-btn ui-btn-soft-action shrink-0" onClick={() => {
                if (onPreviewCheck) { onPreviewCheck(); return; }
                if (browserPreview) { setShowPreview(true); return; }
                try { bridge()?.checkForAppUpdate?.(); setError(""); }
                catch { setError("无法打开更新检查，请稍后重试。"); }
            }}>检查更新</button>
        </div>
        {browserPreview && <p className="menu-desc">本地浏览器预览，点击检查更新可调试弹窗。</p>}
        {error && <p className="menu-desc" role="alert">{error}</p>}
    </section>
        {process.env.NODE_ENV === "development" && showPreview && <AppUpdatePreviewDialog onClose={() => setShowPreview(false)} />}
    </>;
}
