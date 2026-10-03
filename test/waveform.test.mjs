import assert from 'node:assert/strict';
import test from 'node:test';

import { createBrowserLikeContext, loadClassicScript } from './helpers/load-classic-script.mjs';

function loadWaveform(overrides = {}) {
  const context = createBrowserLikeContext(overrides);
  loadClassicScript('js/utils.js', 'AppUtils', context);
  return loadClassicScript('js/waveform.js', 'WaveformViewer', context).exported;
}

function asciiWaveform(unit = 'M/S**2', values = ['1', '-2'], { sampleType = 'FLOAT', identifier = 'XX.TEST.--.HNN.M' } = {}) {
  const header = `TIMESERIES ${identifier}, ${values.length} samples, 100 sps, 2026-01-01T00:00:00.000, TSPAIR, ${sampleType}, ${unit}`;
  return [header, ...values.map((value, index) => `2026-01-01T00:00:00.${String(index * 10).padStart(3, '0')} ${value}`)].join('\n');
}

test('known acceleration units use explicit conversion factors and retain their evidence', () => {
  const WaveformViewer = loadWaveform();
  const units = [
    ['gal', 'gal', 1], ['M/S**2', 'm/s²', 100], ['m/s²', 'm/s²', 100],
    ['CM/S^2', 'cm/s²', 1], ['mm/sec/sec', 'mm/s²', 0.1],
    ['UM/S2', 'µm/s²', 0.0001], ['µm/s²', 'µm/s²', 0.0001], ['μm/s²', 'µm/s²', 0.0001],
    ['NM/S**2', 'nm/s²', 0.0000001],
    ['g', 'g', 980.665], ['mg', 'mg', 0.980665],
    ['ug', 'µg', 0.000980665], ['µg', 'µg', 0.000980665], ['μg', 'µg', 0.000980665],
  ];
  for (const [reported, canonical, factor] of units) {
    const source = asciiWaveform(reported);
    const data = WaveformViewer.parseWaveformText(source, { sourceName: 'local fixture' });
    assert.deepEqual(Array.from(data.acc), [factor, -2 * factor], reported);
    assert.equal(data.meta._maxAcc, 2 * factor, reported);
    assert.equal(data.meta._inputUnitReported, reported);
    assert.equal(data.meta._inputUnit, canonical);
    assert.equal(data.meta._conversionToGal, factor);
    assert.equal(data.meta._unitVerified, true);
    assert.equal(data.meta._unitEvidence, 'header');
    assert.equal(data.meta._displayUnit, 'gal');
    assert.equal(data.meta._rawHeader, source.split('\n')[0]);
    assert.equal(data.meta._source, 'local fixture');
    assert.equal(data.meta._stationId, 'XX.TEST.--.HNN');
    assert.equal(data.meta._responseCorrectionRequested, false);
    assert.match(data.meta._filterLabel, /未確認/);
    assert.equal(WaveformViewer.validateAccelerationData(data), true);
  }
});

test('unknown or non-acceleration units are rejected regardless of requested correction and sample type', () => {
  const WaveformViewer = loadWaveform();
  for (const unit of ['COUNTS', 'ACC', 'unknown', '', 'M/S', 'M', 'V', '%g', 'GARBAGE']) {
    for (const sampleType of ['INTEGER', 'FLOAT', 'DOUBLE', 'REAL']) {
      const context = { requestedUnit: 'ACC', responseCorrected: true };
      assert.equal(WaveformViewer.getAccelerationUnitInfo({ reportedUnit: unit, ...context, sampleType }), null);
      assert.throws(() => WaveformViewer.parseWaveformText(asciiWaveform(unit, ['1', '-2'], { sampleType }), context), /単位/);
    }
  }
  const parsed = WaveformViewer.parseWaveformText(asciiWaveform('gal'), { responseCorrected: 'false' });
  assert.equal(parsed.meta._responseCorrectionRequested, false);
  assert.doesNotMatch(parsed.meta._source, /補正済み/);
});

