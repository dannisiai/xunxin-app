"use client";

import { useState, useEffect, useRef, useCallback, useContext } from "react";
import { Plus, Play, Pause, AlertCircle, RefreshCw, FileEdit, Trash2, X, Check, Upload, List } from "lucide-react";
import { SettingsContext } from "../phone-settings-app";
import type { VoiceApiConfig } from "@/lib/settings-types";
import { loadVoiceConfigs, saveVoiceConfigs } from "@/lib/settings-storage";
import { speakSpeech } from "@/lib/tts-service";
import { ConfirmDialog } from "@/components/ui/modal";
import { Toggle, Input } from "@/components/ui/form";
import { Alert } from "@/components/ui/feedback";
import { VoiceProviderFields } from "./voice-provider-fields";
import { voiceCatalogConfig, voiceCatalogFingerprint } from "@/lib/voice-api";
import type { VoiceCatalogResult } from "@/lib/voice-catalog-types";
import { isMiniCPMVoiceConfig, isUnusedLegacyVoicePreset, resolveVoiceMode, usesReferenceAudioVoice } from "@/lib/voice-mode";

const SUPPORTED_VOICE_PROVIDERS = new Set(["Custom"]);
const VOICE_PROVIDER_OPTIONS = [
    { value: "Custom", label: "自定义" },
];






type VoiceOption = { id: string; name: string; createdAt?: number };

function uniqueOptions(options: VoiceOption[]): VoiceOption[] {
    const seen = new Set<string>();
    return options.filter(option => {
        if (!option.id || seen.has(option.id)) return false;
        seen.add(option.id);
        return true;
    });
}

function defaultVoiceOptions(_provider: string): VoiceOption[] {
    return [];
}

function voiceOptionsForConfig(config: VoiceApiConfig, fetchedVoices: Record<string, VoiceOption[]>): VoiceOption[] {
    return uniqueOptions([
        ...(config.catalog?.voices || []),
        ...(fetchedVoices[config.id] || []),
        ...(config.customVoices || []),
    ]);
}

function normalizeVoiceConfigs(configs: VoiceApiConfig[]): VoiceApiConfig[] {
    return configs
        .filter(config => !isUnusedLegacyVoicePreset(config) && config.provider === "Custom")
        .map(config => ({
            ...config,
            provider: "Custom" as const,
            customTtsProtocol: config.customTtsProtocol || "openai-compatible",
        }));
}

function providerSelectValue(config: VoiceApiConfig): string {
    return config.provider === "Custom" ? "Custom" : "";
}

