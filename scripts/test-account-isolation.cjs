const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");
const install = require("../public/account-storage-bootstrap.js");
const root = path.join(__dirname, "..");
const prefix = id => `__xunxin_account_v1__:${encodeURIComponent(id)}:`;

function load(file, dependencies) {
  const module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(path.join(root, file), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  new Function("require", "module", "exports", code)(name => {
    if (!(name in dependencies)) throw new Error(`Unexpected dependency: ${name}`);
    return dependencies[name];
  }, module, module.exports);
  return module.exports;
}

function browser(id, stores = { local: new Map(), session: new Map(), dbs: new Map(), caches: new Map() }, nativeFetch = async () => Response.json({ ok: true }), platform = {}, lifecycle = false) {
  const storageData = new WeakMap();
  class Storage {
    constructor(data) { storageData.set(this, data); }
    get length() { return storageData.get(this).size; }
    getItem(key) { return storageData.get(this).get(String(key)) ?? null; }
    setItem(key, value) { storageData.get(this).set(String(key), String(value)); }
    removeItem(key) { storageData.get(this).delete(String(key)); }
    key(index) { return [...storageData.get(this).keys()][index] ?? null; }
    clear() { storageData.get(this).clear(); }
  }
  class StorageEvent extends Event { constructor(type, init) { super(type); Object.assign(this, init); } }
  class CustomEvent extends Event {}
  class IDBDatabase {
    constructor(name) { this.name = name; this.closed = false; }
    close() { this.closed = true; }
    transaction() { const tx = new EventTarget(); tx.abort = () => { tx.aborted = true; tx.dispatchEvent(new Event("abort")); }; return tx; }
  }
  class Cache {
    constructor() { this.entries = new Map(); }
    async put(key, value) { this.entries.set(String(key), value); }
    async match(key) { return this.entries.get(String(key)); }
    async keys() { return [...this.entries.keys()]; }
    async delete(key) { return this.entries.delete(String(key)); }
  }
  class XMLHttpRequest extends EventTarget {
    open() { this.headers = new Headers(); }
    setRequestHeader(name, value) { this.headers.append(name, value); }
    send() { this.sent = true; }
    abort() { this.aborted = true; this.dispatchEvent(new Event("loadend")); }
  }
  const win = new EventTarget();
  Object.assign(win, {
    Storage, StorageEvent, CustomEvent, IDBDatabase, Cache, XMLHttpRequest,
    Request, Response, Headers, URL, DOMException, AbortController, AbortSignal, ReadableStream,
    localStorage: new Storage(stores.local), sessionStorage: new Storage(stores.session),
    location: { href: "http://fixture.test/", origin: "http://fixture.test", reload() {} },
    document: Object.assign(new EventTarget(), { documentElement: { getAttribute: () => id }, body: null }),
    navigator: {}, setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, fetch: nativeFetch,
    indexedDB: {
      open(name) {
        const request = new EventTarget();
        request.result = new IDBDatabase(name); stores.dbs.set(name, 1);
        queueMicrotask(() => request.dispatchEvent(new Event("success")));
        return request;
      },
      deleteDatabase: name => stores.dbs.delete(name),
      databases: async () => [...stores.dbs].map(([name, version]) => ({ name, version })),
    },
    caches: {
      open: async name => { if (!stores.caches.has(name)) stores.caches.set(name, new Cache()); return stores.caches.get(name); },
      keys: async () => [...stores.caches.keys()],
      delete: async name => stores.caches.delete(name),
    },
  });
  Object.assign(win, platform);
  if (!win.parent) win.parent = win;
  const runtime = install(win, { accountId: id, noLifecycle: !lifecycle, noReload: true });
  return { win, runtime, stores };
}

test("Storage 方法、属性、枚举与 clear 均按账号隔离，旧资料原样保留", () => {
  const a = browser("A"); a.stores.local.set("old-chats", "legacy-private");
  a.win.localStorage.setItem("chat", "A-chat"); a.win.localStorage.character = "A-character";
  a.win.sessionStorage.setItem("draft", "A-draft");
  const b = browser("B", a.stores);
  assert.equal(b.win.localStorage.getItem("chat"), null);
  assert.equal(b.win.localStorage.character, undefined);
  assert.deepEqual(Object.keys(b.win.localStorage), []);
  assert.equal(b.win.sessionStorage.getItem("draft"), null);
  b.win.localStorage.chat = "B-chat";
  assert.deepEqual(Object.keys(a.win.localStorage), ["chat", "character"]);
  assert.equal(a.win.localStorage.length, 2);
  a.win.localStorage.clear();
  assert.equal(b.win.localStorage.chat, "B-chat");
  assert.equal(a.stores.local.get("old-chats"), "legacy-private");
  assert.equal(browser("A", a.stores).win.localStorage.getItem("chat"), null);
  for (const name of [prefix("B") + "chat", "__xunxin_identity_v1__"]) {
    assert.throws(() => b.win.localStorage.setItem(name, "tamper"), TypeError);
  }
});

test("同源子文档继承父账号，父页面失效后子文档也停止访问", async () => {
  const a = browser("A"); a.win.localStorage.chat = "A-private";
  const frame = browser("B", a.stores, undefined, { parent: a.win });
  assert.equal(frame.runtime.accountId, "A"); assert.equal(frame.win.localStorage.chat, "A-private");
  await a.runtime.invalidate();
  assert.throws(() => frame.win.indexedDB.open("AiPhoneChatDB"), { name: "AbortError" });
  assert.equal(frame.win.localStorage.chat, undefined);
});

test("账号失效关闭原生后台、清理推送，并阻止已保存的原生方法引用", async () => {
  const events = []; let unsubscribed = 0; let closed = 0;
  const subscription = { unsubscribe: async () => { unsubscribed++; return true; } };
  const a = browser("A", undefined, undefined, {
    AndroidShell: { onAccountScopeChanged: id => events.push(id), stopCompanionOverlay: () => events.push("overlay-stopped"), exportDocument: () => events.push("exported") },
    navigator: { serviceWorker: { getRegistrations: async () => [{ active: { scriptURL: "http://fixture.test/sw.js", postMessage() {} }, pushManager: { getSubscription: async () => subscription }, getNotifications: async () => [{ close: () => closed++ }] }] } },
  });
  const exportDocument = a.win.AndroidShell.exportDocument;
  exportDocument(); assert.ok(events.includes("exported"));
  await a.runtime.invalidate();
  assert.ok(events.includes("")); assert.ok(events.includes("overlay-stopped"));
  assert.ok(unsubscribed > 0); assert.equal(closed, 1);
  assert.throws(exportDocument, { name: "AbortError" });
});

test("旧账号退出只清理自身推送注册，不退订新账号的订阅", async () => {
  let removedA = 0; let removedB = 0;
  const registration = (id, remove) => ({ scope: `http://fixture.test/account-push/${id}/`, active: { scriptURL: "http://fixture.test/sw.js", postMessage() {} }, pushManager: { getSubscription: async () => ({ unsubscribe: async () => { remove(); return true; } }) }, getNotifications: async () => [] });
  const a = browser("A", undefined, undefined, {
    navigator: { serviceWorker: { getRegistrations: async () => [registration("A", () => removedA++), registration("B", () => removedB++)] } },
  });
  await a.runtime.invalidate();
  assert.equal(removedA, 1); assert.equal(removedB, 0);
});

test("推送客户端为 A/B 使用不同 Worker scope，旧清理不影响 B 正常启用", async () => {
  const originalWindow = global.window, originalFetch = global.fetch;
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(global, "navigator");
  const registrations = new Map(); const cleanups = { A: [], B: [] }; const kv = new Map(); let id = "A";
  const registrationFor = scope => {
    let subscription;
    return { scope: "http://fixture.test" + scope, active: { postMessage() {} }, update: async () => {}, pushManager: {
      getSubscription: async () => subscription || null,
      subscribe: async options => {
        const result = { endpoint: scope + "endpoint", options, toJSON() { return { endpoint: this.endpoint }; }, unsubscribe: async () => { if (subscription === result) subscription = null; return true; } };
        subscription = result; return result;
      },
    } };
  };
  try {
    global.window = { location: { origin: "http://fixture.test" }, PushManager: {}, Notification: {}, atob, setTimeout, clearTimeout };
    Object.defineProperty(global, "navigator", { configurable: true, value: { userAgent: "test", serviceWorker: {
      getRegistration: async scope => registrations.get(scope) || { scope: "http://fixture.test/" },
      register: async (_, { scope }) => { const registration = registrationFor(scope); registrations.set(scope, registration); return registration; },
    } } });
    global.fetch = async url => Response.json(String(url).endsWith("public-key") ? { ok: true, publicKey: "AQID" } : { ok: true });
    const client = load("lib/push-client.ts", {
      "./browser-notification": { requestNotificationPermission: async () => true },
      "./kv-db": { kvGet: key => kv.get(id + key) ?? null, kvSet: (key, value) => kv.set(id + key, value), kvRemove: key => kv.delete(id + key) },
      "./account-storage": { getDocumentAccountId: () => id, isAccountStorageActive: () => true, registerAccountCleanup: callback => cleanups[id].push(callback) },
      "./personal-push-cloud": { isPersonalPushCloudActive: () => false, PERSONAL_PUSH_SW_SCOPE: "/personal-push/" },
    });
    assert.deepEqual(await client.enableOfflinePush(), { ok: true });
    assert.equal(await client.getOfflinePushState(), "on");
    id = "B"; assert.equal(await client.getOfflinePushState(), "off");
    assert.deepEqual(await client.enableOfflinePush(), { ok: true });
    for (const cleanup of cleanups.A) await cleanup();
    assert.equal(await client.getOfflinePushState(), "on");
    assert.equal(await registrations.get("/account-push/A/").pushManager.getSubscription(), null);
    assert.ok(await registrations.get("/account-push/B/").pushManager.getSubscription());
    await client.disableOfflinePush(); assert.equal(await client.getOfflinePushState(), "off");
  } finally {
    global.window = originalWindow; global.fetch = originalFetch;
    if (navigatorDescriptor) Object.defineProperty(global, "navigator", navigatorDescriptor); else delete global.navigator;
  }
});

test("焦点校验使已失效会话退出，网络暂不可达保留当前账号", async () => {
  let status = 503;
  const a = browser("A", undefined, async () => Response.json({ ok: false }, { status }), {}, true);
  a.win.dispatchEvent(new Event("focus")); await new Promise(resolve => setImmediate(resolve));
  assert.ok(a.runtime.isActive());
  status = 401;
  a.win.dispatchEvent(new Event("focus")); await new Promise(resolve => setImmediate(resolve));
  assert.equal(a.runtime.isActive(), false);
});

test("IndexedDB 原始打开、枚举、删除与 CacheStorage 全域搜索不跨账号", async () => {
  const a = browser("A"); a.stores.dbs.set("AiPhoneChatDB", 3);
  const request = a.win.indexedDB.open("AiPhoneChatDB"); await Promise.resolve();
  const tx = request.result.transaction("chats");
  const cache = await a.win.caches.open("media"); await cache.put("/portrait", "A-portrait");
  const b = browser("B", a.stores);
  assert.deepEqual(await b.win.indexedDB.databases(), []);
  assert.deepEqual(await a.win.indexedDB.databases(), [{ name: "AiPhoneChatDB", version: 1 }]);
  assert.equal(await b.win.caches.match("/portrait"), undefined);
  b.win.indexedDB.deleteDatabase("AiPhoneChatDB");
  assert.ok(a.stores.dbs.has(prefix("A") + "AiPhoneChatDB"));
  assert.ok(a.stores.dbs.has("AiPhoneChatDB"));
  assert.throws(() => b.win.indexedDB.open(prefix("A") + "AiPhoneChatDB"), TypeError);
  await a.runtime.invalidate();
  assert.ok(tx.aborted); assert.ok(request.result.closed);
  assert.throws(() => request.result.transaction("chats"), { name: "AbortError" });
  assert.throws(() => cache.match("/portrait"), { name: "AbortError" });
});

test("账户冻结阻止迟到写入及新请求，fetch 保留请求体与调用方取消信号", async () => {
  const calls = [];
  const a = browser("A", undefined, async request => { calls.push(request); return Response.json({ ok: true }); });
  const abort = new AbortController();
  const response = await a.win.fetch(new Request("http://fixture.test/api/chat", { method: "POST", body: "hello", headers: { "Content-Type": "text/plain" }, signal: abort.signal }));
  assert.equal(await calls[0].text(), "hello");
  assert.equal(calls[0].headers.get("X-Account-Id"), "A");
  assert.deepEqual(await response.json(), { ok: true });
  await assert.rejects(a.win.fetch("/api/chat", { headers: { "X-Account-Id": "B" } }), { name: "AbortError" });
  abort.abort(); assert.ok(calls[0].signal.aborted);
  const xhr = new a.win.XMLHttpRequest(); xhr.open("POST", "/api/chat"); xhr.setRequestHeader("X-Account-Id", "A"); xhr.send();
  assert.equal(xhr.headers.get("X-Account-Id"), "A");
  await a.runtime.reconcile("B");
  assert.ok(xhr.aborted);
  assert.equal(a.runtime.accountId, "A");
  assert.throws(() => a.win.localStorage.setItem("late", "value"), { name: "AbortError" });
  await assert.rejects(a.win.fetch("/api/chat"), { name: "AbortError" });
});

test("流式响应收到首块后切换账号会中断后续读取", async () => {
  let stream;
  const a = browser("A", undefined, async request => new Response(new ReadableStream({
    start(controller) { stream = controller; controller.enqueue(new TextEncoder().encode("A")); request.signal.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError"))); },
  })));
  const response = await a.win.fetch("/api/chat"); const reader = response.body.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), "A");
  await a.runtime.invalidate();
  await assert.rejects(reader.read(), { name: "AbortError" });
  assert.ok(stream);
});

