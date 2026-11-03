// オフライン対応用 Service Worker
// バージョンごとにファイル一式をキャッシュし、そのキャッシュから表示する。
// version.js の番号が変わると新しい Service Worker として入れ替わり、ページに更新を知らせる。
importScripts('version.js');
const CACHE = `recipe-book-v${self.APP_VERSION}`;
const ASSETS = [
  './', './index.html', './style.css', './version.js', './db.js', './app.js', './manifest.webmanifest',
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
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k.startsWith('recipe-book-') && k !== CACHE).map(k => caches.delete(k))))
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
