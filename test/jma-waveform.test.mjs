import assert from 'node:assert/strict';
import test from 'node:test';
import { DOMParser } from './vendor/xmldom-0.9.12/lib/index.js';
import { createBrowserLikeContext, loadClassicScript } from './helpers/load-classic-script.mjs';

function loadJma(overrides = {}) {
  const context = createBrowserLikeContext({ DOMParser, TextDecoder, ...overrides });
  loadClassicScript('js/utils.js', 'AppUtils', context);
  const viewer = loadClassicScript('js/waveform.js', 'WaveformViewer', context).exported;
  return { jma: loadClassicScript('js/jma-waveform.js', 'JmaWaveform', context).exported, viewer };
}

const indexHtml = '<html><body><a href="2401011610_noto/index.html">2024年１月１日16時10分 能登</a>'
  + '<a href="2401011612_noto/index.html">2024年１月１日16時12分 余震</a>'
  + '<a href="https://other.invalid/event.html">2024年１月１日16時10分 偽リンク</a></body></html>';
const eventHtml = '<html><body><p>北緯37度29.7分 東経137度16.2分</p>'
  + '<ul><li>一部の時刻精度に異常が認められます。</li></ul><table>'
  + '<tr><th>都道府県</th><th>観測点名</th><th>最大加速度</th><th>震央距離（km）</th></tr>'
  + '<tr><td>石川県</td><td>合成テスト観測点</td><td>7</td><td>123</td><td>50.2</td>'
  + '<td><a href="wave/wav123.png">波形</a></td><td><a href="data/acc123.csv">ダウンロード</a></td></tr>'
  + '<tr><td>県</td><td>遠方観測点</td><td>1</td><td>1</td><td>999</td>'
  + '<td><a href="wave/remote.png">波形</a></td><td><a href="data/remote.csv">ダウンロード</a></td></tr>'
  + '<tr><td>県</td><td>外部リンク</td><td>1</td><td>1</td><td>2</td>'
  + '<td></td><td><a href="https://other.invalid/acc.csv">ダウンロード</a></td></tr>'
  + '</table></body></html>';
const station = {
  network: 'JMA', station: 'acc123', channel: 'NS', _datacenter: 'jma', name: '合成テスト観測点',
  _csvUrl: 'https://www.data.jma.go.jp/eqev/data/kyoshin/jishin/2401011610_noto/data/acc123.csv',
  _eventTime: Date.UTC(2024, 0, 1, 7, 10),
};
function csv(values = ['1,2,3', '-4,-5,-6'], componentLine = 'NS,EW,UD') {
  return ['SITE CODE= ABCテスト,37.5,137.2,16,7.6', ' LAT.= 37.0', ' LON.= 137.0',
    ' SAMPLING RATE= 100Hz', ' UNIT  = gal(cm/s/s)', 'INITIAL TIME = 2024 01 01 16 10 00',
    componentLine, ...values].join('\r\n');
}

test('JMA index matches minute-level JST dates, preserves event separation and restricts sources', () => {
  const { jma } = loadJma();
  const events = jma.parseEventIndex(indexHtml);
  assert.equal(events.length, 2);
  assert.equal(events[0].time, Date.UTC(2024, 0, 1, 7, 10));
  assert.equal(jma.chooseEvent(events, Date.UTC(2024, 0, 1, 7, 10, 9)).url, events[0].url);
  assert.throws(() => jma.chooseEvent(events, Date.UTC(2024, 0, 1, 7, 11)), /複数/);
  assert.throws(() => jma.chooseEvent(events, Date.UTC(2024, 0, 2, 7, 10)), /一覧にありません/);
});

test('JMA station rows retain official distances and notices without inventing coordinates', () => {
  const { jma } = loadJma();
  const event = jma.parseEventIndex(indexHtml)[0];
  const stations = jma.parseStationPage(eventHtml, event, 37.5, 137.2, 5);
  assert.equal(stations.length, 3);
  assert.deepEqual(Array.from(stations, value => value.channel), ['NS', 'EW', 'UD']);
  assert.equal(stations[0].distanceKm, 50.2);
  assert.equal(stations[0].lat, undefined);
  assert.equal(stations[0].name, '合成テスト観測点');
  assert.match(stations[0]._sourceNotices[0], /時刻精度/);
  assert.equal(stations[0]._csvUrl, station._csvUrl);
  assert.throws(() => jma.parseStationPage(eventHtml, event, 0, 0, 5), /震央が一致/);
});

