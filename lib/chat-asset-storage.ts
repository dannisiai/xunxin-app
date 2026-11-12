import { getThemeAssetDataUrl, saveThemeAssetFromBlob } from "./theme-storage";
import type { ThemeAssetType } from "./theme-types";

// We can leverage the existing IndexedDB logic in theme-storage.ts by 
// just casting a custom type like "chat_bg" to ThemeAssetType to store chat assets.

export async function saveChatImageToIndexedDB(blob: Blob): Promise<string> {
    // "chat_bg" is not in ThemeAssetType strictly, but JS at runtime doesn't care.
    return saveThemeAssetFromBlob(blob, "chat_bg" as ThemeAssetType);
}

export async function getChatImageFromIndexedDB(id: string): Promise<string | null> {
    return getThemeAssetDataUrl(id);
}

/** Older screen companions stored images in the theme asset database. */
export function isLegacyChatImageRef(ref: string): boolean {
    return ref.startsWith("chat_bg_");
}

export function getUserImageCaption(msg: { role: string; content: string }): string {
    if (msg.role !== "user") return "";
    const text = msg.content.trim();
    // These are existing image placeholders/directives, not user-authored captions.
    return !text || /^\[(?:图片|照片(?::[^\]\n]*)?)\]$/.test(text) ? "" : text;
}
