import assert from 'node:assert/strict';
import test from 'node:test';

import { createBrowserLikeContext, loadClassicScript } from './helpers/load-classic-script.mjs';

function loadMap({ leafletAvailable = true } = {}) {
  let popupHtml = '';
  const markerOptions = [];
  const elements = new Map([
    ['map', { innerHTML: '' }],
    ['map-mode-hint', { textContent: '' }],
    ['map-legend', { innerHTML: '' }],
  ]);
  const mapObject = {
    fitBounds: () => {},
    setView: () => {},
    invalidateSize: () => {},
  };
  const markerGroup = { clearLayers: () => {} };
  const L = {
    map: () => mapObject,
    tileLayer: () => ({ addTo: () => {} }),
    layerGroup: () => ({ addTo: () => markerGroup }),
    circleMarker: (_coordinates, options) => {
      markerOptions.push(options);
      return ({
      bindPopup: html => { popupHtml = html; },
      on: () => {},
      addTo: () => {},
      });
    },
  };
  const context = createBrowserLikeContext({
    ...(leafletAvailable ? { L } : {}),
    document: { getElementById: id => elements.get(id) || null },
    I18n: {
      translatePlace: value => value,
      formatDateJST: () => '2026/01/01',
      magnitudeClass: () => 'mag-5',
      magnitudeLabel: () => '中規模',
    },
  });
  loadClassicScript('js/utils.js', 'AppUtils', context);
  const EarthquakeMap = loadClassicScript('js/map.js', 'EarthquakeMap', context).exported;
  return {
    EarthquakeMap,
    elements,
    getPopupHtml: () => popupHtml,
    getLastMarkerOptions: () => markerOptions.at(-1),
  };
}

test('map popup escapes external place text and rejects untrusted detail origins', () => {
  const runtime = loadMap();
  runtime.EarthquakeMap.init('map');
  runtime.EarthquakeMap.displayEarthquakes({
    features: [{
      properties: {
        mag: 5,
        time: Date.now(),
        place: '<img src=x onerror=alert(1)>',
        url: 'javascript:alert(1)',
        tsunami: 0,
      },
      geometry: { coordinates: [140, 35, 0] },
    }],
  });

  const popup = runtime.getPopupHtml();
  assert.ok(!popup.includes('<img'));
  assert.ok(!popup.includes('javascript:'));
  assert.match(popup, /&lt;img/);
  assert.match(popup, /深さ:<\/strong> 0\.0 km/);
  assert.match(popup, /class="mag-badge mag-5"/);
});

test('map legend and marker colors share the active style definition', () => {
  const runtime = loadMap();
  runtime.EarthquakeMap.init('map');

  assert.equal(runtime.EarthquakeMap.magColor(3.5), '#a0c45a');
  assert.match(runtime.elements.get('map-legend').innerHTML, /#a0c45a/);

  runtime.EarthquakeMap.setStyleMode('depth');
  assert.match(runtime.elements.get('map-legend').innerHTML, /震源深さ/);
  assert.match(runtime.elements.get('map-legend').innerHTML, /#d7263d/);
  runtime.EarthquakeMap.displayEarthquakes({
    features: [{
      properties: { mag: 5, time: Date.now(), place: 'Test', tsunami: 0 },
      geometry: { coordinates: [140, 35, 10] },
    }],
  });
  assert.equal(runtime.getLastMarkerOptions().fillColor, '#d7263d');

  runtime.EarthquakeMap.setStyleMode('recency');
  assert.match(runtime.elements.get('map-legend').innerHTML, /発生からの経過時間/);
  assert.match(runtime.elements.get('map-mode-hint').textContent, /1時間以内/);
});

test('missing Leaflet leaves search results and detail selection usable', () => {
  const runtime = loadMap({ leafletAvailable: false });
  assert.doesNotThrow(() => runtime.EarthquakeMap.init('map'));
  assert.match(runtime.elements.get('map').innerHTML, /地図を読み込めませんでした/);
  assert.match(runtime.elements.get('map').innerHTML, /検索結果の一覧・詳細/);

  const data = {
    features: [{
      properties: { mag: 5, time: Date.now(), place: 'Test', tsunami: 0 },
      geometry: { coordinates: [140, 35, 10] },
    }],
  };
  assert.doesNotThrow(() => {
    runtime.EarthquakeMap.displayEarthquakes(data);
    runtime.EarthquakeMap.setStyleMode('depth');
    runtime.EarthquakeMap.focusOn(35, 140);
    runtime.EarthquakeMap.invalidateSize();
    runtime.EarthquakeMap.reset();
  });
  assert.equal(runtime.getLastMarkerOptions(), undefined);
});
