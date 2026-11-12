/* Runs before application modules. Original, unowned stores are never adopted. */
(function (root, factory) {
  var install = factory();
  if (typeof module === "object" && module.exports) module.exports = install;
  else install(root);
})(typeof window === "undefined" ? null : window, function () {
  "use strict";
  return function installAccountStorage(win, options) {
    options = options || {};
    if (!win || win.__XUNXIN_ACCOUNT_STORAGE__) return win && win.__XUNXIN_ACCOUNT_STORAGE__;
    var parentRuntime = null;
    try { if (win.parent !== win) parentRuntime = win.parent.__XUNXIN_ACCOUNT_STORAGE__; } catch (_) {}
    var accountId = parentRuntime ? parentRuntime.accountId : options.accountId;
    if (accountId === undefined) accountId = win.document.documentElement.getAttribute("data-account-storage-scope") || "";
    if (typeof accountId !== "string" || accountId.length > 160 || /[\x00-\x1f]/.test(accountId)) accountId = "";
    var FAMILY = "__xunxin_account_v1__:";
    var prefix = FAMILY + encodeURIComponent(accountId) + ":";
    var IDENTITY_KEY = "__xunxin_identity_v1__";
    var active = true;
    var nativeFetch = win.fetch && win.fetch.bind(win);
    var nativeShell = win.AndroidShell;
    var controllers = new Set(), databases = new Set(), transactions = new Set(), sockets = new Set(), xhrs = new Set();
    var cleanups = new Set(), subscriptions = [], transition = null;
    var rawLocal = null;
    try { rawLocal = win.localStorage; } catch (_) {}
    var storageProto = win.Storage && win.Storage.prototype;
    var rawGet = storageProto && storageProto.getItem;
    var rawSet = storageProto && storageProto.setItem;
    var rawRemove = storageProto && storageProto.removeItem;
    var rawKey = storageProto && storageProto.key;
    var rawLength = storageProto && Object.getOwnPropertyDescriptor(storageProto, "length").get;
    function error(message) { return new win.DOMException(message || "账户已切换，请重新打开页面。", "AbortError"); }
    function isActive() { return active && (!parentRuntime || parentRuntime.isActive()); }
    function assertActive() { if (!isActive() || !accountId) throw error(); }
    function logicalName(name) {
      var value = String(name);
      if (value.indexOf(FAMILY) === 0 || value.indexOf("__xunxin_") === 0) throw new TypeError("不能使用账户存储内部标识。");
      return value;
    }
    function physicalName(name) { assertActive(); return prefix + logicalName(name); }
    function visibleKeys(storage) {
      if (!isActive() || !accountId) return [];
      var result = [];
      for (var i = 0, length = rawLength.call(storage); i < length; i++) {
        var key = rawKey.call(storage, i);
        if (key && key.indexOf(prefix) === 0) result.push(key.slice(prefix.length));
      }
      return result;
    }
    function storageView(storage) {
      var methods = {
        getItem: function (key) { return isActive() && accountId ? rawGet.call(storage, prefix + logicalName(key)) : null; },
        setItem: function (key, value) { rawSet.call(storage, physicalName(key), String(value)); },
        removeItem: function (key) { rawRemove.call(storage, physicalName(key)); },
        key: function (index) { return visibleKeys(storage)[Number(index)] || null; },
        clear: function () { assertActive(); visibleKeys(storage).forEach(function (key) { rawRemove.call(storage, prefix + key); }); }
      };
      return new Proxy(storage, {
        get: function (_, key) {
          if (key === "length") return visibleKeys(storage).length;
          if (Object.prototype.hasOwnProperty.call(methods, key)) return methods[key];
          if (typeof key === "symbol" || key in storageProto) return Reflect.get(storage, key, storage);
          var value = methods.getItem(key); return value === null ? undefined : value;
        },
        set: function (_, key, value) { if (typeof key !== "string") return false; methods.setItem(key, value); return true; },
        deleteProperty: function (_, key) { methods.removeItem(key); return true; },
        ownKeys: function () { return visibleKeys(storage); },
        has: function (_, key) { return key in storageProto || (typeof key === "string" && methods.getItem(key) !== null); },
        getOwnPropertyDescriptor: function (_, key) {
          var value = typeof key === "string" ? methods.getItem(key) : null;
          return value === null ? undefined : { value: value, enumerable: true, configurable: true, writable: true };
        },
        defineProperty: function (_, key, descriptor) { if (!("value" in descriptor)) return false; methods.setItem(key, descriptor.value); return true; }
      });
    }
    ["localStorage", "sessionStorage"].forEach(function (name) {
      try {
        var view = storageView(win[name]);
        Object.defineProperty(win, name, { get: function () { return view; }, configurable: false });
      } catch (failure) { if (rawLocal) throw failure; }
    });
    var processedStorageEvents = new WeakSet();
    win.addEventListener("storage", function (event) {
      if (processedStorageEvents.has(event)) return;
      event.stopImmediatePropagation();
      if (event.key === IDENTITY_KEY) {
        try { if (JSON.parse(event.newValue || "null").accountId !== accountId) void invalidate(); } catch (_) {}
        return;
      }
      if (!isActive() || !accountId || !event.key || event.key.indexOf(prefix) !== 0) return;
      var copy = new win.StorageEvent("storage", {
        key: event.key.slice(prefix.length), oldValue: event.oldValue, newValue: event.newValue, url: event.url
      });
      Object.defineProperty(copy, "storageArea", { value: event.storageArea === rawLocal ? win.localStorage : win.sessionStorage });
      processedStorageEvents.add(copy);
      win.dispatchEvent(copy);
    }, true);

    if (win.indexedDB) {
      var idb = win.indexedDB;
      var open = idb.open.bind(idb), removeDb = idb.deleteDatabase.bind(idb);
      var listDb = idb.databases && idb.databases.bind(idb);
      idb.open = function (name, version) {
        var target = physicalName(name);
        var request = arguments.length > 1 ? open(target, version) : open(target);
        request.addEventListener("success", function () {
          if (!isActive()) { request.result.close(); return; }
          databases.add(request.result);
        });
        return request;
      };
      idb.deleteDatabase = function (name) { return removeDb(physicalName(name)); };
      if (listDb) idb.databases = async function () {
        assertActive();
        return (await listDb()).filter(function (db) { return db.name && db.name.indexOf(prefix) === 0; })
          .map(function (db) { return { name: db.name.slice(prefix.length), version: db.version }; });
      };
      if (win.IDBDatabase) {
        var transaction = win.IDBDatabase.prototype.transaction;
        win.IDBDatabase.prototype.transaction = function () {
          assertActive();
          if (this.name.indexOf(prefix) !== 0) throw error("数据库不属于当前账户。");
          var tx = transaction.apply(this, arguments);
          transactions.add(tx);
          ["complete", "abort", "error"].forEach(function (event) { tx.addEventListener(event, function () { transactions.delete(tx); }); });
          return tx;
        };
      }
    }
    if (win.caches) {
      var caches = win.caches;
      var openCache = caches.open.bind(caches), deleteCache = caches.delete.bind(caches), cacheKeys = caches.keys.bind(caches);
      caches.open = async function (name) { return openCache(physicalName(name)); };
      caches.delete = async function (name) { return deleteCache(physicalName(name)); };
      caches.keys = async function () { assertActive(); return (await cacheKeys()).filter(function (key) { return key.indexOf(prefix) === 0; }).map(function (key) { return key.slice(prefix.length); }); };
      caches.has = async function (name) { return (await caches.keys()).indexOf(logicalName(name)) >= 0; };
      caches.match = async function (request, matchOptions) {
        assertActive();
        var names = matchOptions && matchOptions.cacheName !== undefined ? [logicalName(matchOptions.cacheName)] : await caches.keys();
        for (var i = 0; i < names.length; i++) {
          var match = await (await caches.open(names[i])).match(request, matchOptions);
          if (match) return match;
        }
        return undefined;
      };
      if (win.Cache) ["add", "addAll", "put", "delete", "match", "matchAll", "keys"].forEach(function (name) {
        var original = win.Cache.prototype[name];
        if (original) win.Cache.prototype[name] = function () { assertActive(); return original.apply(this, arguments); };
      });
    }

    function abortSignal(signal, controller) {
      if (!signal) return controller.signal;
      if (signal.aborted) controller.abort(signal.reason);
      else signal.addEventListener("abort", function () { controller.abort(signal.reason); }, { once: true });
      return controller.signal;
    }
    function publicAuth(path) { return ["/api/auth/me", "/api/auth/config", "/api/auth/login", "/api/auth/email-code"].indexOf(path) >= 0; }
    if (nativeFetch) win.fetch = async function (input, init) {
      if (!isActive()) throw error();
      var request = new win.Request(typeof input === "string" || input instanceof win.URL ? new win.URL(input, win.location.href).href : input, init);
      var url = new win.URL(request.url), sameOrigin = url.origin === win.location.origin;
      var sensitive = sameOrigin && url.pathname.indexOf("/api/") === 0 && !publicAuth(url.pathname);
      if (sensitive || !sameOrigin) assertActive();
      var headers = new win.Headers(request.headers);
      if (sensitive) {
        if (headers.has("X-Account-Id") && headers.get("X-Account-Id") !== accountId) throw error();
        headers.set("X-Account-Id", accountId);
      }
      var controller = new win.AbortController(); controllers.add(controller);
      try {
        var response = await nativeFetch(new win.Request(request, { headers: headers, signal: abortSignal(request.signal, controller) }));
        if (!isActive()) { if (response.body) void response.body.cancel(); throw error(); }
        if (response.body) {
          // Keep streaming requests abortable after headers have arrived.
          var reader = response.body.getReader();
          var body = new win.ReadableStream({
            pull: async function (stream) {
              try {
                var part = await reader.read();
                if (!isActive()) throw error();
                if (part.done) { controllers.delete(controller); stream.close(); }
                else stream.enqueue(part.value);
              } catch (failure) { controllers.delete(controller); stream.error(failure); }
            },
            cancel: function (reason) { controllers.delete(controller); return reader.cancel(reason); }
          });
          var wrapped = new win.Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
          ["url", "redirected", "type"].forEach(function (key) { Object.defineProperty(wrapped, key, { value: response[key] }); });
          response = wrapped;
          return response;
        }
        controllers.delete(controller);
        return response;
      } catch (failure) { controllers.delete(controller); throw failure; }
    };
    if (win.XMLHttpRequest) {
      var xhrProto = win.XMLHttpRequest.prototype, xhrOpen = xhrProto.open, xhrSend = xhrProto.send, xhrHeader = xhrProto.setRequestHeader;
      xhrProto.open = function (method, url) { this.__xunxinUrl = new win.URL(url, win.location.href); this.__xunxinAccountHeader = null; return xhrOpen.apply(this, arguments); };
      xhrProto.setRequestHeader = function (name, value) {
        if (String(name).toLowerCase() === "x-account-id") {
          if (String(value) !== accountId) throw error();
          if (this.__xunxinAccountHeader !== null) return;
          this.__xunxinAccountHeader = String(value);
        }
        return xhrHeader.apply(this, arguments);
      };
      xhrProto.send = function () {
        if (!isActive()) throw error();
        var url = this.__xunxinUrl;
        if (url && (url.origin !== win.location.origin || (url.pathname.indexOf("/api/") === 0 && !publicAuth(url.pathname)))) {
          assertActive();
          if (url.origin === win.location.origin) this.setRequestHeader("X-Account-Id", accountId);
        }
        var xhr = this; xhrs.add(xhr); xhr.addEventListener("loadend", function () { xhrs.delete(xhr); }, { once: true });
        return xhrSend.apply(xhr, arguments);
      };
    }
    if (win.WebSocket) {
      var NativeWebSocket = win.WebSocket;
      function ScopedWebSocket(url, protocols) {
        var target = new win.URL(url, win.location.href);
        var hmr = target.pathname === "/_next/webpack-hmr";
        if (!hmr) assertActive();
        var socket = protocols === undefined ? new NativeWebSocket(url) : new NativeWebSocket(url, protocols);
        if (!hmr) { sockets.add(socket); socket.addEventListener("close", function () { sockets.delete(socket); }, { once: true }); }
        return socket;
      }
      ScopedWebSocket.prototype = NativeWebSocket.prototype;
      Object.setPrototypeOf(ScopedWebSocket, NativeWebSocket);
      win.WebSocket = ScopedWebSocket;
    }

    function nativeAccountChanged(id) {
      try { if (nativeShell && nativeShell.onAccountScopeChanged) nativeShell.onAccountScopeChanged(id); } catch (_) {}
      if (!id) try { if (nativeShell && nativeShell.stopCompanionOverlay) nativeShell.stopCompanionOverlay(); } catch (_) {}
    }
    if (nativeShell) {
      var shellMethods = new Map();
      Object.defineProperty(win, "AndroidShell", { configurable: false, value: new Proxy({}, {
        get: function (_, key) {
          var method = nativeShell[key];
          if (typeof method !== "function") return method;
          if (!shellMethods.has(key)) shellMethods.set(key, function () {
            if (!isActive()) throw error();
            return method.apply(nativeShell, arguments);
          });
          return shellMethods.get(key);
        }
      }) });
    }
    function ownedRegistration(registration) {
      var worker = registration.active || registration.waiting || registration.installing;
      if (!worker) return false;
      var path = new win.URL(worker.scriptURL, win.location.href).pathname;
      return path === "/sw.js" || path === "/personal-push-sw.js";
    }
    function accountRegistration(registration) {
      var scope = new win.URL(registration.scope || "/", win.location.href).pathname;
      return scope === "/" || scope === "/personal-push/"
        || scope === "/account-push/" + encodeURIComponent(accountId) + "/"
        || scope === "/personal-push/" + encodeURIComponent(accountId) + "/";
    }
    async function notifyWorkers(id, invalidating) {
      try {
        var registrations = await win.navigator.serviceWorker.getRegistrations();
        if (!invalidating && !isActive()) return;
        registrations.filter(ownedRegistration).forEach(function (registration) {
          [registration.active, registration.waiting, registration.installing].forEach(function (worker) {
            if (worker) worker.postMessage({ type: invalidating ? "xunxin-account-invalidate" : "xunxin-account-active", accountId: invalidating ? accountId : id });
          });
        });
      } catch (_) {}
    }
    async function captureSubscriptions() {
      try {
        var registrations = await win.navigator.serviceWorker.getRegistrations();
        await Promise.all(registrations.filter(function (registration) { return ownedRegistration(registration) && accountRegistration(registration); }).map(async function (registration) {
          var subscription = await registration.pushManager.getSubscription();
          if (subscription) subscriptions.push(subscription);
        }));
        if (!accountId) await Promise.all(subscriptions.map(function (subscription) { return subscription.unsubscribe().catch(function () {}); }));
      } catch (_) {}
    }
    var subscriptionCapture = parentRuntime ? Promise.resolve() : captureSubscriptions();
    async function invalidate(nextAccountId) {
      if (transition) return transition;
      active = false;
      if (nextAccountId !== undefined && rawLocal) rawSet.call(rawLocal, IDENTITY_KEY, JSON.stringify({ accountId: nextAccountId, nonce: String(Date.now()) + Math.random() }));
      controllers.forEach(function (controller) { controller.abort(); });
      xhrs.forEach(function (xhr) { xhr.abort(); });
      sockets.forEach(function (socket) { socket.close(); });
      transactions.forEach(function (tx) { try { tx.abort(); } catch (_) {} });
      databases.forEach(function (db) { db.close(); });
      nativeAccountChanged("");
      void notifyWorkers("", true);
      win.dispatchEvent(new win.CustomEvent("xunxin-account-invalidated"));
      if (!parentRuntime && win.document.body) {
        win.document.body.replaceChildren();
        var notice = win.document.createElement("p"); notice.textContent = "账户已变化，正在重新载入…"; win.document.body.appendChild(notice);
      }
      transition = (async function () {
        var work = (async function () {
        await Promise.all(Array.from(cleanups).map(function (cleanup) { return Promise.resolve().then(cleanup).catch(function () {}); }));
        await subscriptionCapture;
        await Promise.all(subscriptions.map(function (subscription) { return subscription.unsubscribe().catch(function () {}); }));
        try {
          var registrations = await win.navigator.serviceWorker.getRegistrations();
          await Promise.all(registrations.filter(function (registration) { return ownedRegistration(registration) && accountRegistration(registration); }).map(async function (registration) {
            var notifications = await registration.getNotifications(); notifications.forEach(function (notification) { notification.close(); });
          }));
        } catch (_) {}
        })();
        await Promise.race([work, new Promise(function (resolve) { win.setTimeout(resolve, 3000); })]);
        if (!parentRuntime && !options.noReload) win.location.reload();
      })();
      return transition;
    }
    async function revalidate() {
      if (!nativeFetch || !isActive() || parentRuntime) return;
      var checkController = new win.AbortController();
      var checkTimer = win.setTimeout(function () { checkController.abort(); }, 15000);
      try {
        var known = rawLocal && JSON.parse(rawGet.call(rawLocal, IDENTITY_KEY) || "null");
        if (known && known.accountId !== accountId) { await invalidate(); return; }
        var response = await nativeFetch("/api/auth/me", { credentials: "include", cache: "no-store", signal: checkController.signal });
        if (response.status === 401 || response.status === 403) { await invalidate(""); return; }
        if (!response.ok) return;
        var data = await response.json();
        if (data.ok && (data.account && data.account.id || "") !== accountId) await invalidate(data.account && data.account.id || "");
      } catch (_) {} finally { win.clearTimeout(checkTimer); }
    }
    var runtime = Object.freeze({
      accountId: accountId, isActive: isActive,
      physicalName: physicalName,
      reconcile: function (id) { return id === accountId && isActive() ? Promise.resolve(true) : invalidate(id).then(function () { return false; }); },
      invalidate: invalidate,
      registerCleanup: function (cleanup) {
        if (!isActive()) { void Promise.resolve().then(cleanup).catch(function () {}); return function () {}; }
        cleanups.add(cleanup); return function () { cleanups.delete(cleanup); };
      }
    });
    Object.defineProperty(win, "__XUNXIN_ACCOUNT_STORAGE__", { value: runtime, writable: false, configurable: false });
    if (!parentRuntime && !options.noLifecycle) {
      try {
        var previous = rawLocal && JSON.parse(rawGet.call(rawLocal, IDENTITY_KEY) || "null");
        if (rawLocal && (!previous || previous.accountId !== accountId)) rawSet.call(rawLocal, IDENTITY_KEY, JSON.stringify({ accountId: accountId, nonce: String(Date.now()) + Math.random() }));
      } catch (_) {}
      win.addEventListener("focus", revalidate);
      win.addEventListener("pageshow", function (event) { if (event.persisted) void invalidate(); else void revalidate(); });
      win.document.addEventListener("visibilitychange", function () { if (win.document.visibilityState === "visible") void revalidate(); });
      win.setInterval(function () { if (win.document.visibilityState === "visible") void revalidate(); }, 20000);
      nativeAccountChanged(accountId);
      void notifyWorkers(accountId);
      try { win.navigator.serviceWorker.ready.then(function () { if (isActive()) void notifyWorkers(accountId); }).catch(function () {}); } catch (_) {}
    }
    return runtime;
  };
});
