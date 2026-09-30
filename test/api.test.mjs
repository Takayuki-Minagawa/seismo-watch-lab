import assert from 'node:assert/strict';
import test from 'node:test';

import { createBrowserLikeContext, loadClassicScript } from './helpers/load-classic-script.mjs';

const context = createBrowserLikeContext();
loadClassicScript('js/utils.js', 'AppUtils', context);
const { exported: EarthquakeAPI } = loadClassicScript('js/api.js', 'EarthquakeAPI', context);

function earthquake(id, time = 100) {
  return {
    type: 'Feature',
    id,
    properties: { time, mag: 4.5 },
    geometry: { type: 'Point', coordinates: [139, 35, 10] },
  };
}

function apiWithFetch(fetchStub) {
  const mockContext = createBrowserLikeContext({ fetch: fetchStub });
  loadClassicScript('js/utils.js', 'AppUtils', mockContext);
  return loadClassicScript('js/api.js', 'EarthquakeAPI', mockContext).exported;
}

function jsonResponse(features, metadata = {}) {
  return new Response(JSON.stringify({ type: 'FeatureCollection', features, metadata }));
}

test('USGS query is limited to earthquake events and preserves zero values', () => {
  const query = EarthquakeAPI.buildQuery(
    { minmagnitude: 0, maxdepth: 0, limit: 50 },
    { minlat: 0, maxlat: 10, minlon: 0, maxlon: 10 }
  );

  assert.equal(query.get('eventtype'), 'earthquake');
  assert.equal(query.get('minmagnitude'), '0');
  assert.equal(query.get('maxdepth'), '0');
  assert.equal(query.get('minlatitude'), '0');
});

test('search criteria reject reversed dates and incomplete custom bounds', () => {
  assert.throws(
    () => EarthquakeAPI.validateSearchParams({ starttime: '2026-07-18', endtime: '2026-07-17' }),
    /開始日は終了日以前/
  );
  assert.throws(
    () => EarthquakeAPI.validateSearchParams({ minlat: 20, maxlat: 50 }),
    /すべて指定/
  );
  assert.throws(
    () => EarthquakeAPI.validateSearchParams({ requireBounds: true }),
    /すべて指定/
  );
});

test('search criteria validate coordinate ranges and ordering', () => {
  assert.throws(
    () => EarthquakeAPI.validateSearchParams({ minlat: 20, maxlat: 95, minlon: 120, maxlon: 150 }),
    /北端緯度/
  );
  assert.throws(
    () => EarthquakeAPI.validateSearchParams({ minlat: 50, maxlat: 20, minlon: 120, maxlon: 150 }),
    /南端緯度は北端緯度以下/
  );
  assert.equal(EarthquakeAPI.validateSearchParams({
    minlat: 20,
    maxlat: 50,
    minlon: 120,
    maxlon: 150,
    limit: 200,
  }), true);
});

test('merged regional responses are deduplicated, sorted and limited', () => {
  const feature = (id, time) => ({ id, properties: { time }, geometry: { coordinates: [0, 0, 0] } });
  const merged = EarthquakeAPI.mergeGeoJSONResponses([
    { features: [feature('a', 100), feature('shared', 200)], metadata: {} },
    { features: [feature('b', 300), feature('shared', 200)], metadata: {} },
  ], 2);

  assert.deepEqual(Array.from(merged.features, item => item.id), ['b', 'shared']);
  assert.equal(merged.metadata.count, 2);
  assert.equal(merged.metadata.limitReached, true);
});

test('circle searches preserve zero coordinates and use kilometers without rectangle parameters', async () => {
  let requestedURL;
  const api = apiWithFetch(async url => {
    requestedURL = new URL(url);
    return jsonResponse([]);
  });
  await api.search({ latitude: 0, longitude: 0, maxradiuskm: 100, maxdepth: -10, limit: 50 });

  assert.equal(requestedURL.searchParams.get('latitude'), '0');
  assert.equal(requestedURL.searchParams.get('longitude'), '0');
  assert.equal(requestedURL.searchParams.get('maxradiuskm'), '100');
  assert.equal(requestedURL.searchParams.get('maxdepth'), '-10');
  for (const parameter of ['minlatitude', 'maxlatitude', 'minlongitude', 'maxlongitude', 'maxradius']) {
    assert.equal(requestedURL.searchParams.has(parameter), false);
  }
});

test('circle criteria require all fields and reject mixed circle and rectangle searches before fetching', async () => {
  let fetches = 0;
  const api = apiWithFetch(async () => {
    fetches += 1;
    return jsonResponse([]);
  });
  const circle = { latitude: 35, longitude: 139, maxradiuskm: 100 };
  for (const key of ['latitude', 'longitude', 'maxradiuskm']) {
    await assert.rejects(api.search({ ...circle, [key]: '' }), /すべて指定/);
  }
  await assert.rejects(api.search({ requireCircle: true }), /すべて指定/);
  await assert.rejects(api.search({ ...circle, minlat: 0 }), /同時に指定できません/);
  await assert.rejects(api.search({ ...circle, requireBounds: true }), /同時に指定できません/);
  await assert.rejects(api.search({ ...circle, boundsList: [
    { minlat: 20, maxlat: 50, minlon: 120, maxlon: 150 },
  ] }), /同時に指定できません/);
  assert.equal(fetches, 0);
});

