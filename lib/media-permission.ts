/** Reading native permission state never prompts, captures audio, or calls a remote API. */
export type NativeMediaPermissionState = {
    microphoneGranted: boolean; cameraGranted: boolean; requesting: boolean;
    systemMicrophoneMuted: boolean | null;
};
export function readNativeMediaPermission(): NativeMediaPermissionState | null {
    if (typeof window === "undefined") return null;
    try {
        const native = (window as Window & { AndroidShell?: { getMediaPermissionInfo?: () => string } }).AndroidShell;
        if (!native?.getMediaPermissionInfo) return null;
        const data: unknown = JSON.parse(native.getMediaPermissionInfo());
        if (!data || typeof data !== "object" || !("available" in data) || data.available !== true) return null;
        const state = data as Record<string, unknown>;
        return { microphoneGranted: state.microphoneGranted === true, cameraGranted: state.cameraGranted === true,
            requesting: state.requesting === true, systemMicrophoneMuted: typeof state.systemMicrophoneMuted === "boolean" ? state.systemMicrophoneMuted : null };
    } catch { return null; }
}
export function microphoneUnavailableError(): Error {
    if (typeof window !== "undefined" && window.isSecureContext === false) {
        return new Error("当前页面不是安全连接，无法申请麦克风。网页需使用 HTTPS；安卓版应使用应用内置页面。");
    }
    return new Error("当前系统 WebView 不支持所需录音能力，请更新 Android System WebView 后重试。");
}
export function microphoneCaptureError(error: unknown): Error {
    const name = error instanceof Error ? error.name : "";
    if (name === "NotAllowedError" || name === "PermissionDeniedError" || name === "SecurityError") {
        const native = readNativeMediaPermission();
        if (native?.systemMicrophoneMuted) return new Error("系统报告麦克风已静音，请检查控制中心或隐私设置中的麦克风访问开关。");
        if (native && !native.microphoneGranted) return new Error("寻信尚未获得录音权限。请打开手机设置 → 应用 → 寻信 → 权限 → 麦克风，选择使用期间允许，再返回重试。");
        if (native) return new Error("应用录音权限已允许，但网页录音仍被拒绝。请检查系统麦克风访问开关；若仍失败，请更新 Android System WebView 后重试。");
        return new Error("麦克风访问被拒绝，请在手机应用权限和浏览器网站权限中允许麦克风后重试。");
    }
    if (name === "NotReadableError" || name === "TrackStartError") return new Error("麦克风无法启动，可能被其他应用占用或被系统禁用，请检查后重试。");
    if (name === "NotFoundError" || name === "DevicesNotFoundError") return new Error("系统没有找到可用麦克风，请检查输入设备。");
    return new Error(error instanceof Error ? error.message : "无法打开麦克风，请检查录音权限和系统麦克风访问开关。");
}