test('ASCII2 requires a complete and valid seven-field header', () => {
  const WaveformViewer = loadWaveform();
  const source = asciiWaveform();
  const malformed = [
    source.replace(/^.*\n/, 'TIMESERIES anything, GAL\n'),
    source.replace('M/S**2\n', 'COUNTS, M/S**2\n'),
    source.replace('TIMESERIES XX.TEST.--.HNN.M', 'TIMESERIESINVALID XX.TEST.--.HNN.M'),
    source.replace('XX.TEST.--.HNN.M', 'unknown'),
    ...['0', '1', '-2', '2.5', 'NaN', 'Infinity', '9007199254740992'].map(value => source.replace('2 samples', `${value} samples`)),
    ...['0', '-100', '100.0.1', 'NaN', 'Infinity', '1e999'].map(value => source.replace('100 sps', `${value} sps`)),
    source.replace('2026-01-01T00:00:00.000,', '2026-02-30T00:00:00.000,'),
    source.replace('2026-01-01T00:00:00.000,', '2026-01-01T25:00:00.000,'),
    source.replace('TSPAIR', 'SLIST'),
    source.replace('FLOAT', 'TEXT'),
  ];
  for (const text of malformed) {
    assert.throws(() => WaveformViewer.parseWaveformText(text), /ヘッダー/, text.split('\n')[0]);
  }
});

test('ASCII2 values must be complete finite numeric tokens before and after conversion', () => {
  const WaveformViewer = loadWaveform();
  for (const value of ['NaN', 'Infinity', '-Infinity', '2garbage', '1e999', '1e308', '0x10', '2 3']) {
    assert.throws(() => WaveformViewer.parseWaveformText(asciiWaveform('M/S**2', ['1', value])), /加速度値/, value);
  }
  const data = WaveformViewer.parseWaveformText(asciiWaveform('gal', ['+.5', '-2e-3']));
  assert.deepEqual(Array.from(data.acc), [0.5, -0.002]);
});

test('finite sampling intervals cannot overflow the record duration', () => {
  const WaveformViewer = loadWaveform();
  const source = asciiWaveform('gal', ['1', '-2', '3']).replace('100 sps', '1e-308 sps');
  assert.ok(Number.isFinite(1 / 1e-308));
  assert.throws(() => WaveformViewer.parseWaveformText(source), /継続時間は有限値/);
});

test('returned NSLC matches the request while blank location aliases are equivalent', () => {
  const WaveformViewer = loadWaveform();
  const station = { network: 'XX', station: 'TEST', location: '', channel: 'HNN' };
  for (const identifier of ['XX_TEST__HNN_M', 'XX.TEST.--.HNN.M']) {
    assert.equal(WaveformViewer.parseWaveformText(asciiWaveform('gal', ['1', '-2'], { identifier }), { station }).meta._stationId, 'XX.TEST.--.HNN');
  }
  for (const identifier of ['YY_TEST__HNN_M', 'XX_OTHER__HNN_M', 'XX_TEST_00_HNN_M', 'XX_TEST__HNE_M']) {
    assert.throws(() => WaveformViewer.parseWaveformText(asciiWaveform('gal', ['1', '-2'], { identifier }), { station }), /要求と一致/);
  }
});

test('acceleration validation rejects absent, contradictory, and non-finite evidence', () => {
  const WaveformViewer = loadWaveform();
  const data = WaveformViewer.parseWaveformText(asciiWaveform());
  for (const update of [
    { _unitVerified: false }, { _unitEvidence: 'request' }, { _displayUnit: 'm/s²' },
    { _inputUnitReported: 'COUNTS' }, { _inputUnit: 'gal' }, { _conversionToGal: 1 },
  ]) {
    assert.throws(() => WaveformViewer.validateAccelerationData({ ...data, meta: { ...data.meta, ...update } }), /換算根拠/);
  }
  assert.throws(() => WaveformViewer.validateAccelerationData({ ...data, meta: undefined }), /換算根拠/);
  assert.throws(() => WaveformViewer.validateAccelerationData({ ...data, acc: [0, Infinity] }), /有限値/);
  assert.throws(() => WaveformViewer.validateAccelerationData({ ...data, dt: 0 }), /サンプリング間隔/);
  assert.equal(WaveformViewer.validateAccelerationData(WaveformViewer.sliceWaveformData(data)), true);
});

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