test('circle criteria validate finite ranges including poles, date line and zero radius', () => {
  const circle = { latitude: 0, longitude: 0, maxradiuskm: 1 };
  for (const [key, value] of [
    ['latitude', 90.1], ['latitude', -90.1], ['longitude', 180.1], ['longitude', -180.1],
    ['maxradiuskm', -1], ['maxradiuskm', 20001.7], ['maxradiuskm', Infinity], ['latitude', 'invalid'],
  ]) {
    assert.throws(() => EarthquakeAPI.validateSearchParams({ ...circle, [key]: value }), /範囲で指定/);
  }
  assert.equal(EarthquakeAPI.validateSearchParams({ latitude: 90, longitude: 180, maxradiuskm: 0 }), true);
  assert.equal(EarthquakeAPI.validateSearchParams({ latitude: -90, longitude: -180, maxradiuskm: 20001.6 }), true);
});

test('maximum depth allows the documented negative depth range', () => {
  assert.equal(EarthquakeAPI.validateSearchParams({ mindepth: -100, maxdepth: -50 }), true);
  assert.throws(() => EarthquakeAPI.validateSearchParams({ maxdepth: -101 }), /最大深さ/);
  assert.throws(() => EarthquakeAPI.validateSearchParams({ mindepth: 0, maxdepth: -10 }), /最小深さは最大深さ以下/);
});

test('HTTP 204 no-data becomes a successful empty collection', async () => {
  const api = apiWithFetch(async () => new Response(null, { status: 204 }));
  const data = await api.search({ limit: 20 });
  assert.equal(data.type, 'FeatureCollection');
  assert.equal(data.features.length, 0);
  assert.equal(data.metadata.count, 0);
  assert.equal(data.metadata.limitReached, false);
});

test('single searches mark possible incomplete results only when the requested limit is reached', async () => {
  const api = apiWithFetch(async () => jsonResponse([earthquake('a'), earthquake('b')], { count: 999 }));
  assert.equal((await api.search({ limit: 2 })).metadata.limitReached, true);
  const belowLimit = await api.search({ limit: 3 });
  assert.equal(belowLimit.metadata.limitReached, false);
  assert.equal(belowLimit.metadata.count, 2);
  assert.equal((await api.search({})).metadata.limitReached, false);
});

test('merged results flag both per-query limits and post-merge cropping conservatively', () => {
  const response = features => ({ type: 'FeatureCollection', features, metadata: {} });
  const perQueryLimit = EarthquakeAPI.mergeGeoJSONResponses([
    response([earthquake('shared')]), response([earthquake('shared')]),
  ], 1);
  assert.equal(perQueryLimit.features.length, 1);
  assert.equal(perQueryLimit.metadata.limitReached, true);

  const cropped = EarthquakeAPI.mergeGeoJSONResponses([
    response([earthquake('a'), earthquake('b')]), response([earthquake('c'), earthquake('d')]),
  ], 3);
  assert.equal(cropped.features.length, 3);
  assert.equal(cropped.metadata.limitReached, true);

  const complete = EarthquakeAPI.mergeGeoJSONResponses([
    response([earthquake('a')]), response([earthquake('b')]),
  ], 3);
  assert.equal(complete.metadata.limitReached, false);
});

test('merged GeoJSON does not retain a bounding box or URL describing just one query', () => {
  const merged = EarthquakeAPI.mergeGeoJSONResponses([
    { features: [earthquake('west')], bbox: [120, 20, 0, 180, 50, 50], metadata: { url: 'https://example.com/west', generated: 100 } },
    { features: [earthquake('east')], bbox: [-180, 20, 0, -60, 50, 50], metadata: { url: 'https://example.com/east' } },
  ], 50);
  assert.equal(Object.hasOwn(merged, 'bbox'), false);
  assert.equal(Object.hasOwn(merged.metadata, 'url'), false);
  assert.equal(merged.metadata.generated, 100);
  assert.equal(merged.metadata.count, 2);
});

test('malformed API payloads are rejected before result rendering', async () => {
  const invalidPayloads = [
    null,
    { type: 'FeatureCollection', features: {} },
    { type: 'FeatureCollection', features: [], metadata: [] },
    { type: 'FeatureCollection', features: [null] },
    { type: 'FeatureCollection', features: [{ ...earthquake('a'), properties: null }] },
    { type: 'FeatureCollection', features: [{ ...earthquake('a'), geometry: { type: 'Point', coordinates: [139, null, 10] } }] },
    { type: 'FeatureCollection', features: [{ ...earthquake('a'), properties: { time: 'invalid' } }] },
    { type: 'FeatureCollection', features: [{ ...earthquake('a'), properties: { time: 100, mag: '4.5' } }] },
    { type: 'FeatureCollection', features: [{ ...earthquake('a'), properties: { time: 100, mag: 4.5, place: {} } }] },
  ];
  for (const payload of invalidPayloads) {
    const api = apiWithFetch(async () => new Response(JSON.stringify(payload)));
    await assert.rejects(api.search({}), /有効な地震GeoJSON|無効な地震データ/);
  }
  const invalidJSON = apiWithFetch(async () => new Response('<html>upstream failure</html>'));
  await assert.rejects(invalidJSON.search({}), /JSONとして解釈できません/);
});

test('valid earthquake payloads preserve unknown magnitude and depth as null', async () => {
  const feature = earthquake('unknown');
  feature.properties.mag = null;
  feature.geometry.coordinates[2] = null;
  const api = apiWithFetch(async () => jsonResponse([feature]));
  const data = await api.search({});
  assert.equal(data.features[0].properties.mag, null);
  assert.equal(data.features[0].geometry.coordinates[2], null);
});

test('a malformed regional response fails the entire search rather than returning partial results', async () => {
  const api = apiWithFetch(async url => new URL(url).searchParams.get('minlongitude') === '100'
    ? jsonResponse([earthquake('valid')])
    : new Response(JSON.stringify({ error: 'upstream failure' })));
  await assert.rejects(api.search({ boundsList: EarthquakeAPI.getRegionPresets().pacific.boundsList }), /有効な地震GeoJSON/);
});
