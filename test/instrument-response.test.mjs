import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { DOMParser } from './vendor/xmldom-0.9.12/lib/index.js';
import { createBrowserLikeContext, loadClassicScript } from './helpers/load-classic-script.mjs';

const context = createBrowserLikeContext({ DOMParser });
const { exported: InstrumentResponse } = loadClassicScript('js/instrument-response.js', 'InstrumentResponse', context);
const load = (name, extension) => readFileSync(new URL(`./fixtures/instrument-response/${name}.${extension}`, import.meta.url), 'utf8');
const reference = name => JSON.parse(load(name, 'json'));

for (const name of ['geonet', 'geofon', 'earthscope', 'synthetic']) {
  test(`${name}: all response stages match independent ObsPy/evalresp complex values`, () => {
    const ref = reference(name);
    const model = InstrumentResponse.parseStationXML(load(name, 'xml'), ref.trace);
    const actual = InstrumentResponse.evaluateResponse(model, ref.frequencies);
    for (let i = 0; i < ref.frequencies.length; i++) {
      const difference = Math.hypot(actual.real[i] - ref.responseReal[i], actual.imag[i] - ref.responseImag[i]);
      const magnitude = Math.hypot(ref.responseReal[i], ref.responseImag[i]);
      assert.ok(difference / magnitude < 1e-10, `${name} ${ref.frequencies[i]} Hz: ${difference / magnitude}`);
    }
  });
  test(`${name}: corrected SI acceleration agrees with ObsPy Trace.remove_response`, () => {
    const ref = reference(name);
    const model = InstrumentResponse.parseStationXML(load(name, 'xml'), ref.trace);
    const result = InstrumentResponse.correct(ref.samples, ref.trace.sampleRate, model, { preFilter: ref.preFilter });
    const peak = Math.max(...ref.acceleration.map(Math.abs));
    const error = Math.max(...result.acceleration.map((value, i) => Math.abs(value - ref.acceleration[i])));
    assert.ok(error / peak < 1e-9, `${name}: ${error / peak}`);
    assert.equal(result.processing.outputUnits, 'm/s²');
    assert.equal(result.processing.waterLevel, null);
    assert.equal(result.processing.stageCount, model.stages.length);
    assert.equal(result.acceleration.length, ref.samples.length);
  });
}

const geo = reference('geonet');
const xml = load('geonet', 'xml');

test('native acceleration response preserves its DC gain although waveform correction removes DC', () => {
  const model = InstrumentResponse.parseStationXML(xml, geo.trace);
  const response = InstrumentResponse.evaluateResponse(model, [0]);
  assert.ok(Math.abs(response.real[0] / model.sensitivity - 1) < 1e-12);
  assert.equal(response.imag[0], 0);
});

test('response epoch must match every source identifier and the full waveform interval', () => {
  for (const id of ['XX.WTMC.20.HN1', 'NZ.OTHER.20.HN1', 'NZ.WTMC..HN1', 'NZ.WTMC.20.HNZ']) {
    assert.throws(() => InstrumentResponse.parseStationXML(xml, { ...geo.trace, id }), /一意/);
  }
  assert.throws(() => InstrumentResponse.parseStationXML(xml, { ...geo.trace, startMs: Date.parse('2016-01-01') }), /一意/);
  assert.throws(() => InstrumentResponse.parseStationXML(xml, { ...geo.trace, endMs: Date.parse('2018-01-01') }), /一意/);
  const channel = xml.match(/<Channel\b[\s\S]*?<\/Channel>/)[0];
  assert.throws(() => InstrumentResponse.parseStationXML(xml.replace('</Station>', `${channel}</Station>`), geo.trace), /一意/);
});

test('response parsing honors namespaces and never falls back to sensitivity-only correction', () => {
  const namespaced = xml.replace(/<(\/?)([A-Za-z][A-Za-z0-9]*)(?=[\s/>])/g, '<$1s:$2').replace('xmlns=', 'xmlns:s=');
  assert.equal(InstrumentResponse.parseStationXML(namespaced, geo.trace).id, geo.trace.id);
  assert.throws(() => InstrumentResponse.parseStationXML(xml.replace(/<Stage\b[\s\S]*?<\/Stage>/g, ''), geo.trace), /応答段/);
  assert.throws(() => InstrumentResponse.parseStationXML(xml.replace(/<StageGain>[\s\S]*?<\/StageGain>/, ''), geo.trace), /StageGain/);
  assert.throws(() => InstrumentResponse.parseStationXML(xml.replace('<Name>m/s**2</Name>', '<Name>PA</Name>'), geo.trace), /入力単位/);
  assert.throws(() => InstrumentResponse.parseStationXML(xml.replace('<Name>V</Name>', '<Name>A</Name>'), geo.trace), /単位/);
  assert.throws(() => InstrumentResponse.parseStationXML(xml.replace('<Value>101971.62129779284</Value>', '<Value>1</Value>'), geo.trace), /総合感度/);
});

test('unsupported nonlinear/list stages, malformed coefficients and sample rates fail explicitly', () => {
  assert.throws(() => InstrumentResponse.parseStationXML(xml.replace(/PolesZeros/g, 'ResponseList'), geo.trace), /未対応/);
  assert.throws(() => InstrumentResponse.parseStationXML(xml.replace(/<Decimation>[\s\S]*?<\/Decimation>/, ''), geo.trace), /間引き/);
  assert.throws(() => InstrumentResponse.parseStationXML(xml.replace('<InputSampleRate>200</InputSampleRate>', '<InputSampleRate>100</InputSampleRate>'), geo.trace), /標本化周波数/);
  assert.throws(() => InstrumentResponse.parseStationXML(xml, { ...geo.trace, sampleRate: 100 }), /サンプリング/);
  assert.throws(() => InstrumentResponse.parseStationXML(xml.replace('<Coefficients ', '<Polynomial ').replace('</Coefficients>', '</Polynomial>'), geo.trace), /未対応/);
  assert.throws(() => InstrumentResponse.parseStationXML('<!DOCTYPE x><FDSNStationXML/>', geo.trace), /StationXML/);
  const fir = load('earthscope', 'xml').replace('<Numerator number="1">', '<Numerator number="2">');
  assert.throws(() => InstrumentResponse.parseStationXML(fir, reference('earthscope').trace), /順序/);
});

test('deconvolution rejects gaps/nonfinite samples, inconsistent rates, unsafe filters and excess size', () => {
  const model = InstrumentResponse.parseStationXML(xml, geo.trace);
  assert.throws(() => InstrumentResponse.correct([0, 1, NaN, 0, 0, 0, 0, 0], 200, model), /欠測/);
  assert.throws(() => InstrumentResponse.correct(geo.samples, 100, model), /サンプリング/);
  for (const preFilter of [[0, 1, 2, 3], [1, 1, 2, 3], [1, 2, 3, 101], [1, 2, NaN, 4]]) {
    assert.throws(() => InstrumentResponse.correct(geo.samples, 200, model, { preFilter }), /フィルタ/);
  }
  assert.throws(() => InstrumentResponse.correct(geo.samples, 200, model, { waterLevel: 60 }), /未対応/);
  assert.throws(() => InstrumentResponse.correct(new Float64Array(500001), 200, model), /点/);
  const result = InstrumentResponse.correct(new Float64Array(64).fill(7), 200, model);
  assert.ok(result.acceleration.every(value => Math.abs(value) < 1e-18));
});
