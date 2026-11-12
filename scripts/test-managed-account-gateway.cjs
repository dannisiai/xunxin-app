const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

process.env.SUB2API_BASE_URL = "https://account.example";
process.env.ACCOUNT_APP_ORIGIN = "http://localhost:3000";
const provider = createHash("sha256").update(process.env.SUB2API_BASE_URL).digest("hex").slice(0, 16);
const accountId = `sub2api_${provider}_7`;
const session = { provider, accessToken: "account-session-token", accessExpiresAt: Date.now() + 300000 };

function loadServerModule(sessionStore = { readSub2ApiSession: async () => session }) {
  const filename = path.join(__dirname, "..", "lib", "server", "sub2api-auth.ts");
  const code = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  class NextResponse extends Response {
    static json(data, init) { return new Response(JSON.stringify(data), { ...init, headers: { "Content-Type": "application/json", ...init?.headers } }); }
  }
  const dependencies = {
    "server-only": {},
    "node:crypto": require("node:crypto"),
    "next/server": { NextResponse },
    "../account-cookie-constants": { ACCOUNT_SESSION_COOKIE: "session", ACCOUNT_GATE_COOKIE: "gate" },
    "../account-gate-cookie": {},
    "../llm-reasoning.mjs": require("../lib/llm-reasoning.mjs"),
    "./login-rate-limit": {},
    "./sub2api-session-store": sessionStore,
  };
  const module = { exports: {} };
  new Function("require", "module", "exports", code)(name => {
    if (!(name in dependencies)) throw new Error(`Unexpected dependency: ${name}`);
    return dependencies[name];
  }, module, module.exports);
  return module.exports;
}

const service = loadServerModule();
const headers = { Origin: "http://localhost:3000", Cookie: "session=test-session" };
const credentialHeaders = { ...headers, "X-Account-Id": accountId };

