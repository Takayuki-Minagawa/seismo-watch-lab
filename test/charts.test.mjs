import assert from 'node:assert/strict';
import test from 'node:test';

import { createBrowserLikeContext, loadClassicScript } from './helpers/load-classic-script.mjs';

function renderChartConfigs(features) {
  const configs = new Map();
  const grid = { style: {} };
  const context = createBrowserLikeContext({
    document: {
      documentElement: { dataset: {} },
      getElementById: id => id.startsWith('chart-') ? { id, closest: () => grid } : null,
    },
    Chart: class {
      constructor(canvas, config) { configs.set(canvas.id, config); }
      destroy() {}
    },
  });
  loadClassicScript('js/charts.js', 'Charts', context).exported.render({ features });
  return configs;
}

function feature({ depth = 10, time = Date.parse('2026-10-02T16:00:00Z') } = {}) {
  return {
    properties: { mag: 5, time },
    geometry: { coordinates: [140, 35, depth] },
  };
}

test('depth histogram separates negative depths and assigns boundary values correctly', () => {
  const configs = renderChartConfigs([-1, 0, 9.9, 10, 700, null].map(depth => feature({ depth })));
  const data = configs.get('chart-depth').data;
  assert.deepEqual(Array.from(data.labels), ['<0', '0-10', '10-30', '30-70', '70-150', '150-300', '300-700', '700+']);
  assert.deepEqual(Array.from(data.datasets[0].data), [1, 2, 1, 0, 0, 0, 0, 1]);
});

test('timeline ticks and tooltips show the same JST day outside Japan', () => {
  const originalTimezone = process.env.TZ;
  process.env.TZ = 'UTC';
  try {
    const time = Date.parse('2026-10-02T16:00:00Z');
    const config = renderChartConfigs([feature({ time })]).get('chart-timeline');
    assert.equal(config.options.scales.x.ticks.callback(time), '10/3');
    assert.equal(config.options.scales.x.title.text, '日付 (JST)');
    assert.match(config.options.plugins.tooltip.callbacks.label({ raw: { x: time, y: 5 } }), /2026\/10\/3/);
  } finally {
    if (originalTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = originalTimezone;
  }
});

test('missing Chart.js explains unavailable graphs without failing search or theme changes', () => {
  const elements = new Map();
  const grid = {
    style: {},
    before(element) { elements.set(element.id, element); },
  };
  for (const id of ['chart-mag', 'chart-depth', 'chart-timeline', 'chart-magdepth']) {
    elements.set(id, { closest: () => grid });
  }
  const context = createBrowserLikeContext({
    document: {
      documentElement: { dataset: {} },
      getElementById: id => elements.get(id) || null,
      createElement: () => ({ style: {}, setAttribute() {} }),
    },
  });
  const charts = loadClassicScript('js/charts.js', 'Charts', context).exported;
  const data = {
    features: [{
      properties: { time: Date.now(), mag: 5 },
      geometry: { coordinates: [140, 35, 10] },
    }],
  };

  assert.doesNotThrow(() => charts.render(data));
  assert.match(elements.get('charts-unavailable').textContent, /統計グラフを読み込めませんでした/);
  assert.equal(elements.get('charts-unavailable').hidden, false);
  assert.equal(grid.style.display, 'none');
  assert.doesNotThrow(() => charts.refreshTheme(data));

  // Empty searches clear the previous failure message; a later library load can render normally.
  charts.render({ features: [] });
  assert.equal(elements.get('charts-unavailable').hidden, true);
  let created = 0;
  let destroyed = 0;
  context.Chart = class {
    constructor() { created += 1; }
    destroy() { destroyed += 1; }
  };
  charts.render(data);
  assert.equal(created, 4);
  assert.equal(grid.style.display, '');
  assert.equal(elements.get('charts-unavailable').hidden, true);
  charts.clearAll();
  assert.equal(destroyed, 4);
});
