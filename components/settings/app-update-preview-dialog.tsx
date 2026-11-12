"use client";

import { useState } from "react";
import { Download } from "lucide-react";
import { ContentDialog } from "@/components/ui/modal";

/** Development presentation only; never calls update services or the Android bridge. */
export function AppUpdatePreviewDialog({ onClose }: { onClose: () => void }) {
    const [notice, setNotice] = useState("");
    return <ContentDialog title="发现新版本" confirmLabel="立即更新" cancelLabel="稍后更新"
        onCancel={onClose} onConfirm={() => setNotice("这是样式预览，不会下载或安装 APK。") }>
        <div className="flex flex-col gap-4">
            <div className="flex items-center gap-3">
                <span className="ui-icon-circle" data-variant="action"><Download size={26} aria-hidden="true" /></span>
                <div><p className="font-semibold">寻信 1.0.1</p><p className="menu-desc">示例版本 · 普通更新</p></div>
            </div>
            <div className="flex flex-col gap-2 text-sm leading-relaxed">
                <p className="font-medium">更新内容</p>
                <p>支持应用内检查更新、下载进度和断点续传。</p>
                <p>完善语音通话提示与麦克风权限入口。</p>
            </div>
            <p className="menu-desc" role="status">{notice || "此页仅用于浏览器调试，版本和日志为示例。"}</p>
        </div>
    </ContentDialog>;
}
