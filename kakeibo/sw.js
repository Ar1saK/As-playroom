const CACHE = 'kakeibo-v7';
const FILES = ['./', 'index.html', 'style.css', 'app.js', 'calc.js', 'sync.js', 'firebase-config.js', 'manifest.webmanifest', 'icon.svg'];
// 新しい版はすぐに有効にする（開いている画面は app.js 側で再読み込みする）
self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES.map((f) => new Request(f, { cache: 'reload' })))));
});
self.addEventListener('activate', (e) => e.waitUntil(
  caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim())));
// 自分のファイルはネット優先（ブラウザのキャッシュも使わず毎回確認）・オフライン時だけ保存分を使う
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(fetch(e.request, { cache: 'no-cache' }).then((r) => {
    const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return r;
  }).catch(() => caches.match(e.request, { ignoreSearch: true })));
});