test("云端向量自动选择独立于聊天选择，并把实际向量模型返回客户端", async () => {
  const originalFetch = global.fetch; const calls = []; let models = ["gemini-chat", "BAAI/bge-m3"];
  global.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith("/auth/me")) return Response.json({ code: 0, data: { id: 7, email: "test@example.test", status: "active" } });
    if (String(url).endsWith("/models")) return Response.json({ data: models.map(id => ({ id })) });
    return Response.json({ data: [{ embedding: [1, 0] }] });
  };
  const request = () => new Request("http://localhost:3000/api/cloud/v1/embeddings", { method: "POST", headers: { ...credentialHeaders, Authorization: `Bearer account-session:${accountId}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: "__account_default__", input: "memory" }) });
  try {
    const response = await service.proxySub2ApiModel(request(), "/v1/embeddings");
    assert.equal(response.status, 200); assert.equal(response.headers.get("X-Embedding-Model"), "BAAI/bge-m3");
    assert.equal(JSON.parse(calls.at(-1).init.body).model, "BAAI/bge-m3");
    models = ["gemini-chat"]; calls.length = 0;
    assert.equal((await service.proxySub2ApiModel(request(), "/v1/embeddings")).status, 503);
    assert.ok(!calls.some(call => call.url.endsWith("/v1/embeddings")));
  } finally { global.fetch = originalFetch; }
});

test("邀请码只读取当前账户的数据且不返回邀请人的个人信息", async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith("/auth/me")) return Response.json({ code: 0, data: { id: 7, email: "user@example.test", status: "active" } });
    return Response.json({ code: 0, data: { aff_code: "abc+123", aff_count: 2, invitees: [{ email: "private@example.test" }] } });
  };
  try {
    const request = id => new Request("http://localhost:3000/api/account/invitation", { headers: { ...headers, "X-Account-Id": id } });
    assert.equal((await service.accountInvitationSub2Api(request("other"))).status, 409);
    assert.equal(calls.filter(call => call.url.endsWith("/user/aff")).length, 0);
    const response = await service.accountInvitationSub2Api(request(accountId));
    assert.deepEqual(await response.json(), { ok: true, code: "abc+123", count: 2, inviteUrl: "https://account.example/register?aff=abc%2B123" });
    assert.equal(calls.find(call => call.url.endsWith("/user/aff")).init.headers.Authorization, "Bearer account-session-token");
  } finally { global.fetch = originalFetch; }
});

test("账户只能查看自己的可用分组并切换自身凭证分组", async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith("/auth/me")) return Response.json({ code: 0, data: { id: 7, email: "user@example.test", status: "active" } });
    if (String(url).endsWith("/groups/available")) return Response.json({ code: 0, data: [{ id: 4, name: "分组 A", platform: "openai" }] });
    if (String(url).endsWith("/user/credential")) return Response.json({ code: 0, data: { id: 9 } });
    return Response.json({ code: 0, data: {} });
  };
  try {
    const groupHeaders = { ...headers, "X-Account-Id": accountId };
    const list = await service.accountGroupsSub2Api(new Request("http://localhost:3000/api/account/groups", { headers: groupHeaders }));
    assert.deepEqual((await list.json()).groups, [{ id: 4, name: "分组 A", platform: "openai" }]);
    const changed = await service.accountGroupsSub2Api(new Request("http://localhost:3000/api/account/groups", { method: "POST", headers: { ...groupHeaders, "Content-Type": "application/json" }, body: JSON.stringify({ groupId: 4 }) }));
    assert.equal(changed.status, 200);
    const update = calls.find(call => call.url.endsWith("/keys/9"));
    assert.deepEqual(JSON.parse(update.init.body), { group_id: 4 });
    assert.equal(update.init.headers.Authorization, "Bearer account-session-token");
  } finally { global.fetch = originalFetch; }
});

test("分组选择只修改当前账户的凭证", async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith("/auth/me")) return Response.json({ code: 0, data: { id: 7, email: "user@example.test", status: "active" } });
    if (String(url).endsWith("/groups/available")) return Response.json({ code: 0, data: [{ id: 3, name: "Gemini", platform: "antigravity" }] });
    if (String(url).endsWith("/user/credential")) return Response.json({ code: 0, data: { id: 8 } });
    return Response.json({ code: 0, data: {} });
  };
  try {
    const list = await service.accountGroupsSub2Api(new Request("http://localhost:3000/api/account/groups", { headers: { ...headers, "X-Account-Id": accountId } }));
    assert.deepEqual((await list.json()).groups, [{ id: 3, name: "Gemini", platform: "antigravity" }]);
    const change = await service.accountGroupsSub2Api(new Request("http://localhost:3000/api/account/groups", { method: "POST", headers: { ...headers, "Content-Type": "application/json", "X-Account-Id": accountId }, body: JSON.stringify({ groupId: 3 }) }));
    assert.equal(change.status, 200);
    const update = calls.find(call => call.url.endsWith("/keys/8"));
    assert.equal(update.init.method, "PUT");
    assert.deepEqual(JSON.parse(update.init.body), { group_id: 3 });
  } finally { global.fetch = originalFetch; }
});

test("兑换码仅提交到当前已验证账户", async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith("/auth/me")) return Response.json({ code: 0, data: { id: 7, email: "user@example.test", status: "active" } });
    return Response.json({ code: 0, data: { type: "balance" } });
  };
  try {
    const makeRequest = id => new Request("http://localhost:3000/api/account/redeem", { method: "POST", headers: { ...headers, "Content-Type": "application/json", "X-Account-Id": id }, body: JSON.stringify({ code: " example-code " }) });
    const wrongAccount = await service.redeemSub2Api(makeRequest("different-account"));
    assert.equal(wrongAccount.status, 409);
    assert.equal(calls.filter(call => call.url.endsWith("/redeem")).length, 0);
    const result = await service.redeemSub2Api(makeRequest(accountId));
    assert.equal(result.status, 200);
    const request = calls.find(call => call.url.endsWith("/redeem"));
    assert.equal(request.init.headers.Authorization, "Bearer account-session-token");
    assert.deepEqual(JSON.parse(request.init.body), { code: "example-code" });
  } finally { global.fetch = originalFetch; }
});

test("账户凭证读取和重置返回当前账户密钥", async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    const data = String(url).endsWith("/auth/me")
      ? { id: 7, email: "user@example.test", status: "active" }
      : { id: 5, key: "private-key-from-old-server", user: { balance: 12.5 }, status: "active" };
    return Response.json({ code: 0, data });
  };
  try {
    for (const reset of [false, true]) {
      const request = new Request("http://localhost:3000/api/auth/credential", reset ? {
        method: "POST", headers: { ...credentialHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ idempotencyKey: "0123456789abcdef" }),
      } : { headers: credentialHeaders });
      const response = await service.accountCredentialSub2Api(request, reset);
      assert.equal(response.status, 200);
      const text = await response.text();
      const result = JSON.parse(text);
      assert.equal(result.credential.balance, 12.5);
      assert.equal(result.credential.apiBaseUrl, "https://account.example/v1");
      assert.equal(result.credential.key, "private-key-from-old-server");
    }
    const resetCall = calls.find(call => call.url.endsWith("/user/credential/reset"));
    assert.equal(resetCall.init.method, "POST");
    assert.equal(resetCall.init.headers.Authorization, "Bearer account-session-token");
    assert.equal(resetCall.init.headers["Idempotency-Key"], "0123456789abcdef");
    assert.deepEqual(JSON.parse(resetCall.init.body), {});
  } finally { global.fetch = originalFetch; }
});

test("旧标签页及缺少账户绑定的请求不能读取或重置新账户凭证", async () => {
  const originalFetch = global.fetch;
  const credentialCalls = [];
  global.fetch = async (url, init) => {
    if (String(url).endsWith("/auth/me")) return Response.json({ code: 0, data: { id: 7, email: "current@example.test", status: "active" } });
    credentialCalls.push({ url: String(url), init });
    return Response.json({ code: 0, data: { id: 5, key: "must-not-be-returned", user: { balance: 12.5 }, status: "active" } });
  };
  try {
    for (const reset of [true, false]) {
      for (const displayedAccount of [`sub2api_${provider}_6`, undefined, "", `sub2api_${provider}_07`, `${accountId}, ${accountId}`, "sub2api_0000000000000000_7"]) {
        const boundHeaders = { ...headers, ...(displayedAccount !== undefined ? { "X-Account-Id": displayedAccount } : {}) };
        const request = new Request(`http://localhost:3000/api/auth/credential?accountId=${accountId}`, reset ? {
          method: "POST", headers: { ...boundHeaders, "Content-Type": "application/json" },
          // A body/query account ID must not override the displayed-account header.
          body: JSON.stringify({ idempotencyKey: "0123456789abcdef", accountId }),
        } : { headers: boundHeaders });
        const response = await service.accountCredentialSub2Api(request, reset);
        assert.equal(response.status, 409, `reset=${reset}, displayedAccount=${displayedAccount}`);
        assert.equal(response.headers.get("cache-control"), "no-store");
        const result = await response.json();
        assert.equal(result.ok, false);
        assert.match(result.error, /账户已切换/);
        assert.equal(result.credential, undefined);
      }
    }
    assert.equal(credentialCalls.length, 0);
  } finally { global.fetch = originalFetch; }
});

