"use client";

import { useState } from "react";
import { AppUpdateSettings } from "./app-update-settings";
import { AppUpdatePreviewDialog } from "./app-update-preview-dialog";

/** Presentation only: no Android bridge, feed requests, downloads, installation or storage changes. */
export function AppUpdatePreview() {
    const [open, setOpen] = useState(true);
    return <main className="min-h-dvh bg-[var(--background)] p-5 text-[var(--foreground)]">
        <div className="mx-auto flex max-w-md flex-col gap-5 pt-10">
            <div>
                <h1 className="text-xl font-semibold">应用更新预览</h1>
                <p className="menu-desc mt-2">本地样式预览。APK 的实际弹窗由 Android 原生绘制。</p>
            </div>
            <AppUpdateSettings previewVersion="1.0.0" onPreviewCheck={() => setOpen(true)} />
        </div>
        {open && <AppUpdatePreviewDialog onClose={() => setOpen(false)} />}
    </main>;
}
