import assert from 'node:assert/strict';
import test from 'node:test';

import { createBrowserLikeContext, loadClassicScript } from './helpers/load-classic-script.mjs';

const context = createBrowserLikeContext();
loadClassicScript('js/utils.js', 'AppUtils', context);
const { exported: EarthquakeAPI } = loadClassicScript('js/api.js', 'EarthquakeAPI', context);

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
});
