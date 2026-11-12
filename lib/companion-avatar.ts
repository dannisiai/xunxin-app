import { kvGet, kvSet, kvRemove, registerDynamicPrefix } from "./kv-db";
import type { Character } from "./character-types";

const PREFIX = "ai_phone_companion_avatar_v1:";
const MAX_DATA_URL_LENGTH = 200_000;
export const COMPANION_AVATAR_SIZE = 192;
export const COMPANION_AVATAR_UPDATED_EVENT = "companion-avatar-updated";
registerDynamicPrefix(PREFIX);

export function loadCompanionAvatar(characterId: string): string | null {
    if (!characterId) return null;
    const value = kvGet(PREFIX + characterId);
    return value?.startsWith("data:image/png;base64,") && value.length <= MAX_DATA_URL_LENGTH ? value : null;
}

export function resolveCompanionAvatar(character: Pick<Character, "id">): string | undefined {
    return loadCompanionAvatar(character.id) || undefined;
}

export function subscribeCompanionAvatar(listener: () => void): () => void {
    const refresh = () => listener();
    window.addEventListener(COMPANION_AVATAR_UPDATED_EVENT, refresh);
    return () => window.removeEventListener(COMPANION_AVATAR_UPDATED_EVENT, refresh);
}

export function saveCompanionAvatar(characterId: string, dataUrl: string | null): void {
    if (!characterId.trim()) throw new Error("请先选择 AI，再更换头像。");
    if (dataUrl !== null && (!dataUrl.startsWith("data:image/png;base64,") || dataUrl.length > MAX_DATA_URL_LENGTH)) {
        throw new Error("头像图片无效，请重新选择图片。");
    }
    if (dataUrl === null) kvRemove(PREFIX + characterId);
    else kvSet(PREFIX + characterId, dataUrl);
    window.dispatchEvent(new CustomEvent(COMPANION_AVATAR_UPDATED_EVENT, { detail: { characterId } }));
}

/** Store a small, square image so native overlays never receive the full uploaded photo. */
export async function fileToCompanionAvatar(file: File): Promise<string> {
    if (file.size > 20 * 1024 * 1024) throw new Error("请选择小于 20 MB 的头像图片。");
    const bitmap = await createImageBitmap(file);
    try {
        if (!bitmap.width || !bitmap.height) throw new Error("无法读取这张图片。");
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = COMPANION_AVATAR_SIZE;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("无法处理头像图片。");
        const side = Math.min(bitmap.width, bitmap.height);
        context.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side,
            0, 0, COMPANION_AVATAR_SIZE, COMPANION_AVATAR_SIZE);
        const dataUrl = canvas.toDataURL("image/png");
        if (dataUrl.length > MAX_DATA_URL_LENGTH) throw new Error("头像图片过大，请换一张图片。");
        return dataUrl;
    } finally {
        bitmap.close();
    }
}
