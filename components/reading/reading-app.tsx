"use client";

import { useState, useEffect, useRef, type CSSProperties } from "react";
import { hydrateReadingStorage } from "@/lib/reading-storage";
import { ReadingShelf } from "./reading-shelf";
import { ReadingViewer } from "./reading-viewer";
import type { Book } from "@/lib/reading-types";
import { usePaneSize } from "@/components/ui/use-pane-size";
import { getTabletLayout } from "@/lib/tablet-layout";
import { BookOpen } from "lucide-react";
import {
    DEFAULT_READING_APPEARANCE,
    loadReadingAppearance,
    loadReadingBackground,
    loadReadingCustomFont,
    resolveReadingFontFamily,
    saveReadingAppearance,
    saveReadingBackground,
    saveReadingCustomFont,
    type ReadingAppearance,
} from "@/lib/reading-appearance";

type Props = { onClose: () => void };

export default function ReadingApp({ onClose }: Props) {
    const pane = usePaneSize();
    const wide = getTabletLayout(pane.width).shelfAlongsideReader;
    const [ready, setReady] = useState(false);
    const [activeBook, setActiveBook] = useState<Book | null>(null);
    const [appearance, setAppearance] = useState<ReadingAppearance>(DEFAULT_READING_APPEARANCE);
    const [backgroundUrl, setBackgroundUrl] = useState<string | null>(null);
    const [customFontFamily, setCustomFontFamily] = useState<string | undefined>(undefined);
    // Keep track of the last opened book so viewer stays mounted
    const [lastBook, setLastBook] = useState<Book | null>(null);
    const backgroundUrlRef = useRef<string | null>(null);
    const customFontUrlRef = useRef<string | null>(null);

    const updateBackgroundUrl = (nextUrl: string | null) => {
        if (backgroundUrlRef.current && backgroundUrlRef.current !== nextUrl) {
            URL.revokeObjectURL(backgroundUrlRef.current);
        }
        backgroundUrlRef.current = nextUrl;
        setBackgroundUrl(nextUrl);
    };

    const loadCustomFontFace = async (blob: Blob | null) => {
        if (customFontUrlRef.current) {
            URL.revokeObjectURL(customFontUrlRef.current);
            customFontUrlRef.current = null;
        }
        setCustomFontFamily(undefined);
        if (!blob) return;

        const url = URL.createObjectURL(blob);
        customFontUrlRef.current = url;
        const familyName = `AIVirtualPhoneReadingFont_${Date.now()}`;

        try {
            const face = new FontFace(familyName, `url("${url}")`);
            await face.load();
            document.fonts.add(face);
            setCustomFontFamily(`"${familyName}"`);
        } catch {
            setCustomFontFamily(undefined);
        }
    };

    useEffect(() => {
        hydrateReadingStorage().then(() => setReady(true));
        setAppearance(loadReadingAppearance());
        void loadReadingBackground().then((blob) => {
            updateBackgroundUrl(blob ? URL.createObjectURL(blob) : null);
        });
        void loadReadingCustomFont().then((blob) => {
            void loadCustomFontFace(blob);
        });
        return () => {
            if (backgroundUrlRef.current) URL.revokeObjectURL(backgroundUrlRef.current);
            if (customFontUrlRef.current) URL.revokeObjectURL(customFontUrlRef.current);
        };
    }, []);

    const handleSaveAppearance = async (
        nextAppearance: ReadingAppearance,
        options: { backgroundFile: File | null; clearBackground: boolean; customFontFile: File | null; clearCustomFont: boolean },
    ) => {
        const normalized = saveReadingAppearance(nextAppearance);
        setAppearance(normalized);

        if (options.clearBackground) {
            await saveReadingBackground(null);
            updateBackgroundUrl(null);
            return;
        }

        if (options.backgroundFile) {
            await saveReadingBackground(options.backgroundFile);
            updateBackgroundUrl(URL.createObjectURL(options.backgroundFile));
        }

        if (options.clearCustomFont) {
            await saveReadingCustomFont(null);
            await loadCustomFontFace(null);
            return;
        }

        if (options.customFontFile) {
            await saveReadingCustomFont(options.customFontFile);
            await loadCustomFontFace(options.customFontFile);
        }
    };

    const appearanceStyle = {
        ["--reading-font-family" as "--reading-font-family"]: resolveReadingFontFamily(appearance.fontFamily, customFontFamily),
        ["--reading-font-size" as "--reading-font-size"]: `${appearance.fontSize}px`,
        ["--reading-text-color" as "--reading-text-color"]: appearance.textColor,
        ["--reading-line-height" as "--reading-line-height"]: String(appearance.lineHeight),
        ["--reading-bg-image" as "--reading-bg-image"]: backgroundUrl ? `url("${backgroundUrl}")` : "none",
    } as CSSProperties;
    const hiddenViewerStyle = {
        position: "absolute",
        inset: 0,
        visibility: "hidden",
        pointerEvents: "none",
    } as CSSProperties;

    return (
        <div ref={pane.ref} className="reading-app-workspace absolute inset-0" data-wide={String(wide)} data-book-active={String(Boolean(activeBook))} style={appearanceStyle}>
            {!ready ? <div className="flex h-full items-center justify-center" style={{ background: "#fffced" }}>加载中...</div> : <>
            <div className="reading-library-pane" inert={Boolean(activeBook) && !wide} aria-hidden={Boolean(activeBook) && !wide}>
                <ReadingShelf
                    onOpenBook={book => { setLastBook(book); setActiveBook(book); }}
                    onClose={onClose}
                    appearance={appearance}
                    backgroundUrl={backgroundUrl}
                    onSaveAppearance={handleSaveAppearance}
                    activeBookId={activeBook?.id}
                    onBookRemoved={id => { if (lastBook?.id === id) { setLastBook(null); setActiveBook(null); } }}
                />
            </div>
            <div className="reading-reader-pane" inert={!activeBook && !wide} aria-hidden={!activeBook && !wide}>
            {lastBook && (
                <div style={activeBook ? undefined : hiddenViewerStyle} aria-hidden={!activeBook}>
                    <ReadingViewer book={lastBook} onBack={() => setActiveBook(null)} />
                </div>
            )}
            {!activeBook && wide && <div className="tablet-detail-placeholder"><BookOpen size={42} strokeWidth={1.3} /><h2>选择一本书，继续阅读</h2><p>书架和阅读内容可以并排查看</p></div>}
            </div>
            </>}
        </div>
    );
}
