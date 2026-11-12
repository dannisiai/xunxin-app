"use client";

import { useSyncExternalStore } from "react";
import { Gauge } from "lucide-react";
import { FRAME_RATE_CHOICES, canSelectFrameRate, getDisplayRefreshSnapshot, getServerDisplayRefreshSnapshot, setPreferredFrameRate, subscribeDisplayRefresh } from "@/lib/display-refresh";

export function DisplayRefreshSettings() {
  const info = useSyncExternalStore(subscribeDisplayRefresh, getDisplayRefreshSnapshot, getServerDisplayRefreshSnapshot);
  return <section className="app-card display-refresh-card" aria-labelledby="display-refresh-title">
    <div className="display-refresh-heading">
      <Gauge size={24} aria-hidden="true" />
      <div><h3 id="display-refresh-title">FPS / 刷新率</h3>
        <p>{info.maximumHz !== null ? `屏幕最高 ${Math.round(info.maximumHz)} Hz${info.currentHz !== null ? ` · 当前 ${Math.round(info.currentHz)} Hz` : ""}` : "暂未读取到屏幕刷新率上限"}</p>
      </div>
    </div>
    <div className="display-refresh-options" role="group" aria-label="目标刷新率">
      {FRAME_RATE_CHOICES.map(fps => <button key={fps} type="button"
        aria-pressed={info.targetFps === fps} disabled={info.applying || !canSelectFrameRate(fps, info)}
        title={!canSelectFrameRate(fps, info) ? "超出设备上限或当前显示模式不支持" : undefined}
        onClick={() => setPreferredFrameRate(fps)}>{fps} FPS</button>)}
    </div>
    <p className="display-refresh-hint" role="status">{info.error || (info.applying ? "正在应用…" : info.available
      ? "仅可选择屏幕支持的档位。此设置为目标刷新率，实际 FPS 受系统、省电模式和页面负载影响。"
      : "此环境暂不能读取设备上限，手动档位已禁用；请使用支持此功能的安卓版。")}</p>
  </section>;
}
