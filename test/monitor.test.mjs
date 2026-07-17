import assert from 'node:assert/strict';
import test from 'node:test';

import { createBrowserLikeContext, loadClassicScript } from './helpers/load-classic-script.mjs';

const context = createBrowserLikeContext();
loadClassicScript('js/utils.js', 'AppUtils', context);
const { exported: MonitorDashboard } = loadClassicScript('js/monitor.js', 'MonitorDashboard', context);

function feature({ magnitude, time, tsunami = 0, depth = 20 }) {
  return {
    properties: { mag: magnitude, time, tsunami, place: 'Test' },
    geometry: { coordinates: [140, 35, depth] },
  };
}

test('USGS tsunami-related flag alone does not escalate the reference status', () => {
  const now = Date.now();
  const status = MonitorDashboard.buildStatus([
    feature({ magnitude: 5, time: now - 60_000, tsunami: 1 }),
  ], now);
  assert.equal(status.label, '通常');
});

test('old large events do not look like a current high status', () => {
  const now = Date.now();
  const status = MonitorDashboard.buildStatus([
    feature({ magnitude: 8, time: now - 7 * 24 * 60 * 60 * 1000 }),
  ], now);
  assert.equal(status.label, '通常');
  assert.match(status.note, /過去24時間/);
});

test('a recent M7.5+ event is classified high within the documented window', () => {
  const now = Date.now();
  const status = MonitorDashboard.buildStatus([
    feature({ magnitude: 7.6, time: now - 60_000 }),
  ], now);
  assert.equal(status.label, '高');
});

test('tsunami-related flag is not double-counted in the watch score', () => {
  const base = feature({ magnitude: 6, time: Date.now(), tsunami: 0 });
  const flagged = feature({ magnitude: 6, time: Date.now(), tsunami: 1 });
  assert.equal(MonitorDashboard.riskScore(base), MonitorDashboard.riskScore(flagged));
});
