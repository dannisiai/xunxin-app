const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

function loadTypeScript(relativePath, dependencies, window) {
  const source = fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  const requireDependency = name => {
    if (!(name in dependencies)) throw new Error(`Unexpected dependency: ${name}`);
    return dependencies[name];
  };
  new Function("require", "module", "exports", "window", compiled)(
    requireDependency, module, module.exports, window,
  );
  return module.exports;
}

function createFixture() {
  const values = new Map();
  const window = new EventTarget();
  let characters = [{ id: "a", name: "同名角色" }, { id: "b", name: "同名角色" }];
  const characterStorage = { loadCharacters: () => characters };
  const kv = {
    kvGet: key => values.get(key) ?? null,
    kvSet: (key, value) => values.set(key, value),
    kvRemove: key => values.delete(key),
    registerKvMigration: () => {},
  };
  const storage = loadTypeScript("lib/diary-entry-storage.ts", {
    "./kv-db": kv,
    "./character-storage": characterStorage,
    "./diary-entry-types": {
      DEFAULT_DIARY_ENTRY_TIMER_SETTINGS: {
        enabled: false, intervalHours: 24, characterIds: [], lastRunAtByCharacter: {},
      },
    },
  }, window);
  return {
    window, storage, characterStorage,
    deleteCharacter: id => { characters = characters.filter(character => character.id !== id); },
  };
}

function entryInput(characterId, title) {
  return { characterId, characterName: "同名角色", title, body: title, blocks: [] };
}

test("删除角色的全部日记，只保留其他角色的日记并通知界面", () => {
  const { storage, window } = createFixture();
  storage.createDiaryEntry(entryInput("a", "第一篇"));
  storage.createDiaryEntry(entryInput("a", "第二篇"));
  storage.createDiaryEntry(entryInput("b", "另一位角色"));
  let updates = 0;
  window.addEventListener(storage.DIARY_ENTRIES_UPDATED_EVENT, () => { updates += 1; });

  storage.deleteDiaryEntriesForCharacter("a");
  assert.deepEqual(storage.loadDiaryEntries().map(entry => entry.title), ["另一位角色"]);
  assert.equal(updates, 1);
  storage.deleteDiaryEntriesForCharacter("a");
  storage.deleteDiaryEntriesForCharacter("");
  assert.equal(updates, 1);
});

test("角色删除后，迟到的生成结果不能创建日记", () => {
  const { storage, deleteCharacter } = createFixture();
  storage.createDiaryEntry(entryInput("a", "旧日记"));
  deleteCharacter("a");
  storage.deleteDiaryEntriesForCharacter("a");

  assert.equal(storage.createDiaryEntry(entryInput("a", "迟到的日记")), null);
  assert.ok(storage.createDiaryEntry(entryInput("b", "其他角色的新日记")));
  assert.deepEqual(storage.loadDiaryEntries().map(entry => entry.characterId), ["b"]);
});

test("定时生成途中删除角色，不会重新写入该角色的日记", async () => {
  const fixture = createFixture();
  const { storage, window, characterStorage, deleteCharacter } = fixture;
  storage.createDiaryEntry(entryInput("a", "旧日记"));
  storage.saveDiaryEntryTimerSettings({
    enabled: true, intervalHours: 24, characterIds: [], lastRunAtByCharacter: {},
  });

  let resolveDraft;
  let signalStarted;
  const started = new Promise(resolve => { signalStarted = resolve; });
  const draft = { title: "定时日记", body: "内容", blocks: [] };
  const timer = loadTypeScript("lib/diary-entry-timer-service.ts", {
    "./bg-timer": { bgSetInterval: () => () => {} },
    "./character-storage": characterStorage,
    "./diary-entry-storage": storage,
    "./diary-entry-engine": {
      generateDiaryEntryForCharacter: characterId => {
        if (characterId !== "a") return Promise.resolve(draft);
        signalStarted();
        return new Promise(resolve => { resolveDraft = resolve; });
      },
    },
  }, window);

  const running = timer.runDiaryEntryTimerCheck();
  await started;
  deleteCharacter("a");
  storage.deleteDiaryEntriesForCharacter("a");
  resolveDraft(draft);
  await running;
  assert.deepEqual(storage.loadDiaryEntries().map(entry => entry.characterId), ["b"]);
});
