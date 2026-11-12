"use client";

import { useState, type CSSProperties } from "react";

/** A companion without a custom image is represented by its name, including on image failure. */
export function CompanionAvatar({ src, name, className, style }: { src?: string | null; name: string; className?: string; style?: CSSProperties }) {
    const [failed, setFailed] = useState<string | null>(null);
    if (!src || failed === src) {
        return <span className={className} aria-label={name} title={name} style={{
            display: "grid", placeItems: "center", overflow: "hidden", boxSizing: "border-box", padding: 4,
            background: "var(--c-input, #FFFCF7)", color: "var(--c-text-title, #563931)",
            fontSize: 12, lineHeight: 1.25, textAlign: "center", overflowWrap: "anywhere", ...style,
        }}>{name}</span>;
    }
    return <img className={className} src={src} alt={name} style={style} onError={() => setFailed(src)} />;
}
