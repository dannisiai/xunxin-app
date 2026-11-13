const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

const root = path.join(__dirname, "..");
function load(file, dependencies = {}) {
    const module = { exports: {} };
    const code = ts.transpileModule(fs.readFileSync(path.join(root, file), "utf8"), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    new Function("require", "module", "exports", code)(name => {
        if (!(name in dependencies)) throw new Error(`Unexpected dependency: ${name}`);
        return dependencies[name];
    }, module, module.exports);
    return module.exports;
}

const mode = load("lib/voice-mode.ts");
const qwen = load("lib/qwen-tts.ts");
const reference = "data:audio/wav;base64,dGVzdA==";
const wave = Buffer.concat([Buffer.from("RIFF"), Buffer.from([12, 0, 0, 0]), Buffer.from("WAVEtest-audio")]);
const config = overrides => ({
    id: "clone", provider: "Custom", apiKey: "", baseUrl: "https://voice.example/v1",
    model: "Qwen3-TTS-12Hz-1.7B-Base", defaultVoice: "", referenceAudio: reference,
    referenceText: "你好", ...overrides,
});

function setup() {
    const requests = [];
    const service = load("lib/tts-service.ts", {
        "./settings-storage": {},
        "./voice-api": load("lib/voice-api.ts"),
        "./voice-mode": mode,
        "./qwen-tts": qwen,
        "./tts-request": {
            fetchTtsResponse: async (url, init) => {
                requests.push({ url, body: JSON.parse(init.body) });
                return new Response(wave, { headers: { "Content-Type": "application/octet-stream" } });
            },
        },
        "./tts-pcm-player": {},
        "./tts-audio-stream": load("lib/tts-audio-stream.ts"),
        "./reference-audio": load("lib/reference-audio.ts"),
        "./dashscope-tts": load("lib/dashscope-tts.ts"),
    });
    return { ...service, requests };
}

test("Qwen Base 上传参考音频后，空音色 ID 可以合成且传递克隆参数", async () => {
    const app = setup();
    const audio = await app.synthesizeSpeech("测试回复", config());
    assert.deepEqual(Buffer.from(await audio.arrayBuffer()), wave);
    assert.equal(audio.type, "audio/wav");
    assert.equal(app.requests.length, 1);
    assert.equal(app.requests[0].url, "https://voice.example/v1/audio/speech");
    assert.deepEqual(app.requests[0].body, {
        model: "Qwen3-TTS-12Hz-1.7B-Base", input: "测试回复", voice: "default",
        stream: false, response_format: "wav", task_type: "Base",
        ref_audio: reference, x_vector_only_mode: false, ref_text: "你好",
    });
});

test("上传的克隆音频优先于以前保存的音色 ID", () => {
    const body = qwen.qwenSpeechBody("测试", config({ defaultVoice: "previous-voice" }), false);
    assert.equal(body.voice, "default");
    assert.equal(body.ref_audio, reference);
    assert.equal(body.task_type, "Base");
});

test("试听的非流式回退同样允许参考音频配合空音色 ID", async () => {
    const app = setup();
    let played;
    await app.speakSpeech("试听", config(), {
        playBlob: blob => { played = blob; return { promise: Promise.resolve(), abort() {} }; },
    }).promise;
    assert.deepEqual(Buffer.from(await played.arrayBuffer()), wave);
    assert.equal(app.requests.length, 1);
});

test("关闭语音合成的方案不会发起试听请求", async () => {
    const app = setup();
    await assert.rejects(app.speakSpeech("试听", config({ enableTTS: false })).promise, /已关闭合成/);
    assert.equal(app.requests.length, 0);
});

test("没有参考文本时，流式克隆请求仍带参考音频并启用 x-vector 模式", () => {
    const body = qwen.qwenSpeechBody("试听", config({ referenceText: " " }), true);
    assert.equal(body.voice, "default");
    assert.equal(body.ref_audio, reference);
    assert.equal(body.x_vector_only_mode, true);
    assert.equal(body.stream, true);
    assert.equal(body.response_format, "pcm");
    assert.equal("ref_text" in body, false);
});

test("Base 缺少用户上传的参考音频时，在发起合成前明确提示", async () => {
    const app = setup();
    await assert.rejects(app.synthesizeSpeech("你好", config({ referenceAudio: undefined })), /先上传人声音频/);
    assert.equal(app.requests.length, 0);
});

test("非 Base 模型可以使用服务商内置音色", async () => {
    const app = setup();
    await app.synthesizeSpeech("你好", config({ model: "Qwen3-TTS-12Hz-1.7B-CustomVoice", referenceAudio: undefined }));
    assert.equal(app.requests[0].body.voice, "default");
    assert.equal("ref_audio" in app.requests[0].body, false);
});

test("已保存的服务商音色配置继续兼容", async () => {
    const app = setup();
    await app.synthesizeSpeech("你好", config({ model: "Qwen3-TTS-12Hz-1.7B-CustomVoice", referenceAudio: undefined, defaultVoice: "saved-voice" }));
    assert.equal(app.requests[0].body.voice, "saved-voice");
});

test("参考音频不能替代模型 ID 或其他服务商的密钥", async () => {
    const app = setup();
    await assert.rejects(app.synthesizeSpeech("你好", config({ model: "" })), /合成模型 ID/);
    await assert.rejects(app.synthesizeSpeech("你好", config({ provider: "OpenAI" })), /API Key/);
    assert.equal(app.requests.length, 0);
});

test("克隆状态只适用于上传参考音频的自定义 TTS，旧配置无需迁移", () => {
    assert.equal(mode.usesReferenceAudioVoice(config()), true);
    assert.equal(mode.usesReferenceAudioVoice(config({ defaultVoice: "previous-voice" })), true);
    assert.equal(mode.usesReferenceAudioVoice(config({ referenceAudio: undefined })), false);
    assert.equal(mode.usesReferenceAudioVoice(config({ provider: "Minimax" })), false);
    assert.equal(mode.usesReferenceAudioVoice(config({ customTtsProtocol: "minicpm" })), false);
});
