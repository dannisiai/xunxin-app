"use client";

import { useRef } from "react";

/** A pointer/keyboard separator. Resizing never replaces either pane's component tree. */
export function PaneResizeHandle({ value, min, max, onChange, label, className = "" }: {
    value: number; min: number; max: number; onChange: (width: number) => void; label: string; className?: string;
}) {
    const drag = useRef<{ id: number; x: number; width: number } | null>(null);
    const update = (next: number) => onChange(Math.round(Math.max(min, Math.min(max, next))));
    return <div role="separator" aria-orientation="vertical" tabIndex={0} aria-label={label}
        aria-valuemin={min} aria-valuemax={max} aria-valuenow={Math.round(value)} aria-valuetext={`${Math.round(value)} 像素`}
        className={`pane-resize-handle ${className}`}
        onPointerDown={event => {
            if (event.button !== 0) return;
            event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId);
            drag.current = { id: event.pointerId, x: event.clientX, width: value };
        }}
        onPointerMove={event => {
            if (drag.current?.id === event.pointerId) update(drag.current.width + event.clientX - drag.current.x);
        }}
        onPointerUp={event => { if (drag.current?.id === event.pointerId) { drag.current = null; event.currentTarget.releasePointerCapture(event.pointerId); } }}
        onPointerCancel={() => { drag.current = null; }} onLostPointerCapture={() => { drag.current = null; }}
        onKeyDown={event => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            update(event.key === "Home" ? min : event.key === "End" ? max : value + (event.key === "ArrowLeft" ? -1 : 1) * (event.shiftKey ? 40 : 16));
        }}><span aria-hidden="true" /></div>;
}
