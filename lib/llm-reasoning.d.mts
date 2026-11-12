export function applyLowReasoning<T extends Record<string, unknown>>(
    body: T,
    protocol: "openai-compatible" | "gemini" | "anthropic" | "responses",
    modelName: unknown,
    baseUrl?: string,
): T;
