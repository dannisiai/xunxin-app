const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");
const root = path.join(__dirname, "..");
function load(file, deps = {}) {
  const module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(path.join(root, file), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function("require", "module", "exports", code)(name => {
    if (!(name in deps)) throw new Error(`Unexpected dependency ${name}`);
    return deps[name];
  }, module, module.exports);
  return module.exports;
}
const bilingual = load("lib/bilingual-text.ts");
const tick = () => new Promise(resolve => setImmediate(resolve));
function setup(synth = async () => new Blob(["fake-audio"], { type: "audio/mpeg" })) {
  const kv = new Map(), events = [], calls = [], synthCalls = [];
  global.window = { dispatchEvent: event => events.push(event) };
  let config = { id: "test", enableTTS: true };
  const voice = load("lib/companion-voice.ts", {
    "./kv-db": { kvGet: key => kv.get(key), kvSet: (k, v) => kv.set(k, v), registerDynamicPrefix() {} },
    "./bilingual-text": bilingual,
    "./tts-service": {
      resolveVoiceConfig: (characterId, appId) => { assert.equal(characterId, "character"); assert.equal(appId, "chat"); return config; },
      synthesizeSpeech: (text, cfg, options) => { synthCalls.push({ text, cfg, signal: options.signal }); return synth(text, options.signal); },
    },
  });
  const native = Object.fromEntries(["beginCompanionAudio", "appendCompanionAudio", "finishCompanionAudio", "failCompanionAudio"].map(name => [name, (...args) => calls.push([name, ...args])]));
  return { ...voice, replies: voice.createCompanionVoiceReplies(() => native), native, calls, synthCalls, events, setConfig: value => { config = value; } };
}
const request = (id = "one", enabled = true) => ({ overlayId: "overlay", requestId: id, characterId: "character", voiceReplyEnabled: enabled });

test("语音开关默认关闭，两个 App 分别保存并发送变更通知", () => {
  const v = setup();
  assert.equal(v.loadCompanionVoiceEnabled("douyin"), false);
  v.saveCompanionVoiceEnabled("douyin", true);
  assert.equal(v.loadCompanionVoiceEnabled("douyin"), true);
  assert.equal(v.loadCompanionVoiceEnabled("xiaohongshu"), false);
  v.saveCompanionVoiceEnabled("douyin", false);
  assert.equal(v.loadCompanionVoiceEnabled("douyin"), false);
  assert.deepEqual(v.events[0].detail, { appId: "douyin", enabled: true });
});

test("关闭语音或旧壳请求不调用付费语音接口", async () => {
  const v = setup();
  v.replies.reply(request("off", false), "你好");
  v.replies.reply({ ...request(), voiceReplyEnabled: undefined }, "你好");
  await tick();
  assert.equal(v.synthCalls.length, 0);
  assert.equal(v.calls.length, 0);
});

test("使用角色音色合成一次，分块传输并能无额外合成地重试传输", async () => {
  const bytes = new Uint8Array(110_000).fill(107);
  const v = setup(async () => new Blob([bytes]));
  v.replies.reply(request(), "**你好**");
  await tick();
  assert.equal(v.synthCalls.length, 1);
  assert.equal(v.synthCalls[0].text, "你好");
  const chunks = v.calls.filter(call => call[0] === "appendCompanionAudio");
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every(call => call[3].length <= 48 * 1024));
  assert.deepEqual(Buffer.from(chunks.map(call => call[3]).join(""), "base64"), Buffer.from(bytes));
  assert.equal(v.calls.at(-1)[0], "finishCompanionAudio");
  v.replies.retry({ overlayId: "overlay", requestId: "one" });
  await tick();
  assert.equal(v.synthCalls.length, 1);
  assert.equal(v.calls.filter(call => call[0] === "finishCompanionAudio").length, 2);
});

test("新回复取消旧合成，即使服务商忽略 abort 也不发送迟到音频", async () => {
  let resolveOld;
  const v = setup(text => text === "旧回复" ? new Promise(resolve => { resolveOld = resolve; }) : Promise.resolve(new Blob(["new"])));
  v.replies.reply(request("old"), "旧回复");
  v.replies.reply(request("new"), "新回复");
  assert.equal(v.synthCalls[0].signal.aborted, true);
  resolveOld(new Blob(["late"]));
  await tick();
  assert.ok(v.calls.length > 0);
  assert.ok(v.calls.every(call => call[2] === "new"));
});

test("关闭陪伴丢弃重试上下文，不同悬浮会话的取消不会误伤本轮", async () => {
  let resolve;
  const v = setup(() => new Promise(done => { resolve = done; }));
  v.replies.reply(request(), "回复");
  v.replies.stop({ overlayId: "another" }, true);
  assert.equal(v.synthCalls[0].signal.aborted, false);
  v.replies.stop({ overlayId: "overlay" }, true);
  assert.equal(v.synthCalls[0].signal.aborted, true);
  resolve(new Blob(["late"]));
  v.replies.retry({ requestId: "one" });
  await tick();
  assert.equal(v.calls.length, 0);
  assert.equal(v.synthCalls.length, 1);
});

