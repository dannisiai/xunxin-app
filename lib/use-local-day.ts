"use client";

import { useSyncExternalStore } from "react";
import { localDateKey } from "./relationship-dates";

const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | undefined;

function refresh(): void {
  if (!listeners.size) return;
  for (const listener of listeners) listener();
  if (timer !== undefined) clearTimeout(timer);
  const now = new Date();
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  timer = setTimeout(refresh, Math.max(1, midnight.getTime() - now.getTime() + 100));
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    window.addEventListener("focus", refresh);
    window.addEventListener("pageshow", refresh);
    document.addEventListener("visibilitychange", refresh);
    refresh();
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      window.removeEventListener("focus", refresh);
      window.removeEventListener("pageshow", refresh);
      document.removeEventListener("visibilitychange", refresh);
    }
  };
}

export function useLocalDay(): string | null {
  return useSyncExternalStore<string | null>(subscribe, () => localDateKey(new Date()), () => null);
}