test("StorageEvent 不暴露其他账号，当前账号事件翻译为逻辑键", async () => {
  const a = browser("A"); const events = [];
  a.win.addEventListener("storage", event => events.push(event));
  a.win.dispatchEvent(new a.win.StorageEvent("storage", { key: prefix("B") + "chat", newValue: "B-secret" }));
  assert.equal(events.length, 0);
  a.win.dispatchEvent(new a.win.StorageEvent("storage", { key: prefix("A") + "chat", newValue: "A-value" }));
  assert.equal(events[0].key, "chat"); assert.equal(events[0].newValue, "A-value");
  a.win.dispatchEvent(new a.win.StorageEvent("storage", { key: "__xunxin_identity_v1__", newValue: JSON.stringify({ accountId: "B" }) }));
  assert.equal(a.runtime.isActive(), false);
});

test("未登录文档不可读取旧资料或打开数据库", async () => {
  const a = browser(""); a.stores.local.set("chat", "private");
  assert.equal(a.win.localStorage.getItem("chat"), null);
  assert.throws(() => a.win.indexedDB.open("AiPhoneChatDB"), { name: "AbortError" });
  await assert.rejects(a.win.fetch("https://personal.example/data"), { name: "AbortError" });
  assert.ok((await a.win.fetch("/api/auth/me")).ok);
});

