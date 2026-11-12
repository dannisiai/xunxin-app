const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');
function load(file, dependencies = {}) {
  const module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  new Function('require', 'module', 'exports', code)(name => { if (!(name in dependencies)) throw Error(name); return dependencies[name]; }, module, module.exports);
  return module.exports;
}
const keys = load('lib/shared-persona-keys.ts');
function setup() {
  let id = 'A', active = true, archive = null, reading, writing = []; const stores = new Map();
  const store = () => { if (!stores.has(id)) stores.set(id, new Map()); return stores.get(id); };
  const response = value => JSON.stringify({ ok: true, value });
  const bridge = {
    sharedArchiveReadStart: () => { reading = archive; return response(JSON.stringify(archive ? { exists: true, size: archive.length, token: 'read' } : { exists: false })); },
    sharedArchiveRead: (_, token, offset) => response(Buffer.from(reading.subarray(Number(offset), Number(offset) + 192 * 1024)).toString('base64')),
    sharedArchiveWriteStart: () => { writing = []; return response('write'); },
    sharedArchiveWrite: (_, token, chunk) => { writing.push(Buffer.from(chunk, 'base64')); return response(true); },
    sharedArchiveCommit: () => { archive = Buffer.concat(writing); return response(true); },
  };
  const oldWindow = global.window;
  global.window = { AndroidShell: bridge, dispatchEvent() {} };
  const api = load('lib/shared-persona-archive.ts', {
    './kv-db': { kvGet: key => store().get(key) ?? null, kvSetAsync: async (key, value) => store().set(key, value) },
    './account-storage': { getDocumentAccountId: () => id, isAccountStorageActive: () => active },
    './shared-persona-keys': keys,
  });
  return { api, store, switchAccount: next => { id = next; }, freeze: () => { active = false; }, bytes: () => archive, replace: value => { archive = Buffer.from(value); }, close: () => { global.window = oldWindow; } };
}
test('所有账号读写同一份人设和头像，不共享凭证；修改和删除可以传播', async () => {
  const s = setup();
  try {
    s.store().set('ai_phone_characters_v1', JSON.stringify([{ id: 'char', name: '人设', avatar: 'data:image/png;base64,AA==' }]));
    s.store().set('ai_phone_user_identities_v1', JSON.stringify([{ id: 'identity', name: '用户', avatarUrl: 'data:image/png;base64,AQ==' }]));
    s.store().set('ai_phone_api_configs_v1', 'secret-do-not-export');
    await s.api.saveSharedArchive();
    assert.ok(!s.bytes().toString().includes('secret-do-not-export'));
    s.switchAccount('B'); assert.equal(await s.api.restoreSharedArchive(), true);
    assert.equal(JSON.parse(s.store().get('ai_phone_characters_v1'))[0].avatar, 'data:image/png;base64,AA==');
    assert.equal(JSON.parse(s.store().get('ai_phone_user_identities_v1'))[0].name, '用户');
    assert.equal(await s.api.restoreSharedArchive(), false);
    await s.api.saveSharedArchive();
    s.store().set('ai_phone_characters_v1', '[]'); await s.api.saveSharedArchive();
    s.switchAccount('A'); assert.equal(await s.api.restoreSharedArchive(), true);
    assert.deepEqual(JSON.parse(s.store().get('ai_phone_characters_v1')), []);
  } finally { s.close(); }
});
test('首次接入合并本机现有人设，后续不让旧副本覆盖共享文件', async () => {
  const s = setup();
  try {
    s.store().set('ai_phone_characters_v1', '[{"id":"a","name":"A"}]'); await s.api.saveSharedArchive();
    s.switchAccount('B'); s.store().set('ai_phone_characters_v1', '[{"id":"b","name":"B"}]');
    await s.api.restoreSharedArchive(); await s.api.saveSharedArchive();
    assert.deepEqual(JSON.parse(s.store().get('ai_phone_characters_v1')).map(item => item.id).sort(), ['a', 'b']);
    s.switchAccount('A'); await assert.rejects(s.api.saveSharedArchive(), /已变化/);
    await s.api.restoreSharedArchive(); assert.equal(JSON.parse(s.store().get('ai_phone_characters_v1')).length, 2);
  } finally { s.close(); }
});
test('校验失败和非法身份键拒绝载入，失效页面拒绝读写', async () => {
  const s = setup();
  try {
    await s.api.saveSharedArchive(); const saved = s.bytes().toString();
    const damaged = JSON.parse(saved); damaged.records.ai_phone_characters_v1 = '[{"id":"x","name":"tampered"}]';
    await assert.rejects(s.api.validateSharedArchive(JSON.stringify(damaged)), /校验失败/);
    damaged.records.__xunxin_identity_v1__ = 'B';
    await assert.rejects(s.api.validateSharedArchive(JSON.stringify(damaged)), /不允许共享/);
    s.freeze(); await assert.rejects(s.api.restoreSharedArchive(), /账户已切换/);
  } finally { s.close(); }
});
test('分块保存和扫描保留超过单块的中文头像资料；初始化只运行一次', async () => {
  const s = setup();
  try {
    const persona = JSON.stringify([{ id: 'large', name: '中文😀', avatar: 'data:image/png;base64,' + 'A'.repeat(500000) }]);
    s.store().set('ai_phone_characters_v1', persona);
    const [a, b] = await Promise.all([s.api.initializeSharedArchive(), s.api.initializeSharedArchive()]);
    assert.equal(a, false); assert.equal(b, false);
    s.switchAccount('reinstalled-account'); await s.api.restoreSharedArchive();
    assert.equal(s.store().get('ai_phone_characters_v1'), persona);
  } finally { s.close(); }
});
