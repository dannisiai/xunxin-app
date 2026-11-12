const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
function load(file, dependencies = {}) {
  const module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  new Function('require', 'module', 'exports', code)(name => { if (!(name in dependencies)) throw Error(name); return dependencies[name]; }, module, module.exports);
  return module.exports;
}
const embedding = load('lib/memory-embedding.ts', { './api-helpers': {
  determineBaseUrl: config => config.baseUrl,
  buildRequestHeaders: config => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` }),
} });
const config = { id: 'cloud-A', provider: 'Custom', apiKey: 'account-session:A', baseUrl: 'http://fixture.test/api/cloud/v1', defaultModel: 'gemini-chat', embeddingModel: '__account_default__' };
const entry = (id, content, extra = {}) => ({ id, content, characterId: 'char', type: 'long_term', createdAt: '2026-01-01', updatedAt: '2026-01-01', ...extra });

test('默认开启向量记忆，云端聊天模型与向量模型互不覆盖', () => {
  assert.equal(load('lib/memory-types.ts').DEFAULT_MEMORY_CONFIG.vectorRecallEnabled, true);
  const previous = global.window;
  try {
    global.window = { location: { origin: 'http://fixture.test' } };
    const cloud = load('lib/cloud-account.ts', { './account-client': { loadActiveAccountId: () => 'sub2api_0123456789abcdef_1' }, './kv-db': { kvGet: () => 'gemini-chat' }, './cloud-voice': {} }).cloudAccountConfig();
    assert.equal(cloud.defaultModel, 'gemini-chat'); assert.equal(embedding.resolveEmbeddingModel(cloud), '__account_default__');
    assert.equal(embedding.resolveEmbeddingModel({ provider: 'OpenAI', defaultModel: 'gpt-chat' }), 'text-embedding-3-small');
    assert.equal(embedding.resolveEmbeddingModel({ provider: 'Custom', defaultModel: 'shared-model', embeddingModel: 'shared-model' }), 'shared-model');
  } finally { global.window = previous; }
});

test('真实生成函数到达 embeddings 并保存实际模型，拒绝损坏向量', async () => {
  const previous = global.fetch; const calls = [];
  try {
    global.fetch = async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return Response.json({ data: [{ embedding: [1, 0] }] }, { headers: { 'X-Embedding-Model': 'bge-m3' } }); };
    const vector = await embedding.generateEmbeddingRecord('记忆正文', config);
    assert.equal(calls[0].url, config.baseUrl + '/embeddings');
    assert.deepEqual(calls[0].body, { model: '__account_default__', input: '记忆正文' });
    assert.equal(vector.model, 'bge-m3'); assert.ok(vector.embeddingSpace.includes('bge-m3'));
    for (const bad of [[0, 0], [1, 'bad'], [null, 1], []]) {
      global.fetch = async () => Response.json({ model: 'bge-m3', data: [{ embedding: bad }] });
      await assert.rejects(embedding.generateEmbeddingRecord('text', config, { throwOnError: true }), /向量/);
    }
  } finally { global.fetch = previous; }
});

test('旧向量、相同维度不同模型及不同维度不得直接比较', async () => {
  const query = { embedding: [1, 0], model: 'bge-m3', embeddingSpace: 'space-bge' };
  assert.equal(embedding.compatibleEmbedding(entry('legacy', 'old', { embedding: [1, 0] }), query), false);
  assert.equal(embedding.compatibleEmbedding(entry('other', 'old', { embedding: [1, 0], embeddingSpace: 'other-model' }), query), false);
  assert.equal(embedding.compatibleEmbedding(entry('dim', 'old', { embedding: [1, 0, 0], embeddingSpace: 'space-bge' }), query), false);
  assert.equal(embedding.compatibleEmbedding(entry('ok', 'old', { embedding: [1, 0], embeddingSpace: 'space-bge' }), query), true);
  assert.equal(embedding.cosineSimilarity([NaN, 1], [1, 0]), 0);
});

function service(entries, options = {}) {
  const calls = []; const saved = [];
  const vector = { embedding: [1, 0], model: 'bge-m3', embeddingSpace: 'space-bge' };
  const memory = load('lib/memory-service.ts', {
    './memory-storage': { loadMemoryEntriesByType: async () => entries.map(e => ({ ...e })), saveMemoryEmbedding: async (...args) => saved.push(args) },
    './settings-storage': { resolveAuxiliaryApiConfig: () => config },
    './token-counter': { estimateTokens: content => content.length },
    './memory-embedding': { ...embedding, generateEmbeddingRecord: async (text, api) => { calls.push({ text, api }); if (options.unavailable) return null; return { ...vector, embedding: text === 'unrelated' ? [0, 1] : [1, 0] }; } },
  });
  return { memory, calls, saved };
}
test('超预算时补建旧向量且优先召回语义相关记忆；关闭和全量预算不发请求', async () => {
  const entries = [entry('old', 'unrelated'), entry('relevant', '生日蛋糕')];
  const s = service(entries);
  const result = await s.memory.retrieveMemoriesForPrompt('char', '生日', { vectorRecallEnabled: true, longTermTokenBudget: 12 });
  assert.equal(result[0].id, 'relevant'); assert.equal(s.saved.length, 2);
  assert.ok(s.calls.slice(1).every(call => call.api.embeddingModel === 'bge-m3'));
  for (const settings of [{ vectorRecallEnabled: false, longTermTokenBudget: 12 }, { vectorRecallEnabled: true, longTermTokenBudget: 1000 }]) {
    const control = service(entries); await control.memory.retrieveMemoriesForPrompt('char', '生日', settings); assert.equal(control.calls.length, 0);
  }
});
test('补建每次最多四条；模型不可用仍可返回文字记忆', async () => {
  const entries = Array.from({ length: 20 }, (_, index) => entry(String(index), '生日蛋糕'));
  const s = service(entries); await s.memory.retrieveMemoriesForPrompt('char', '生日', { vectorRecallEnabled: true, longTermTokenBudget: 10 });
  assert.equal(s.saved.length, 4); assert.equal(s.calls.length, 5);
  const unavailable = service(entries, { unavailable: true });
  assert.ok((await unavailable.memory.retrieveMemoriesForPrompt('char', '生日', { vectorRecallEnabled: true, longTermTokenBudget: 10 })).length);
});

test('默认值兼容旧配置，明确关闭保留；迟到向量不恢复已删除或已修改记忆', async () => {
  const oldWindow = global.window, oldIndexedDb = global.indexedDB;
  let raw = null, current; const writes = [];
  const original = entry('entry', 'original');
  try {
    global.window = {}; global.indexedDB = {};
    const storage = load('lib/memory-storage.ts', {
      './memory-types': load('lib/memory-types.ts'),
      './kv-db': { kvGet: () => raw, registerKvMigration() {}, registerDynamicPrefix() {} },
      './idb-open': { openIndexedDbAtLeast: async () => ({ close() {}, transaction() {
        const tx = { objectStore: () => ({
          get: () => { const request = {}; setImmediate(() => { request.result = current; request.onsuccess(); tx.oncomplete(); }); return request; },
          put: value => writes.push(value),
        }) }; return tx;
      } }) },
    });
    assert.equal(storage.loadMemoryConfig().vectorRecallEnabled, true);
    raw = '{}'; assert.equal(storage.loadMemoryConfig().vectorRecallEnabled, true);
    raw = '{"vectorRecallEnabled":null}'; assert.equal(storage.loadMemoryConfig().vectorRecallEnabled, true);
    raw = '{"vectorRecallEnabled":false}'; assert.equal(storage.loadMemoryConfig().vectorRecallEnabled, false);
    current = undefined; await storage.saveMemoryEmbedding(original, [1, 0], 'space');
    current = { ...original, content: 'edited' }; await storage.saveMemoryEmbedding(original, [1, 0], 'space');
    assert.equal(writes.length, 0);
    current = { ...original }; await storage.saveMemoryEmbedding(original, [1, 0], 'space');
    assert.equal(writes.length, 1); assert.equal(writes[0].content, 'original'); assert.equal(writes[0].embeddingSpace, 'space');
  } finally { global.window = oldWindow; global.indexedDB = oldIndexedDb; }
});
