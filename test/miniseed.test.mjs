import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createBrowserLikeContext, loadClassicScript } from './helpers/load-classic-script.mjs';

function decoder() {
  const context = createBrowserLikeContext();
  loadClassicScript('vendor/seisplotjs-3.2.7/seedcodec.js', 'SeedCodec', context);
  return loadClassicScript('js/miniseed.js', 'MiniSeedDecoder', context).exported;
}

function record({ samples = [1, -2, 3, 4], little = false, fraction = 0, microseconds = 0,
  second = 0, correction = 0, activity = 0, channel = 'HNZ', factor = 100,
  multiplier = 1, encoding = 3, floatRate } = {}) {
  const out = new ArrayBuffer(512), view = new DataView(out);
  const text = (offset, value) => [...value].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  text(0, '000001D '); text(8, 'TEST '); text(13, '  '); text(15, channel); text(18, 'XX');
  view.setUint16(20, 2026, little); view.setUint16(22, 276, little);
  view.setUint8(26, second); view.setUint16(28, fraction, little);
  view.setUint16(30, samples.length, little);
  view.setInt16(32, factor, little); view.setInt16(34, multiplier, little);
  view.setUint8(36, activity); view.setUint8(39, floatRate === undefined ? 2 : 3);
  view.setInt32(40, correction, little); view.setUint16(44, 128, little); view.setUint16(46, 48, little);
  view.setUint16(48, 1000, little); view.setUint16(50, 56, little);
  view.setUint8(52, encoding); view.setUint8(53, little ? 0 : 1); view.setUint8(54, 9);
  view.setUint16(56, 1001, little); view.setUint8(60, 100); view.setInt8(61, microseconds);
  if (floatRate !== undefined) {
    view.setUint16(58, 64, little); view.setUint16(64, 100, little); view.setFloat32(68, floatRate, little);
  }
  const widths = { 1: 2, 3: 4, 4: 4, 5: 8 };
  samples.forEach((value, i) => {
    const off = 128 + i * widths[encoding];
    if (encoding === 1) view.setInt16(off, value, little);
    if (encoding === 3) view.setInt32(off, value, little);
    if (encoding === 4) view.setFloat32(off, value, little);
    if (encoding === 5) view.setFloat64(off, value, little);
  });
  return out;
}

function concatenate(...buffers) {
  const result = new Uint8Array(buffers.reduce((sum, buffer) => sum + buffer.byteLength, 0));
  let offset = 0;
  for (const buffer of buffers) { result.set(new Uint8Array(buffer), offset); offset += buffer.byteLength; }
  return result.buffer;
}

test('miniSEED handles integer and floating encodings, both byte orders and blank locations', () => {
  for (const encoding of [1, 3, 4, 5]) for (const little of [false, true]) {
    const data = decoder().decode(record({ encoding, little }), {
      network: 'XX', station: 'TEST', location: '--', channel: 'HNZ',
    });
    assert.deepEqual(Array.from(data.samples), [1, -2, 3, 4]);
    assert.equal(data.sampleRate, 100);
    assert.equal(data.id, 'XX.TEST..HNZ');
    assert.equal(data.startTime, '2026-10-03T00:00:00.000000Z');
    assert.equal(data.endMs - data.startMs, 30);
  }
});

test('sample-rate factors, divisors, and blockette 100 explicit rates are respected', () => {
  assert.equal(decoder().decode(record({ factor: 20, multiplier: -2 })).sampleRate, 10);
  assert.equal(decoder().decode(record({ factor: -2, multiplier: -5 })).sampleRate, 0.1);
  assert.equal(decoder().decode(record({ factor: 0, floatRate: 40.5 })).sampleRate, 40.5);
});

test('fixed correction and signed microseconds are applied without millisecond truncation', () => {
  assert.equal(decoder().decode(record({ fraction: 123, microseconds: -38, correction: 10 })).startTime,
    '2026-10-03T00:00:00.013262Z');
  assert.equal(decoder().decode(record({ fraction: 123, microseconds: -38, correction: 10, activity: 2 })).startTime,
    '2026-10-03T00:00:00.012262Z');
});

