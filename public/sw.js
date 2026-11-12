const CACHE_VERSION = "ai-phone-pwa-v13";
const STATIC_CACHE = `${CACHE_VERSION}-static`;
const RUNTIME_CACHE = `${CACHE_VERSION}-runtime`;
importScripts("/push-account-scope.js");

const PRECACHE_URLS = [
  "/manifest.json",
  "/icon-192.png",
  "/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => key.startsWith("ai-phone-pwa-") && !key.startsWith(CACHE_VERSION))
          .map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

function isCacheableRequest(request) {
  if (request.method !== "GET") return false;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return false;
  if (url.pathname.startsWith("/api/")) return false;
  if (url.pathname.startsWith("/_next/static/")) return true;
  return ["font", "image", "script", "style", "worker"].includes(request.destination);
}

async function networkFirst(request) {
  try {
    return await fetch(new Request(request, { cache: "no-store" }));
  } catch (error) {
    return new Response('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>寻信</title><p>网络暂时不可用。请连接网络后重新打开寻信，以确认账户。</p>', { status: 503, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
  }
}

// 静态资源（字体/图片/脚本/样式/模型）用 cache-first：命中缓存直接返回，
// 不再每次都在后台把整份文件重新拉一遍校验。字体动辄 7~24MB，旧的
// stale-while-revalidate 会持续重下，是带宽爆掉的主因之一。
// 需要更新缓存内容时，升 CACHE_VERSION 即可让旧缓存在 activate 时清空。
async function cacheFirst(request) {
  const cache = await caches.open(RUNTIME_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) cache.put(request, response.clone());
  return response;
}

// 离线推送：App 被杀后由系统唤起 SW 弹通知。payload 由服务端 JSON 编码。
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (error) {
    data = { body: event.data ? event.data.text() : "" };
  }
  const declarative = data.web_push === 8030 && data.notification && typeof data.notification === "object"
    ? data.notification
    : null;
  const notificationData = declarative && declarative.data && typeof declarative.data === "object"
    ? declarative.data
    : data;
  const title = (declarative && declarative.title) || data.title || "小手机";
  event.waitUntil((async () => {
    if (!await xunxinPushAccountAllowed()) return;
    if (notificationData.type === "chat_outbox") {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const visible = windows.filter((client) => client.visibilityState === "visible");
      if (visible.length > 0) {
        visible.forEach((client) => client.postMessage({ type: "push_outbox_ready" }));
        return;
      }
    }
    // 来电推送：页面可见时直接进页面振铃（来电横幅），不弹系统通知
    if (notificationData.type === "incoming_call") {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const visible = windows.filter((client) => client.visibilityState === "visible");
      if (visible.length > 0) {
        visible.forEach((client) => client.postMessage({
          type: "incoming_call_push",
          sessionId: notificationData.sessionId || "",
          callTs: notificationData.callTs || 0,
        }));
        visible.forEach((client) => client.postMessage({ type: "push_outbox_ready" }));
        return;
      }
    }
    await self.registration.showNotification(title, {
      body: (declarative && declarative.body) || data.body || "",
      icon: (declarative && declarative.icon) || data.icon || "/icon-192.png",
      badge: (declarative && declarative.badge) || "/icon-192.png",
      tag: (declarative && declarative.tag) || data.tag || `push-${Date.now()}`,
      data: {
        url: (declarative && declarative.navigate) || notificationData.url || "/",
        type: notificationData.type || "",
        commandId: notificationData.commandId || "",
        sessionId: notificationData.sessionId || "",
        callTs: notificationData.callTs || 0,
      },
    });
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const notificationData = event.notification.data || {};
  const targetUrl = notificationData.url || "/";
  event.waitUntil((async () => {
    if (!await xunxinPushAccountAllowed()) return;
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    if (notificationData.type === "shortcut_command") {
      // iOS silently ignores custom URL schemes passed to clients.openWindow().
      const absoluteUrl = new URL(targetUrl, self.location.origin).href;
      // 有活窗口：不导航（navigate 会杀掉 SPA，回来一片空白、进行中的生成全断）。
      // 交给页面自己 location 到 /shortcut-run——302 到 shortcuts:// 属于外部 App
      // 启动，WebKit 不会卸载当前页面，聊天界面与本地生成原地保留。
      for (const client of windows) {
        if ("focus" in client) {
          client.postMessage({ type: "run_shortcut", url: absoluteUrl });
          return client.focus();
        }
      }
      // App 已被杀：没有页面可保，开新窗口走 /shortcut-run 跳转
      return self.clients.openWindow(absoluteUrl);
    }
      for (const client of windows) {
        if ("focus" in client) {
          if (notificationData.type === "chat_outbox") {
            client.postMessage({ type: "push_outbox_ready" });
          }
          if (notificationData.type === "incoming_call") {
            // 有活窗口：不导航（会杀掉 SPA），交给页面弹来电横幅 + 合并 outbox
            client.postMessage({
              type: "incoming_call_push",
              sessionId: notificationData.sessionId || "",
              callTs: notificationData.callTs || 0,
            });
            client.postMessage({ type: "push_outbox_ready" });
          }
          return client.focus();
        }
      }
      return self.clients.openWindow(targetUrl);
  })());
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.mode === "navigate") {
    event.respondWith(networkFirst(request));
    return;
  }
  if (isCacheableRequest(request)) {
    event.respondWith(cacheFirst(request));
  }
});
