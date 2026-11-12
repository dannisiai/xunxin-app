"use client";

import { useCallback, useEffect, useState } from "react";
import { VnSelect } from "./vn-select";
import { VnChapters } from "./vn-chapters";
import { VnPlayer } from "./vn-player";
import { hydrateVnStorage, loadVnConfig, loadVnSessions, saveVnConfig } from "@/lib/vn-storage";
import { PageShell } from "@/components/ui/page-shell";

interface VnAppProps {
  onClose: () => void;
  entry?: "chapters" | "continue";
}

type VnView = "select" | "chapters" | "player";

export function VnApp({ onClose, entry = "chapters" }: VnAppProps) {
  const [storageReady, setStorageReady] = useState(false);
  const [storageError, setStorageError] = useState(false);
  const [view, setView] = useState<VnView>("select");
  const [selectedCharacterId, setSelectedCharacterId] = useState<string | null>(null);
  const [activeChapterIndex, setActiveChapterIndex] = useState<number>(0);
  const [vnTheme, setVnThemeState] = useState(() => loadVnConfig("theme") || "default");

  useEffect(() => {
    let cancelled = false;
    void hydrateVnStorage().then(() => {
      if (!cancelled) setStorageReady(true);
    }).catch(() => {
      if (!cancelled) setStorageError(true);
    });
    return () => { cancelled = true; };
  }, []);

  const setVnTheme = useCallback((t: string) => {
    setVnThemeState(t);
    saveVnConfig("theme", t);
  }, []);

  const handleCharacterSelect = useCallback((characterId: string) => {
    setSelectedCharacterId(characterId);
    const session = loadVnSessions().find(item => item.characterId === characterId);
    const chapter = session?.chapters.find(item => item.index === session.activeChapterIndex)
      ?? session?.chapters.at(-1);
    if (entry === "continue" && chapter) {
      setActiveChapterIndex(chapter.index);
      setView("player");
    } else {
      setView("chapters");
    }
  }, [entry]);

  const handleChapterSelect = useCallback((chapterIndex: number) => {
    setActiveChapterIndex(chapterIndex);
    setView("player");
  }, []);

  const handleChapterEnd = useCallback(() => {
    setView("chapters");
  }, []);

  const handleBackFromChapters = useCallback(() => {
    setSelectedCharacterId(null);
    setView("select");
  }, []);

  const handleBackFromPlayer = useCallback(() => {
    setView("chapters");
  }, []);

  const handleOpenAssets = useCallback(() => {
    window.dispatchEvent(new CustomEvent("open-app", { detail: { appId: "resources", resourcePage: "vn_assets" } }));
  }, []);

  if (!storageReady) {
    return (
      <PageShell title="漫卷" onBack={onClose}>
        <p role="status">{storageError ? "读取漫卷记录失败，请退出后重试。" : "正在读取漫卷记录…"}</p>
      </PageShell>
    );
  }

  if (view === "select") {
    return (
      <VnSelect
        onClose={onClose}
        onSelect={handleCharacterSelect}
        vnTheme={vnTheme}
        onThemeChange={setVnTheme}
        onOpenAssets={handleOpenAssets}
      />
    );
  }

  if (view === "chapters" && selectedCharacterId) {
    return (
      <VnChapters
        characterId={selectedCharacterId}
        onClose={handleBackFromChapters}
        onSelect={handleChapterSelect}
        vnTheme={vnTheme}
      />
    );
  }

  if (view === "player" && selectedCharacterId) {
    return (
      <VnPlayer
        characterId={selectedCharacterId}
        chapterIndex={activeChapterIndex}
        onClose={handleBackFromPlayer}
        onChapterEnd={handleChapterEnd}
        vnTheme={vnTheme}
      />
    );
  }

  return null;
}
