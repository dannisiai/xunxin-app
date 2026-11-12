"use client";

import { useId } from "react";
import { getRelationshipDays } from "@/lib/relationship-dates";
import { useLocalDay } from "@/lib/use-local-day";

export function LoveDaysBadge({ createdAt }: { createdAt: string | undefined }) {
  const gradientId = "love-gem-" + useId().replace(/:/g, "");
  const today = useLocalDay();
  const days = getRelationshipDays(createdAt, today);
  if (!days) return null;
  const label = `相爱第 ${days.dayNumber} 天`;
  const winged = days.dayNumber > 90;
  return (
    <span className="chat-love-days" data-bond-tier={winged ? "winged" : days.dayNumber >= 30 ? "rose" : "blush"}
      aria-label={label + (winged ? "，已解锁羽翼爱心" : "")} title={`从 ${days.startedOn} 开始，${label}${winged ? " · 羽翼爱心" : ""}`}>
      <svg viewBox={winged ? "0 0 112 56" : "20 0 72 56"} preserveAspectRatio="none" aria-hidden="true" focusable="false">
        <defs><linearGradient id={gradientId} x1="0" y1="0" x2="0.2" y2="1">
          <stop offset="0" stopColor="#fff8fc" /><stop offset="0.5" stopColor="#fce0ec" /><stop offset="1" stopColor="#efabc6" />
        </linearGradient></defs>
        {winged && <g className="chat-love-wings">
          <path d="M29 20 C20 19 9 12 3 6 C3 21 10 31 22 33 C14 32 9 28 6 25 C8 37 19 41 30 35 L37 29 Z" />
          <path d="M83 20 C92 19 103 12 109 6 C109 21 102 31 90 33 C98 32 103 28 106 25 C104 37 93 41 82 35 L75 29 Z" />
          <path className="chat-love-feather" d="M8 14 Q18 28 31 27 M8 25 Q19 34 29 31 M104 14 Q94 28 81 27 M104 25 Q93 34 83 31" />
        </g>}
        <path className="chat-love-gem" fill={"url(#" + gradientId + ")"} d="M56 14 C44 1 25 4 25 19 C25 32 44 43 56 51 C68 43 87 32 87 19 C87 4 68 1 56 14 Z" />
        <path className="chat-love-highlight" d="M30 18 C30 8 44 7 52 16 M60 16 C68 7 80 9 82 17" />
        {winged && <path className="chat-love-spark" d="M56 2 L58 6 L56 10 L54 6 Z" />}
      </svg>
      <span aria-hidden="true">相爱第<strong>{days.dayNumber}</strong>天</span>
    </span>
  );
}
