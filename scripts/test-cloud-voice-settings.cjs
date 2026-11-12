const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

const root = path.join(__dirname, "..");
const accountA = "sub2api_0123456789abcdef_1";
const accountB = "sub2api_0123456789abcdef_2";
const localVoiceKey = "ai_phone_voice_configs_v1";
const voice = id => ({ id, name: id, provider: "Custom", apiKey: "fake-test-key", baseUrl: "https://voice.example/v1", model: "test-tts", defaultVoice: "test-voice", enableTTS: true, enableSTT: true });

function compile(source) {
    return ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
}

function load(file, dependencies = {}) {
    const module = { exports: {} };
    new Function("require", "module", "exports", compile(fs.readFileSync(path.join(root, file), "utf8")))(name => {
        if (!(name in dependencies)) throw new Error(`Unexpected dependency: ${name}`);
        return dependencies[name];
    }, module, module.exports);
    return module.exports;
}

// Execute the production storage/resolver functions without importing unrelated
// preset databases or audio playback modules into this isolated storage test.
function loadFunctions(file, names, scope) {
    const filename = path.join(root, file);
    const source = fs.readFileSync(filename, "utf8");
    const tree = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
    const functions = tree.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text)).map(node => node.getText(tree)).join("\n");
    const module = { exports: {} };
    new Function(...Object.keys(scope), "module", "exports", compile(functions))(...Object.values(scope), module, module.exports);
    return module.exports;
}

function setup() {
    let accountId = accountA;
    const kv = new Map();
    const events = [];
    global.window = { location: { origin: "http://localhost:18471" }, dispatchEvent: event => events.push(event.type) };
    const account = { loadActiveAccountId: () => accountId };
    const storage = { kvGet: key => kv.get(key) || null, kvSet: (key, value) => kv.set(key, value), registerDynamicPrefix: () => {} };
    const mode = load("lib/voice-mode.ts");
    const settings = load("lib/cloud-voice.ts", { "./account-client": account, "./kv-db": storage, "./voice-mode": mode });
    const cloud = load("lib/cloud-account.ts", { "./account-client": account, "./kv-db": storage, "./cloud-voice": settings });
    const store = loadFunctions("lib/settings-storage.ts", ["loadVoiceConfigs", "saveVoiceConfigs", "resolveBinding"], {
        ...account, ...storage, ...mode, ...settings, ...cloud, VOICE_CONFIGS_KEY: localVoiceKey,
    });
    const bindings = () => ({ globalDefaults: { voiceConfigId: "legacy-local-voice" }, appDefaults: { chat: { voiceConfigId: "old-app-voice" } }, characterBindings: [{ characterId: "char", defaults: { voiceConfigId: "old-character-voice" }, appOverrides: { chat: { voiceConfigId: "old-override-voice" } } }] });
    const tts = loadFunctions("lib/tts-service.ts", ["resolveVoiceConfig"], {
        ...store, loadBindingConfig: () => cloud.bindCloudAccount(bindings()),
    });
    return { kv, events, settings, cloud, store, tts, bindings, switchAccount: id => { accountId = id; } };
}

test("云端语音默认关闭，不读取或覆盖原有本地语音配置", () => {
    const app = setup();
    app.kv.set(localVoiceKey, JSON.stringify([voice("local")]));
    assert.deepEqual(app.settings.loadCloudVoiceSettings(), { enabled: false, configs: [], defaultConfigId: "" });
    assert.deepEqual(app.store.loadVoiceConfigs(), []);
    assert.equal(app.tts.resolveVoiceConfig("char", "chat"), null);
    assert.equal(JSON.parse(app.kv.get(localVoiceKey))[0].id, "local");
});

test("开启后使用选择的语音方案，关闭保留配置并停止解析语音调用配置", () => {
    const app = setup();
    app.store.saveVoiceConfigs([voice("one"), voice("two")], accountA);
    app.settings.saveCloudVoiceDefaultConfig("two", accountA);
    app.settings.saveCloudVoiceEnabled(true, accountA);
    assert.equal(app.store.loadVoiceConfigs().length, 2);
    assert.equal(app.tts.resolveVoiceConfig("char", "chat").id, "two");
    app.settings.saveCloudVoiceEnabled(false, accountA);
    assert.deepEqual(app.store.loadVoiceConfigs(), []);
    assert.equal(app.tts.resolveVoiceConfig("char", "chat"), null);
    assert.equal(app.settings.loadCloudVoiceSettings().configs.length, 2);
    app.settings.saveCloudVoiceEnabled(true, accountA);
    assert.equal(app.tts.resolveVoiceConfig("char", "chat").id, "two");
});

test("账户切换与旧编辑器保存不会串用另一账户的语音方案和开关", () => {
    const app = setup();
    app.settings.saveCloudVoiceEnabled(true, accountA);
    app.store.saveVoiceConfigs([voice("A")], accountA);
    app.switchAccount(accountB);
    assert.equal(app.settings.loadCloudVoiceSettings().enabled, false);
    assert.deepEqual(app.store.loadVoiceConfigs(), []);
    app.settings.saveCloudVoiceEnabled(true, accountB);
    app.store.saveVoiceConfigs([voice("B")], accountB);
    app.store.saveVoiceConfigs([voice("A-updated")], accountA);
    assert.equal(app.tts.resolveVoiceConfig("char").id, "B");
    app.switchAccount(accountA);
    assert.equal(app.tts.resolveVoiceConfig("char").id, "A-updated");
});

test("语音选择覆盖有效绑定但不修改旧的角色与应用绑定数据", () => {
    const app = setup();
    const original = app.bindings();
    const before = JSON.stringify(original);
    app.settings.saveCloudVoiceConfigs([voice("selected")]);
    app.settings.saveCloudVoiceEnabled(true);
    const resolved = app.cloud.bindCloudAccount(original);
    assert.equal(resolved.globalDefaults.voiceConfigId, "selected");
    assert.equal(resolved.appDefaults.chat.voiceConfigId, "selected");
    assert.equal(resolved.characterBindings[0].defaults.voiceConfigId, "selected");
    assert.equal(resolved.characterBindings[0].appOverrides.chat.voiceConfigId, "selected");
    assert.equal(JSON.stringify(original), before);
    assert.ok(app.events.includes("settings-bindings-updated"));
});

test("删除当前方案后使用剩余方案，删除全部方案不会遗留失效绑定", () => {
    const app = setup();
    app.settings.saveCloudVoiceEnabled(true);
    app.store.saveVoiceConfigs([voice("one"), voice("two")]);
    app.settings.saveCloudVoiceDefaultConfig("two");
    app.store.saveVoiceConfigs([voice("one")]);
    assert.equal(app.tts.resolveVoiceConfig("char").id, "one");
    app.store.saveVoiceConfigs([]);
    assert.equal(app.tts.resolveVoiceConfig("char"), null);
    assert.equal(app.settings.loadCloudVoiceSettings().defaultConfigId, "");
});

test("本地模式继续使用原有语音配置，云端设置不会覆盖它", () => {
    const app = setup();
    app.switchAccount("local_user");
    app.store.saveVoiceConfigs([voice("legacy")]);
    assert.equal(app.store.loadVoiceConfigs()[0].id, "legacy");
    app.settings.saveCloudVoiceEnabled(true, "local_user");
    assert.equal(app.settings.loadCloudVoiceSettings("local_user").enabled, false);
    app.switchAccount(accountA);
    app.store.saveVoiceConfigs([voice("cloud")]);
    app.switchAccount("local_user");
    assert.equal(app.store.loadVoiceConfigs()[0].id, "legacy");
});
