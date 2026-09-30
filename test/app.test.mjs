import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

import { createBrowserLikeContext, loadClassicScript } from './helpers/load-classic-script.mjs';

const appSource = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');

function createApp() {
  const elements = new Map();
  const createElement = () => {
    const classes = new Set();
    const attributes = new Map();
    return {
      value: '', textContent: '', innerHTML: '', style: {}, dataset: {},
      disabled: false, hidden: false,
      classList: {
        add: (...names) => names.forEach(name => classes.add(name)),
        remove: (...names) => names.forEach(name => classes.delete(name)),
        toggle(name, active = !classes.has(name)) {
          if (active) classes.add(name);
          else classes.delete(name);
        },
      },
      setAttribute: (name, value) => attributes.set(name, value),
      getAttribute: name => attributes.get(name),
      querySelector: () => null,
      querySelectorAll: () => [],
      scrollIntoView() {},
      focus() {},
      remove() { elements.delete(this.id); },
    };
  };
  for (const id of [
    'startdate', 'enddate', 'minmag', 'maxdepth', 'region', 'limit',
    'custom-minlat', 'custom-maxlat', 'custom-minlon', 'custom-maxlon', 'custom-bounds',
    'circle-latitude', 'circle-longitude', 'circle-radius', 'circle-bounds',
    'btn-search', 'btn-reset', 'loading', 'results-count', 'results-limit-notice',
    'eq-tbody', 'btn-csv', 'btn-json', 'btn-geojson', 'pagination', 'page-info',
    'page-prev', 'page-next', 'charts-empty', 'results-section',
  ]) elements.set(id, { ...createElement(), id });
  const field = id => elements.get(id);
  field('startdate').value = '2026-09-20';
  field('enddate').value = '2026-09-29';
  field('region').value = 'global';
  field('minmag').value = '4';
  field('limit').value = '200';

  const main = createElement();
  const card = { insertBefore: element => elements.set(element.id, element) };
  field('eq-tbody').closest = selector => selector === '.card' ? card : createElement();
  const headers = ['time', 'mag', 'depth', 'place'].map(key => {
    const header = createElement();
    header.dataset.sort = key;
    const icon = createElement();
    header.querySelector = selector => selector === '.sort-icon' ? icon : null;
    return header;
  });

  let now = Date.parse('2026-09-30T00:00:00Z');
  class ControlledDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const requests = [];
  const responses = [];
  const cleared = { map: 0, monitor: 0, charts: 0, detail: 0 };
  const context = createBrowserLikeContext({
    Date: ControlledDate,
    document: {
      getElementById: id => field(id) || null,
      querySelector: selector => selector === 'main' ? main : field(selector.slice(1)) || null,
      querySelectorAll: selector => selector === '.eq-table thead th[data-sort]' ? headers : [],
      createElement,
    },
    fetch: async (url, options) => {
      requests.push({ url: new URL(url), signal: options.signal });
      return responses.shift() || jsonResponse([]);
    },
    EarthquakeMap: {
      reset: () => { cleared.map += 1; },
      displayEarthquakes() {},
    },
    MonitorDashboard: {
      clear: () => { cleared.monitor += 1; },
      render() {},
    },
    Charts: {
      clearAll: () => { cleared.charts += 1; },
      render() {},
    },
    DetailPanel: { close: () => { cleared.detail += 1; } },
    WaveformViewer: { clearCache() {}, resetDisplay() {} },
    Spectrum: { clearCharts() {} },
  });
  loadClassicScript('js/utils.js', 'AppUtils', context);
  const { exported: api } = loadClassicScript('js/api.js', 'EarthquakeAPI', context);
  const { exported: settings } = loadClassicScript('js/settings.js', 'Settings', context);
  loadClassicScript('js/i18n.js', 'I18n', context);

  // Expose only the tested entry points in this VM; production retains its private closure.
  const startup = "document.addEventListener('DOMContentLoaded', init);";
  assert.ok(appSource.includes(startup));
  vm.runInContext(appSource.replace(startup, `
    globalThis.appTest = { executeSearch, refreshLastSearch, quickSearch, onSortClick };
  `), context, { filename: 'js/app.js' });

  return {
    app: context.appTest, api, settings, field, headers, requests, responses, cleared,
    advanceTime: milliseconds => { now += milliseconds; },
    assertNoError: () => assert.equal(field('error-msg'), undefined),
  };
}