test('JMA CSV converts all three components with unit evidence and actual UTC start time', () => {
  const { jma, viewer } = loadJma();
  for (const [component, expected] of [['NS', [1, -4]], ['EW', [2, -5]], ['UD', [3, -6]]]) {
    const data = jma.parseCsv(csv(), { ...station, channel: component });
    assert.deepEqual(Array.from(data.acc), expected);
    assert.equal(data.dt, 0.01);
    assert.equal(data.meta._startTime, '2024-01-01T07:10:00.000Z');
    assert.equal(data.meta._stationId, `JMA.ABC.--.${component}`);
    assert.equal(data.meta._rawUnitReported, 'gal(cm/s/s)');
    assert.equal(data.meta._conversionToGal, 1);
    assert.equal(data.meta._responseCorrectionRequested, false);
    assert.equal(data.meta._responseCorrectionApplied, false);
    assert.equal(data.meta._processing.dataUrl, station._csvUrl);
    assert.equal(data.meta._rawDataFormat, 'JMA CSV');
    assert.equal(viewer.validateAccelerationData(data), true);
  }
  const reordered = jma.parseCsv(csv(['3,1,2', '-6,-4,-5'], 'UD,NS,EW'), station);
  assert.deepEqual(Array.from(reordered.acc), [1, -4]);
});

test('JMA CSV refuses unsupported units, missing components, invalid dates and corrupt samples', () => {
  const { jma } = loadJma();
  for (const bad of [
    csv().replace('gal(cm/s/s)', 'counts'),
    csv().replace('NS,EW,UD', 'NS,NS,UD'),
    csv().replace('100Hz', '0Hz'),
    csv().replace('100Hz', '1001Hz'),
    csv().replace('16 10 00', '24 10 00'),
    csv().replace('2024 01 01', '2024 02 30'),
    csv(['1,2,3', 'NaN,5,6']), csv(['1,2,3', '1,2']),
    csv(['1,2,3', '1,,3']), csv(['1,2,3', '1e999,2,3']),
    csv(['1,2,3', '', '1,2,3']),
  ]) assert.throws(() => jma.parseCsv(bad, station));
  assert.throws(() => jma.parseCsv(csv(), { ...station, _eventTime: Date.UTC(2025, 0, 1) }), /日時が/);
});

test('JMA legacy CSV accepts trailing empty columns and resolves two-digit years from the selected event', () => {
  const { jma } = loadJma();
  const padded = csv().split('\r\n').map(line => `${line},,,,,`).join('\r\n');
  assert.deepEqual(Array.from(jma.parseCsv(padded, station).acc), [1, -4]);
  const old = padded.replace('2024 01 01 16 10 00', '95 01 17 05 46 27');
  const oldStation = { ...station, _eventTime: Date.UTC(1995, 0, 16, 20, 46) };
  assert.equal(jma.parseCsv(old, oldStation).meta._startTime, '1995-01-16T20:46:27.000Z');
  assert.throws(() => jma.parseCsv(old, station), /年が選択した地震/);
  assert.throws(() => jma.parseCsv(old, { channel: 'NS' }), /照合が必要/);
  assert.throws(() => jma.parseCsv(csv(['1,2,3', '1,2,,,,']), station), /欠測/);
});

test('JMA fetch searches the official index then station rows and reads Shift_JIS samples', async () => {
  const requests = [];
  const bytes = Buffer.concat([
    Buffer.from(csv().split('テスト')[0]), Buffer.from([0x83, 0x65, 0x83, 0x58, 0x83, 0x67]),
    Buffer.from(csv().split('テスト')[1]),
  ]);
  const { jma } = loadJma({ fetch: async (url, options) => {
    requests.push({ url: String(url), options });
    return new Response(String(url).endsWith('.csv') ? bytes
      : String(url) === jma.INDEX_URL ? indexHtml : eventHtml);
  } });
  const result = await jma.searchStations(37.5, 137.2, 5, station._eventTime);
  assert.equal(requests.length, 2);
  assert.equal(result.checkedCount, 0);
  assert.equal(result.stations.length, 3);
  const data = await jma.fetchWaveformData(result.stations[0], '2024-01-01T07:09:00Z', '2024-01-01T07:20:00Z');
  assert.deepEqual(Array.from(data.acc), [1, -4]);
  assert.match(data.meta._rawHeader, /ABCテスト/);
  assert.equal(requests.length, 3);
  assert.ok(requests.every(request => request.options.credentials === 'omit'));
});

test('JMA download enforces byte limits, official hosts and cancellation', async () => {
  let calls = 0;
  let cancelled = false;
  const { jma } = loadJma({ fetch: async () => {
    calls++;
    return {
      ok: true,
      headers: new Headers({ 'Content-Length': String(21 * 1024 * 1024) }),
      body: { cancel: async () => { cancelled = true; } },
    };
  } });
  await assert.rejects(jma.fetchWaveformData(station), /上限/);
  assert.equal(cancelled, true);
  await assert.rejects(jma.fetchWaveformData({ ...station, _csvUrl: 'https://other.invalid/test.csv' }), /公開強震データURL/);
  assert.equal(calls, 1);
  const aborted = loadJma({ fetch: async () => new Response(csv()) }).jma;
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(aborted.fetchWaveformData(station, '', '', { signal: controller.signal }), { name: 'AbortError' });
});
