// Service workers use native CacheStorage; this control cache contains identity only.
const PUSH_SCOPE_CACHE = `xunxin-push-scope-v1:${self.registration.scope}`;
let pushScopeWrite = Promise.resolve();
self.addEventListener("message", event => {
  const data = event.data;
  if (!data || !["xunxin-account-active", "xunxin-account-invalidate", "xunxin-push-owner"].includes(data.type) || typeof data.accountId !== "string") return;
  // Only an in-scope, same-origin controlled application window can bind its worker.
  if (!event.source || !event.source.url || new URL(event.source.url).origin !== self.location.origin) return;
  const operation = pushScopeWrite.then(async () => {
    const cache = await caches.open(PUSH_SCOPE_CACHE);
    const previous = await cache.match("/scope");
    const state = previous ? await previous.json() : {};
    if (data.type === "xunxin-account-invalidate") { if (state.active === data.accountId) state.active = ""; }
    else if (data.type === "xunxin-account-active") state.active = data.accountId;
    else { state.active = data.accountId; state.owner = data.accountId; state.endpoint = data.endpoint; }
    await cache.put("/scope", new Response(JSON.stringify(state), { headers: { "Content-Type": "application/json" } }));
  });
  pushScopeWrite = operation.catch(() => {});
  event.waitUntil(operation);
});
async function xunxinPushAccountAllowed() {
  await pushScopeWrite;
  const cache = await caches.open(PUSH_SCOPE_CACHE);
  const response = await cache.match("/scope");
  if (!response) return false;
  const state = await response.json();
  if (!state.active || state.active !== state.owner) return false;
  const subscription = await self.registration.pushManager.getSubscription();
  return Boolean(subscription && subscription.endpoint === state.endpoint);
}
