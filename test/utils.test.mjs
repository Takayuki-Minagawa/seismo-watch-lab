import assert from 'node:assert/strict';
import test from 'node:test';

import { createBrowserLikeContext, loadClassicScript } from './helpers/load-classic-script.mjs';

const { exported: AppUtils } = loadClassicScript('js/utils.js', 'AppUtils');

test('escapeHtml encodes markup-significant characters', () => {
  assert.equal(
    AppUtils.escapeHtml(`<img alt="'" onerror='x'>&`),
    '&lt;img alt=&quot;&#39;&quot; onerror=&#39;x&#39;&gt;&amp;'
  );
});

test('sanitizeHttpUrl only accepts HTTP(S) URLs', () => {
  assert.equal(AppUtils.sanitizeHttpUrl('javascript:alert(1)'), '');
  assert.equal(AppUtils.sanitizeHttpUrl('data:text/html,x'), '');
  assert.equal(AppUtils.sanitizeHttpUrl('https://earthquake.usgs.gov/test'), 'https://earthquake.usgs.gov/test');
});

test('sanitizeUrlForOrigins rejects unexpected HTTP origins', () => {
  const allowed = ['https://earthquake.usgs.gov'];
  assert.equal(
    AppUtils.sanitizeUrlForOrigins('https://earthquake.usgs.gov/earthquakes/eventpage/test', allowed),
    'https://earthquake.usgs.gov/earthquakes/eventpage/test'
  );
  assert.equal(AppUtils.sanitizeUrlForOrigins('https://evil.example/event', allowed), '');
});

test('maxAbs handles long waveforms without spreading array arguments', () => {
  const values = new Array(200_000).fill(1);
  values[150_000] = -321.5;
  assert.equal(AppUtils.maxAbs(values), 321.5);
});

test('sample index helpers preserve exact grid points and exclude samples outside a requested interval', () => {
  assert.equal(AppUtils.sampleIndexAtOrAfter(0.3, 0.1), 3);
  assert.equal(AppUtils.sampleIndexAtOrBefore(0.3, 0.1), 3);
  assert.equal(AppUtils.sampleIndexAtOrAfter(0.1, 0.06), 2);
  assert.equal(AppUtils.sampleIndexAtOrBefore(0.2, 0.06), 3);
});

test('escapeCsvCell quotes delimiters and neutralizes spreadsheet formulas', () => {
  assert.equal(AppUtils.escapeCsvCell(',us1,us2,'), '",us1,us2,"');
  assert.equal(AppUtils.escapeCsvCell('a"b'), '"a""b"');
  assert.equal(AppUtils.escapeCsvCell('=HYPERLINK("x")'), '"\'=HYPERLINK(""x"")"');
  assert.equal(AppUtils.escapeCsvCell(-10), '"-10"');
});

test('formatLocalDate preserves the local calendar date', () => {
  const localEarlyMorning = new Date(2026, 6, 17, 1, 0, 0);
  assert.equal(AppUtils.formatLocalDate(localEarlyMorning), '2026-07-17');
});

test('request coordinator invalidates and aborts the previous request', () => {
  const coordinator = AppUtils.createRequestCoordinator();
  const first = coordinator.begin();
  const second = coordinator.begin();

  assert.equal(first.signal.aborted, true);
  assert.equal(first.isCurrent(), false);
  assert.equal(second.signal.aborted, false);
  assert.equal(second.isCurrent(), true);
});

test('text fetch timeout remains active while the response body is being consumed', async () => {
  const context = createBrowserLikeContext({
    fetch: async (_resource, { signal }) => ({
      text: () => new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve('late body'), 100);
        signal.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new DOMException('Aborted', 'AbortError'));
        }, { once: true });
      }),
    }),
  });
  const { exported: UtilsWithSlowFetch } = loadClassicScript('js/utils.js', 'AppUtils', context);

  await assert.rejects(
    UtilsWithSlowFetch.fetchTextWithTimeout('/slow', {
      timeoutMs: 10,
      timeoutMessage: 'body timeout',
    }),
    /body timeout/
  );
});

test('external cancellation remains connected after response headers arrive', async () => {
  let bodyStarted;
  const bodyStartPromise = new Promise(resolve => { bodyStarted = resolve; });
  const context = createBrowserLikeContext({
    fetch: async (_resource, { signal }) => ({
      text: () => {
        bodyStarted();
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          }, { once: true });
        });
      },
    }),
  });
  const { exported: UtilsWithCancellableFetch } = loadClassicScript('js/utils.js', 'AppUtils', context);
  const controller = new AbortController();
  const request = UtilsWithCancellableFetch.fetchTextWithTimeout('/pending', {
    signal: controller.signal,
    timeoutMs: 1000,
  });

  await bodyStartPromise;
  controller.abort();
  await assert.rejects(request, error => error?.name === 'AbortError');
});
