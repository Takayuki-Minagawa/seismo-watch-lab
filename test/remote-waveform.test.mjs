import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { DOMParser } from './vendor/xmldom-0.9.12/lib/index.js';
import { createBrowserLikeContext, loadClassicScript } from './helpers/load-classic-script.mjs';

const station = { network: 'XX', station: 'TEST', location: '', channel: 'HNZ' };
const datacenter = { label: 'Public Test', dataUrl: 'https://example.org/fdsnws/dataselect/1/query',
  stationUrl: 'https://example.org/fdsnws/station/1/query' };
const start = '2026-10-03T00:00:00', end = '2026-10-03T00:01:00';
const trace = { samples: new Float64Array(8), sampleRate: 100, id: 'XX.TEST..HNZ',
  startMs: Date.parse(`${start}Z`), endMs: Date.parse(`${start}Z`) + 70, startTime: `${start}.000000Z` };

function harness(options = {}) {
  const fetchCalls = [], workers = [], progress = [];
  const context = createBrowserLikeContext({
    TextDecoder, DOMParser,
    fetch: options.fetch || (async (url, init) => { fetchCalls.push({ url, init }); return new Response(new Uint8Array([1, 2, 3])); }),
    MiniSeedDecoder: { decode: options.decode || (() => trace) },
    InstrumentResponse: { parseStationXML: () => ({ sampleRate: 100 }) },
    Worker: class {
      constructor(url) { this.url = url; workers.push(this); }
      terminate() { this.terminated = true; }
      postMessage(data) {
        this.sent = data;
        if (options.silentWorker) return;
        queueMicrotask(() => {
          if (this.terminated) return;
          const result = options.correct
            ? options.correct(data, context)
            : { acceleration: new Float64Array([0, 0.5, -1, 2, 0, 0, 0, 0]), processing: { stageCount: 2 } };
          this.onmessage({ data: result });
        });
      }
    },
    ...options.globals,
  });
  loadClassicScript('js/utils.js', 'AppUtils', context);
  const remote = loadClassicScript('js/remote-waveform.js', 'RemoteWaveform', context).exported;
  return { remote, context, fetchCalls, workers, progress,
    load: (loadOptions = {}) => remote.load(station, start, end, datacenter, { onProgress: message => progress.push(message), ...loadOptions }) };
}

test('FDSN requests preserve exact NSLC and times, request full response, and omit credentials', async () => {
  const { load, fetchCalls, workers } = harness();
  await load();
  assert.equal(fetchCalls.length, 2);
  for (const request of fetchCalls) {
    const url = new URL(request.url);
    assert.equal(url.searchParams.get('net'), 'XX');
    assert.equal(url.searchParams.get('loc'), '--');
    assert.equal(url.searchParams.get('starttime'), start);
    assert.equal(request.init.credentials, 'omit');
    assert.equal(request.init.cache, 'no-store');
  }
  assert.equal(new URL(fetchCalls[1].url).searchParams.get('level'), 'response');
  assert.equal(workers[0].url, 'js/waveform-worker.js');
  assert.equal(workers[0].terminated, true);
});

test('corrected SI acceleration converts once to gal with provenance accepted by waveform validation', async () => {
  const { load, context, progress } = harness();
  const data = await load();
  assert.deepEqual(Array.from(data.acc), [0, 50, -100, 200, 0, 0, 0, 0]);
  assert.equal(data.dt, 0.01);
  assert.equal(data.meta._maxAcc, 200);
  assert.equal(data.meta._conversionToGal, 100);
  assert.equal(data.meta._unitEvidence, 'stationxml-response');
  assert.equal(data.meta._responseCorrectionApplied, true);
  assert.equal(data.meta._processing.outputUnits, 'M/S**2');
  assert.equal(data.meta._processing.stageCount, 2);
  assert.equal(data.meta._analysisPeriodMin, 0.1);
  assert.equal(data.meta._analysisPeriodMax, 10);
  assert.equal(progress.length, 3);
  const viewer = loadClassicScript('js/waveform.js', 'WaveformViewer', context).exported;
  assert.equal(viewer.validateAccelerationData(data), true);
  assert.throws(() => viewer.validateAccelerationData({ ...data, meta: { ...data.meta, _responseCorrectionApplied: false } }), /換算根拠/);
});

test('HTTP no-data, authentication, size, and server failures remain actionable', async () => {
  for (const [status, expected] of [[204, /ありません/], [404, /ありません/], [401, /認証/], [403, /認証/], [413, /取得上限/], [503, /503/]]) {
    const h = harness({ fetch: async () => new Response(null, { status }) });
    await assert.rejects(h.load(), expected);
    assert.equal(h.workers.length, 0);
  }
  await assert.rejects(harness({ fetch: async () => { throw new TypeError('Failed to fetch'); } }).load(), /CORS/);
});

test('streaming download size bound cancels the reader instead of buffering a large response', async () => {
  let cancelled = false, released = false, reads = 0;
  const h = harness({ fetch: async () => ({ status: 200, ok: true, headers: new Headers(), body: {
    getReader: () => ({
      async read() { reads++; return { done: false, value: new Uint8Array(3) }; },
      async cancel() { cancelled = true; }, releaseLock() { released = true; },
    }),
  } }) });
  await assert.rejects(h.remote.fetchBytes(datacenter.dataUrl, { maxBytes: 4 }), /上限/);
  assert.equal(reads, 2);
  assert.equal(cancelled, true);
  assert.equal(released, true);
});

