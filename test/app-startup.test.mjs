import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { createBrowserLikeContext, loadClassicScript } from './helpers/load-classic-script.mjs';

const indexHtml = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

function createAppWithoutVisualLibraries() {
  const elements = new Map();
  let document;

  function createElement(tagName = 'div') {
    const listeners = new Map();
    const attributes = new Map();
    const classes = new Set();
    let html = '';
    let rows = [];
    const element = {
      tagName: tagName.toUpperCase(), id: '', value: '', textContent: '', style: {}, dataset: {},
      disabled: false, hidden: false, children: [],
      classList: {
        add: (...names) => names.forEach(name => classes.add(name)),
        remove: (...names) => names.forEach(name => classes.delete(name)),
        contains: name => classes.has(name),
        toggle(name, active = !classes.has(name)) {
          if (active) classes.add(name);
          else classes.delete(name);
          return active;
        },
      },
      setAttribute(name, value) { attributes.set(name, String(value)); },
      getAttribute(name) { return attributes.get(name) ?? null; },
      removeAttribute(name) { attributes.delete(name); },
      addEventListener(type, listener) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(listener);
      },
      async dispatch(type, details = {}) {
        const event = { target: this, stopPropagation() {}, preventDefault() {}, ...details };
        for (const listener of listeners.get(type) || []) await listener(event);
      },
      async click() { if (!this.disabled) await this.dispatch('click'); },
      appendChild(child) {
        this.children.push(child);
        if (child.id) elements.set(child.id, child);
        return child;
      },
      insertBefore(child) { return this.appendChild(child); },
      before(sibling) { if (sibling.id) elements.set(sibling.id, sibling); },
      remove() { elements.delete(this.id); },
      focus() { document.activeElement = this; },
      scrollIntoView() {},
      closest(selector) {
        if (this.id === 'eq-tbody') return selector === '.card' ? resultsCard : tableWrapper;
        if (this.id === 'chart-mag' && selector === '.chart-grid') return chartGrid;
        return null;
      },
      querySelector(selector) {
        if (selector === '[data-open-row-detail]') return this.detailButton || null;
        const index = selector.match(/^tr\[data-index="(\d+)"\]$/)?.[1];
        return index === undefined ? null : rows.find(row => row.dataset.index === index) || null;
      },
      querySelectorAll(selector) {
        if (selector === 'tr' || selector === 'tr[data-lat]') return rows;
        return [];
      },
      get innerHTML() { return html; },
      set innerHTML(value) {
        html = value;
        // Only the result rows need a parsed subtree to exercise their real click handlers.
        if (this.id !== 'eq-tbody') return;
        rows = [...value.matchAll(/<tr data-index="([^"]+)" data-lat="([^"]+)" data-lon="([^"]+)"/g)]
          .map(([, index, lat, lon]) => {
            const row = createElement('tr');
            row.dataset = { index, lat, lon };
            row.detailButton = createElement('button');
            return row;
          });
      },
    };
    return element;
  }

  // Derive the available elements from the shipped document instead of inventing missing IDs.
  for (const [, tagName, before, id, after] of indexHtml.matchAll(/<([a-z][a-z0-9-]*)\b([^<>]*?)\bid="([^"]+)"([^<>]*)>/gi)) {
    const element = createElement(tagName);
    element.id = id;
    const attributes = `${before} ${after}`;
    element.value = attributes.match(/\bvalue="([^"]*)"/)?.[1] || '';
    element.disabled = /\bdisabled\b/.test(attributes);
    element.hidden = /\bhidden\b/.test(attributes);
    elements.set(id, element);
  }
  for (const [, id, options] of indexHtml.matchAll(/<select\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)) {
    const choices = [...options.matchAll(/<option\b([^>]*)>/g)].map(([, attrs]) => ({
      value: attrs.match(/\bvalue="([^"]*)"/)?.[1] || '', selected: /\bselected\b/.test(attrs),
    }));
    elements.get(id).value = (choices.find(choice => choice.selected) || choices[0])?.value || '';
  }

  const main = createElement('main');
  const resultsCard = createElement();
  const tableWrapper = createElement();
  const chartGrid = createElement();
  const documentEvents = createElement();
  document = {
    activeElement: null,
    documentElement: createElement('html'),
    body: createElement('body'),
    getElementById: id => elements.get(id) || null,
    querySelector: selector => selector === 'main' ? main : elements.get(selector.slice(1)) || null,
    querySelectorAll: selector => selector === '.header, .main, .footer' ? [main] : [],
    createElement,
    addEventListener: (...args) => documentEvents.addEventListener(...args),
  };
  const responses = [];
  const requests = [];
  const storage = new Map();
  const context = createBrowserLikeContext({
    document,
    location: { search: '', origin: 'http://localhost:8000', pathname: '/' },
    navigator: {},
    localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) },
    fetch: async (url, options) => {
      requests.push({ url, options });
      assert.ok(responses.length, 'Every request must have an explicit local fixture');
      return responses.shift();
    },
  });

  // Keep all production module implementations and the DOMContentLoaded entry point intact.
  // Omit the visual libraries deliberately to reproduce an unavailable dependency at startup.
  const moduleSources = [...indexHtml.matchAll(/<script\b[^>]*\bsrc="(js\/[^"?]+\.js)"/g)]
    .map(([, source]) => source);
  assert.ok(moduleSources.includes('js/app.js'));
  moduleSources.forEach(source => loadClassicScript(source, 'undefined', context));
  assert.equal(context.L, undefined);
  assert.equal(context.Chart, undefined);

  return {
    field: id => elements.get(id), requests, responses,
    start: () => documentEvents.dispatch('DOMContentLoaded'),
  };
}