test("修改另一个 App 的开关不会取消当前播报", async () => {
  let resolve;
  const v = setup(() => new Promise(done => { resolve = done; }));
  v.replies.reply({ ...request(), appId: "xiaohongshu" }, "回复");
  v.replies.stop({ appId: "douyin" }, true);
  assert.equal(v.synthCalls[0].signal.aborted, false);
  resolve(new Blob(["audio"])); await tick();
  assert.equal(v.calls.at(-1)[0], "finishCompanionAudio");
});

test("未绑定语音时保留文字链路，提示配置，不调用合成", async () => {
  const v = setup(); v.setConfig(null);
  v.replies.reply(request(), "回复");
  await tick();
  assert.equal(v.synthCalls.length, 0);
  assert.match(v.calls[0][3], /配置/);
});

test("合成失败不自动重试、不输出服务商密钥，用户重试才再次调用", async () => {
  const v = setup(async () => { throw new Error("provider failure secret-test-key"); });
  v.replies.reply(request(), "回复");
  await tick();
  assert.equal(v.synthCalls.length, 1);
  assert.equal(v.calls[0][0], "failCompanionAudio");
  assert.ok(!v.calls[0][3].includes("secret-test-key"));
  v.replies.retry({ overlayId: "wrong" });
  await tick(); assert.equal(v.synthCalls.length, 1);
  v.replies.retry({ overlayId: "overlay", requestId: "one" });
  await tick(); assert.equal(v.synthCalls.length, 2);
});

test("超大音频不跨桥传输；纯格式、隐藏推理和翻译不被朗读", async () => {
  const v = setup(async () => new Blob([new Uint8Array(4 * 1024 * 1024 + 1)]));
  v.replies.reply(request(), "回复"); await tick();
  assert.equal(v.calls[0][0], "failCompanionAudio");
  assert.equal(v.calls.some(call => call[0] === "beginCompanionAudio"), false);
  assert.equal(v.companionSpeechText('<think>内部推理</think>\n**Hello** | 你好\n[一起看看](https://example.invalid)\n```js\nalert(1)\n```'), "Hello\n一起看看");
});

async function screenScenario(initialEnabled, updatedEnabled, nativeFlag = initialEnabled) {
  const v = setup();
  global.window = new EventTarget();
  window.setTimeout = setTimeout; window.clearTimeout = clearTimeout;
  window.AndroidShell = { ...v.native, completeCompanionRequest: (...args) => completions.push(args) };
  v.saveCompanionVoiceEnabled("douyin", initialEnabled);
  const completions = [], messages = [];
  let finishReply;
  const companion = load("lib/android-companion.ts", {
    "@/lib/character-storage": { loadCharacters: () => [{ id: "character", name: "测试角色" }] },
    "@/lib/mascot-state": { getActiveCompanion: () => null },
    "@/lib/mascot-settings": { resolveMascotImageRef: async () => "" },
    "@/lib/companion-chat": {
      assertCompanionVisionConfigured() {}, isCompanionReplyRunning: () => false,
      loadCompanionMessages: () => messages,
      openCompanionSession: async () => ({ id: "session" }),
      sendCompanionMessage: async () => {
        await new Promise(resolve => { finishReply = resolve; });
        messages.push({ id: "reply", role: "assistant", content: "一起看看吧" });
      },
    },
    "@/lib/chat-storage": { getChatMessagePreview: msg => msg.content },
    "@/lib/media-cache-storage": { storeMediaBlob: async () => "media-store://fake", deleteMediaRef: async () => {} },
    "@/lib/abort-utils": { throwIfAborted: signal => signal.throwIfAborted() },
    "@/lib/companion-voice": v,
    "@/lib/account-storage": { registerAccountCleanup: () => () => {} },
  });
  const originalFetch = global.fetch;
  global.fetch = async () => ({ blob: async () => new Blob(["fake-image"]) });
  const dispose = companion.listenForAndroidCompanion();
  try {
    window.dispatchEvent(new CustomEvent("android-companion-screen", { detail: {
      ...request(), appId: "douyin", voiceReplyEnabled: nativeFlag === null ? undefined : nativeFlag, imageDataUrl: "data:image/jpeg;base64,ZmFrZQ==",
    } }));
    await tick(); assert.ok(finishReply, "screen request reached reply generation");
    v.saveCompanionVoiceEnabled("douyin", updatedEnabled);
    finishReply(); await tick(); await tick();
    assert.equal(completions.length, 1);
    assert.equal(completions[0][2], "一起看看吧");
    return v.synthCalls.length;
  } finally { dispose(); global.fetch = originalFetch; }
}

test("等待文字期间关闭开关，回复仍显示且不会发起语音计费请求", async () => {
  assert.equal(await screenScenario(true, false), 0);
});

test("等待文字期间开启开关使用最新设置；旧壳仍只显示文字", async () => {
  assert.equal(await screenScenario(false, true), 1);
  assert.equal(await screenScenario(false, true, null), 0);
});