test("服务端 Cookie 账号与页面账号须匹配，本地、Sub2API、Supabase 模式一致", async () => {
  for (const mode of ["local", "sub2api", "supabase"]) {
    const service = load("lib/server/account-auth.ts", {
      crypto: require("node:crypto"), "../account-cookie-constants": { ACCOUNT_SESSION_COOKIE: "session" },
      "../self-hosting": { isSelfHostedModeEnabled: () => mode === "local" },
      "./sub2api-auth": { isSub2ApiAuthEnabled: () => mode === "sub2api", getSub2ApiAccount: async () => ({ id: "B" }) },
      "./supabase-rest": { encodeSupabaseFilter: encodeURIComponent, supabaseRestFetch: async () => ({ ok: true, data: [{ id: "B", username: "b@example.test" }] }) },
    });
    const expected = mode === "local" ? "local_user" : "B";
    const request = marker => new Request("http://fixture.test/api/chat", { headers: { Cookie: "session=fake", ...(marker ? { "X-Account-Id": marker } : {}) } });
    assert.equal(await service.getCurrentAccount(request("A")), null);
    assert.equal(await service.getCurrentAccount(request()), null);
    assert.equal((await service.getCurrentAccount(request(expected))).id, expected);
    assert.equal((await service.getAccountForDocument(request())).id, expected);
    assert.equal(await service.getAccountForResource(new Request("http://fixture.test/api/icon?account=A", { headers: { Cookie: "session=fake" } })), null);
    assert.equal((await service.getAccountForResource(new Request(`http://fixture.test/api/icon?account=${expected}`, { headers: { Cookie: "session=fake" } }))).id, expected);
  }
});

