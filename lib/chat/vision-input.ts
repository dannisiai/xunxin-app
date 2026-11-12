import type { LlmRequestPayload } from "@/lib/llm-provider-adapter";

/** The current capture must survive presets, history limits, plugins and provider conversion. */
export type RequiredVisionInput = { imageUrl: string; text: string };

export function assertRequiredVisionRequest(request: LlmRequestPayload, required?: RequiredVisionInput): void {
    if (!required) return;
    const data = required.imageUrl.match(/^data:image\/[^;,]+;base64,([\s\S]+)$/)?.[1];
    if (!data) throw new Error("当前屏幕图片读取失败，请重新截图。");
    let hasImage = false;
    const texts: string[] = [];
    const visit = (value: unknown): void => {
        if (!value || typeof value !== "object") return;
        if (Array.isArray(value)) { value.forEach(visit); return; }
        const part = value as Record<string, unknown>;
        if (typeof part.text === "string") texts.push(part.text);
        if (typeof part.content === "string") texts.push(part.content);
        // OpenAI-compatible, Anthropic and Gemini use different image envelopes.
        const image = part.image_url as { url?: unknown } | undefined;
        const source = part.source as { type?: unknown; data?: unknown } | undefined;
        const inline = (part.inlineData ?? part.inline_data) as { data?: unknown } | undefined;
        if (part.type === "image_url" && image?.url === required.imageUrl
            || part.type === "image" && source?.type === "base64" && source.data === data
            || inline?.data === data) hasImage = true;
        Object.values(part).forEach(visit);
    };
    visit(request.body);
    if (!hasImage) throw new Error("本轮截图未进入模型请求，请检查识图开关、预设历史条目和聊天插件。");
    const normalize = (text: string) => text.replace(/\s+/g, " ").trim();
    if (!normalize(texts.join("\n")).includes(normalize(required.text))) {
        throw new Error("本轮提问未完整进入模型请求，请检查预设、正则和聊天插件是否移除了图片正文。");
    }
}
