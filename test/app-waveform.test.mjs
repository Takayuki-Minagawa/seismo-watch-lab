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
    async input(value) {
      this.value = value;
      for (const listener of listeners.get('input') || []) await listener({ target: this });
    },
    async click() {
      for (const listener of listeners.get('click') || []) await listener({ target: this });
    },
  };
}

function loadWaveformApp({ queueTimers = false } = {}) {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, createElement(id));
    return elements.get(id);
  };
  const charts = [];
  const toasts = [];
  const timers = [];
  const context = createBrowserLikeContext({
    ...(queueTimers ? { setTimeout: callback => { timers.push(callback); return timers.length; } } : {}),
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
      initSpectrumTool,
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
  app.initSpectrumTool();
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
  element('spectrum-damping').value = '5';
  element('spectrum-type').value = 'sa';
  element('waveform-filter').value = 'none';
  element('waveform-station').value = JSON.stringify({
    network: 'XX', station: 'TEST', location: '', channel: 'HNN', stationKey: 'XX.TEST.--.HNN',
  });
  return { app, data, result, element, charts, toasts, WaveformViewer, Spectrum,
    runTimers: () => timers.splice(0).forEach(callback => callback()),
  };
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
  assert.deepEqual(Array.from(currentInputChart.config.data.datasets[0].data, point => point.y), [10, -20]);
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

test('view controls preserve short records and precise bounds through repeated zoom and reset', async () => {
  const { app, element } = loadWaveformApp();
  await element('waveform-file').change([accelerationFile('GAL', [0, 0, 100])]);
  assert.equal(element('waveform-view-end').value, '0.02');
  assert.equal(element('waveform-view-end').max, '0.02');
  assert.equal(element('waveform-view-end').step, 'any');
  assert.match(element('spectrum-info').innerHTML, /継続時間: 0\.020秒/);
  assert.match(element('waveform-display').innerHTML, /実効サンプル範囲: 0\.000 - 0\.020 秒/);
  await element('btn-apply-waveform-view').click();
  assert.equal(app.state().spectrumInputData.meta._npts, 3);
  assert.equal(app.state().spectrumInputData.meta._maxAcc, 100);

  // Neither selecting nor resetting a sub-tenth-second range may round away its last sample.
  await element('waveform-view-start').input('0.009');
  await element('waveform-view-end').input('0.02');
  await element('btn-apply-waveform-view').click();
  assert.equal(element('waveform-view-start').value, '0.009');
  assert.equal(app.state().spectrumInputData.meta._npts, 2);
  await element('btn-apply-waveform-view').click();
  assert.equal(app.state().spectrumInputData.meta._npts, 2);
  await element('btn-reset-waveform-view').click();
  assert.equal(element('waveform-view-end').value, '0.02');
  assert.equal(app.state().spectrumInputData.meta._npts, 3);
});

test('damping edits invalidate the previous spectrum and export while preserving the input waveform', async () => {
  for (const event of ['input', 'change']) {
    const { app, data, element, charts } = loadWaveformApp();
    element('spectrum-damping').value = '10';
    if (event === 'input') await element('spectrum-damping').input('10');
    else await element('spectrum-damping').change();
    assert.equal(app.state().currentSpectrumResult, null, event);
    assert.equal(app.state().spectrumInputData, data, event);
    assert.equal(app.state().currentWaveformData, data, event);
    assert.equal(element('btn-download-spectrum').disabled, true, event);
    assert.equal(element('btn-calc-spectrum').disabled, false, event);
    assert.equal(element('spectrum-summary').innerHTML, '', event);
    assert.equal(charts[0].destroyed, false, event);
    assert.equal(charts[1].destroyed, false, event);
    assert.equal(charts[2].destroyed, true, event);
  }
});

test('invalid damping and failed recalculation cannot leave an earlier spectrum exportable', () => {
  const invalid = loadWaveformApp({ queueTimers: true });
  invalid.element('spectrum-damping').value = 'invalid';
  invalid.app.calculateSpectrumForLoadedData();
  assert.equal(invalid.app.state().currentSpectrumResult, null);
  assert.equal(invalid.element('btn-download-spectrum').disabled, true);
  assert.match(invalid.toasts.at(-1), /減衰定数/);

  const failed = loadWaveformApp({ queueTimers: true });
  failed.Spectrum.computeSpectrum = () => { throw new Error('fixture computation failure'); };
  failed.app.calculateSpectrumForLoadedData();
  assert.equal(failed.app.state().currentSpectrumResult, null, 'old result clears before the queued calculation');
  assert.equal(failed.element('btn-download-spectrum').disabled, true);
  failed.runTimers();
  assert.equal(failed.app.state().currentSpectrumResult, null);
  assert.equal(failed.app.state().spectrumInputData, failed.data);
  assert.equal(failed.element('btn-calc-spectrum').disabled, false);
  assert.equal(failed.element('btn-download-spectrum').disabled, true);
  assert.match(failed.toasts.at(-1), /fixture computation failure/);
});

test('a damping edit cancels queued spectrum work before entering the solver', async () => {
  const { app, element, Spectrum, runTimers } = loadWaveformApp({ queueTimers: true });
  let calculations = 0;
  const computeSpectrum = Spectrum.computeSpectrum;
  Spectrum.computeSpectrum = (...args) => { calculations += 1; return computeSpectrum(...args); };
  app.calculateSpectrumForLoadedData();
  await element('spectrum-damping').input('10');
  runTimers();
  assert.equal(calculations, 0);
  assert.equal(app.state().currentSpectrumResult, null);
  assert.equal(element('btn-calc-spectrum').disabled, false);

  app.calculateSpectrumForLoadedData();
  runTimers();
  assert.equal(calculations, 1);
  assert.deepEqual(Object.keys(app.state().currentSpectrumResult.results), ['0.1']);
  assert.equal(element('btn-download-spectrum').disabled, false);
});

function correctedRemoteData(stationId = 'XX.TEST..HNN', amplitude = 100) {
  const acc = Array.from({ length: 100 }, (_, index) => amplitude * Math.sin(index * Math.PI / 10));
  return {
    acc, dt: 0.05,
    meta: {
      _dt: 0.05, _sampleRate: 20, _npts: acc.length, _duration: (acc.length - 1) * 0.05,
      _maxAcc: amplitude, _stationId: stationId, _startTime: '2026-01-01T00:00:00.000000Z',
      _source: 'Public observation / StationXML correction', _filterLabel: '0.02 / 0.05 / 6 / 8 Hz',
      _displayUnit: 'gal', _inputUnit: 'm/s²', _inputUnitReported: 'M/S**2', _conversionToGal: 100,
      _unitVerified: true, _unitEvidence: 'stationxml-response', _responseCorrectionApplied: true,
      _responseCorrectionRequested: true, _responseUrl: 'https://example.org/fdsnws/station/1/query',
      _processing: { outputUnits: 'M/S**2', stageCount: 3, preFilter: [0.02, 0.05, 6, 8] },
      _analysisPeriodMin: 0.5, _analysisPeriodMax: 10, _hasTimingGap: false,
    },
  };
}

function pendingRemoteFetch(WaveformViewer) {
  const requests = [];
  WaveformViewer.fetchWaveformData = (station, starttime, endtime, options) => {
    let resolve, reject;
    const promise = new Promise((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
    requests.push({ station, starttime, endtime, options, resolve, reject });
    return promise; // Deliberately ignores abort to exercise stale-result protection too.
  };
  WaveformViewer.fetchStationPublicInfo = async () => { throw new Error('fixture metadata unavailable'); };
  return requests;
}

test('successful remote acquisition enables spectrum calculation and retains processing provenance without file input', async () => {
  const { app, element, WaveformViewer, runTimers } = loadWaveformApp({ queueTimers: true });
  const data = correctedRemoteData();
  let received;
  WaveformViewer.fetchWaveformData = async (station, starttime, endtime, options) => {
    received = { station, starttime, endtime, options };
    options.onProgress('Correcting response');
    return data;
  };
  element('waveform-filter').value = '0.02, 0.05, 6, 8';
  await element('btn-show-waveform').click();

  assert.equal(element('waveform-file').files, undefined, 'no file selection is required');
  assert.deepEqual(Array.from(received.options.preFilter), [0.02, 0.05, 6, 8]);
  assert.equal(app.state().currentWaveformData, data);
  assert.equal(app.state().spectrumInputData.acc, data.acc);
  assert.equal(app.state().currentSpectrumResult, null);
  assert.equal(element('btn-calc-spectrum').disabled, false);
  assert.equal(element('btn-waveform-spectrum').disabled, false);
  assert.equal(element('btn-download-spectrum').disabled, true);
  assert.equal(element('btn-cancel-waveform').disabled, true);
  assert.match(element('waveform-fetch-status').textContent, /100点.*応答スペクトル/);
  assert.match(element('spectrum-info').innerHTML, /計器情報からの加速度補正/);
  await element('btn-calc-spectrum').click();
  runTimers();
  const result = app.state().currentSpectrumResult;
  assert.ok(result);
  assert.equal(result.meta.pga, 100);
  assert.equal(result.meta.effectivePeriodMin, 0.5);
  assert.equal(result.meta.waveform._responseCorrectionApplied, true);
  assert.equal(result.meta.waveform._processing.stageCount, 3);
  assert.equal(element('btn-download-spectrum').disabled, false);
});

test('station or correction-filter changes abort in-flight acquisition and never repopulate from stale progress or completion', async () => {
  for (const kind of ['station', 'filter']) {
    const { app, element, charts, WaveformViewer } = loadWaveformApp();
    const requests = pendingRemoteFetch(WaveformViewer);
    const pending = element('btn-show-waveform').click();
    assert.equal(requests.length, 1);
    assert.equal(element('btn-cancel-waveform').disabled, false);
    requests[0].options.onProgress('Old request processing');
    assert.equal(element('waveform-fetch-status').textContent, 'Old request processing');
    if (kind === 'station') {
      element('waveform-station').value = JSON.stringify({ network: 'XX', station: 'NEW', location: '', channel: 'HNE', stationKey: 'XX.NEW.--.HNE' });
      await element('waveform-station').change();
    } else {
      element('waveform-filter').value = '0.03, 0.1, 6, 8';
      await element('waveform-filter').change();
    }
    assert.equal(requests[0].options.signal.aborted, true, kind);
    requests[0].options.onProgress('Late progress must be ignored');
    requests[0].resolve(correctedRemoteData());
    await pending;
    assert.equal(app.state().currentWaveformData, null, kind);
    assert.equal(app.state().spectrumInputData, null, kind);
    assert.equal(app.state().currentSpectrumResult, null, kind);
    assert.equal(element('waveform-fetch-status').textContent, '', kind);
    assert.equal(element('btn-calc-spectrum').disabled, true, kind);
    assert.equal(element('btn-download-spectrum').disabled, true, kind);
    assert.equal(element('btn-cancel-waveform').disabled, true, kind);
    assert.ok(charts.every(chart => chart.destroyed), kind);
  }
});

test('a slow former station cannot overwrite a newer successful remote waveform or its enabled controls', async () => {
  const { app, element, WaveformViewer } = loadWaveformApp();
  const requests = pendingRemoteFetch(WaveformViewer);
  const oldPending = element('btn-show-waveform').click();
  element('waveform-station').value = JSON.stringify({ network: 'XX', station: 'NEW', location: '', channel: 'HNE', stationKey: 'XX.NEW.--.HNE' });
  await element('waveform-station').change();
  const newPending = element('btn-show-waveform').click();
  const current = correctedRemoteData('XX.NEW..HNE', 25);
  assert.equal(requests.length, 2);
  requests[1].resolve(current);
  await newPending;
  const status = element('waveform-fetch-status').textContent;
  requests[0].options.onProgress('Old processing result');
  requests[0].resolve(correctedRemoteData());
  await oldPending;
  assert.equal(app.state().currentWaveformData, current);
  assert.equal(app.state().spectrumInputData.acc, current.acc);
  assert.equal(app.state().spectrumInputData.meta._stationId, 'XX.NEW..HNE');
  assert.equal(element('waveform-fetch-status').textContent, status);
  assert.equal(element('btn-calc-spectrum').disabled, false);
  assert.equal(element('btn-show-waveform').disabled, false);
  assert.equal(element('btn-cancel-waveform').disabled, true);
});

test('cancel clears waveform and spectrum controls immediately and prevents late remote completion', async () => {
  const { app, element, charts, WaveformViewer } = loadWaveformApp();
  const requests = pendingRemoteFetch(WaveformViewer);
  const pending = element('btn-show-waveform').click();
  assert.equal(element('btn-show-waveform').disabled, true);
  await element('btn-cancel-waveform').click();
  assert.equal(requests[0].options.signal.aborted, true);
  assert.equal(app.state().currentWaveformData, null);
  assert.equal(app.state().spectrumInputData, null);
  assert.equal(app.state().currentSpectrumResult, null);
  assert.equal(element('btn-cancel-waveform').disabled, true);
  assert.equal(element('btn-show-waveform').disabled, false);
  assert.equal(element('btn-apply-waveform-view').disabled, true);
  assert.equal(element('btn-waveform-spectrum').disabled, true);
  assert.equal(element('btn-calc-spectrum').disabled, true);
  assert.equal(element('btn-download-spectrum').disabled, true);
  assert.match(element('waveform-fetch-status').textContent, /中止/);
  requests[0].options.onProgress('Too late');
  requests[0].resolve(correctedRemoteData());
  await pending;
  assert.equal(app.state().currentWaveformData, null);
  assert.equal(app.state().spectrumInputData, null);
  assert.match(element('waveform-fetch-status').textContent, /中止/);
  assert.ok(charts.every(chart => chart.destroyed));
});

test('low-rate remote records remain viewable while an empty usable period range disables and explains spectrum calculation', async () => {
  const { app, element, WaveformViewer, Spectrum, toasts, runTimers } = loadWaveformApp({ queueTimers: true });
  const data = correctedRemoteData('XX.TEST..LHZ');
  data.dt = 1;
  Object.assign(data.meta, { _dt: 1, _sampleRate: 1, _duration: 99, _analysisPeriodMin: 10, _analysisPeriodMax: 10,
    _filterLabel: '0.02 / 0.05 / 0.3 / 0.4 Hz' });
  WaveformViewer.fetchWaveformData = async () => data;
  await element('btn-show-waveform').click();
  assert.equal(app.state().currentWaveformData, data);
  assert.equal(app.state().spectrumInputData.acc, data.acc);
  assert.equal(element('btn-apply-waveform-view').disabled, false);
  assert.equal(element('btn-waveform-spectrum').disabled, true);
  assert.equal(element('btn-calc-spectrum').disabled, true);
  assert.equal(element('btn-download-spectrum').disabled, true);
  assert.match(element('spectrum-info').innerHTML, /周期/);
  assert.match(element('waveform-fetch-status').textContent, /周期/);
  assert.doesNotMatch(element('waveform-fetch-status').textContent, /応答スペクトルを計算できます/);
  let calculations = 0;
  Spectrum.computeSpectrum = () => { calculations++; throw new Error('must not enter solver'); };
  app.calculateSpectrumForLoadedData(); // Defensive guard also covers programmatic callers.
  runTimers();
  assert.equal(calculations, 0);
  assert.equal(app.state().currentSpectrumResult, null);
  assert.match(toasts.at(-1), /周期/);
});
