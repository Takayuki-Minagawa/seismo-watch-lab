import assert from 'node:assert/strict';
import test from 'node:test';

import { createBrowserLikeContext, loadClassicScript } from './helpers/load-classic-script.mjs';

const context = createBrowserLikeContext({
  I18n: {
    formatDateJST: value => `JST:${value}`,
    formatDateUTC: value => `UTC:${value}`,
    magnitudeLabel: value => `M${value}`,
    translatePlace: value => value,
    translateTerm: value => value,
  },
});
loadClassicScript('js/utils.js', 'AppUtils', context);
const { exported: Download } = loadClassicScript('js/download.js', 'Download', context);

function parseCsvLine(line) {
  const values = [];
  let value = '';
  let quoted = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (char === '"') {
      if (quoted && line[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === ',' && !quoted) {
      values.push(value);
      value = '';
    } else {
      value += char;
    }
  }
  values.push(value);
  return values;
}

test('earthquake CSV keeps comma-delimited USGS ids in one cell', () => {
  const csv = Download.earthquakeToCSV({
    features: [{
      properties: {
        time: 1,
        mag: 5,
        place: 'A, B',
        tsunami: 0,
        status: 'reviewed',
        ids: ',us1,us2,',
        url: 'https://example.test/event',
      },
      geometry: { coordinates: [140, 35, 10] },
    }],
  });
  const [header, row] = csv.slice(1).split('\n').map(parseCsvLine);
  assert.equal(header.length, 13);
  assert.equal(header[9], 'USGS津波関連フラグ');
  assert.equal(row.length, 13);
  assert.equal(row[11], ',us1,us2,');
});

test('earthquake CSV neutralizes spreadsheet formulas from external fields', () => {
  const csv = Download.earthquakeToCSV({
    features: [{
      properties: { time: 1, mag: 1, place: '=CMD()', tsunami: 0, status: 'ok', ids: '', url: '' },
      geometry: { coordinates: [0, 0, 0] },
    }],
  });
  const row = parseCsvLine(csv.slice(1).split('\n')[1]);
  assert.equal(row[5], "'=CMD()");
});

test('response spectrum CSV exports every damping series with units', () => {
  const csv = Download.spectrumToCSV({
    periods: [0, 0.1],
    results: {
      0.05: { sa: [10, 20], sv: [0, 1], sd: [0, 2] },
      0.1: { sa: [10, 15], sv: [0, 0.8], sd: [0, 1.5] },
    },
  }, 'sa');
  const lines = csv.slice(1).split('\n').map(parseCsvLine);
  assert.deepEqual(lines[0], ['period_s', 'Sa_gal_h5.00pct', 'Sa_gal_h10.00pct']);
  assert.deepEqual(lines[2], ['0.1', '20', '15']);
});