test("云备份路径按账号隔离，并拒绝字面及编码的目录穿越", () => {
  const filename = path.join(root, "lib/cloud-backup/engine.ts");
  const source = ts.createSourceFile(filename, fs.readFileSync(filename, "utf8"), ts.ScriptTarget.Latest, true);
  const declaration = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "accountBackupPath");
  const code = ts.transpileModule(declaration.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  let id = "A"; let active = true;
  const scopePath = new Function("getDocumentAccountId", "isAccountStorageActive", code + ";return accountBackupPath")(() => id, () => active);
  assert.equal(scopePath("manifests/2026-11-11T12-00-00.json"), "accounts/A/manifests/2026-11-11T12-00-00.json");
  id = "B"; assert.equal(scopePath("media/hash.bin"), "accounts/B/media/hash.bin");
  for (const input of ["../A/data", "media/../../A/data", "%2e%2e/A/data", "media/%252e%252e/data", "media\\..\\A", "/accounts/A/data", "accounts/A/data", "https://example.test/"]) {
    assert.throws(() => scopePath(input), /无效/);
  }
  active = false; assert.throws(() => scopePath("media/hash.bin"), /登录/);
});

test("推送 Worker 的当前账号、订阅归属和 endpoint 必须同时匹配", async () => {
  const handlers = {}; let state; let endpoint = "endpoint-A";
  const self = { registration: { scope: "http://fixture.test/", pushManager: { getSubscription: async () => ({ endpoint }) } }, location: { origin: "http://fixture.test" }, addEventListener: (event, callback) => { handlers[event] = callback; } };
  const cache = { match: async () => state ? Response.json(state) : undefined, put: async (_, response) => { state = await response.json(); } };
  const context = vm.createContext({ self, URL, Response, caches: { open: async () => cache } });
  vm.runInContext(fs.readFileSync(path.join(root, "public/push-account-scope.js"), "utf8"), context);
  async function send(data, origin = "http://fixture.test/frame") { let done; handlers.message({ data, source: { url: origin }, waitUntil: p => { done = p; } }); await done; }
  assert.equal(await context.xunxinPushAccountAllowed(), false);
  await send({ type: "xunxin-push-owner", accountId: "A", endpoint });
  assert.equal(await context.xunxinPushAccountAllowed(), true);
  await send({ type: "xunxin-account-active", accountId: "B" });
  assert.equal(await context.xunxinPushAccountAllowed(), false);
  endpoint = "endpoint-B";
  await send({ type: "xunxin-push-owner", accountId: "B", endpoint });
  assert.equal(await context.xunxinPushAccountAllowed(), true);
  await send({ type: "xunxin-account-invalidate", accountId: "A" });
  assert.equal(await context.xunxinPushAccountAllowed(), true);
  await send({ type: "xunxin-account-active", accountId: "A" }, "https://untrusted.example/");
  assert.equal(state.active, "B");
  endpoint = "stale-endpoint";
  assert.equal(await context.xunxinPushAccountAllowed(), false);
});