test("账户匹配时仍拒绝缺少或无效的凭证重置幂等标识", async () => {
  const originalFetch = global.fetch;
  let resetCalls = 0;
  global.fetch = async url => {
    if (String(url).endsWith("/auth/me")) return Response.json({ code: 0, data: { id: 7, email: "current@example.test", status: "active" } });
    resetCalls++;
    return Response.json({ code: 0, data: {} });
  };
  try {
    for (const idempotencyKey of [undefined, "short", "0123456789abcde!", "x".repeat(129)]) {
      const request = new Request("http://localhost:3000/api/auth/credential", {
        method: "POST", headers: { ...credentialHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ idempotencyKey }),
      });
      assert.equal((await service.accountCredentialSub2Api(request, true)).status, 400);
    }
    assert.equal(resetCalls, 0);
  } finally { global.fetch = originalFetch; }
});

test("会话续期后仍按重新验证的账户拒绝旧页面，匹配账户可正常重置", async () => {
  const originalFetch = global.fetch;
  let stored = { provider, accessToken: "expired-token", refreshToken: "refresh-token", accessExpiresAt: Date.now() - 1000, expiresAt: Date.now() + 3600000 };
  const renewedService = loadServerModule({
    readSub2ApiSession: async () => stored,
    withSub2ApiSessionLock: async (_id, operation) => operation(),
    writeSub2ApiSession: async (_id, next) => { stored = next; },
  });
  const credentialCalls = [];
  let refreshCalls = 0;
  global.fetch = async (url, init) => {
    if (String(url).endsWith("/auth/refresh")) {
      refreshCalls++;
      return Response.json({ code: 0, data: { access_token: "renewed-token", refresh_token: "renewed-refresh-token", expires_in: 600 } });
    }
    if (String(url).endsWith("/auth/me")) {
      assert.equal(init.headers.Authorization, "Bearer renewed-token");
      return Response.json({ code: 0, data: { id: 8, email: "renewed@example.test", status: "active" } });
    }
    credentialCalls.push({ url: String(url), init });
    return Response.json({ code: 0, data: { id: 5, key: "renewed-account-key", user: { balance: 12.5 }, status: "active" } });
  };
  try {
    const request = displayedAccount => new Request("http://localhost:3000/api/auth/credential", {
      method: "POST", headers: { ...headers, "Content-Type": "application/json", "X-Account-Id": displayedAccount },
      body: JSON.stringify({ idempotencyKey: "0123456789abcdef" }),
    });
    assert.equal((await renewedService.accountCredentialSub2Api(request(accountId), true)).status, 409);
    assert.equal(refreshCalls, 1);
    assert.equal(credentialCalls.length, 0);
    assert.equal((await renewedService.accountCredentialSub2Api(request(`sub2api_${provider}_8`), true)).status, 200);
    assert.equal(credentialCalls.length, 1);
    assert.ok(credentialCalls[0].url.endsWith("/user/credential/reset"));
    assert.equal(credentialCalls[0].init.headers.Authorization, "Bearer renewed-token");
    assert.equal(credentialCalls[0].init.headers["Idempotency-Key"], "0123456789abcdef");
  } finally { global.fetch = originalFetch; }
});

