/**
 * Service Worker - SeismoWatch Lab
 * アプリシェルのキャッシュとオフライン対応
 */
const CACHE_PREFIX = 'seismo-watch-';
const CACHE_NAME = `${CACHE_PREFIX}v5`;
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
  './favicon.svg',
  './manifest.json',
];

// CDNリソース（ネットワーク優先、フォールバックでキャッシュ）
const CDN_RESOURCES = [
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  'https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js',
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
    caches.open(CACHE_NAME).then(async (cache) => {
      await cache.addAll(APP_SHELL);
      await Promise.allSettled(CDN_RESOURCES.map(resource => cache.add(resource)));
    })
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
  const isExplicitCdnResource = CDN_RESOURCES.includes(requestUrl.href);

  // API・地図タイルを含む外部リソースは、明示したCDN資産以外キャッシュしない。
  if (requestUrl.origin !== self.location.origin && !isExplicitCdnResource) {
    event.respondWith(fetch(event.request));
    return;
  }

  // CDNリソース: ネットワーク優先、失敗時キャッシュ
  if (isExplicitCdnResource) {
    event.respondWith(
      fetch(event.request)
        .then(resp => cacheSuccessfulResponse(resp, event.request))
        .catch(() => caches.match(event.request))
    );
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