test("PWA 离线不回放账号页面，升级不删除账号缓存，失效通知不运行旧快捷动作", async () => {
  const handlers = {}; const deleted = []; const opened = []; const shown = [];
  let allowed = false;
  const self = {
    location: { origin: "http://fixture.test" }, registration: { showNotification: (...args) => shown.push(args) },
    clients: { claim: async () => {}, matchAll: async () => [], openWindow: async url => opened.push(url) },
    addEventListener: (event, callback) => { handlers[event] = callback; }, skipWaiting: async () => {},
  };
  const context = vm.createContext({ self, URL, Response, Request: function (input) { return input; },
    importScripts() {}, xunxinPushAccountAllowed: async () => allowed,
    caches: { keys: async () => ["ai-phone-pwa-v12-runtime", prefix("A") + "media", "xunxin-push-scope-v1:http://fixture.test/"], delete: async name => deleted.push(name) },
    fetch: async () => { throw new Error("offline"); },
  });
  vm.runInContext(fs.readFileSync(path.join(root, "public/sw.js"), "utf8"), context);
  let done; const waitUntil = p => { done = p; };
  handlers.activate({ waitUntil }); await done;
  assert.deepEqual(deleted, ["ai-phone-pwa-v12-runtime"]);
  handlers.fetch({ request: { mode: "navigate", url: "http://fixture.test/" }, respondWith: p => { done = p; } });
  const offline = await done; assert.equal(offline.status, 503);
  assert.ok(!(await offline.text()).includes("data-account-storage-scope"));
  handlers.notificationclick({ notification: { close() {}, data: { type: "shortcut_command", url: "/shortcut-run?old-A-ticket" } }, waitUntil }); await done;
  assert.deepEqual(opened, []);
  handlers.push({ data: { json: () => ({ title: "A-private", body: "A-secret" }) }, waitUntil }); await done;
  assert.deepEqual(shown, []);
  allowed = true;
  handlers.notificationclick({ notification: { close() {}, data: { type: "shortcut_command", url: "/push-open?account=B" } }, waitUntil }); await done;
  assert.equal(opened[0], "http://fixture.test/push-open?account=B");
});

