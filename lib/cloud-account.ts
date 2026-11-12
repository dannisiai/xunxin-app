import { loadActiveAccountId } from "./account-client";
import { kvGet, kvSet } from "./kv-db";
import { loadCloudVoiceSettings } from "./cloud-voice";
import type { ApiConfig, BindingConfig, BindingSlot } from "./settings-types";

export const CLOUD_DEFAULT_MODEL = "__account_default__";

export function cloudAccountConfig(accountId = loadActiveAccountId()): ApiConfig | null {
    if (typeof window === "undefined" || !/^sub2api_[a-f0-9]{16}_\d+$/.test(accountId)) return null;
    return {
        id: `cloud-${accountId}`, name: "账户云端 API", provider: "Custom",
        // This is an account binding marker, never a model-service credential.
        apiKey: `account-session:${accountId}`, baseUrl: `${window.location.origin}/api/cloud/v1`,
        defaultModel: kvGet(`cloud-model:${accountId}`) || CLOUD_DEFAULT_MODEL,
        embeddingModel: CLOUD_DEFAULT_MODEL,
        enableNativeTools: true, enableImageRecognition: true, enableImageGeneration: false,
        preventEmptyGenerateRambling: true,
    };
}

export function saveCloudAccountModel(model: string): void {
    const accountId = loadActiveAccountId();
    if (!cloudAccountConfig(accountId)) return;
    kvSet(`cloud-model:${accountId}`, model.trim() || CLOUD_DEFAULT_MODEL);
    window.dispatchEvent(new CustomEvent("settings-bindings-updated"));
}

export function bindCloudAccount(config: BindingConfig): BindingConfig {
    const cloud = cloudAccountConfig();
    if (!cloud) return config;
    const voice = loadCloudVoiceSettings();
    const slot = (value: BindingSlot): BindingSlot => ({
        ...value, apiConfigId: cloud.id,
        voiceConfigId: voice.enabled ? voice.defaultConfigId || undefined : undefined,
    });
    return {
        ...config, globalDefaults: slot(config.globalDefaults),
        appDefaults: Object.fromEntries(Object.entries(config.appDefaults || {}).map(([key, value]) => [key, slot(value || {})])),
        characterBindings: config.characterBindings.map(binding => ({
            ...binding, defaults: slot(binding.defaults),
            appOverrides: Object.fromEntries(Object.entries(binding.appOverrides).map(([key, value]) => [key, slot(value || {})])),
        })),
        memorySummaryApiConfigId: cloud.id, mascotApiConfigId: cloud.id,
        reasoningTranslateApiConfigId: cloud.id, qaApiConfigId: cloud.id,
        embeddingApiConfigId: cloud.id,
    };
}
