/* 最小のservice worker：ネットワーク優先＋キャッシュ退避。
   オフライン対応は目的ではなく、ホーム画面起動の要件を満たすためのもの。 */
const C = "hx-v5";
const ASSETS = [
  "./", "./index.html", "./manifest.json",
  "./icon-192.png", "./icon-512.png",
  "./icon-maskable-192.png", "./icon-maskable-512.png", "./apple-touch-icon.png"
];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(C).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()).catch(() => {}));
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== C).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  if (new URL(req.url).origin !== location.origin) return;
  // ブラウザのHTTPキャッシュ（GitHub Pages は10分）を使わず毎回サーバーに確認する。
  // 更新直後に新しいHTMLと古いJSが混ざるのを防ぐため（変更がなければ304で軽い）
  e.respondWith(
    fetch(req, { cache: "no-cache" })
      .then(res => {
        const copy = res.clone();
        caches.open(C).then(c => c.put(req, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(req))
  );
});

/* ---------- プッシュ通知 ---------- */
self.addEventListener("push", e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = {}; }
  e.waitUntil(self.registration.showNotification(d.title || "ROXX", {
    body: d.body || "",
    tag: d.tag || "roxx",
    icon: "./icon-192.png",
    badge: "./icon-192.png",
    data: { url: d.url || "./" }
  }));
});

/* 開いているアプリがあればそこへ、なければ新しく開く */
self.addEventListener("notificationclick", e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || "./";
  const target = new URL(url, self.registration.scope).href;
  e.waitUntil(clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
    for (const c of list) {
      if (c.url.startsWith(self.registration.scope) && "focus" in c) {
        return c.navigate(target).then(w => (w || c).focus());
      }
    }
    return clients.openWindow(target);
  }));
});
