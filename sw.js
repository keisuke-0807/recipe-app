// オフライン対応用 Service Worker
// ★ 更新を公開するときは、この APP_VERSION を1つ上げる（バージョン番号はここだけで管理）。
//   sw.js 自体の中身が変わるので、iPhone（Safari）でも確実に新しいバージョンとして検知される。
const APP_VERSION = 7;
const PREFIX = 'recipe-book-v';
const CACHE = `${PREFIX}${APP_VERSION}`;
const ASSETS = [
  './', './index.html', './style.css', './db.js', './app.js', './manifest.webmanifest',
  './icons/icon-180.png', './icons/icon-192.png', './icons/icon-512.png',
];

self.addEventListener('install', e => {
  // cache: 'reload' でブラウザのHTTPキャッシュを使わず、必ずサーバーから最新を取得する
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(ASSETS.map(u => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  // 同じドメインの他のアプリ（筋トレ記録など）のキャッシュは消さない
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k.startsWith(PREFIX) && k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    caches.open(CACHE)
      .then(c => c.match(req, { ignoreSearch: true }))
      .then(hit => hit || fetch(req))
  );
});