function jsonResponse(features, metadata = {}) {
  return new Response(JSON.stringify({ type: 'FeatureCollection', features, metadata }));
}

function earthquake(id, time, mag) {
  return {
    type: 'Feature', id,
    properties: { time, mag, place: id, status: 'reviewed', tsunami: 0 },
    geometry: { type: 'Point', coordinates: [139, 35, 10] },
  };
}

test('manual auto-refresh reuses a successful snapshot despite form and preset edits', async () => {
  const h = createApp();
  h.field('region').value = 'pacific';
  await h.app.executeSearch();
  h.assertNoError();
  const originalURLs = h.requests.map(request => request.url.href);
  assert.equal(originalURLs.length, 2);

  h.field('region').value = 'circle';
  h.field('startdate').value = '2020-01-01';
  h.field('minmag').value = '7';
  h.api.getRegionPresets().pacific.boundsList[0].minlat = -30;
  await h.app.refreshLastSearch();
  h.assertNoError();
  assert.deepEqual(h.requests.slice(2).map(request => request.url.href), originalURLs);
  assert.equal(h.field('region').value, 'circle');
  assert.equal(h.field('minmag').value, '7');
});

test('a failed manual search does not replace the last successful refresh conditions', async () => {
  const h = createApp();
  h.field('region').value = 'japan';
  await h.app.executeSearch();
  h.assertNoError();
  const successfulURL = h.requests[0].url.href;

  h.field('region').value = 'global';
  h.responses.push(new Response('upstream failure', { status: 500 }));
  await h.app.executeSearch();
  assert.match(h.field('error-msg').textContent, /HTTP 500/);
  await h.app.refreshLastSearch();
  h.assertNoError();
  assert.equal(h.requests[2].url.href, successfulURL);
});

test('auto-refresh waits for a pending user search and then refreshes its successful conditions', async t => {
  for (const mode of ['manual', 'circle', 'quick']) {
    await t.test(mode, async () => {
      const h = createApp();
      h.field('region').value = 'japan';
      await h.app.executeSearch();
      h.assertNoError();

      let resolveResponse;
      h.responses.push(new Promise(resolve => { resolveResponse = resolve; }));
      h.field('region').value = mode === 'circle' ? 'circle' : 'southeast_asia';
      if (mode === 'circle') {
        h.field('circle-latitude').value = '35';
        h.field('circle-longitude').value = '139';
        h.field('circle-radius').value = '100';
      }
      const pendingSearch = mode === 'quick'
        ? h.app.quickSearch('365d-7.0')
        : h.app.executeSearch();
      const userRequest = h.requests[1];

      try {
        await h.app.refreshLastSearch();
        assert.equal(h.requests.length, 2, 'the timer must not enqueue the old search while a user search is pending');
        assert.equal(userRequest.signal.aborted, false, 'the timer must not cancel the user request');
      } finally {
        resolveResponse(jsonResponse([]));
        await pendingSearch;
      }
      h.assertNoError();

      h.advanceTime(60000);
      await h.app.refreshLastSearch();
      h.assertNoError();
      assert.equal(h.requests.length, 3);
      const refreshed = h.requests[2].url;
      if (mode === 'quick') {
        assert.equal(refreshed.searchParams.get('minmagnitude'), '7');
        assert.equal(refreshed.searchParams.has('minlatitude'), false);
        assert.equal(
          Date.parse(refreshed.searchParams.get('endtime')) - Date.parse(userRequest.url.searchParams.get('endtime')),
          60000
        );
      } else {
        assert.equal(refreshed.href, userRequest.url.href, 'the next timer run must use the new successful criteria');
      }
    });
  }
});

