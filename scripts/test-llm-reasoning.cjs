const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");
const policy = require("../lib/llm-reasoning.mjs");

function load(file, deps = {}) {
    const source = fs.readFileSync(path.join(__dirname, "../lib", file), "utf8");
    const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
    const module = { exports: {} };
    new Function("require", "module", "exports", outputText)(name => {
        if (!(name in deps)) throw new Error(`Unexpected dependency: ${name}`);
        return deps[name];
    }, module, module.exports);
    return module.exports;
}
const api = load("api-helpers.ts", { "./api-log-store": {}, "./llm-reasoning.mjs": policy });
const { buildProviderRequest } = load("llm-provider-adapter.ts", {
    "./api-helpers": api, "./llm-reasoning.mjs": policy,
    "./generation-parameters": load("generation-parameters.ts"),
});
const messages = [{ role: "user", content: "你好" }];
const cfg = (provider, defaultModel, baseUrl) => ({ provider, defaultModel, baseUrl, apiKey: "test-key" });

test("聊天和摘要都请求 OpenAI low，并保留兼容的输出上限", () => {
    const config = cfg("OpenAI", "gpt-5.4");
    const chat = buildProviderRequest(config, null, messages, { maxTokens: 2500, stream: true }).body;
    const simple = JSON.parse(api.buildSimpleLLMRequest(config, messages, { max_tokens: 2500 }).body);
    for (const body of [chat, simple]) {
        assert.equal(body.reasoning_effort, "low");
        assert.equal(body.max_completion_tokens, 2500);
        assert.equal(body.max_tokens, undefined);
        assert.equal(body.temperature, undefined);
    }
    assert.equal(chat.stream, true);
});

test("原生 Gemini 3 使用低档，2.5 使用对应预算", () => {
    const flash = cfg("Google", "gemini-3.8-flash");
    const pro = cfg("Google", "gemini-2.5-pro");
    assert.deepEqual(buildProviderRequest(flash, null, messages).body.generationConfig.thinkingConfig, { thinkingLevel: "LOW" });
    assert.deepEqual(JSON.parse(api.buildSimpleLLMRequest(pro, messages).body).generationConfig.thinkingConfig, { thinkingBudget: 1024 });
});

test("Claude 按原生协议，OpenRouter 按兼容协议传低档", () => {
    const claude = buildProviderRequest(cfg("Anthropic", "claude-sonnet-4-6"), null, messages).body;
    assert.deepEqual(claude.output_config, { effort: "low" });
    assert.deepEqual(claude.thinking, { type: "adaptive" });
    assert.equal(claude.temperature, undefined);
    const routed = buildProviderRequest(cfg("OpenRouter", "anthropic/claude-sonnet-4.6"), null, messages).body;
    assert.deepEqual(routed.reasoning, { effort: "low" });
    assert.equal(routed.reasoning_effort, undefined);
});

test("不向普通模型、未知别名和媒体模型注入未声明参数", () => {
    for (const model of ["gpt-4o", "gpt-5-pro", "gpt-5.2-chat-latest", "gemini-3.1-flash-lite-image", "unknown-llm"]) {
        const body = buildProviderRequest(cfg("Custom", model, "https://relay.example/v1"), null, messages).body;
        assert.equal(body.reasoning_effort, undefined, model);
        assert.equal(body.reasoning, undefined, model);
        assert.equal(body.temperature, 0.8);
    }
});

test("原生 DeepSeek 和账户 Responses 路径改用各自的 low 字段", () => {
    assert.equal(buildProviderRequest(cfg("DeepSeek", "deepseek-v4-pro"), null, messages).body.reasoning_effort, "low");
    const body = policy.applyLowReasoning({ reasoning: { effort: "high", summary: "auto" } }, "responses", "gpt-5.4");
    assert.deepEqual(body.reasoning, { effort: "low", summary: "auto" });
});
