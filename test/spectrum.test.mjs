import assert from 'node:assert/strict';
import test from 'node:test';

import { createBrowserLikeContext, loadClassicScript } from './helpers/load-classic-script.mjs';

const context = createBrowserLikeContext();
loadClassicScript('js/utils.js', 'AppUtils', context);
const { exported: Spectrum } = loadClassicScript('js/spectrum.js', 'Spectrum', context);

function assertClose(actual, expected, tolerance = 1e-9) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
}

test('Newmark absolute acceleration is not incorrectly floored at PGA', () => {
  const constantInput = new Array(101).fill(100);
  const response = Spectrum.sdofNewmark(constantInput, 0.01, 10, 0.05);
  assertClose(response.sa, 24.404019307402905, 1e-9);
  assert.ok(response.sa < 100);

  const impulse = new Array(101).fill(0);
  impulse[0] = 100;
  assertClose(Spectrum.sdofNewmark(impulse, 0.01, 10, 0.05).sa, 0.20204150112813712, 1e-9);
});

test('zero input produces zero response for every spectrum ordinate', () => {
  const spectrum = Spectrum.computeSpectrum(new Array(201).fill(0), 0.01, {
    hList: [0, 0.05],
    periodMin: 0.02,
    periodMax: 2,
    periodCount: 10,
  });
  for (const result of Object.values(spectrum.results)) {
    assert.ok(Array.from(result.sa).every(value => value === 0));
    assert.ok(Array.from(result.sv).every(value => value === 0));
    assert.ok(Array.from(result.sd).every(value => value === 0));
  }
});

test('effective minimum period enforces ten samples per cycle', () => {
  const spectrum = Spectrum.computeSpectrum(new Array(201).fill(0), 0.01, {
    hList: [0.05],
    periodMin: 0.02,
    periodMax: 2,
    periodCount: 10,
  });

  assert.equal(spectrum.meta.requestedPeriodMin, 0.02);
  assert.equal(spectrum.meta.effectivePeriodMin, 0.1);
  assert.equal(spectrum.meta.periodMinAdjusted, true);
  assertClose(spectrum.periods[1], 0.1);
});

test('evaluation window inherits oscillator state from the preceding record', () => {
  const input = new Array(1001).fill(0);
  input[0] = 100;
  const inherited = Spectrum.sdofNewmark(input, 0.01, 1, 0.05, {
    evaluationStart: 1,
    evaluationEnd: 2,
  });
  const incorrectlyCropped = Spectrum.sdofNewmark(input.slice(100, 201), 0.01, 1, 0.05);

  assert.ok(inherited.sd > 0);
  assert.equal(incorrectlyCropped.sd, 0);
});

test('non-grid evaluation boundaries exclude samples immediately outside the requested window', () => {
  const input = [0, 999, 10, -20, 888, 0];
  const evaluation = Spectrum.normalizeEvaluationRange(input.length, 0.06, {
    evaluationStart: 0.10,
    evaluationEnd: 0.20,
  });
  assert.deepEqual(
    { startIndex: evaluation.startIndex, endIndex: evaluation.endIndex },
    { startIndex: 2, endIndex: 3 }
  );
  assert.equal(Spectrum.sdofNewmark(input, 0.06, 0, 0.05, {
    evaluationStart: 0.10,
    evaluationEnd: 0.20,
  }).sa, 20);
});

test('Newmark response agrees with the closed-form steady-state harmonic amplification', () => {
  const amplitude = 100;
  const oscillatorPeriod = 1;
  const damping = 0.05;
  const dt = 0.002;
  const duration = 30;
  const omega = 2 * Math.PI / oscillatorPeriod;
  const input = Array.from(
    { length: Math.round(duration / dt) + 1 },
    (_, index) => amplitude * Math.sin(omega * index * dt)
  );
  const response = Spectrum.sdofNewmark(input, dt, oscillatorPeriod, damping, {
    evaluationStart: 20,
    evaluationEnd: duration,
  });
  const exactAmplification = Math.sqrt(1 + 4 * damping ** 2) / (2 * damping);
  assertClose(response.sa, amplitude * exactAmplification, amplitude * exactAmplification * 0.01);
});

test('spectrum input validation rejects non-finite data and invalid damping', () => {
  assert.throws(() => Spectrum.computeSpectrum([0, Number.NaN], 0.01), /有限値/);
  assert.throws(() => Spectrum.computeSpectrum([0, 1], 0, { hList: [0.05] }), /サンプリング間隔/);
  assert.throws(() => Spectrum.computeSpectrum([0, 1], 0.01, { hList: [1] }), /減衰定数/);
});

test('invalidating a spectrum chart preserves the input waveform chart', () => {
  const charts = [];
  const chartContext = createBrowserLikeContext({
    document: { getElementById: id => ({ id }) },
    Chart: class {
      constructor(canvas) {
        this.canvas = canvas;
        this.destroyCount = 0;
        charts.push(this);
      }
      destroy() { this.destroyCount += 1; }
    },
  });
  loadClassicScript('js/utils.js', 'AppUtils', chartContext);
  const { exported: chartSpectrum } = loadClassicScript('js/spectrum.js', 'Spectrum', chartContext);
  chartSpectrum.renderWaveform([0, 1, 0], 0.01, 'input-waveform');
  chartSpectrum.renderSpectrum({
    periods: [0, 0.1, 1],
    results: { 0.05: { sa: [1, 2, 1], sv: [0, 1, 0], sd: [0, 1, 0] } },
  }, 'response-spectrum');

  chartSpectrum.clearSpectrumChart();
  chartSpectrum.clearSpectrumChart();
  assert.equal(charts[0].destroyCount, 0);
  assert.equal(charts[1].destroyCount, 1);

  chartSpectrum.clearCharts();
  assert.equal(charts[0].destroyCount, 1);
  assert.equal(charts[1].destroyCount, 1);
});

test('spectrum input waveform plots preserve isolated peaks and their actual time coordinates', () => {
  let configuration;
  const chartContext = createBrowserLikeContext({
    document: { getElementById: () => ({}) },
    Chart: class { constructor(_canvas, config) { configuration = config; } },
  });
  loadClassicScript('js/utils.js', 'AppUtils', chartContext);
  const { exported: chartSpectrum } = loadClassicScript('js/spectrum.js', 'Spectrum', chartContext);
  const acceleration = new Array(8001).fill(0);
  acceleration[1] = 500;
  acceleration[2] = -750;
  chartSpectrum.renderWaveform(acceleration, 0.001, 'input-waveform');
  const points = configuration.data.datasets[0].data;
  assert.ok(points.some(point => point.x === 0.001 && point.y === 500));
  assert.ok(points.some(point => point.x === 0.002 && point.y === -750));
  assert.equal(points.at(-1).x, 8);
  assert.equal(configuration.options.scales.x.type, 'linear');
});
