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
    async change(files) {
      this.files = files;
      for (const listener of listeners.get('change') || []) await listener({ target: this });
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
      calculateSpectrumForLoadedData,
      resetWaveformViewerState,
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
      _unitVerified: true, _unitEvidence: 'header', _inputUnit: 'gal',
      _inputUnitReported: 'GAL', _conversionToGal: 1,
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

const accelerationFile = (unit = 'M/S**2', values = [0.1, -0.2, 0.3]) => ({
  name: 'observation.txt', size: 200,
  text: async () => `TIMESERIES XX.FILE.--.HNE.M, 3 samples, 100 sps, 2026-01-01T00:00:00.000, TSPAIR, FLOAT, ${unit}\n${values.map((value, i) => `2026-01-01T00:00:00.0${i}0 ${value}`).join('\n')}`,
});

test('file import verifies explicit acceleration units, clears prior results and preserves provenance in spectra', async () => {
  const { app, element } = loadWaveformApp();
  await element('waveform-file').change([accelerationFile()]);
  assert.deepEqual(Array.from(app.state().currentWaveformData.acc), [10, -20, 30]);
  assert.equal(app.state().currentSpectrumResult, null);
  assert.equal(element('btn-download-spectrum').disabled, true);
  assert.equal(element('btn-calc-spectrum').disabled, false);
  assert.match(element('spectrum-info').innerHTML, /M\/S\*\*2.*100.*gal/);
  assert.match(element('waveform-import-status').textContent, /計器補正/);
  element('spectrum-damping').value = '5';
  element('spectrum-type').value = 'sa';
  app.calculateSpectrumForLoadedData();
  await new Promise(resolve => setTimeout(resolve, 70));
  const result = app.state().currentSpectrumResult;
  assert.equal(result.meta.pga, 30);
  assert.equal(result.meta.waveform._stationId, 'XX.FILE.--.HNE');
  assert.equal(result.meta.waveform._conversionToGal, 100);
  assert.equal(result.meta.waveform._inputUnitReported, 'M/S**2');
  assert.equal(result.meta.waveform._responseCorrectionRequested, false);
});

test('unknown-unit file import removes stale data and blocks spectrum export', async () => {
  const { app, element, charts } = loadWaveformApp();
  await element('waveform-file').change([accelerationFile('COUNTS')]);
  assert.equal(app.state().currentWaveformData, null);
  assert.equal(app.state().spectrumInputData, null);
  assert.equal(app.state().currentSpectrumResult, null);
  assert.ok(charts.every(chart => chart.destroyed));
  assert.equal(element('btn-calc-spectrum').disabled, true);
  assert.equal(element('btn-download-spectrum').disabled, true);
  assert.match(element('waveform-import-status').textContent, /COUNTS/);
});

test('superseded slow file imports cannot overwrite a newer waveform', async () => {
  const { app, element } = loadWaveformApp();
  let resolveText;
  const pendingText = new Promise(resolve => { resolveText = resolve; });
  const pending = element('waveform-file').change([{ name: 'old.txt', size: 100, text: () => pendingText }]);
  await element('waveform-file').change([accelerationFile('GAL', [1, 2, 3])]);
  resolveText(await accelerationFile().text());
  await pending;
  assert.deepEqual(Array.from(app.state().currentWaveformData.acc), [1, 2, 3]);
  assert.match(element('waveform-import-status').textContent, /observation.txt/);
});

test('defensive spectrum validation rejects seeded unverified units and disables old exports', () => {
  const { app, data, element, toasts } = loadWaveformApp();
  data.meta._unitVerified = false;
  app.calculateSpectrumForLoadedData();
  assert.equal(app.state().spectrumInputData, null);
  assert.equal(app.state().currentSpectrumResult, null);
  assert.equal(element('btn-download-spectrum').disabled, true);
  assert.match(toasts.at(-1), /単位・データ検証/);
});

test('file size limit is checked before reading, and discontinuous files cannot be calculated', async () => {
  const { app, element } = loadWaveformApp();
  await element('waveform-file').change([{ name: 'huge.txt', size: 21 * 1024 * 1024, text: () => { throw new Error('must not read'); } }]);
  assert.match(element('waveform-import-status').textContent, /20 MiB/);
  const file = accelerationFile();
  const text = (await file.text()).replace('00:00:00.020', '00:00:00.090');
  await element('waveform-file').change([{ ...file, text: async () => text }]);
  assert.equal(app.state().spectrumInputData.meta._hasTimingGap, true);
  assert.equal(element('btn-waveform-spectrum').disabled, true);
  assert.equal(element('btn-calc-spectrum').disabled, true);
  app.calculateSpectrumForLoadedData();
  assert.equal(app.state().currentSpectrumResult, null);
});


test('local import and metadata searches preserve each other while remote waveforms still invalidate', async () => {
  const { app, element } = loadWaveformApp();
  element('waveform-station-detail').innerHTML = 'Scale: 2000000 / ScaleUnits: M/S';
  const stationSelection = element('waveform-station').value;
  await element('waveform-file').change([accelerationFile()]);
  const loaded = app.state().currentWaveformData;
  const spectrum = app.state().spectrumInputData;
  assert.equal(element('waveform-station-detail').innerHTML, 'Scale: 2000000 / ScaleUnits: M/S');
  assert.equal(element('waveform-station').value, stationSelection);
  element('waveform-radius').value = '10';
  await element('waveform-radius').change([]);
  assert.equal(app.state().currentWaveformData, loaded);
  assert.equal(app.state().spectrumInputData, spectrum);
  assert.equal(element('btn-calc-spectrum').disabled, false);
  assert.match(element('waveform-import-status').textContent, /observation.txt/);
  app.resetWaveformViewerState(); // Also called when earthquake search/auto-refresh completes.
  assert.equal(app.state().currentWaveformData, loaded);
  assert.equal(app.state().spectrumInputData, spectrum);

  const remote = loadWaveformApp();
  await remote.element('waveform-radius').change([]);
  assert.equal(remote.app.state().currentWaveformData, null);
  assert.equal(remote.app.state().spectrumInputData, null);
});

test('metadata changes during a slow local import do not cancel that import', async () => {
  const { app, element } = loadWaveformApp();
  let resolveText;
  const pendingText = new Promise(resolve => { resolveText = resolve; });
  const pending = element('waveform-file').change([{ name: 'slow.txt', size: 100, text: () => pendingText }]);
  await element('waveform-datacenter').change([]);
  resolveText(await accelerationFile('GAL').text());
  await pending;
  assert.equal(app.state().currentWaveformData.meta._stationId, 'XX.FILE.--.HNE');
  assert.match(element('waveform-import-status').textContent, /slow.txt/);
});