test("Supabase 旧页面退出不会删除当前账号会话，匹配账号退出保持可用", async () => {
  let removed = 0;
  class NextResponse extends Response { static json(value, init) { const response = Response.json(value, init); response.cookies = { set() {} }; return response; } }
  const service = load("app/api/auth/logout/route.ts", {
    "next/server": { NextResponse }, "@/lib/server/sub2api-auth": { isSub2ApiAuthEnabled: () => false },
    "@/lib/server/account-auth": { ACCOUNT_SESSION_COOKIE: "session", getAccountForDocument: async () => ({ id: "B" }), readCookie: () => "fake-B-session", deleteSessionToken: async () => { removed++; } },
    "@/lib/account-cookie-constants": { ACCOUNT_GATE_COOKIE: "gate" },
  });
  const request = id => new Request("http://fixture.test/api/auth/logout", { method: "POST", headers: { "X-Account-Id": id } });
  assert.equal((await service.POST(request("A"))).status, 409); assert.equal(removed, 0);
  assert.equal((await service.POST(request("B"))).status, 200); assert.equal(removed, 1);
});

test("备份拒绝内部数据库与身份记录，普通逻辑资料可导入", async () => {
  const kv = new Map();
  const storage = load("lib/account-storage.ts", {});
  const serializers = load("lib/data-management/serializers.ts", { "../sha256-stream": {} });
  const data = load("lib/data-management/idb.ts", {
    "./serializers": serializers, "../account-storage": storage,
    "../kv-db": { kvEntries: () => [...kv], kvGet: key => kv.get(key) ?? null, kvRemove: key => kv.delete(key), kvSetAsync: async (key, value) => { kv.set(key, value); } },
  });
  const payload = { type: "kv", records: [{ key: "ai_phone_active_account_id_v1", value: "B" }, { key: "__xunxin_identity_v1__", value: "B" }, { key: "chat-settings", value: "own-settings" }] };
  const result = await data.importSource(payload);
  assert.equal(result.errors.length, 2); assert.equal(result.added, 1);
  assert.deepEqual([...kv], [["chat-settings", "own-settings"]]);
  const rejected = await data.importSource({ type: "indexeddb", dbName: prefix("B") + "AiPhoneChatDB", stores: [] });
  assert.equal(rejected.errors.length, 1);
  const originalWindow = global.window, originalIndexedDb = global.indexedDB;
  let transactions = 0;
  try {
    global.window = {};
    global.indexedDB = { open: () => {
      const request = { result: { objectStoreNames: Object.assign(["entries"], { contains: name => name === "entries" }), close() {}, transaction() { transactions++; throw new Error("Identity records must be rejected before starting a transaction"); } } };
      queueMicrotask(() => request.onsuccess()); return request;
    } };
    const maliciousKvDb = await data.importSource({ type: "indexeddb", dbName: "AiPhoneKvDB", stores: [{ name: "entries", keyPath: "key", autoIncrement: false, indexes: [], records: [
      { key: "ai_phone_active_account_id_v1", value: { key: "ai_phone_active_account_id_v1", value: "B" } },
      { value: { key: "__xunxin_identity_v1__", value: "B" } },
    ] }] });
    assert.equal(maliciousKvDb.errors.length, 2); assert.equal(transactions, 0);
    assert.ok(maliciousKvDb.errors.every(error => error.includes("内部存储标识")));
  } finally { global.window = originalWindow; global.indexedDB = originalIndexedDb; }
});

