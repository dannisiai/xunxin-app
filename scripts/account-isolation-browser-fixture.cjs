// Synthetic browser integration fixture. Uses only its own localhost origin,
// fake account cookies and disposable data; never connects to a live account.
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const bootstrap = fs.readFileSync(path.join(__dirname, "../public/account-storage-bootstrap.js"));
const port = Number(process.env.ACCOUNT_FIXTURE_PORT || 3127);

async function runner() {
  const output = document.querySelector("pre");
  const lines = [];
  function check(condition, label) { if (!condition) throw new Error(label); lines.push("PASS " + label); output.textContent = lines.join("\n"); }
  const request = async (url, init) => { const response = await fetch(url, init); if (!response.ok) throw new Error(url); return response; };
  const pause = () => new Promise(resolve => setTimeout(resolve, 100));
  async function frame(url = "/frame") {
    const element = document.createElement("iframe"); element.src = url; document.body.append(element);
    await new Promise((resolve, reject) => { element.onload = resolve; element.onerror = reject; });
    return element.contentWindow;
  }
  async function dbPut(win, name, key, value) {
    const db = await new Promise((resolve, reject) => { const r = win.indexedDB.open(name, 1); r.onupgradeneeded = () => r.result.createObjectStore("records"); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    await new Promise((resolve, reject) => { const tx = db.transaction("records", "readwrite"); tx.objectStore("records").put(value, key); tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
    db.close();
  }
  async function dbGet(win, name, key) {
    const db = await new Promise((resolve, reject) => { const r = win.indexedDB.open(name, 1); r.onupgradeneeded = () => r.result.createObjectStore("records"); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    const value = await new Promise((resolve, reject) => { const r = db.transaction("records").objectStore("records").get(key); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    db.close(); return value;
  }
  try {
    await request("/switch?account=A");
    localStorage.setItem("legacy-private", "unowned-private");
    await dbPut(window, "LegacyUnownedDB", "secret", "unowned-db-private");
    const a = await frame(); const ar = a.__XUNXIN_ACCOUNT_STORAGE__;
    const aStorage = a.localStorage;
    check(ar.accountId === "A", "document A receives verified account scope");
    check(a.localStorage.getItem("legacy-private") === null, "legacy localStorage is quarantined");
    check(!(await a.indexedDB.databases()).some(db => db.name === "LegacyUnownedDB"), "legacy IndexedDB is hidden");
    a.localStorage.chat = "A-chat"; a.sessionStorage.draft = "A-draft";
    await dbPut(a, "AiPhoneChatDB", "chat", { text: "A-chat", media: new Blob(["A-media"], { type: "text/plain" }) });
    await (await a.caches.open("media")).put("/private", new Response("A-cached"));
    const nested = a.document.createElement("iframe");
    nested.srcdoc = '<!doctype html><script src="/account-storage-bootstrap.js"></script><p>nested</p>';
    a.document.body.append(nested); await new Promise(resolve => nested.onload = resolve);
    check(nested.contentWindow.localStorage.chat === "A-chat", "same-origin authored frame inherits scope before scripts");
    nested.contentWindow.localStorage.frameData = "A-frame";
    check(a.localStorage.frameData === "A-frame", "frame writes remain in A namespace");
    const stream = await a.fetch("/api/stream"); const reader = stream.body.getReader(); await reader.read();
    await request("/switch?account=B");
    const b = await frame();
    for (let i = 0; i < 30 && ar.isActive(); i++) await pause();
    check(!ar.isActive(), "opening B freezes stale A tab");
    let aborted = false; try { await reader.read(); } catch (e) { aborted = e.name === "AbortError"; }
    check(aborted, "account switch aborts an in-flight streaming response");
    check(b.localStorage.chat === undefined && b.sessionStorage.draft === undefined, "B sees neither A chats nor session drafts");
    check(await dbGet(b, "AiPhoneChatDB", "chat") === undefined, "B cannot read A IndexedDB rows or blobs");
    check(await b.caches.match("/private") === undefined, "CacheStorage global match cannot read A media");
    let lateBlocked = false; try { aStorage.chat = "late"; } catch (e) { lateBlocked = e.name === "AbortError"; }
    check(lateBlocked, "stale A callbacks cannot write after switch");
    b.localStorage.chat = "B-chat";
    await dbPut(b, "AiPhoneChatDB", "chat", { text: "B-chat" });
    b.localStorage.clear();
    await request("/switch?account=A");
    const a2 = await frame();
    check(a2.localStorage.chat === "A-chat", "returning to A restores its own settings and chat keys");
    const row = await dbGet(a2, "AiPhoneChatDB", "chat");
    check(row.text === "A-chat" && await row.media.text() === "A-media", "returning to A restores original records and media blobs");
    const api = await (await a2.fetch("/api/echo", { method: "POST", headers: { "Content-Type": "text/plain" }, body: "A-body" })).json();
    check(api.account === "A" && api.marker === "A" && api.body === "A-body", "fetch binds API identity and preserves request body");
    const xhr = new a2.XMLHttpRequest(); xhr.open("POST", "/api/echo"); xhr.setRequestHeader("X-Account-Id", "A"); xhr.send("xhr-body");
    await new Promise(resolve => xhr.onload = resolve);
    check(JSON.parse(xhr.responseText).marker === "A", "XHR explicit account header is not duplicated");
    check(localStorage.getItem("legacy-private") === "unowned-private" && await dbGet(window, "LegacyUnownedDB", "secret") === "unowned-db-private", "all legacy data remains unchanged and unassigned");
    await ar.invalidate(); await b.__XUNXIN_ACCOUNT_STORAGE__.invalidate(); await a2.__XUNXIN_ACCOUNT_STORAGE__.invalidate();
    output.textContent += "\nALL " + lines.length + " CHECKS PASSED";
    document.title = "PASS account isolation";
  } catch (failure) { output.textContent += "\nFAIL " + failure.stack; document.title = "FAIL account isolation"; }
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://localhost:${port}`);
  const account = /(?:^|;\s*)fixture_account=([AB])/.exec(request.headers.cookie || "")?.[1] || "";
  response.setHeader("Cache-Control", "no-store");
  if (url.pathname === "/account-storage-bootstrap.js") { response.setHeader("Content-Type", "text/javascript"); response.end(bootstrap); return; }
  if (url.pathname === "/switch") { response.setHeader("Set-Cookie", `fixture_account=${url.searchParams.get("account")}; Path=/; SameSite=Lax`); response.end("ok"); return; }
  if (url.pathname === "/api/auth/me") { response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify({ ok: true, account: account ? { id: account } : null })); return; }
  if (url.pathname === "/api/echo") { let body = ""; for await (const chunk of request) body += chunk; response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify({ account, marker: request.headers["x-account-id"], body })); return; }
  if (url.pathname === "/api/stream") { response.setHeader("Content-Type", "text/plain"); response.write("first\n"); const timer = setInterval(() => response.write("next\n"), 10000); response.on("close", () => clearInterval(timer)); return; }
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  if (url.pathname === "/frame") {
    response.end(`<!doctype html><html data-account-storage-scope="${account}"><head><script src="/account-storage-bootstrap.js"></script></head><body>Account fixture ${account}</body></html>`); return;
  }
  response.end(`<!doctype html><title>Account isolation verification</title><style>body{font:16px system-ui;margin:32px;background:#f7f7f9}pre{white-space:pre-wrap;line-height:1.7}iframe{width:240px;height:42px;border:1px solid #ccc}</style><h1>Account isolation browser regression</h1><p>Synthetic accounts A/B. Isolated localhost test origin. No live account calls.</p><pre>Running…</pre><script>(${runner.toString()})();</script>`);
});
server.listen(port, "127.0.0.1", () => console.log(`Fixture ready: http://localhost:${port}`));
