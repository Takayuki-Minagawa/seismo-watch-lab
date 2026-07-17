import assert from 'node:assert/strict';
import test from 'node:test';

import { createBrowserLikeContext, loadClassicScript } from './helpers/load-classic-script.mjs';

function fakeElement() {
  const classes = new Set();
  return {
    innerHTML: '',
    attributes: new Map(),
    classList: {
      add: value => classes.add(value),
      remove: value => classes.delete(value),
    },
    addEventListener() {},
    querySelectorAll: () => [],
    setAttribute(name, value) { this.attributes.set(name, String(value)); },
    removeAttribute(name) { this.attributes.delete(name); },
    focus() {},
  };
}

test('detail panel ignores non-numeric external metrics instead of injecting markup', () => {
  const panel = fakeElement();
  const close = fakeElement();
  const overlay = fakeElement();
  const content = fakeElement();
  const elements = new Map([
    ['detail-panel', panel],
    ['detail-close', close],
    ['detail-overlay', overlay],
    ['detail-content', content],
  ]);
  const document = {
    activeElement: null,
    addEventListener() {},
    getElementById: id => elements.get(id) || null,
    querySelectorAll: () => [],
  };
  const context = createBrowserLikeContext({
    document,
    navigator: {},
    prompt() {},
    EarthquakeMap: { focusOn() {} },
    Settings: { showToast() {} },
    I18n: {
      translatePlace: value => value,
      magnitudeClass: () => 'mag-major',
      magnitudeLabel: () => '大規模',
      formatDateJST: () => '2026-01-01 09:00',
      formatDateUTC: () => '2026-01-01 00:00',
      translateTerm: value => value,
    },
  });
  loadClassicScript('js/utils.js', 'AppUtils', context);
  const { exported: DetailPanel } = loadClassicScript('js/detail.js', 'DetailPanel', context);
  DetailPanel.init();
  DetailPanel.show({
    properties: {
      mag: 6.2,
      place: 'Test place',
      time: 0,
      status: 'reviewed',
      type: 'earthquake',
      felt: '<img src=x onerror=alert(1)>',
      sig: '<svg onload=alert(1)>',
      cdi: '7.2',
      mmi: null,
      tsunami: 0,
    },
    geometry: { coordinates: [139, 35, 10] },
  });

  assert.ok(!content.innerHTML.includes('<img'));
  assert.ok(!content.innerHTML.includes('<svg'));
  assert.match(content.innerHTML, /7\.2/);
});
