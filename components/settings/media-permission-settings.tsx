"use client";

import { useEffect, useState } from "react";
import { Mic } from "lucide-react";
import { readNativeMediaPermission, type NativeMediaPermissionState } from "@/lib/media-permission";

type MediaBridge = {
    requestMicrophonePermission?: () => void;
    openMediaPermissionSettings?: () => void;
    openMicrophonePrivacySettings?: () => void;
};
function bridge(): MediaBridge | undefined {
    return typeof window === "undefined" ? undefined : (window as Window & { AndroidShell?: MediaBridge }).AndroidShell;
}

export function MediaPermissionSettings() {
    const [info, setInfo] = useState<NativeMediaPermissionState | null>(null);
    const [error, setError] = useState("");
    useEffect(() => {
        const refresh = () => setInfo(readNativeMediaPermission());
        const visible = () => { if (!document.hidden) refresh(); };
        refresh();
        window.addEventListener("android-media-permissions-changed", refresh);
        window.addEventListener("focus", refresh);
        document.addEventListener("visibilitychange", visible);
        return () => {
            window.removeEventListener("android-media-permissions-changed", refresh);
            window.removeEventListener("focus", refresh);
            document.removeEventListener("visibilitychange", visible);
        };
    }, []);
    if (!info) return null;
    const invoke = (method: keyof MediaBridge) => {
        try {
            const native = bridge();
            if (typeof native?.[method] !== "function") throw new Error("此版本不支持该权限入口，请到手机应用权限设置中开启。");
            native[method]!(); setError("");
        } catch (failure) { setError(failure instanceof Error ? failure.message : "无法打开系统权限设置"); }
    };
    return <section className="app-card flex flex-col gap-3 p-4" aria-label="麦克风权限">
        <div className="flex items-center gap-3">
            <Mic size={22} aria-hidden="true" />
            <div className="min-w-0 flex-1">
                <h3 className="font-semibold">麦克风权限</h3>
                <p className="menu-desc" role="status">{info.requesting ? "请完成系统权限选择"
                    : info.systemMicrophoneMuted ? "系统报告麦克风已静音，请检查麦克风访问开关"
                    : info.microphoneGranted ? "应用录音权限已允许" : "应用录音权限尚未允许"}</p>
            </div>
        </div>
        <div className="flex flex-wrap gap-2">
            {!info.microphoneGranted && <button type="button" className="ui-btn ui-btn-soft-action" disabled={info.requesting}
                onClick={() => invoke("requestMicrophonePermission")}>申请麦克风权限</button>}
            <button type="button" className="ui-btn ui-btn-soft-action" disabled={info.requesting}
                onClick={() => invoke("openMediaPermissionSettings")}>应用权限设置</button>
            {info.microphoneGranted && <button type="button" className="ui-btn ui-btn-soft-action" disabled={info.requesting}
                onClick={() => invoke("openMicrophonePrivacySettings")}>系统隐私设置</button>}
        </div>
        <p className="menu-desc">允许权限后，返回通话或录音页面重新点击麦克风。这里仅申请权限，不会录音。</p>
        {error && <p className="menu-desc" role="alert">{error}</p>}
    </section>;
}
