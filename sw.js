// Service worker: only shows the rain alerts pushed by .github/workflows/alertas-lluvia.yml.
// It does not cache anything, so the dashboard always loads fresh data.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));

self.addEventListener("push", e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = {body: e.data && e.data.text()}; }
  e.waitUntil(self.registration.showNotification(d.title || "Cruz Roja Tolima", {
    body: d.body || "", tag: d.tag, renotify: !!d.tag, icon: "icon-192.png", badge: "icon-192.png",
    data: {url: new URL(d.url || "./", self.registration.scope).href},
  }));
});

self.addEventListener("notificationclick", e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || self.registration.scope;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({type: "window", includeUncontrolled: true});
    for (const w of wins) if (w.url.startsWith(self.registration.scope) && "navigate" in w) {
      await w.focus(); return w.navigate(url);
    }
    return self.clients.openWindow(url);
  })());
});