test('station metadata recognizes both ScaleFrequency and legacy ScaleFreq column names', async () => {
  for (const frequencyHeader of ['ScaleFrequency', 'ScaleFreq']) {
    const WaveformViewer = loadWaveform({ fetch: async () => ({
      ok: true, status: 200,
      text: async () => `#Network|Station|Location|Channel|Latitude|Longitude|${frequencyHeader}\nXX|TEST||HNN|35|139|1.5`,
    }) });
    const result = await WaveformViewer.searchStations(35, 139);
    assert.equal(result.stations[0].scaleFreq, '1.5');
    assert.equal(result.candidateCount, 1);
    assert.equal(result.checkedCount, 0);
    assert.equal(result.availableCount, 0);
  }
});

test('remote waveform path uses the selected provider and validates returned acceleration', async () => {
  const calls = [];
  let data;
  const WaveformViewer = loadWaveform({ RemoteWaveform: { load: async (...args) => { calls.push(args); return data; } } });
  data = WaveformViewer.parseWaveformText(asciiWaveform('GAL'));
  const station = { network: 'XX', station: 'TEST', channel: 'HNN', _datacenter: 'geofon' };
  await WaveformViewer.fetchWaveformData(station, '2026-01-01T00:00:00', '2026-01-01T00:00:01');
  assert.equal(calls[0][3].dataUrl, 'https://geofon.gfz.de/fdsnws/dataselect/1/query');
  await WaveformViewer.fetchWaveformData({...station, _datacenter:'iris'}, '2026-01-01T00:00:00', '2026-01-01T00:00:01');
  assert.equal(calls.length, 2, 'data center must be part of cache identity');
  data = {...data,meta:{...data.meta,_inputUnitReported:'COUNTS'}};
  await assert.rejects(WaveformViewer.fetchWaveformData(station, '2026-01-01T00:00:00', '2026-01-01T00:00:02'), /換算根拠/);
});

test('raw miniSEED and response-correction evidence are distinct from an acceleration file header', () => {
  const WaveformViewer = loadWaveform();
  const data = WaveformViewer.parseWaveformText(asciiWaveform());
  data.meta._unitEvidence = 'stationxml-response';
  assert.throws(() => WaveformViewer.validateAccelerationData(data), /換算根拠/);
  Object.assign(data.meta, {_responseCorrectionApplied:true, _processing:{outputUnits:'M/S**2'}, _responseUrl:'https://example.org/station'});
  assert.equal(WaveformViewer.validateAccelerationData(data), true);
  assert.match(WaveformViewer.getWaveformDataURL({network:'IU',station:'ANMO',location:'00',channel:'BHZ'},'2010-01-01','2010-01-02'), /earthscope\.org\/fdsnws\/dataselect/);
  assert.equal(WaveformViewer.getWaveformImageURL(), '');
});