test("声明式推送旧账号跳转不能运行快捷动作，匹配账号可正常跳转", async () => {
  const service = load("app/push-open/route.ts", { "@/lib/server/account-auth": { getAccountForDocument: async () => ({ id: "B" }) } });
  const target = "/shortcut-run?command=fake&ticket=fake";
  const request = id => new Request(`http://fixture.test/push-open?account=${id}&to=${encodeURIComponent(target)}`);
  assert.equal((await service.GET(request("A"))).headers.get("Location"), "http://fixture.test/");
  assert.equal((await service.GET(request("B"))).headers.get("Location"), "http://fixture.test" + target);
  const originalWindow = global.window; let active = true;
  try {
    global.window = { location: { origin: "http://fixture.test" }, __XUNXIN_ACCOUNT_STORAGE__: { accountId: "B", isActive: () => active } };
    const storage = load("lib/account-storage.ts", {});
    assert.ok(storage.isCurrentAccountPushUrl("http://fixture.test/push-open?account=B"));
    for (const url of ["/push-open?account=A", "https://other.example/push-open?account=B", "/push-open-extra?account=B"]) assert.equal(storage.isCurrentAccountPushUrl(url), false);
    active = false; assert.equal(storage.isCurrentAccountPushUrl("/push-open?account=B"), false);
  } finally { global.window = originalWindow; }
});

test("OAuth 回调须属于发起授权的账号，不把 A 的授权码写入 B", async () => {
  const scope = load("lib/oauth-account-scope.ts", {});
  const state = scope.createAccountOAuthState("A", "01234567-89ab-cdef-0123-456789abcdef");
  assert.ok(scope.matchesAccountOAuthState(state, "A"));
  assert.equal(scope.matchesAccountOAuthState(state, "B"), false);
  for (const bad of ["old-unowned-state", state + ":extra", state.replace(":A:", ":%41:")]) {
    assert.equal(scope.matchesAccountOAuthState(bad, "A"), false);
  }
  let id = "B";
  const service = load("app/api/oauth-callback/route.ts", {
    "next/server": { NextResponse: Response },
    "@/lib/server/account-auth": { getAccountForDocument: async () => ({ id }) },
    "@/lib/oauth-account-scope": scope,
  });
  const url = new URL("http://fixture.test/api/oauth-callback"); url.searchParams.set("state", state); url.searchParams.set("code", "A-private-code</script>");
  const request = new Request(url); request.nextUrl = url;
  const rejected = await service.GET(request); assert.equal(rejected.status, 409);
  assert.ok(!(await rejected.text()).includes("A-private-code"));
  id = "A";
  const response = await service.GET(request); const html = await response.text();
  assert.equal(response.status, 200); assert.ok(html.includes('data-account-storage-scope="A"'));
  assert.ok(html.indexOf("/account-storage-bootstrap.js") < html.indexOf("localStorage.setItem"));
  assert.ok(html.includes("A-private-code\\u003c/script>"));
});
