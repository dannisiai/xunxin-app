export const FRAME_RATE_CHOICES = [60, 120, 144, 185] as const;
export type FrameRate = typeof FRAME_RATE_CHOICES[number] | 0;
type RefreshBridge = { getDisplayRefreshInfo?: () => string; setPreferredRefreshRate?: (fps: number) => void };
export type DisplayRefreshState = {
  available: boolean; availableRates: readonly number[]; maximumHz: number | null;
  currentHz: number | null; targetFps: FrameRate; applying: boolean; error: string | null;
};
const unknown: DisplayRefreshState = { available: false, availableRates: [], maximumHz: null, currentHz: null, targetFps: 0, applying: false, error: null };
let state = unknown;
const listeners = new Set<() => void>();
let pending: FrameRate | null = null;
let timeout: ReturnType<typeof setTimeout> | null = null;
function bridge(): RefreshBridge | undefined {
  return typeof window === "undefined" ? undefined : (window as Window & { AndroidShell?: RefreshBridge }).AndroidShell;
}
function update(next: DisplayRefreshState) {
  if (JSON.stringify(state) === JSON.stringify(next)) return;
  state = next;
  listeners.forEach(listener => listener());
}
function accept(value: unknown) {
  if (!value || typeof value !== "object") return;
  const data = value as Record<string, unknown>;
  const rates = Array.isArray(data.availableRates) ? data.availableRates.filter((n): n is number => typeof n === "number" && Number.isFinite(n) && n >= 1 && n <= 1000) : [];
  const maximum = typeof data.maximumHz === "number" && Number.isFinite(data.maximumHz) && data.maximumHz >= 1 ? data.maximumHz : null;
  const target = data.targetFps === 0 || FRAME_RATE_CHOICES.some(fps => fps === data.targetFps) ? data.targetFps as FrameRate : 0;
  const available = data.canSet === true && maximum !== null && rates.length > 0 && typeof bridge()?.setPreferredRefreshRate === "function";
  if (pending !== null && pending === target) {
    pending = null;
    if (timeout !== null) clearTimeout(timeout);
    timeout = null;
  }
  update({ available, availableRates: rates, maximumHz: maximum,
    currentHz: typeof data.currentHz === "number" && Number.isFinite(data.currentHz) && data.currentHz > 0 ? data.currentHz : null,
    targetFps: target, applying: pending !== null, error: null });
}
function refresh() {
  try {
    const raw = bridge()?.getDisplayRefreshInfo?.();
    if (raw) accept(JSON.parse(raw));
    else update({ ...unknown });
  } catch {
    pending = null;
    if (timeout !== null) clearTimeout(timeout);
    timeout = null;
    update({ ...unknown, error: "无法读取屏幕刷新率，请稍后重试" });
  }
}
export function canSelectFrameRate(fps: FrameRate, snapshot = state): boolean {
  return snapshot.available && (fps === 0 || snapshot.maximumHz !== null && fps <= snapshot.maximumHz + 0.6
    && snapshot.availableRates.some(rate => Math.abs(rate - fps) <= 0.6));
}
export function setPreferredFrameRate(fps: FrameRate): boolean {
  if (state.applying || !canSelectFrameRate(fps) || ![0, ...FRAME_RATE_CHOICES].includes(fps)) return false;
  pending = fps;
  update({ ...state, applying: true, error: null });
  try { bridge()!.setPreferredRefreshRate!(fps); }
  catch { pending = null; update({ ...state, applying: false, error: "未能设置刷新率，请重试" }); return false; }
  timeout = setTimeout(() => {
    timeout = null; refresh();
    if (pending !== null) { pending = null; update({ ...state, applying: false, error: "设备没有接受此档位，请重试" }); }
  }, 1500);
  return true;
}
export function subscribeDisplayRefresh(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1 && typeof window !== "undefined") {
    window.addEventListener("android-display-refresh-changed", changed);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", visible);
    refresh();
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size && typeof window !== "undefined") {
      window.removeEventListener("android-display-refresh-changed", changed);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", visible);
      if (timeout !== null) clearTimeout(timeout);
      timeout = null; pending = null;
      state = { ...state, applying: false };
    }
  };
}
function changed(event: Event) {
  // Event detail is not an authority for hardware capabilities; reread the cached native snapshot.
  if (event.type === "android-display-refresh-changed") refresh();
}
function visible() { if (!document.hidden) refresh(); }
export function getDisplayRefreshSnapshot() { return state; }
export function getServerDisplayRefreshSnapshot() { return unknown; }