test('quick auto-refresh rolls its time window forward while preserving the draft mode', async () => {
  const h = createApp();
  await h.app.quickSearch('24h-4.5');
  h.assertNoError();
  const first = h.requests[0].url.searchParams;
  for (const draft of [null, '365d-7.0']) {
    h.settings.setActiveQuickType(draft);
    h.advanceTime(60000);
    await h.app.refreshLastSearch();
    h.assertNoError();
    const latest = h.requests.at(-1).url.searchParams;
    const elapsed = (h.requests.length - 1) * 60000;
    assert.equal(Date.parse(latest.get('endtime')) - Date.parse(first.get('endtime')), elapsed);
    assert.equal(Date.parse(latest.get('starttime')) - Date.parse(first.get('starttime')), elapsed);
    assert.equal(latest.get('minmagnitude'), '4.5');
    assert.equal(h.settings.getActiveQuickType(), draft);
  }
});

test('the search button executes a restored quick preset instead of stale form conditions', async () => {
  const h = createApp();
  h.settings.applySearchParams({ quick: '7d-5.0', region: 'japan', minmag: '2' });
  await h.app.executeSearch();
  h.assertNoError();
  assert.equal(h.requests.length, 1);
  const query = h.requests[0].url.searchParams;
  assert.equal(query.get('minmagnitude'), '5');
  assert.equal(Date.parse(query.get('endtime')) - Date.parse(query.get('starttime')), 7 * 86400000);
  assert.equal(query.has('minlatitude'), false);
});

test('circle form searches send kilometer bounds without stale rectangle fields', async () => {
  const h = createApp();
  h.settings.applySearchParams({
    region: 'circle', latitude: '0', longitude: '-179.5', maxradiuskm: '125',
    minlat: '20', maxlat: '50', minlon: '120', maxlon: '155',
  });
  await h.app.executeSearch();
  h.assertNoError();
  assert.equal(h.requests.length, 1);
  const query = h.requests[0].url.searchParams;
  assert.equal(query.get('latitude'), '0');
  assert.equal(query.get('longitude'), '-179.5');
  assert.equal(query.get('maxradiuskm'), '125');
  for (const key of ['minlatitude', 'maxlatitude', 'minlongitude', 'maxlongitude', 'maxradius']) {
    assert.equal(query.has(key), false);
  }
});

test('reversed adjacent dates report an error without making an API request', async () => {
  const h = createApp();
  h.field('startdate').value = '2026-09-30';
  h.field('enddate').value = '2026-09-29';
  await h.app.executeSearch();
  assert.equal(h.requests.length, 0);
  assert.match(h.field('error-msg').textContent, /開始日は終了日以前/);
  assert.equal(h.field('btn-search').disabled, false);
});

test('empty results clear prior rows, detail, map, charts, exports and sort indicators', async () => {
  const h = createApp();
  h.responses.push(jsonResponse([
    earthquake('event-small', Date.parse('2026-09-25'), 4),
    earthquake('event-large', Date.parse('2026-09-26'), 6),
  ]));
  await h.app.executeSearch();
  h.assertNoError();
  h.app.onSortClick('mag');
  assert.match(h.field('eq-tbody').innerHTML, /event-large/);
  assert.equal(h.headers.find(header => header.dataset.sort === 'mag').getAttribute('aria-sort'), 'descending');
  const detailCloses = h.cleared.detail;

  await h.app.executeSearch();
  h.assertNoError();
  assert.doesNotMatch(h.field('eq-tbody').innerHTML, /event-small|event-large/);
  assert.match(h.field('eq-tbody').innerHTML, /見つかりませんでした/);
  assert.equal(h.field('results-count').textContent, '検索結果: 0件');
  assert.equal(h.field('pagination').style.display, 'none');
  assert.equal(h.field('results-limit-notice').hidden, true);
  for (const id of ['btn-csv', 'btn-json', 'btn-geojson']) assert.equal(h.field(id).disabled, true);
  assert.equal(h.headers.find(header => header.dataset.sort === 'time').getAttribute('aria-sort'), 'descending');
  assert.equal(h.headers.find(header => header.dataset.sort === 'mag').getAttribute('aria-sort'), 'none');
  assert.equal(h.cleared.detail, detailCloses + 1);
  assert.equal(h.cleared.map, 1);
  assert.equal(h.cleared.charts, 1);
  assert.equal(h.cleared.monitor, 1);
  h.app.onSortClick('mag');
  assert.doesNotMatch(h.field('eq-tbody').innerHTML, /event-small|event-large/);
});
