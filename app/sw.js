// 네트워크 우선, 실패하면 캐시: 온라인이면 늘 최신 사전을, 오프라인이면 마지막으로 받은 사전을 보여 준다.
const CACHE = 'vocab-book-v3';
const ASSETS = ['./', 'index.html', 'style.css', 'app.js', 'chat.js', 'vendor/anthropic-sdk.js', 'words.json', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    // no-cache: 브라우저 HTTP 캐시(GitHub Pages는 10분)를 건너뛰고 서버에 최신인지 확인한다.
    fetch(req, { cache: 'no-cache' })
      .then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true }).then((hit) => hit || caches.match('index.html')))
  );
});
