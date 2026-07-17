import assert from 'node:assert/strict';
import test from 'node:test';

import { createBrowserLikeContext, loadClassicScript } from './helpers/load-classic-script.mjs';

function loadWaveform(overrides = {}) {
  const context = createBrowserLikeContext(overrides);
  loadClassicScript('js/utils.js', 'AppUtils', context);
  return loadClassicScript('js/waveform.js', 'WaveformViewer', context).exported;
}

test('station search requests strong-motion and broadband channel families', async () => {
  let requestedUrl = '';
  const WaveformViewer = loadWaveform({
    fetch: async url => {
      requestedUrl = String(url);
      return { ok: false, status: 404, text: async () => '' };
    },
  });

  const result = await WaveformViewer.searchStations(35, 139, 5, Date.UTC(2026, 0, 1));
  const query = new URL(requestedUrl).searchParams;
  assert.equal(query.get('channel'), 'HN?,BN?,EN?,HH?,BH?');
  assert.deepEqual({
    candidateCount: result.candidateCount,
    checkedCount: result.checkedCount,
    availableCount: result.availableCount,
  }, { candidateCount: 0, checkedCount: 0, availableCount: 0 });
});

test('strong-motion horizontal channels are prioritized at equal distance', () => {
  const WaveformViewer = loadWaveform();
  assert.ok(WaveformViewer.channelPriority('HNN') < WaveformViewer.channelPriority('HHN'));
  assert.ok(WaveformViewer.channelPriority('HNE') < WaveformViewer.channelPriority('HNZ'));
});

test('station metadata fetch remains cancellable while its response body is pending', async () => {
  let bodyStarted;
  const bodyStartPromise = new Promise(resolve => { bodyStarted = resolve; });
  const WaveformViewer = loadWaveform({
    fetch: async (_url, { signal }) => ({
      ok: true,
      status: 200,
      text: () => {
        bodyStarted();
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          }, { once: true });
        });
      },
    }),
  });
  const controller = new AbortController();
  const station = {
    network: 'XX',
    station: 'TEST',
    location: '',
    channel: 'HNN',
    stationKey: 'XX.TEST.--.HNN',
  };
  const request = WaveformViewer.fetchStationPublicInfo(station, Date.UTC(2026, 0, 1), {
    signal: controller.signal,
    timeoutMs: 1000,
  });

  await bodyStartPromise;
  controller.abort();
  await assert.rejects(request, error => error?.name === 'AbortError');
});

test('waveform slicing handles large arrays and preserves requested range metadata', () => {
  const WaveformViewer = loadWaveform();
  const data = {
    acc: new Array(150_000).fill(1),
    dt: 0.01,
    meta: { _duration: 1499.99, _dt: 0.01 },
  };
  data.acc[1_500] = -200;

  const sliced = WaveformViewer.sliceWaveformData(data, 10, 20);
  assert.equal(sliced.meta._analysisWindowStart, 10);
  assert.equal(sliced.meta._analysisWindowEnd, 20);
  assert.equal(sliced.meta._maxAcc, 200);
  assert.equal(sliced.acc.length, 1001);
});

test('waveform slicing excludes non-grid samples outside the requested range', () => {
  const WaveformViewer = loadWaveform();
  const data = {
    acc: [0, 999, 10, -20, 888, 0],
    dt: 0.06,
    meta: { _duration: 0.30, _dt: 0.06 },
  };
  const sliced = WaveformViewer.sliceWaveformData(data, 0.10, 0.20);

  assert.deepEqual(Array.from(sliced.acc), [10, -20]);
  assert.equal(sliced.meta._requestedWindowStart, 0.10);
  assert.equal(sliced.meta._requestedWindowEnd, 0.20);
  assert.equal(sliced.meta._analysisWindowStart, 0.12);
  assert.equal(sliced.meta._analysisWindowEnd, 0.18);
});

test('renderWaveform honors the public {start, end} range contract', () => {
  const elements = new Map([
    ['waveform', { innerHTML: '' }],
    ['waveform-canvas', {}],
  ]);
  let chartConfig = null;
  const WaveformViewer = loadWaveform({
    document: { getElementById: id => elements.get(id) || null },
    Chart: class {
      constructor(_canvas, config) { chartConfig = config; }
      destroy() {}
    },
  });
  const data = {
    acc: new Array(101).fill(1),
    dt: 0.1,
    meta: {
      _duration: 10,
      _dt: 0.1,
      _stationId: 'XX.TEST.--.HNN',
      _displayUnit: 'gal',
      _filterLabel: 'なし',
      _source: 'test',
      _inputUnit: 'gal',
      _inputUnitReported: 'gal',
    },
  };

  const range = WaveformViewer.renderWaveform(data, 'waveform', { start: 2, end: 4 });
  assert.deepEqual({ start: range.start, end: range.end }, { start: 2, end: 4 });
  assert.equal(chartConfig.options.scales.x.min, 2);
  assert.equal(chartConfig.options.scales.x.max, 4);
  assert.equal(chartConfig.data.datasets[0].data[0].x, 2);
});

test('waveform parser flags timing gaps instead of compressing them silently', () => {
  const WaveformViewer = loadWaveform();
  const text = [
    'TIMESERIES XX.TEST.--.HNN.M, 3 samples, 100 sps, 2026-01-01T00:00:00.000, TSPAIR, FLOAT, M/S**2',
    '2026-01-01T00:00:00.000 0.1',
    '2026-01-01T00:00:00.010 0.2',
    '2026-01-01T00:00:00.050 0.3',
  ].join('\n');

  const parsed = WaveformViewer.parseWaveformText(text, {
    requestedUnit: 'ACC',
    responseCorrected: true,
  });
  assert.equal(parsed.meta._hasTimingGap, true);
  assert.equal(parsed.meta._maxAcc, 30);
});

test('waveform parser flags invalid timestamps and declared sample-count mismatches', () => {
  const WaveformViewer = loadWaveform();
  const text = [
    'TIMESERIES XX.TEST.--.HNN.M, 4 samples, 100 sps, 2026-01-01T00:00:00.000, TSPAIR, FLOAT, M/S**2',
    '2026-01-01T00:00:00.000 0.1',
    'bad-time 0.2',
    '2026-01-01T00:00:00.020 0.3',
  ].join('\n');

  const parsed = WaveformViewer.parseWaveformText(text, {
    requestedUnit: 'ACC',
    responseCorrected: true,
  });
  assert.equal(parsed.meta._hasTimingGap, true);
  assert.equal(parsed.meta._sampleCountHeader, 4);
  assert.equal(parsed.meta._npts, 3);
  assert.ok(parsed.meta._timingIssues.length >= 2);
});