export function VoiceSettings({ embedded = false, accountId }: { embedded?: boolean; accountId?: string } = {}) {
    const { setSubpageRightAction } = useContext(SettingsContext);
    const [configs, setConfigs] = useState<VoiceApiConfig[]>([]);
    const configsRef = useRef<VoiceApiConfig[]>([]);
    const catalogRequests = useRef(new Map<string, AbortController>());
    const [catalogNotices, setCatalogNotices] = useState<Record<string, string>>({});
    useEffect(() => () => { for (const request of catalogRequests.current.values()) request.abort(); catalogRequests.current.clear(); }, []);
    const [editingId, setEditingId] = useState<string | null>(null);
    const [isNewConfig, setIsNewConfig] = useState(false);
    const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
    const [playingVoiceId, setPlayingVoiceId] = useState<string | null>(null);
    const [manualModelIds, setManualModelIds] = useState<Record<string, boolean>>({});
    const [manualVoiceIds, setManualVoiceIds] = useState<Record<string, boolean>>({});
    const [isLoaded, setIsLoaded] = useState(false);
    const previewAbortRef = useRef<AbortController | null>(null);
    const previewPlaybackRef = useRef<(() => void) | null>(null);
    useEffect(() => () => {
        previewAbortRef.current?.abort();
        previewPlaybackRef.current?.();
    }, []);

    // Fetching states for Voices
    const [isFetching, setIsFetching] = useState<Record<string, boolean>>({});
    const [fetchedVoices, setFetchedVoices] = useState<Record<string, VoiceOption[]>>({});
    const [fetchError, setFetchError] = useState<Record<string, string>>({});

    // Load from localStorage on mount
    useEffect(() => {
        const stored = loadVoiceConfigs(accountId);
        const loaded = normalizeVoiceConfigs(stored);
        configsRef.current = loaded;
        setConfigs(loaded);
        saveVoiceConfigs(loaded, accountId);
        setIsLoaded(true);
    }, [accountId]);

    const persist = useCallback((newConfigs: VoiceApiConfig[]) => {
        configsRef.current = newConfigs;
        setConfigs(newConfigs);
        saveVoiceConfigs(newConfigs, accountId);
    }, [accountId]);

    const addConfig = useCallback(() => {
        const newConfig: VoiceApiConfig = {
            id: `voice-${Date.now()}`,
            name: "新语音配置",
            provider: "Custom",
            customTtsProtocol: "openai-compatible",
            voiceMode: "tts",
            apiKey: "",
            defaultVoice: "",
            enableSTT: true,
            enableTTS: true,
        };
        persist([...configs, newConfig]);
        setIsNewConfig(true);
        setEditingId(newConfig.id);
    }, [configs, persist]);

    useEffect(() => {
        if (embedded) return;
        setSubpageRightAction("voice",
            <button
                onClick={addConfig}
                className="inline-flex h-10 items-center justify-center gap-1.5 whitespace-nowrap rounded-[20px] bg-black px-4 text-xs font-bold text-white shadow-sm transition-all hover:bg-gray-800 hover:shadow-md active:scale-95 focus:outline-none"
            >
                <Plus size={15} strokeWidth={1.8} />
                <span>新增语音方案</span>
            </button>
        );
        return () => setSubpageRightAction("voice", null);
    }, [addConfig, embedded, setSubpageRightAction]);

    const cancelCatalog = (id: string) => {
        const request = catalogRequests.current.get(id);
        if (request) { request.abort(); catalogRequests.current.delete(id); }
        setIsFetching(prev => ({ ...prev, [id]: false }));
    };
    const updateConfig = (id: string, updates: Partial<VoiceApiConfig>) => {
        previewAbortRef.current?.abort();
        previewPlaybackRef.current?.(); previewPlaybackRef.current = null;
        setPlayingVoiceId(null);
        const reset = ["provider", "baseUrl", "apiKey", "region", "voiceAuthMode", "quotaProjectId", "modelListUrl", "voiceListUrl", "voiceMode", "customTtsProtocol", "miniCPMGatewayUrl", "realtimeProtocol", "webSocketProtocol", "webSocketRealtime"]
            .some(key => Object.prototype.hasOwnProperty.call(updates, key));
        if (reset) {
            cancelCatalog(id);
            setCatalogNotices(prev => ({ ...prev, [id]: "" }));
            setFetchError(prev => ({ ...prev, [id]: "" }));
            setFetchedVoices(prev => ({ ...prev, [id]: [] }));
        }
        persist(configsRef.current.map(c => c.id === id ? { ...c, ...updates, ...(reset ? { catalog: undefined } : {}) } : c));
    };

    const updateProvider = (id: string, providerOption: string) => {
        if (!VOICE_PROVIDER_OPTIONS.some(option => option.value === providerOption)) return;
        const current = configsRef.current.find(c => c.id === id);
        const providerDefaults = { modelListUrl: undefined, voiceListUrl: undefined, voiceLocale: undefined, voiceMode: "tts" as const };
        setFetchedVoices(prev => ({ ...prev, [id]: [] }));
        setFetchError(prev => ({ ...prev, [id]: "" }));
        if (providerOption === "Custom") {
            updateConfig(id, {
                ...providerDefaults,
                provider: "Custom",
                customTtsProtocol: "openai-compatible",
                baseUrl: current?.baseUrl || "",
                model: current?.model || "",
                defaultVoice: current?.defaultVoice || "",
            });
            setManualModelIds(prev => ({ ...prev, [id]: true }));
            setManualVoiceIds(prev => ({ ...prev, [id]: true }));
            return;
        }
    };

    const removeConfig = (id: string) => {
        previewAbortRef.current?.abort();
        previewPlaybackRef.current?.(); previewPlaybackRef.current = null;
        setPlayingVoiceId(null);
        cancelCatalog(id);
        persist(configsRef.current.filter(c => c.id !== id));

        // Cleanup states
        const newFetchedVoices = { ...fetchedVoices };
        delete newFetchedVoices[id];
        setFetchedVoices(newFetchedVoices);

        const newFetchError = { ...fetchError };
        delete newFetchError[id];
        setFetchError(newFetchError);

        setManualModelIds(prev => {
            const next = { ...prev };
            delete next[id];
            return next;
        });
        setManualVoiceIds(prev => {
            const next = { ...prev };
            delete next[id];
            return next;
        });
    };

    const fetchVoices = async (config: VoiceApiConfig) => {
        if (isMiniCPMVoiceConfig(config) || !SUPPORTED_VOICE_PROVIDERS.has(config.provider)) return;
        cancelCatalog(config.id);
        const controller = new AbortController();
        catalogRequests.current.set(config.id, controller);
        const fingerprint = voiceCatalogFingerprint(config);
        const timer = setTimeout(() => controller.abort(), 30_000);
        setIsFetching(prev => ({ ...prev, [config.id]: true }));
        setFetchError(prev => ({ ...prev, [config.id]: "" }));
        const stillCurrent = () => {
            const current = configsRef.current.find(item => item.id === config.id);
            return catalogRequests.current.get(config.id) === controller && current
                && voiceCatalogFingerprint(current) === fingerprint;
        };
        try {
            const response = await fetch("/api/voice/catalog", {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ config: voiceCatalogConfig(config) }), signal: controller.signal,
            });
            const data = await response.json().catch(() => null);
            if (!response.ok) throw new Error(data?.error || "拉取失败（HTTP " + response.status + "）");
            if (!Array.isArray(data?.models) || !Array.isArray(data?.voices)) throw new Error("未识别到模型或音色列表");
            if (!Array.isArray(data.messages) || !["fetched", "unsupported", "error"].includes(data.modelStatus)
                || !["fetched", "unsupported", "error"].includes(data.voiceStatus)) throw new Error("语音列表响应格式无效");
            if (!stillCurrent() || controller.signal.aborted) return;
            const result = data as VoiceCatalogResult;
            const current = configsRef.current.find(item => item.id === config.id)!;
            updateConfig(config.id, { catalog: {
                models: result.modelStatus === "fetched" && result.models.length ? result.models : current.catalog?.models || [],
                voices: result.voiceStatus === "fetched" && result.voices.length ? result.voices : current.catalog?.voices || [],
                updatedAt: result.updatedAt,
            } });
            const counts = [
                result.modelStatus === "fetched" ? "联网模型 " + result.models.length + " 项" : "",
                result.voiceStatus === "fetched" ? "联网音色 " + result.voices.length + " 项" : "",
            ].filter(Boolean).join("，");
            setCatalogNotices(prev => ({ ...prev, [config.id]: [counts, ...result.messages].filter(Boolean).join("\n") }));
        } catch (error) {
            if (stillCurrent()) setFetchError(prev => ({ ...prev, [config.id]: controller.signal.aborted
                ? "拉取已取消或超时，已有配置与列表已保留。" : error instanceof Error ? error.message : String(error) }));
        } finally {
            clearTimeout(timer);
            if (catalogRequests.current.get(config.id) === controller) {
                catalogRequests.current.delete(config.id);
                setIsFetching(prev => ({ ...prev, [config.id]: false }));
            }
        }
    };

    const togglePreview = async (config: VoiceApiConfig) => {
        const stopping = playingVoiceId === config.id;
        previewAbortRef.current?.abort();
        previewPlaybackRef.current?.(); previewPlaybackRef.current = null;
        if (stopping) { setPlayingVoiceId(null); return; }
        const controller = new AbortController();
        previewAbortRef.current = controller;
        setPlayingVoiceId(config.id);
        const current = () => previewAbortRef.current === controller && !controller.signal.aborted;
        const finish = () => {
            if (previewAbortRef.current !== controller || controller.signal.aborted) return;
            previewPlaybackRef.current = null;
            setPlayingVoiceId(null);
        };
        try {
            const previewText = "你好，这是一段语音试听，很高兴认识你。";
            const playback = speakSpeech(previewText, config, { signal: controller.signal });
            previewPlaybackRef.current = playback.abort;
            await playback.promise;
            finish();
        } catch (failure) {
            if (current()) { finish(); setFetchError(previous => ({ ...previous,
                [config.id]: "语音试听失败：" + (failure instanceof Error ? failure.message : String(failure)) })); }
        }
    };

    if (!isLoaded) return null;

    return (
        <div className="flex flex-col gap-6">
            {embedded ? <div className="flex flex-wrap items-center justify-between gap-3">
                <h3 className="m-0 font-semibold">语音方案</h3>
                {configs.length > 0 && <button type="button" onClick={addConfig} className="ui-btn ui-btn-secondary">
                    <Plus size={16} /> 新增语音方案
                </button>}
            </div> : <div className="flex items-center">
                <h2 className="m-0 mx-2 ts-28 font-bold italic leading-none text-black">Voice API</h2>
            </div>}

            {configs.length === 0 ? (
                <div className="ui-empty">
                    <div className="ui-icon-circle">
                        <Play size={24} />
                    </div>
                    <span className="menu-label font-semibold">没有语音配置</span>
                    <span className="menu-desc max-w-[240px]">
                        配置语音 API 以启用语音通话和回复播报。
                    </span>
                    <button onClick={addConfig} className="ui-btn ui-btn-primary rounded-[20px] mt-2">
                        <Plus size={16} /> 添加配置
                    </button>
                </div>
            ) : (
                <div className="grid grid-cols-2 gap-3">
                    {configs.map(config => (
                        <div
                            key={config.id}
                            className="ui-config-card min-w-0 cursor-pointer"
                            style={{ aspectRatio: "3 / 2", padding: "12px", justifyContent: "space-between" }}
                            role="button"
                            tabIndex={0}
                            aria-label={`编辑 ${config.name || config.provider}`}
                            onClick={() => setEditingId(config.id)}
                            onKeyDown={(event) => {
                                if (event.target !== event.currentTarget) return;
                                if (event.key === "Enter" || event.key === " ") {
                                    event.preventDefault();
                                    setEditingId(config.id);
                                }
                            }}
                        >
                            <div className="min-w-0 flex flex-col gap-1">
                                <span className="truncate text-[calc(14.4px*var(--app-text-scale,1))] font-bold leading-tight text-[var(--c-text-title)]">{config.name || config.provider}</span>
                                <span className="menu-desc truncate">{usesReferenceAudioVoice(config) ? "参考音频克隆" : config.defaultVoice || config.model || config.provider || "未设置音色"}</span>
                            </div>
                            <div className="flex gap-2 shrink-0 items-center justify-end">
                                <button
                                    type="button"
                                    onClick={(event) => {
                                        event.stopPropagation();
                                        setEditingId(config.id);
                                    }}
                                    className="ui-link-btn"
                                >
                                    <FileEdit size={18} />
                                </button>
                                <button
                                    type="button"
                                    onClick={(event) => {
                                        event.stopPropagation();
                                        setConfirmDeleteId(config.id);
                                    }}
                                    className="ui-link-btn"
                                    data-variant="danger"
                                >
                                    <Trash2 size={18} />
                                </button>
                            </div>
                        </div>
                    ))}
                </div>
            )}

            {editingId && (
                <div className="modal-overlay modal-overlay-bottom">
                    <div className="modal-sheet" data-ui="modal-sheet">
                        <div className="modal-header" data-ui="modal-header">
                            <button type="button" aria-label="取消编辑语音配置" onClick={() => { if (isNewConfig && editingId) removeConfig(editingId); setIsNewConfig(false); setEditingId(null); }} className="modal-header-btn modal-header-btn-muted"><X size={18} /></button>
                            <span className="modal-header-title">{isNewConfig ? "添加语音配置" : "编辑语音配置"}</span>
                            <button type="button" aria-label="保存语音配置" onClick={() => { setIsNewConfig(false); setEditingId(null); }} className="modal-header-btn modal-header-btn-action"><Check size={18} /></button>
                        </div>

                        <div className="modal-body hide-scrollbar pb-10" data-ui="modal-body">
                            {(() => {
                                const config = configs.find(c => c.id === editingId);
                                if (!config) return null;
                                return (
                                    <div className="flex flex-col gap-4">
                                        <div className="flex flex-col gap-1">
                                            <label className="menu-desc ml-1">配置名称 (Name)</label>
                                            <Input
                                                type="text"
                                                value={config.name || ""}
                                                onChange={(e) => updateConfig(config.id, { name: e.target.value })}
                                                placeholder="例如: 我的语音助手"
                                            />
                                        </div>
                                        <div className="flex flex-col gap-1">
                                            <label className="menu-desc ml-1">服务商 (Provider)</label>
                                            <select
                                                value={providerSelectValue(config)}
                                                onChange={(e) => updateProvider(config.id, e.target.value)}
                                                className="ui-select"
                                            >
                                                {!SUPPORTED_VOICE_PROVIDERS.has(config.provider) && <option value="" disabled>请选择服务商</option>}
                                                {VOICE_PROVIDER_OPTIONS.map(option => (
                                                    <option key={option.value} value={option.value}>{option.label}</option>
                                                ))}
                                            </select>
                                        </div>

                                        {SUPPORTED_VOICE_PROVIDERS.has(config.provider) && resolveVoiceMode(config) === "tts" && !isMiniCPMVoiceConfig(config) && <div className="flex flex-col gap-1">
                                            <label className="menu-desc ml-1">API Key / Access Token{config.provider === "Custom" ? "（按服务商要求填写）" : ""}</label>
                                            <Input
                                                type="password"
                                                value={config.apiKey}
                                                onChange={(e) => updateConfig(config.id, { apiKey: e.target.value })}
                                                placeholder="输入密钥..."
                                            />
                                        </div>}
                                        <VoiceProviderFields config={config}
                                            onChange={patch => updateConfig(config.id, patch)}
                                            onFetch={() => fetchVoices(config)} fetching={!!isFetching[config.id]}
                                            onCancel={() => { cancelCatalog(config.id); setCatalogNotices(prev => ({ ...prev, [config.id]: "已停止拉取，保留已有配置与列表。" })); }}
                                            message={catalogNotices[config.id]} />
                                        <div className="flex flex-col gap-2">
                                            {config.provider === "Custom" && resolveVoiceMode(config) === "tts" && (
                                                <div className="flex flex-col gap-2 p-2.5 rounded-lg border border-[var(--border-color)] bg-[var(--card-bg)] text-xs">
                                                    <div className="flex items-center justify-between">
                                                        <span className="font-medium text-[var(--foreground)]">参考音频克隆音色 (可选)</span>
                                                        <span className="text-[11px] text-[var(--muted-foreground)]">支持上传格式：WAV、MP3、FLAC、M4A</span>
                                                    </div>
                                                    <div className="flex flex-col gap-1">
                                                        <input
                                                            type="file"
                                                            accept=".wav,.mp3,.flac,.m4a,audio/wav,audio/x-wav,audio/mpeg,audio/flac,audio/x-flac,audio/mp4,audio/x-m4a"
                                                            className="ui-input text-xs"
                                                            onChange={(e) => {
                                                                const file = e.target.files?.[0];
                                                                if (!file) return;
                                                                const reader = new FileReader();
                                                                reader.onload = () => {
                                                                    updateConfig(config.id, {
                                                                        referenceAudio: reader.result as string,
                                                                        referenceAudioName: file.name,
                                                                    });
                                                                };
                                                                reader.readAsDataURL(file);
                                                            }}
                                                        />
                                                    </div>
                                                    {config.referenceAudio && (
                                                        <div className="flex items-center justify-between bg-[var(--bg-muted)] px-2 py-1.5 rounded">
                                                            <span className="truncate max-w-[180px] text-[11px]" title={config.referenceAudioName}>
                                                                {config.referenceAudioName || "已保存参考音频"}
                                                            </span>
                                                            <button
                                                                type="button"
                                                                className="text-red-500 hover:underline text-[11px]"
                                                                onClick={() => updateConfig(config.id, { referenceAudio: undefined, referenceAudioName: undefined })}
                                                            >
                                                                移除音频
                                                            </button>
                                                        </div>
                                                    )}
                                                    {usesReferenceAudioVoice(config) && (
                                                        <p className="m-0 text-[11px] text-[var(--muted-foreground)]">已使用上传的参考音频，无需填写音色 ID。</p>
                                                    )}
                                                    <div className="flex flex-col gap-1">
                                                        <label className="text-[11px] text-[var(--muted-foreground)]">参考文本 (Prompt Text, 可选)</label>
                                                        <Input
                                                            type="text"
                                                            value={config.referenceText || ""}
                                                            placeholder="参考音频中所说的文字内容"
                                                            onChange={(e) => updateConfig(config.id, { referenceText: e.target.value })}
                                                            className="text-xs"
                                                        />
                                                    </div>
                                                </div>
                                            )}
                                            {(resolveVoiceMode(config) === "tts" || isMiniCPMVoiceConfig(config)) && <button type="button" onClick={() => togglePreview(config)}
                                                disabled={!SUPPORTED_VOICE_PROVIDERS.has(config.provider)}
                                                className="ui-btn ui-btn-soft-action" data-active={playingVoiceId === config.id}>
                                                {playingVoiceId === config.id ? <Pause size={18} /> : <Play size={18} />}
                                                {playingVoiceId === config.id ? "停止试听" : "流式试听合成音色"}
                                            </button>}
                                            {fetchError[config.id] && <Alert variant="danger"><AlertCircle size={14} />{fetchError[config.id]}</Alert>}
                                        </div>


                                    </div>
                                )
                            })()}
                        </div>
                    </div>
                </div>
            )}

            {confirmDeleteId && (
                <ConfirmDialog
                    title="确认删除？"
                    message="删除配置后无法恢复。是否继续？"
                    icon={AlertCircle}
                    variant="danger"
                    confirmLabel="确认删除"
                    cancelLabel="取消"
                    onConfirm={() => {
                        removeConfig(confirmDeleteId);
                        setConfirmDeleteId(null);
                    }}
                    onCancel={() => setConfirmDeleteId(null)}
                />
            )}
        </div>
    );
}
