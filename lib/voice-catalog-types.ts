export type VoiceCatalogEntry = {
    id: string;
    name: string;
    locale?: string;
    createdAt?: number;
    group?: string;
};
export type VoiceCatalogCache = {
    models: VoiceCatalogEntry[];
    voices: VoiceCatalogEntry[];
    updatedAt: number;
};
export type VoiceCatalogResult = VoiceCatalogCache & {
    modelStatus: "fetched" | "unsupported" | "error";
    voiceStatus: "fetched" | "unsupported" | "error";
    messages: string[];
};
