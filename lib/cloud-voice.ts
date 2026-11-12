import { loadActiveAccountId } from "./account-client";
import { kvGet, kvSet, registerDynamicPrefix } from "./kv-db";
import type { VoiceApiConfig } from "./settings-types";
import { isUnusedLegacyVoicePreset, migrateLegacyVoiceConfig } from "./voice-mode";

const STORAGE_PREFIX = "ai_phone_cloud_voice_v1:";
export const CLOUD_VOICE_UPDATED_EVENT = "settings-voice-updated";
registerDynamicPrefix(STORAGE_PREFIX);

export type CloudVoiceSettings = {
    enabled: boolean;
    defaultConfigId: string;
    configs: VoiceApiConfig[];
};

function emptySettings(): CloudVoiceSettings {
    return { enabled: false, defaultConfigId: "", configs: [] };
}

function validAccount(accountId: string): boolean {
    return typeof window !== "undefined" && /^sub2api_[a-f0-9]{16}_\d+$/.test(accountId);
}

function normalizeConfigs(configs: unknown): VoiceApiConfig[] {
    if (!Array.isArray(configs)) return [];
    return configs.filter((config): config is VoiceApiConfig => Boolean(config && typeof config === "object"
        && typeof config.id === "string" && config.id && typeof config.provider === "string"))
        .filter(config => !isUnusedLegacyVoicePreset(config)).map(migrateLegacyVoiceConfig);
}

export function loadCloudVoiceSettings(accountId = loadActiveAccountId()): CloudVoiceSettings {
    if (!validAccount(accountId)) return emptySettings();
    try {
        const raw = kvGet(`${STORAGE_PREFIX}${accountId}`);
        if (!raw) return emptySettings();
        const data = JSON.parse(raw) as Partial<CloudVoiceSettings> | null;
        const configs = normalizeConfigs(data?.configs);
        const selectedId = typeof data?.defaultConfigId === "string" ? data.defaultConfigId : "";
        return {
            enabled: data?.enabled === true,
            defaultConfigId: configs.some(config => config.id === selectedId) ? selectedId : configs[0]?.id || "",
            configs,
        };
    } catch { return emptySettings(); }
}

function save(settings: CloudVoiceSettings, accountId: string): void {
    if (!validAccount(accountId)) return;
    kvSet(`${STORAGE_PREFIX}${accountId}`, JSON.stringify(settings));
    window.dispatchEvent(new CustomEvent(CLOUD_VOICE_UPDATED_EVENT));
    window.dispatchEvent(new CustomEvent("settings-bindings-updated"));
}

export function saveCloudVoiceEnabled(enabled: boolean, accountId = loadActiveAccountId()): void {
    save({ ...loadCloudVoiceSettings(accountId), enabled }, accountId);
}

export function saveCloudVoiceConfigs(configs: VoiceApiConfig[], accountId = loadActiveAccountId()): void {
    const settings = loadCloudVoiceSettings(accountId);
    const normalized = normalizeConfigs(configs);
    save({
        ...settings, configs: normalized,
        defaultConfigId: normalized.some(config => config.id === settings.defaultConfigId)
            ? settings.defaultConfigId : normalized[0]?.id || "",
    }, accountId);
}

export function saveCloudVoiceDefaultConfig(configId: string, accountId = loadActiveAccountId()): void {
    const settings = loadCloudVoiceSettings(accountId);
    if (!settings.configs.some(config => config.id === configId)) return;
    save({ ...settings, defaultConfigId: configId }, accountId);
}
