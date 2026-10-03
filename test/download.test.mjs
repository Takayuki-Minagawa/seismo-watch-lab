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

function parseCsv(csv) {
  const records = [];
  let record = '';
  let quoted = false;
  const text = csv.replace(/^\uFEFF/, '');
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === '"') {
      record += char;
      if (quoted && text[index + 1] === '"') record += text[++index];
      else quoted = !quoted;
    } else if (char === '\n' && !quoted) {
      records.push(parseCsvLine(record));
      record = '';
    } else {
      record += char;
    }
  }
  records.push(parseCsvLine(record));
  return records;
}

function spectrumFixture(waveform) {
  return {
    periods: [0, 0.1],
    results: {
      0.05: { sa: [10, 20], sv: [0, 1], sd: [0, 2] },
      0.1: { sa: [10, 15], sv: [0, 0.8], sd: [0, 1.5] },
    },
    meta: { waveform, evaluationStart: 0, evaluationEnd: 12.5 },
  };
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

test('spectrum provenance is appended after numeric columns and repeats for every period', () => {
  const waveform = {
    _stationId: 'IU.ANMO.00.BHZ',
    _seriesId: 'IU.ANMO.00.BHZ.M',
    _startTime: '2026-09-29T00:00:00.000Z',
    _inputUnitReported: 'M/S**2',
    _conversionToGal: 100,
    _unitEvidence: 'response-header',
    _source: 'IRIS / EarthScope',
    _dataUrl: 'https://example.test/query?correct=true&units=ACC',
    _processing: ['taper=0.05', 'demean=true', 'correct=true', 'units=ACC'],
    _responseCorrectionRequested: true,
    _unitVerified: true,
    _rawHeader: 'TIMESERIES IU.ANMO.00.BHZ.M, 2 samples, "M/S**2"\nprovider note',
  };
  const [header, first, second] = parseCsv(Download.spectrumToCSV(spectrumFixture(waveform)));
  assert.deepEqual(header.slice(0, 3), ['period_s', 'Sa_gal_h5.00pct', 'Sa_gal_h10.00pct']);
  assert.deepEqual(header.slice(3), [
    'waveform_station_id', 'waveform_start_utc', 'input_unit', 'conversion_to_gal',
    'unit_evidence', 'waveform_source', 'waveform_url', 'response_url', 'raw_data_format', 'source_notices', 'processing',
    'response_correction_requested', 'response_correction_applied', 'raw_header',
    'evaluation_start_s', 'evaluation_end_s', 'header_unit_verified',
  ]);
  assert.deepEqual(first.slice(0, 3), ['0', '10', '10']);
  assert.deepEqual(second.slice(0, 3), ['0.1', '20', '15']);
  assert.deepEqual(first.slice(3), [
    waveform._stationId, waveform._startTime, waveform._inputUnitReported, '100',
    waveform._unitEvidence, waveform._source, waveform._dataUrl, '', '', '', JSON.stringify(waveform._processing),
    'true', '', waveform._rawHeader, '0', '12.5', 'true',
  ]);
  assert.deepEqual(second.slice(3), first.slice(3));
  assert.equal(first.length, header.length);
  assert.equal(second.length, header.length);
});

test('provenance exports fallbacks, false and zero without replacing them with blank values', () => {
  const rows = parseCsv(Download.spectrumToCSV(spectrumFixture({
    _seriesId: 'XX.TEST.--.HNN.M',
    _conversionToGal: 0,
    _filterLabel: 'Low-pass 5 Hz',
    _responseCorrectionRequested: false,
    _unitVerified: false,
  }), 'sv'));
  const values = Object.fromEntries(rows[0].map((key, index) => [key, rows[1][index]]));
  assert.equal(values.waveform_station_id, 'XX.TEST.--.HNN.M');
  assert.equal(values.conversion_to_gal, '0');
  assert.equal(values.processing, 'Low-pass 5 Hz');
  assert.equal(values.response_correction_requested, 'false');
  assert.equal(values.evaluation_start_s, '0');
  assert.equal(values.evaluation_end_s, '12.5');
  assert.equal(values.header_unit_verified, 'false');
  assert.equal(values.input_unit, '');
  assert.equal(values.raw_header, '');
  assert.deepEqual(rows[0].slice(0, 3), ['period_s', 'Sv_cm_per_s_h5.00pct', 'Sv_cm_per_s_h10.00pct']);
});

test('spectrum CSV neutralizes formulas in provenance including leading whitespace and newlines', () => {
  const waveform = {
    _stationId: '=HYPERLINK("https://example.test","station")',
    _source: '\t+SUM(1,2)',
    _unitEvidence: '\r@source',
    _processing: '\n =CMD()',
    _rawHeader: '-formula',
  };
  const rows = parseCsv(Download.spectrumToCSV(spectrumFixture(waveform)));
  const values = Object.fromEntries(rows[0].map((key, index) => [key, rows[1][index]]));
  assert.equal(values.waveform_station_id, `'${waveform._stationId}`);
  assert.equal(values.waveform_source, `'${waveform._source}`);
  assert.equal(values.unit_evidence, `'${waveform._unitEvidence}`);
  assert.equal(values.processing, `'${waveform._processing}`);
  assert.equal(values.raw_header, `'${waveform._rawHeader}`);
});

test('spectrum CSV remains byte-compatible when waveform provenance is absent', () => {
  const expected = '\uFEFF"period_s","Sd_cm_h5.00pct","Sd_cm_h10.00pct"\n"0","0","0"\n"0.1","2","1.5"';
  for (const waveform of [undefined, null, false, [], 'not metadata']) {
    assert.equal(Download.spectrumToCSV(spectrumFixture(waveform), 'sd'), expected);
  }
  const specData = spectrumFixture();
  delete specData.meta;
  assert.equal(Download.spectrumToCSV(specData, 'sd'), expected);
});
