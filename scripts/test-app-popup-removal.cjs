const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const ts = require("typescript");

const root = path.join(__dirname, "..");
function environment() {
    const now = 2_000_000_000_000;
    const timers = new Map(), listeners = new Map(), documentListeners = new Map();
    const created = [], storageReads = [], storageWrites = [], nativeCalls = [];
    let nextTimer = 0;
    class Element {
        constructor(tag) { this.tag = tag; this.style = { setProperty: (key, value) => { this.style[key] = value; } }; this.children = []; }
        append(...children) { this.children.push(...children); }
        appendChild(child) { this.append(child); }
        setAttribute() {}
        addEventListener() {}
        remove() {}
    }
    class Anchor extends Element {}
    class Button extends Element {}
    const meta = new Element("meta");
    const document = {
        body: new Element("body"), head: new Element("head"), documentElement: new Element("html"),
        visibilityState: "visible",
        createElement(tag) {
            created.push(tag);
            return tag === "a" ? new Anchor(tag) : tag === "button" ? new Button(tag) : new Element(tag);
        },
        querySelector: () => meta,
        addEventListener: (name, fn) => documentListeners.set(name, fn),
    };
    const storage = {
        // Simulate an upgrade with the old reminder's timestamp already over a day old.
        getItem(key) { storageReads.push(key); return JSON.stringify({ f: now - 3 * 86_400_000 }); },
        setItem(key, value) { storageWrites.push([key, value]); },
    };
    const window = {
        document, localStorage: storage,
        addEventListener: (name, fn) => listeners.set(name, fn),
        setTimeout(fn, delay) { const id = ++nextTimer; timers.set(id, { fn, delay }); return id; },
        clearTimeout: id => timers.delete(id),
        AndroidShell: { setSystemBarAppearanceForBackgrounds: (...args) => nativeCalls.push(args) },
    };
    const context = vm.createContext({
        window, document, localStorage: storage, console,
        Date: class extends Date { static now() { return now; } },
        performance: { now: () => 120_000 },
        HTMLAnchorElement: Anchor, HTMLButtonElement: Button,
        getComputedStyle: element => ({
            backgroundColor: element.background || "rgb(248, 247, 242)", backgroundImage: "none",
            display: "block", visibility: "visible", opacity: "1",
            getPropertyValue: () => "rgb(248, 247, 242)",
        }),
    });
    function load(file, dependencies = {}) {
        const module = { exports: {} };
        const code = ts.transpileModule(fs.readFileSync(path.join(root, file), "utf8"), {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
        }).outputText;
        const run = vm.runInContext(`(function(require,module,exports){${code}\n})`, context);
        run(name => {
            if (!(name in dependencies)) throw new Error(`Unexpected dependency: ${name}`);
            return dependencies[name];
        }, module, module.exports);
        return module.exports;
    }
    function runTimers() {
        const pending = [...timers.values()]; timers.clear();
        pending.sort((a, b) => a.delay - b.delay).forEach(timer => timer.fn());
    }
    return { load, window, document, timers, listeners, documentListeners, created, storageReads, storageWrites, nativeCalls, meta, runTimers };
}

test("升级后已有超过一天的提示记录，媒体维护仍只运行清理任务", () => {
    const app = environment();
    let cleanup, runs = 0;
    const scheduler = app.load("components/media-maintenance-scheduler.tsx", {
        react: { useEffect: effect => { cleanup = effect(); } },
        "@/lib/media-maintenance": { runScheduledMediaMaintenance: async () => { runs++; } },
    });
    scheduler.MediaMaintenanceScheduler();
    assert.equal([...app.timers.values()][0].delay, 45_000);
    app.runTimers();
    assert.equal(runs, 1);
    assert.deepEqual(app.created, []);
    assert.deepEqual(app.storageReads, []);
    assert.deepEqual(app.storageWrites, []);
    cleanup();
});

test("媒体维护组件卸载后取消任务", () => {
    const app = environment();
    let cleanup, runs = 0;
    const scheduler = app.load("components/media-maintenance-scheduler.tsx", {
        react: { useEffect: effect => { cleanup = effect(); } },
        "@/lib/media-maintenance": { runScheduledMediaMaintenance: async () => { runs++; } },
    });
    scheduler.MediaMaintenanceScheduler();
    cleanup(); app.runTimers();
    assert.equal(runs, 0);
});

test("状态栏取色在长时间运行及旧提示记录下保持正常，不创建弹窗", async () => {
    const app = environment();
    const tone = app.load("lib/bg-tone.ts");
    const shell = { isConnected: true, style: { setProperty() {} }, querySelector: () => null };
    await tone.updateStatusBarTone(shell, null);
    assert.deepEqual(app.nativeCalls, [[true, true]]);
    assert.equal(app.meta.content, "#f8f7f2");
    assert.deepEqual(app.created, []);
    assert.deepEqual(app.storageReads, []);
    assert.deepEqual(app.storageWrites, []);
});

test("报错收集启动及恢复前台不触发延时声明，仍记录三种来源的错误", () => {
    const app = environment();
    const log = app.load("lib/qa-error-log.ts");
    log.installQaErrorLog();
    app.runTimers();
    app.documentListeners.get("visibilitychange")?.();
    assert.deepEqual(app.created, []);
    assert.deepEqual(app.storageReads, []);
    assert.deepEqual(app.storageWrites, []);
    app.listeners.get("error")({ message: "script failed", filename: "https://example.test/app.js", lineno: 7 });
    app.listeners.get("unhandledrejection")({ reason: "request failed" });
    app.listeners.get("message")({ data: { source: "ai-phone-iframe-error", origin: "game", message: "iframe failed" } });
    const entries = log.getQaErrorEntries();
    assert.equal(entries.length, 3);
    assert.equal(entries[0].source, "app.js:7");
    assert.equal(entries[1].kind, "unhandledrejection");
    assert.equal(entries[2].message, "[game] iframe failed");
});