test('continuous records can arrive out of order; gaps, overlaps and timing drifts are rejected', () => {
  const first = record(), second = record({ fraction: 400 });
  const data = decoder().decode(concatenate(second, first));
  assert.deepEqual(Array.from(data.samples), [1, -2, 3, 4, 1, -2, 3, 4]);
  assert.equal(data.recordCount, 2);
  for (const variant of [record({ fraction: 500 }), record({ fraction: 300 }), record({ fraction: 400, microseconds: -38 })]) {
    assert.throws(() => decoder().decode(concatenate(first, variant)), /欠測または重複/);
  }
  const drifting = [0, 1, 2, 3].map(index => record({ fraction: index * 400, microseconds: index }));
  assert.throws(() => decoder().decode(concatenate(...drifting)), /欠測または重複/);
});

test('multiple NSLCs, request mismatches and sample rate changes never merge', () => {
  assert.throws(() => decoder().decode(record(), { network: 'YY', station: 'TEST', location: '', channel: 'HNZ' }), /要求と一致/);
  assert.throws(() => decoder().decode(concatenate(record(), record({ fraction: 400, channel: 'HNN' }))), /要求と一致/);
  assert.throws(() => decoder().decode(concatenate(record(), record({ fraction: 400, factor: 50 }))), /周波数が変わ/);
});

test('malformed, incomplete, unsupported, and nonfinite records fail explicitly', () => {
  assert.throws(() => decoder().decode(new ArrayBuffer(0)), /空/);
  assert.throws(() => decoder().decode(record().slice(0, 511)), /途中/);
  assert.throws(() => decoder().decode(record({ samples: [] })), /サンプルを含まない/);
  assert.throws(() => decoder().decode(record({ factor: 0 })), /周波数/);
  assert.throws(() => decoder().decode(record({ second: 60 })), /閏秒/);
  assert.throws(() => decoder().decode(record({ activity: 16 })), /閏秒/);
  assert.throws(() => decoder().decode(record({ encoding: 4, samples: [0, Infinity] })), /値が不正/);
  const cyclic = record(); new DataView(cyclic).setUint16(58, 48);
  assert.throws(() => decoder().decode(cyclic), /ブロケット/);
  const noLength = record(); new DataView(noLength).setUint16(48, 2000);
  assert.throws(() => decoder().decode(noLength), /レコード長/);
  const unsupported = record(); new DataView(unsupported).setUint8(52, 19);
  assert.throws(() => decoder().decode(unsupported), /not supported/);
});

for (const fixture of [
  { name: 'earthscope', id: 'IU.ANMO.00.BHZ', count: 6000, start: '2010-02-27T06:30:00.019538Z', first: [-47237, -47304, -47367, -47430, -47499] },
  { name: 'geofon', id: 'GE.APE..BHN', count: 12481, start: '2023-02-06T01:09:41.135000Z', first: [1327, 1477, 1604, 1664, 1749] },
]) {
  test(`${fixture.name} real Steim2 response retains every sample and precise start time`, () => {
    const bytes = readFileSync(new URL(`./fixtures/miniseed/${fixture.name}.mseed`, import.meta.url));
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const data = decoder().decode(buffer);
    assert.equal(data.id, fixture.id);
    assert.equal(data.sampleRate, 20);
    assert.equal(data.samples.length, fixture.count);
    assert.equal(data.startTime, fixture.start);
    assert.deepEqual(Array.from(data.samples.slice(0, 5)), fixture.first);
    // Corrupt the first record's reverse integration constant; do not accept bad data.
    const view = new DataView(buffer);
    const dataOffset = view.getUint16(44);
    view.setInt32(dataOffset + 8, view.getInt32(dataOffset + 8) + 1);
    assert.throws(() => decoder().decode(buffer), /整合性確認値/);
  });
}
