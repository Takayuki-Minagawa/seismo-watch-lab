/**
 * Service Worker - SeismoWatch Lab
 * アプリシェルのキャッシュとオフライン対応
 */
const CACHE_NAME = 'seismo-v1';
const APP_SHELL = [
  './',
  './index.html',
  './css/style.css',
  './js/app.js',
  './js/api.js',
  './js/i18n.js',
  './js/map.js',
  './js/download.js',
  './js/charts.js',
  './js/settings.js',
  './js/detail.js',
  './js/spectrum.js',
  './js/waveform.js',
  './favicon.svg',
  './manifest.json',
];

// CDNリソース（ネットワーク優先、フォールバックでキャッシュ）
const CDN_RESOURCES = [
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  'https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(APP_SHELL);
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = event.request.url;

  // API リクエストはキャッシュしない（常にネットワーク）
  if (url.includes('earthquake.usgs.gov') || url.includes('service.iris.edu')) {
    event.respondWith(fetch(event.request));
    return;
  }

  // CDNリソース: ネットワーク優先、失敗時キャッシュ
  if (CDN_RESOURCES.some((r) => url.includes(new URL(r).pathname))) {
    event.respondWith(
      fetch(event.request)
        .then((resp) => {
          const clone = resp.clone();
          caches.open(CACHE_NAME).then((c) => c.put(event.request, clone));
          return resp;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // アプリシェル: キャッシュ優先、失敗時ネットワーク
  event.respondWith(
    caches.match(event.request).then((cached) => {
      return cached || fetch(event.request);
    })
  );
});