test("域名连接使用域名对应的账户和会话标识", async () => {
  const originalFetch = global.fetch;
  const originalBase = process.env.SUB2API_BASE_URL;
  const oldIpProvider = createHash("sha256").update("https://54.64.70.205").digest("hex").slice(0, 16);
  const domainProvider = createHash("sha256").update("https://xunxin.shop").digest("hex").slice(0, 16);
  process.env.SUB2API_BASE_URL = "https://xunxin.shop";
  session.provider = oldIpProvider;
  const calls = [];
  global.fetch = async url => {
    calls.push(String(url));
    return Response.json({ code: 0, data: String(url).endsWith("/auth/me")
      ? { id: 7, email: "user@example.test", status: "active" }
      : { id: 5, user: { balance: 1 }, status: "active" } });
  };
  try {
    const domainHeaders = { ...headers, "X-Account-Id": `sub2api_${domainProvider}_7` };
    const stale = await service.accountCredentialSub2Api(new Request("http://localhost:3000/api/auth/credential", { headers: domainHeaders }), false);
    assert.equal(stale.status, 401);
    session.provider = domainProvider;
    const response = await service.accountCredentialSub2Api(new Request("http://localhost:3000/api/auth/credential", { headers: domainHeaders }), false);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).credential.apiBaseUrl, "https://xunxin.shop/v1");
    assert.ok(calls.every(url => url.startsWith("https://xunxin.shop/")));
    const account = await service.getSub2ApiAccount(new Request("http://localhost:3000/", { headers: domainHeaders }));
    assert.equal(account.id, `sub2api_${domainProvider}_7`);
  } finally { global.fetch = originalFetch; process.env.SUB2API_BASE_URL = originalBase; session.provider = provider; }
});

test("自动模型和生成请求使用账户会话访问云端代理", async () => {
  const originalFetch = global.fetch;
  const requests = [];
  global.fetch = async (url, init) => {
    requests.push({ url: String(url), init });
    if (String(url).endsWith("/auth/me")) return Response.json({ code: 0, data: { id: 7, email: "user@example.test", status: "active" } });
    if (String(url).endsWith("/managed-gateway/v1/models")) return Response.json({ data: [{ id: "gemini-3.8-flash" }] });
    return new Response("data: test\n\n", { headers: { "Content-Type": "text/event-stream" } });
  };
  try {
    const request = new Request("http://localhost:3000/api/cloud/v1/chat/completions", {
      method: "POST", headers: { ...headers, "X-Account-Id": accountId, Authorization: `Bearer account-session:${accountId}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "__account_default__", messages: [] }),
    });
    const response = await service.proxySub2ApiModel(request, "/v1/chat/completions");
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "data: test\n\n");
    assert.equal(requests.length, 3);
    assert.ok(requests.every(call => !call.url.endsWith("/user/credential")));
    assert.ok(requests[1].url.endsWith("/managed-gateway/v1/models"));
    assert.ok(requests[2].url.endsWith("/managed-gateway/v1/chat/completions"));
    assert.equal(requests[2].init.headers.Authorization, "Bearer account-session-token");
    assert.equal(JSON.parse(requests[2].init.body).model, "gemini-3.8-flash");
    assert.equal(JSON.parse(requests[2].init.body).reasoning_effort, "low");
  } finally { global.fetch = originalFetch; }
});
