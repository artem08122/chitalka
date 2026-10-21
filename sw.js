const CACHE_NAME = 'antigravity-reader-v5';
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './css/reader.css',
  './js/app.js',
  './js/reader.js',
  './js/library.js',
  './js/storage.js',
  './js/cloud.js',
  './js/parsers/index.js',
  './js/parsers/fb2.js',
  './js/parsers/epub.js',
  './js/parsers/pdf_reformat.js',
  './js/parsers/docx.js',
  './js/parsers/txt.js',
  './vendor/telegram-web-app.js',
  './vendor/jszip.min.js',
  './vendor/pdf.min.js',
  './vendor/pdf.worker.min.js',
  './vendor/mammoth.browser.min.js',
  './manifest.json'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS_TO_CACHE);
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  // Only cache same-origin GET requests (never GitHub API / Telegram calls)
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== self.location.origin) return;
  // Network-first (bypass HTTP cache) so updates arrive at once; cache is the offline fallback
  e.respondWith(
    fetch(e.request, { cache: 'reload' }).then((networkResponse) => {
      if (networkResponse && networkResponse.status === 200) {
        const copy = networkResponse.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(e.request, copy));
      }
      return networkResponse;
    }).catch(() => caches.match(e.request))
  );
});
