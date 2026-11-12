export const SHARED_PERSONA_KEYS = ["ai_phone_characters_v1", "ai_phone_bg_items_v1", "ai_phone_character_versions_v1", "ai_phone_character_worlds_v1", "ai_phone_user_identities_v1"] as const;
export const SHARED_ARCHIVE_CHANGED = "shared-persona-data-changed";
export function notifySharedPersonaChange(key: string) {
    if (typeof window !== "undefined" && (SHARED_PERSONA_KEYS as readonly string[]).includes(key)) window.dispatchEvent(new Event(SHARED_ARCHIVE_CHANGED));
}
