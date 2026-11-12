// lib/memory-service.ts
// High-level memory orchestration: retrieve long-term memories for prompt injection.

import type { MemoryConfig, MemoryEntry } from "./memory-types";
import { loadMemoryEntriesByType, saveMemoryEmbedding } from "./memory-storage";
import { resolveAuxiliaryApiConfig } from "./settings-storage";
import { generateEmbeddingRecord, resolveEmbeddingModel, cosineSimilarity, compatibleEmbedding, keywordSearch } from "./memory-embedding";
import { estimateTokens } from "./token-counter";

/**
 * Retrieve relevant long-term memories for prompt injection.
 * Strategy:
 *   1. Total tokens <= longTermTokenBudget → return all
 *   2. Over budget + embedding API configured → vector-rank, fill until budget
 *   3. Over budget + no embedding → time-sorted (newest first), fill until budget
 * Embedding API is resolved from auxiliary binding (global, not per-character).
 */
export async function retrieveMemoriesForPrompt(
    characterId: string,
    currentContext: string,
    config: MemoryConfig
): Promise<MemoryEntry[]> {
    const longTermEntries = await loadMemoryEntriesByType(characterId, "long_term");
    if (longTermEntries.length === 0 || !currentContext.trim()) return [];

    const budget = config.longTermTokenBudget;

    // Calculate total tokens for all entries
    let totalTokens = 0;
    for (const entry of longTermEntries) {
        totalTokens += estimateTokens(entry.content) + 4;
    }

    // Strategy 1: all fit within budget → return all
    if (totalTokens <= budget) {
        return longTermEntries;
    }

    // Strategy 2: vector recall enabled + embedding API configured → vector search, fill by relevance
    const embeddingApiConfig = config.vectorRecallEnabled ? resolveAuxiliaryApiConfig("embeddingApiConfigId") : null;
    if (embeddingApiConfig && resolveEmbeddingModel(embeddingApiConfig)) {
        const queryEmbedding = await generateEmbeddingRecord(currentContext, embeddingApiConfig);
        if (queryEmbedding) {
            // Bound migration work per retrieval. Use the exact query model for all documents.
            const pending = keywordSearch(currentContext, longTermEntries.filter(entry => !compatibleEmbedding(entry, queryEmbedding)), longTermEntries.length);
            const candidates = [...pending.map(item => item.entry), ...longTermEntries.filter(entry => !compatibleEmbedding(entry, queryEmbedding) && !pending.some(item => item.entry.id === entry.id))].slice(0, 4);
            await Promise.all(candidates.map(async entry => {
                try {
                const record = await generateEmbeddingRecord(entry.content, { ...embeddingApiConfig, embeddingModel: queryEmbedding.model });
                if (!record || !compatibleEmbedding({ ...entry, ...record }, queryEmbedding)) return;
                await saveMemoryEmbedding(entry, record.embedding, record.embeddingSpace);
                entry.embedding = record.embedding; entry.embeddingSpace = record.embeddingSpace;
                } catch { /* Keep text recall available when migration or persistence fails. */ }
            }));
            const withEmbeddings = longTermEntries.filter(m => compatibleEmbedding(m, queryEmbedding));
            if (withEmbeddings.length > 0) {
                const scored = withEmbeddings.map(entry => ({
                    entry,
                    score: cosineSimilarity(queryEmbedding.embedding, entry.embedding!),
                }));
                scored.sort((a, b) => b.score - a.score);
                const missing = longTermEntries.filter(entry => !compatibleEmbedding(entry, queryEmbedding));
                const fallback = keywordSearch(currentContext, missing, missing.length).map(item => item.entry);
                return fillByBudget([...scored.map(s => s.entry), ...fallback, ...missing.filter(entry => !fallback.includes(entry))], budget);
            }
        }
    }

    // Strategy 3: no embedding support → newest first, fill by budget
    const sorted = [...longTermEntries].sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
    return fillByBudget(sorted, budget);
}

export async function retrieveCoreMemoriesForPrompt(
    characterId: string,
    config: MemoryConfig,
): Promise<MemoryEntry[]> {
    const coreEntries = await loadMemoryEntriesByType(characterId, "core");
    if (coreEntries.length === 0) return [];

    const sorted = [...coreEntries].sort((a, b) => {
        const aActive = a.metadata?.active ? 1 : 0;
        const bActive = b.metadata?.active ? 1 : 0;
        if (aActive !== bActive) return bActive - aActive;
        const aDate = String(a.metadata?.eventDate ?? a.updatedAt ?? a.createdAt);
        const bDate = String(b.metadata?.eventDate ?? b.updatedAt ?? b.createdAt);
        return bDate.localeCompare(aDate);
    });

    return fillByBudget(sorted, config.coreMemoryTokenBudget);
}

/** Pick entries in order until token budget is exhausted. */
function fillByBudget(entries: MemoryEntry[], budget: number): MemoryEntry[] {
    const result: MemoryEntry[] = [];
    let used = 0;
    for (const entry of entries) {
        const tokens = estimateTokens(entry.content) + 4;
        if (used + tokens > budget) continue;
        result.push(entry);
        used += tokens;
    }
    return result;
}
