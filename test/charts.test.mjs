import assert from 'node:assert/strict';
import test from 'node:test';

import { createBrowserLikeContext, loadClassicScript } from './helpers/load-classic-script.mjs';

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
