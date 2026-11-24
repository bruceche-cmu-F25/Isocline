/* Zirma's service worker: push notifications only. It does not cache or intercept anything; every page and API call
 * goes to the home node as usual.
 *
 * iOS revokes a push subscription when a push arrives and no notification is shown, so every push shows one
 * (notifications sharing a tag replace each other instead of stacking).
 */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let message = {};
  try { message = event.data ? event.data.json() : {}; } catch { /* malformed */ }
  const title = typeof message.title === "string" && message.title ? message.title : "Zirma";
  const body = typeof message.body === "string" ? message.body : "";
  event.waitUntil(self.registration.showNotification(title, {
    body,
    icon: "/apple-touch-icon.png",
    badge: "/favicon-32.png",
    tag: typeof message.tag === "string" && message.tag ? message.tag : undefined,
    data: { url: typeof message.url === "string" ? message.url : "/", notice: message.notice, ack: message.ack === true },
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  let target = new URL("/", self.location.origin);
  try {
    const candidate = new URL(data.url || "/", self.location.origin);
    if (candidate.origin === self.location.origin) target = candidate;
  } catch { /* keep the root */ }
  event.waitUntil((async () => {
    // A result is read once it is opened; a question or a proposal stays until it is answered or decided.
    if (data.ack && typeof data.notice === "string" && /^[A-Za-z0-9_-]+$/.test(data.notice)) {
      await fetch(`/api/notices/${data.notice}/acknowledge`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }).catch(() => {});
    }
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of windows) {
      try {
        const opened = client.url === target.href ? client : (await client.navigate(target.href)) || client;
        await opened.focus();
        return;
      } catch { /* closed meanwhile: try the next */ }
    }
    await self.clients.openWindow(target.href);
  })());
});