test('declared and unstreamed response sizes cannot bypass the download bound', async () => {
  let read = false;
  let h = harness({ fetch: async () => ({ status: 200, ok: true, headers: new Headers({ 'content-length': '50' }),
    async arrayBuffer() { read = true; return new ArrayBuffer(50); } }) });
  await assert.rejects(h.remote.fetchBytes(datacenter.dataUrl, { maxBytes: 4 }), /上限/);
  assert.equal(read, false);
  h = harness({ fetch: async () => ({ status: 200, ok: true, headers: new Headers(),
    async arrayBuffer() { return new ArrayBuffer(5); } }) });
  await assert.rejects(h.remote.fetchBytes(datacenter.dataUrl, { maxBytes: 4 }), /上限/);
});

test('network abort preserves the cancellation reason and cancels both requests', async () => {
  const signals = [];
  const h = harness({ fetch: (url, { signal }) => new Promise((resolve, reject) => {
    signals.push(signal);
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }) });
  const controller = new AbortController();
  const pending = h.load({ signal: controller.signal });
  const reason = new DOMException('New station selected', 'AbortError');
  controller.abort(reason);
  await assert.rejects(pending, error => error === reason);
  assert.equal(signals.length, 2);
  assert.ok(signals.every(signal => signal.aborted));
});

test('timeout aborts pending network requests and also terminates stalled correction workers', async () => {
  const network = harness({ fetch: (url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }) });
  await assert.rejects(network.load({ timeoutMs: 5 }), /タイムアウト/);
  const correction = harness({ silentWorker: true });
  await assert.rejects(correction.load({ timeoutMs: 5 }), /タイムアウト/);
  assert.equal(correction.workers[0].terminated, true);
});

test('abort while correcting terminates worker and refuses a late success', async () => {
  const h = harness({ silentWorker: true });
  const controller = new AbortController();
  const pending = h.load({ signal: controller.signal });
  // Give streaming response consumption time to reach worker dispatch.
  for (let i = 0; i < 20 && !h.workers.length; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.workers.length, 1);
  controller.abort(new DOMException('Superseded', 'AbortError'));
  await assert.rejects(pending, /Superseded/);
  assert.equal(h.workers[0].terminated, true);
  h.workers[0].onmessage({ data: { acceleration: new Float64Array(8), processing: {} } });
});

test('request interval mismatches, sample bounds, and invalid corrected samples reject before display', async () => {
  await assert.rejects(harness({ decode: () => ({ ...trace, startMs: 0, endMs: 1 }) }).load(), /要求期間/);
  await assert.rejects(harness({ decode: () => ({ ...trace, sampleRate: 1001 }) }).load(), /処理上限/);
  await assert.rejects(harness({ decode: () => ({ ...trace, samples: new Float64Array(500001) }) }).load(), /処理上限/);
  for (const acceleration of [new Float64Array(7), new Float64Array([NaN, 0, 0, 0, 0, 0, 0, 0]), new Float64Array([1e308, 0, 0, 0, 0, 0, 0, 0])]) {
    await assert.rejects(harness({ correct: () => ({ acceleration, processing: {} }) }).load(), /加速度が不正/);
  }
  await assert.rejects(harness({ correct: () => ({ error: 'Unsupported response stage' }) }).load(), /Unsupported/);
});

test('invalid datacenter cannot leave a timeout or abort listener allocated', async () => {
  const timers = new Set();
  let added = 0, removed = 0;
  const h = harness({ globals: {
    setTimeout: callback => { timers.add(callback); return callback; }, clearTimeout: callback => timers.delete(callback),
  } });
  const signal = { aborted: false, addEventListener() { added++; }, removeEventListener() { removed++; } };
  await assert.rejects(h.remote.load(station, start, end, {}, { signal }), /未設定/);
  assert.equal(timers.size, 0);
  assert.equal(added, removed);
});

test('real miniSEED and full StationXML complete the acquisition-to-spectrum pipeline without manual files', async () => {
  const raw = readFileSync(new URL('./fixtures/miniseed/earthscope.mseed', import.meta.url));
  const xml = readFileSync(new URL('./fixtures/instrument-response/earthscope.xml', import.meta.url));
  const h = harness({
    fetch: async url => new Response(url.includes('/station/') ? xml : raw),
    correct: (data, context) => context.RealResponse.correct(data.samples, data.sampleRate, data.response, { preFilter: data.preFilter, taperFraction: 0.05 }),
  });
  loadClassicScript('vendor/seisplotjs-3.2.7/seedcodec.js', 'SeedCodec', h.context);
  h.context.MiniSeedDecoder = loadClassicScript('js/miniseed.js', 'MiniSeedDecoder', h.context).exported;
  h.context.RealResponse = loadClassicScript('js/instrument-response.js', 'InstrumentResponse', h.context).exported;
  h.context.InstrumentResponse = h.context.RealResponse;
  const data = await h.remote.load({ network: 'IU', station: 'ANMO', location: '00', channel: 'BHZ' },
    '2010-02-27T06:30:00', '2010-02-27T06:35:00', datacenter);
  assert.equal(data.acc.length, 6000);
  assert.equal(data.dt, 0.05);
  assert.equal(data.meta._processing.stageCount, 3);
  assert.equal(data.meta._startTime, '2010-02-27T06:30:00.019538Z');
  assert.ok(data.meta._maxAcc > 0 && data.meta._maxAcc < 10);
  const viewer = loadClassicScript('js/waveform.js', 'WaveformViewer', h.context).exported;
  assert.equal(viewer.validateAccelerationData(data), true);
  const spectrum = loadClassicScript('js/spectrum.js', 'Spectrum', h.context).exported;
  const result = spectrum.computeSpectrum(data.acc, data.dt, {
    periodMin: data.meta._analysisPeriodMin, periodMax: data.meta._analysisPeriodMax, periodCount: 20,
  });
  assert.equal(result.periods.length, 21); // Includes the T=0 PGA point.
  assert.equal(result.periods[0], 0);
  assert.ok(result.periods[1] >= 0.5);
});
