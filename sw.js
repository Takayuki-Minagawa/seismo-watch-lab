/**
 * Service Worker - SeismoWatch Lab
 * アプリシェルのキャッシュとオフライン対応
 */
const CACHE_PREFIX = 'seismo-watch-';
const CACHE_NAME = `${CACHE_PREFIX}v9`;
const APP_SHELL = [
  './',
  './index.html',
  './css/style.css',
  './js/utils.js',
  './js/app.js',
  './js/api.js',
  './js/i18n.js',
  './js/map.js',
  './js/download.js',
  './js/charts.js',
  './js/settings.js',
  './js/monitor.js',
  './js/detail.js',
  './js/spectrum.js',
  './js/waveform.js',
  './js/miniseed.js',
  './js/instrument-response.js',
  './js/remote-waveform.js',
  './js/waveform-worker.js',
  './js/jma-waveform.js',
  './vendor/seisplotjs-3.2.7/seedcodec.js',
  './favicon.svg',
  './manifest.json',
  './vendor/leaflet-1.9.4/leaflet.css',
  './vendor/leaflet-1.9.4/leaflet.js',
  './vendor/leaflet-1.9.4/images/layers-2x.png',
  './vendor/leaflet-1.9.4/images/layers.png',
  './vendor/leaflet-1.9.4/images/marker-icon-2x.png',
  './vendor/leaflet-1.9.4/images/marker-icon.png',
  './vendor/leaflet-1.9.4/images/marker-shadow.png',
  './vendor/chartjs-4.4.7/chart.umd.js',
];

async function cacheSuccessfulResponse(response, cacheKey) {
  if (!response.ok) return response;
  try {
    const cache = await caches.open(CACHE_NAME);
    await cache.put(cacheKey, response.clone());
  } catch (_) {
    // キャッシュ更新失敗で、取得済みのネットワーク応答まで失敗扱いにしない。
  }
  return response;
}

function withoutSearchOrHash(value) {
  const url = new URL(value);
  url.search = '';
  url.hash = '';
  return url.href;
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME && (key.startsWith(CACHE_PREFIX) || key === 'seismo-v3'))
          .map((key) => caches.delete(key))
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const requestUrl = new URL(event.request.url);

  // API・地図タイルを含む外部リソースはキャッシュしない。
  if (requestUrl.origin !== self.location.origin) {
    event.respondWith(fetch(event.request));
    return;
  }

  if (event.request.mode === 'navigate') {
    const fallbackUrl = new URL('./index.html', self.registration.scope).href;
    const scopeUrl = withoutSearchOrHash(self.registration.scope);
    const normalizedRequestUrl = withoutSearchOrHash(requestUrl.href);
    const isAppEntry = normalizedRequestUrl === scopeUrl || normalizedRequestUrl === fallbackUrl;

    if (!isAppEntry) {
      event.respondWith(
        fetch(event.request)
          .catch(async () => (await caches.match(event.request)) || new Response('Offline', { status: 503 }))
      );
      return;
    }

    event.respondWith(
      fetch(event.request)
        .then(resp => cacheSuccessfulResponse(resp, fallbackUrl))
        .catch(async () => (await caches.match(fallbackUrl)) || new Response('Offline', { status: 503 }))
    );
    return;
  }

  const shellUrls = new Set(APP_SHELL.map(resource => new URL(resource, self.registration.scope).href));
  const normalizedUrl = new URL(requestUrl.href);
  normalizedUrl.search = '';
  normalizedUrl.hash = '';
  if (!shellUrls.has(normalizedUrl.href)) {
    event.respondWith(fetch(event.request));
    return;
  }

  // 同一オリジンのアプリシェルだけをネットワーク優先で更新する。
  event.respondWith(
    fetch(event.request)
      .then(resp => cacheSuccessfulResponse(resp, normalizedUrl.href))
      .catch(async () => (await caches.match(normalizedUrl.href)) || new Response('Offline', { status: 503 }))
  );
});
