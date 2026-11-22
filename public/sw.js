// Offline app shell. API calls are never cached: the app keeps its own data in IndexedDB.
const CACHE = 'lucy-locates-v1';
const SHELL = [
  './', 'index.html', 'styles.css', 'manifest.webmanifest',
  'js/app.js', 'js/sync.js', 'js/kv.js', 'js/ui.js', 'js/scanner.js',
  'shared/constants.js', 'shared/logic.js',
  'vendor/zxing.min.js',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.includes('/api/')) return;
  // Network first (so updates arrive), cache fallback (so it works offline).
  e.respondWith(
    fetch(e.request).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
      return res;
    }).catch(() => caches.match(e.request).then((r) => r || caches.match('index.html'))),
  );
});