test('local waveform display shows the conversion and original header without correction claims or remote links', () => {
  const container = { innerHTML: '' };
  const WaveformViewer = loadWaveform({
    document: { getElementById: id => id === 'waveform' ? container : {} },
    Chart: class { destroy() {} },
  });
  const parsed = WaveformViewer.parseWaveformText(asciiWaveform('g'), { sourceName: 'ローカルファイル: quake.txt' });
  WaveformViewer.renderWaveform(parsed, 'waveform');
  assert.match(container.innerHTML, /入力値 \(g\) × 980\.665/);
  assert.ok(container.innerHTML.includes(parsed.meta._rawHeader));
  assert.match(container.innerHTML, /計器補正・校正の実施や精度を検証したものではありません/);
  assert.doesNotMatch(container.innerHTML, /補正済み|href=/);
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

test('station metadata and response links use the station search datacenter', async () => {
  const requestedUrls = [];
  const WaveformViewer = loadWaveform({
    fetch: async url => {
      requestedUrls.push(new URL(url));
      return {
        ok: true,
        status: 200,
        text: async () => '#Network|Station|SiteName\nNZ|TEST|GeoNet test site',
      };
    },
  });
  const station = {
    network: 'NZ', station: 'TEST', location: '', channel: 'HNN',
    stationKey: 'NZ.TEST.--.HNN', _datacenter: 'geonet',
  };
  const info = await WaveformViewer.fetchStationPublicInfo(station, Date.UTC(2026, 0, 1));

  assert.equal(requestedUrls[0].origin, 'https://service.geonet.org.nz');
  assert.equal(info.siteRow.SiteName, 'GeoNet test site');
  assert.equal(info.datacenterLabel, 'GeoNet');
  for (const url of Object.values(info.urls)) {
    assert.equal(new URL(url).origin, 'https://service.geonet.org.nz');
    assert.equal(new URL(url).searchParams.get('net'), 'NZ');
  }
  assert.equal(new URL(info.urls.responseXmlUrl).searchParams.get('level'), 'response');
  assert.equal(new URL(info.urls.responseXmlUrl).searchParams.get('format'), 'xml');
});

test('station metadata cache does not share records across datacenters', async () => {
  let requestCount = 0;
  const WaveformViewer = loadWaveform({
    fetch: async url => {
      requestCount += 1;
      const provider = new URL(url).hostname;
      return {
        ok: true,
        status: 200,
        text: async () => `#Network|Station|SiteName\nNZ|TEST|${provider}`,
      };
    },
  });
  const station = {
    network: 'NZ', station: 'TEST', location: '', channel: 'HNN',
    stationKey: 'NZ.TEST.--.HNN',
  };
  const eventTime = Date.UTC(2026, 0, 1);
  const irisInfo = await WaveformViewer.fetchStationPublicInfo(station, eventTime);
  const geoNetStation = { ...station, _datacenter: 'geonet' };
  const geoNetInfo = await WaveformViewer.fetchStationPublicInfo(geoNetStation, eventTime);
  const cachedGeoNetInfo = await WaveformViewer.fetchStationPublicInfo(geoNetStation, eventTime);

  assert.equal(irisInfo.siteRow.SiteName, 'service.earthscope.org');
  assert.equal(geoNetInfo.siteRow.SiteName, 'service.geonet.org.nz');
  assert.equal(cachedGeoNetInfo, geoNetInfo);
  assert.equal(requestCount, 2);
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

test('header time mismatch and calendar-normalized sample dates prevent timing verification', () => {
  const WaveformViewer = loadWaveform();
  const mismatch = WaveformViewer.parseWaveformText(asciiWaveform().replace('2026-01-01T00:00:00.000,', '2026-01-02T00:00:00.000,'));
  assert.equal(mismatch.meta._hasTimingGap, true);
  assert.ok(mismatch.meta._timingIssues.some(issue => /開始日時と先頭サンプル/.test(issue)));

  const overflow = WaveformViewer.parseWaveformText(asciiWaveform().replace('2026-01-01T00:00:00.010 -2', '2026-02-30T00:00:00.010 -2'));
  assert.equal(overflow.meta._hasTimingGap, true);
  assert.ok(overflow.meta._timingIssues.some(issue => /時刻を解析できませんでした/.test(issue)));
});

test('timing checks catch one missing sample through 1000 Hz and cumulative clock drift', () => {
  const WaveformViewer = loadWaveform();
  const series = (rate, fractions) => [
    `TIMESERIES XX.TEST.--.HNN.M, ${fractions.length} samples, ${rate} sps, 2026-01-01T00:00:00.000000, TSPAIR, FLOAT, GAL`,
    ...fractions.map(fraction => `2026-01-01T00:00:00.${fraction} 1`),
  ].join('\n');
  for (const [rate, fractions] of [
    [1000, ['000000', '002000', '003000']],
    [800, ['000000', '002500', '003750']],
    [500, ['000000', '004000', '006000']],
    [100, ['000000', '020000', '030000']],
  ]) {
    assert.equal(WaveformViewer.parseWaveformText(series(rate, fractions)).meta._hasTimingGap, true, `${rate} Hz missing sample`);
  }
  assert.equal(WaveformViewer.parseWaveformText(series(1000, ['000000', '001000', '002000'])).meta._hasTimingGap, false);
  assert.equal(WaveformViewer.parseWaveformText(series(800, ['000000', '001250', '002500', '003750'])).meta._hasTimingGap, false);
  assert.equal(WaveformViewer.parseWaveformText(series(300, ['000000', '003333', '006667', '010000'])).meta._hasTimingGap, false);
  assert.equal(WaveformViewer.parseWaveformText(series(100, ['000000', '010001', '020002'])).meta._hasTimingGap, true);
  assert.equal(WaveformViewer.parseWaveformText(series(1000, ['000', '001', '002', '004'])).meta._hasTimingGap, true);
  const unsupported = WaveformViewer.parseWaveformText(series(2000, ['000000', '000500', '001000']));
  assert.equal(unsupported.meta._hasTimingGap, true);
  assert.ok(unsupported.meta._timingIssues.some(issue => /1000 Hz/.test(issue)));
  for (const rate of [20, 40, 100]) {
    const fractions = Array.from({ length: 5 }, (_, index) => String(19538 + index * 1000000 / rate).padStart(6, '0'));
    const source = series(rate, fractions).replace('2026-01-01T00:00:00.000000,', '2026-01-01T00:00:00.019538,');
    assert.equal(WaveformViewer.parseWaveformText(source).meta._hasTimingGap, false, `${rate} Hz fractional start`);
  }
});

test('waveform chart visibly explains timing issues and the declared-dt horizontal axis', () => {
  const container = { innerHTML: '' };
  const WaveformViewer = loadWaveform({
    document: { getElementById: id => id === 'waveform' ? container : {} },
    Chart: class { destroy() {} },
  });
  const parsed = WaveformViewer.parseWaveformText(asciiWaveform().replace('00:00:00.010 -2', '00:00:00.020 -2'));
  WaveformViewer.renderWaveform(parsed, 'waveform');
  assert.match(container.innerHTML, /応答スペクトルは計算できません/);
  assert.match(container.innerHTML, /横軸はヘッダーのサンプリング間隔/);
  assert.ok(container.innerHTML.includes(parsed.meta._timingIssues[0]));
});

test('waveform viewer preserves isolated positive and negative peaks when reducing a long plot', () => {
  let configuration;
  const container = { innerHTML: '' };
  const WaveformViewer = loadWaveform({
    document: { getElementById: id => id === 'waveform' ? container : {} },
    Chart: class { constructor(_canvas, config) { configuration = config; } },
  });
  const data = WaveformViewer.parseWaveformText(asciiWaveform('GAL'));
  data.acc = new Array(8001).fill(0);
  data.acc[1] = 500;
  data.acc[2] = -750;
  Object.assign(data.meta, { _npts: data.acc.length, _duration: 80, _maxAcc: 750 });
  WaveformViewer.renderWaveform(data, 'waveform');
  const points = configuration.data.datasets[0].data;
  assert.ok(points.length <= 4000);
  assert.ok(points.some(point => point.x === 0.01 && point.y === 500));
  assert.ok(points.some(point => point.x === 0.02 && point.y === -750));
  assert.equal(points.at(-1).x, 80);
});
