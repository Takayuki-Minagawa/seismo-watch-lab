import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

import { createBrowserLikeContext, loadClassicScript } from './helpers/load-classic-script.mjs';

function createElement(id) {
  const listeners = new Map();
  return {
    id,
    value: '',
    innerHTML: '',
    textContent: '',
    disabled: false,
    style: {},
    classList: { add() {}, remove() {}, toggle() {} },
    setAttribute() {},
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(listener);
    },
    async click() {
      for (const listener of listeners.get('click') || []) await listener({ target: this });
    },
  };
}

function loadWaveformApp() {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, createElement(id));
    return elements.get(id);
  };
  const charts = [];
  const toasts = [];
  const context = createBrowserLikeContext({
    document: {
      querySelector: selector => selector.startsWith('#') ? element(selector.slice(1)) : null,
      querySelectorAll: () => [],
      getElementById: element,
      addEventListener() {},
    },
    Settings: { showToast: message => toasts.push(message) },
    Chart: class {
      constructor(canvas, config) {
        this.canvas = canvas;
        this.config = config;
        this.destroyed = false;
        charts.push(this);
      }
      destroy() { this.destroyed = true; }
    },
  });
  loadClassicScript('js/utils.js', 'AppUtils', context);
  const { exported: WaveformViewer } = loadClassicScript('js/waveform.js', 'WaveformViewer', context);
  const { exported: Spectrum } = loadClassicScript('js/spectrum.js', 'Spectrum', context);
  const appPath = new URL('../js/app.js', import.meta.url);
  const appSource = readFileSync(appPath, 'utf8');
  const startup = "document.addEventListener('DOMContentLoaded', init);";
  assert.ok(appSource.includes(startup), 'App startup hook must exist for the test harness');
  // Expose state only in this VM; production initialization and event handlers stay unchanged.
  const exposedSource = appSource.replace(startup, `
    globalThis.waveformAppTest = {
      initWaveformViewer,
      seed(data, result) {
        selectedFeature = {
          properties: { time: Date.UTC(2026, 0, 1), mag: 5 },
          geometry: { coordinates: [139, 35, 10] },
        };
        currentWaveformData = data;
        currentWaveformView = { start: 0, end: data.meta._duration };
        spectrumInputData = data;
        currentSpectrumResult = result;
      },
      state() {
        return { currentWaveformData, currentWaveformView, spectrumInputData, currentSpectrumResult };
      },
    };
  `);
  vm.runInContext(exposedSource, context, { filename: appPath.pathname });
  const app = context.waveformAppTest;
  app.initWaveformViewer();

  const data = {
    acc: [0, 999, 10, -20, 888, 0],
    dt: 0.06,
    meta: {
      _dt: 0.06, _npts: 6, _duration: 0.30, _maxAcc: 999,
      _displayUnit: 'gal', _stationId: 'XX.TEST.--.HNN',
    },
  };
  const result = Spectrum.computeSpectrum(data.acc, data.dt, { periodCount: 5 });
  app.seed(data, result);
  WaveformViewer.renderWaveform(data, 'waveform-display');
  Spectrum.renderWaveform(data.acc, data.dt, 'chart-waveform-input');
  Spectrum.renderSpectrum(result, 'chart-spectrum');
  element('btn-download-spectrum').disabled = false;
  element('btn-calc-spectrum').disabled = false;
  element('spectrum-summary').innerHTML = 'previous spectrum summary';
  element('waveform-filter').value = 'none';
  element('waveform-station').value = JSON.stringify({
    network: 'XX', station: 'TEST', location: '', channel: 'HNN', stationKey: 'XX.TEST.--.HNN',
  });
  return { app, data, result, element, charts, toasts, WaveformViewer };
}

test('rejecting a one-sample view range preserves the loaded waveform and spectrum result', async () => {
  const { app, data, result, element, charts, toasts } = loadWaveformApp();
  element('waveform-view-start').value = '0.10';
  element('waveform-view-end').value = '0.15';

  await element('btn-apply-waveform-view').click();

  const state = app.state();
  assert.equal(state.currentWaveformData, data);
  assert.deepEqual({ ...state.currentWaveformView }, { start: 0, end: 0.30 });
  assert.equal(state.spectrumInputData, data);
  assert.equal(state.currentSpectrumResult, result);
  assert.equal(charts.length, 3);
  assert.ok(charts.every(chart => !chart.destroyed));
  assert.equal(element('btn-download-spectrum').disabled, false);
  assert.equal(element('spectrum-summary').innerHTML, 'previous spectrum summary');
  assert.match(toasts.at(-1), /2点以上/);
});

test('applying a valid view range clears the previous spectrum and uses the selected samples', async () => {
  const { app, data, element, charts } = loadWaveformApp();
  const previousSpectrumChart = charts.find(chart => chart.canvas.id === 'chart-spectrum');
  element('waveform-view-start').value = '0.10';
  element('waveform-view-end').value = '0.20';

  await element('btn-apply-waveform-view').click();

  const state = app.state();
  assert.equal(state.currentWaveformData, data);
  assert.deepEqual({ ...state.currentWaveformView }, { start: 0.10, end: 0.20 });
  assert.equal(state.currentSpectrumResult, null);
  assert.equal(previousSpectrumChart.destroyed, true);
  assert.equal(element('btn-download-spectrum').disabled, true);
  assert.equal(element('spectrum-summary').innerHTML, '');
  assert.equal(state.spectrumInputData.acc, data.acc, 'integration retains the preceding waveform history');
  assert.equal(state.spectrumInputData.meta._analysisWindowStart, 0.12);
  assert.equal(state.spectrumInputData.meta._analysisWindowEnd, 0.18);
  assert.equal(state.spectrumInputData.meta._npts, 2);
  const currentInputChart = charts.filter(chart => chart.canvas.id === 'chart-waveform-input').at(-1);
  assert.equal(currentInputChart.destroyed, false);
  assert.deepEqual(Array.from(currentInputChart.config.data.datasets[0].data), [10, -20]);
});

test('a failed waveform reload clears stale spectrum data, charts, and download controls', async () => {
  const { app, element, charts, toasts, WaveformViewer } = loadWaveformApp();
  WaveformViewer.fetchWaveformData = async () => { throw new Error('fixture network failure'); };

  await element('btn-show-waveform').click();

  const state = app.state();
  assert.equal(state.currentWaveformData, null);
  assert.equal(state.spectrumInputData, null);
  assert.equal(state.currentSpectrumResult, null);
  assert.ok(charts.every(chart => chart.destroyed));
  assert.equal(element('btn-calc-spectrum').disabled, true);
  assert.equal(element('btn-download-spectrum').disabled, true);
  assert.equal(element('spectrum-summary').innerHTML, '');
  assert.match(toasts.at(-1), /fixture network failure/);
});
