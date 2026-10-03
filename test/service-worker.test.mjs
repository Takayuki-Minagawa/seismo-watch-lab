import assert from 'node:assert/strict';
import test from 'node:test';

import { createBrowserLikeContext, loadClassicScript } from './helpers/load-classic-script.mjs';

function loadServiceWorker() {
  const handlers = {};
  const deleted = [];
  const cachePuts = [];
  let cacheOpenCount = 0;
  const networkResponse = new Response('network');
  const self = {
    location: { origin: 'https://example.test' },
    registration: { scope: 'https://example.test/seismo-watch-lab/' },
    clients: { claim: () => Promise.resolve() },
    skipWaiting: () => {},
    addEventListener: (name, handler) => { handlers[name] = handler; },
  };
  const caches = {
    keys: async () => ['unrelated-app-cache', 'seismo-v3', 'seismo-watch-v2', 'seismo-watch-v4', 'seismo-watch-v5', 'seismo-watch-v6', 'seismo-watch-v7'],
    delete: async key => { deleted.push(key); return true; },
    open: async () => {
      cacheOpenCount += 1;
      return {
        addAll: async () => {},
        add: async () => {},
        put: async (key, response) => {
          cachePuts.push({ key: typeof key === 'string' ? key : key.url, body: await response.text() });
        },
      };
    },
    match: async () => null,
  };
  const context = createBrowserLikeContext({
    self,
    caches,
    fetch: async () => networkResponse,
  });
  loadClassicScript('sw.js', 'CACHE_NAME', context);
  return { handlers, deleted, cachePuts, networkResponse, getCacheOpenCount: () => cacheOpenCount };
}

test('activation deletes only caches owned by this app', async () => {
  const runtime = loadServiceWorker();
  let completion;
  runtime.handlers.activate({ waitUntil: promise => { completion = promise; } });
  await completion;

  assert.deepEqual(runtime.deleted.sort(), ['seismo-v3', 'seismo-watch-v2', 'seismo-watch-v4', 'seismo-watch-v5', 'seismo-watch-v6']);
  assert.ok(!runtime.deleted.includes('seismo-watch-v7'));
  assert.ok(!runtime.deleted.includes('unrelated-app-cache'));
});

test('external FDSN requests remain network-only and are not dynamically cached', async () => {
  const runtime = loadServiceWorker();
  let responsePromise;
  runtime.handlers.fetch({
    request: {
      method: 'GET',
      mode: 'cors',
      url: 'https://geofon.gfz-potsdam.de/fdsnws/station/1/query?net=XX',
    },
    respondWith: promise => { responsePromise = promise; },
  });

  assert.equal(await responsePromise, runtime.networkResponse);
  assert.equal(runtime.getCacheOpenCount(), 0);
});

test('non-entry navigation cannot overwrite the cached offline app entry', async () => {
  const runtime = loadServiceWorker();
  let responsePromise;
  runtime.handlers.fetch({
    request: {
      method: 'GET',
      mode: 'navigate',
      url: 'https://example.test/seismo-watch-lab/LICENSE',
    },
    respondWith: promise => { responsePromise = promise; },
  });

  assert.equal(await responsePromise, runtime.networkResponse);
  assert.deepEqual(runtime.cachePuts, []);
});

test('app-entry navigation waits for the refreshed offline entry to be cached', async () => {
  const runtime = loadServiceWorker();
  let responsePromise;
  runtime.handlers.fetch({
    request: {
      method: 'GET',
      mode: 'navigate',
      url: 'https://example.test/seismo-watch-lab/?minmag=5',
    },
    respondWith: promise => { responsePromise = promise; },
  });

  assert.equal(await responsePromise, runtime.networkResponse);
  assert.deepEqual(runtime.cachePuts, [{
    key: 'https://example.test/seismo-watch-lab/index.html',
    body: 'network',
  }]);
});
