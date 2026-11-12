const LOW_EFFORT = "low";

/** Only send provider controls to model families with a known compatible setting. */
export function applyLowReasoning(body, protocol, modelName, baseUrl = "") {
    const model = String(modelName || "").trim().toLowerCase().split("/").pop()?.split(":")[0] || "";
    const openAI = /^(?:o[134](?:-mini)?|gpt-5(?:\.\d+)?(?:-mini|-nano)?|gpt-6(?:\.1)?-(?:astra|sol))(?:-\d{4}-\d{2}-\d{2})?$/.test(model);
    const claudeModel = model.replaceAll(".", "-");
    const claude = /^claude-(?:opus-(?:4-[5-8]|5(?:-5)?)|sonnet-(?:4-6|5(?:-5)?)|haiku-5-5|(?:fable|mythos)-5(?:-[12])?)(?:-\d{8}|-latest)?$/.test(claudeModel);
    const gemini25 = /^gemini-2\.5-(?:pro|flash(?:-lite)?)(?:$|-)/.test(model);
    const gemini3 = /^gemini-3(?:\.\d+)?-(?:pro|flash(?:-lite)?)(?:$|-)/.test(model);
    const gemini = (gemini25 || gemini3) && !/(?:^|-)(?:image|tts|audio|live|native)(?:-|$)/.test(model);
    const deepseek = /^deepseek-(?:v4-(?:pro|flash)|pro|flash)(?:$|-\d{4}-\d{2}-\d{2}$)/.test(model)
        || (/^https:\/\/api\.deepseek\.com(?:\/|$)/i.test(baseUrl) && /^deepseek-(?:chat|reasoner)$/.test(model));

    if (protocol === "gemini" && gemini) {
        body.generationConfig ??= {};
        // 1024 is Google's equivalent of `low` for the 2.5 compatibility API.
        body.generationConfig.thinkingConfig = gemini25 ? { thinkingBudget: 1024 } : { thinkingLevel: "LOW" };
    } else if (protocol === "anthropic" && claude) {
        body.output_config = { ...body.output_config, effort: LOW_EFFORT };
        // Opus 4.5 accepts effort but does not support adaptive thinking.
        if (!/^claude-opus-4-5(?:$|-)/.test(claudeModel)) {
            body.thinking = { type: "adaptive" };
            for (const key of ["temperature", "top_p", "top_k"]) delete body[key];
        }
    } else if (protocol === "anthropic" && deepseek) {
        body.output_config = { ...body.output_config, effort: LOW_EFFORT };
    } else if (protocol === "responses" && (openAI || deepseek)) {
        body.reasoning = { ...body.reasoning, effort: LOW_EFFORT };
        if (openAI) for (const key of ["temperature", "top_p"]) delete body[key];
    } else if (protocol === "openai-compatible") {
        const openRouter = /^https:\/\/(?:www\.)?openrouter\.ai(?:\/|$)/i.test(baseUrl);
        if (openRouter && (openAI || claude || gemini || deepseek || /^(?:deepseek-r1|deepseek-v3\.2)(?:$|[:\-])/.test(model) || /^gpt-oss-(?:20b|120b)$/.test(model))) {
            body.reasoning = { ...body.reasoning, effort: LOW_EFFORT };
            delete body.reasoning.max_tokens;
        } else if (openAI || deepseek || gemini || /^gpt-oss-(?:20b|120b)$/.test(model)) {
            body.reasoning_effort = LOW_EFFORT;
        }
        if (openAI && !openRouter) {
            // Reasoning requests can reject custom sampling and legacy max_tokens.
            for (const key of ["temperature", "top_p", "top_k", "frequency_penalty", "presence_penalty", "repetition_penalty", "min_p", "top_a"]) delete body[key];
            if (body.max_tokens !== undefined) {
                body.max_completion_tokens ??= body.max_tokens;
                delete body.max_tokens;
            }
        }
    }
    return body;
}