function earthquakeResponse(features) {
  return new Response(JSON.stringify({ type: 'FeatureCollection', features, metadata: { count: features.length } }));
}

test('real startup keeps search results, monitor, downloads and detail usable without map or chart libraries', async () => {
  const app = createAppWithoutVisualLibraries();
  await app.start();
  assert.match(app.field('startdate').value, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(app.field('map').innerHTML, /地図を読み込めませんでした/);
  app.responses.push(earthquakeResponse([{
    type: 'Feature', id: 'startup-fixture',
    properties: { time: Date.now(), mag: 6.2, place: 'Japan', status: 'reviewed', tsunami: 0 },
    geometry: { type: 'Point', coordinates: [139, 35, 10] },
  }]));

  await app.field('btn-search').click();

  assert.equal(app.requests.length, 1, 'Startup must attach the search button listener');
  assert.equal(new URL(app.requests[0].url).hostname, 'earthquake.usgs.gov');
  assert.equal(app.field('error-msg'), undefined);
  assert.equal(app.field('results-count').textContent, '検索結果: 1件');
  assert.match(app.field('eq-tbody').innerHTML, /6\.2/);
  assert.match(app.field('monitor-cards').innerHTML, /M6\.2/);
  assert.match(app.field('monitor-hotspots').innerHTML, /日本周辺/);
  assert.equal(app.field('charts-unavailable').hidden, false);
  assert.match(app.field('charts-unavailable').textContent, /統計グラフを読み込めませんでした/);
  assert.equal(app.field('btn-search').disabled, false);
  assert.equal(app.field('loading').getAttribute('aria-hidden'), 'true');
  for (const id of ['btn-csv', 'btn-json', 'btn-geojson']) assert.equal(app.field(id).disabled, false);

  const row = app.field('eq-tbody').querySelectorAll('tr[data-lat]')[0];
  assert.ok(row);
  await row.querySelector('[data-open-row-detail]').click();
  assert.equal(app.field('detail-panel').getAttribute('aria-hidden'), 'false');
  assert.match(app.field('detail-content').innerHTML, /M6\.2/);
  assert.match(app.field('detail-content').innerHTML, /10\.0 km/);
  await app.field('detail-close').click();
  assert.equal(app.field('detail-panel').getAttribute('aria-hidden'), 'true');

  // A subsequent empty search must clear the previous result without failing in visual cleanup.
  app.responses.push(earthquakeResponse([]));
  await app.field('btn-search').click();
  assert.equal(app.field('error-msg'), undefined);
  assert.equal(app.field('results-count').textContent, '検索結果: 0件');
  assert.match(app.field('eq-tbody').innerHTML, /見つかりませんでした/);
  assert.equal(app.field('charts-unavailable').hidden, true);
  for (const id of ['btn-csv', 'btn-json', 'btn-geojson']) assert.equal(app.field(id).disabled, true);
});
