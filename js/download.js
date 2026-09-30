/**
 * download.js - データエクスポートモジュール
 * Blob APIを使用してCSV/JSON/GeoJSONをダウンロード
 */
const Download = (() => {

  /**
   * Blobを生成してダウンロードを実行
   */
  function triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  /**
   * GeoJSONデータをCSV形式でダウンロード
   * @param {Object} geojson - USGS GeoJSON レスポンス
   * @param {string} filename - ファイル名
   */
  function asCSV(geojson, filename = 'earthquakes.csv') {
    if (!geojson || !geojson.features) return;
    const csv = earthquakeToCSV(geojson);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    triggerDownload(blob, filename);
  }

  function earthquakeToCSV(geojson) {
    if (!geojson || !Array.isArray(geojson.features)) return '';

    // BOM付きUTF-8でExcel対応
    const BOM = '\uFEFF';

    const headers = [
      '発生日時(JST)',
      '発生日時(UTC)',
      'マグニチュード',
      '規模',
      '深さ(km)',
      '震央(原文)',
      '震央(日本語)',
      '緯度',
      '経度',
      'USGS津波関連フラグ',
      '状態',
      'USGS ID',
      '詳細URL',
    ];

    const rows = geojson.features.map(f => {
      const p = f.properties;
      const c = f.geometry.coordinates;
      return [
        I18n.formatDateJST(p.time),
        I18n.formatDateUTC(p.time),
        p.mag !== null ? p.mag : '',
        I18n.magnitudeLabel(p.mag),
        c[2] !== null ? c[2] : '',
        p.place || '',
        I18n.translatePlace(p.place),
        c[1],
        c[0],
        p.tsunami ? 'あり' : 'なし',
        I18n.translateTerm(p.status) || p.status,
        p.ids || '',
        p.url || '',
      ].map(AppUtils.escapeCsvCell).join(',');
    });

    return BOM + headers.map(AppUtils.escapeCsvCell).join(',') + '\n' + rows.join('\n');
  }

  /**
   * 整形済みJSON形式でダウンロード（日本語ラベル付き）
   */
  function asJSON(geojson, filename = 'earthquakes.json') {
    if (!geojson || !geojson.features) return;

    const data = geojson.features.map(f => {
      const p = f.properties;
      const c = f.geometry.coordinates;
      return {
        発生日時_JST: I18n.formatDateJST(p.time),
        発生日時_UTC: I18n.formatDateUTC(p.time),
        マグニチュード: p.mag,
        規模: I18n.magnitudeLabel(p.mag),
        深さ_km: c[2],
        震央_原文: p.place,
        震央_日本語: I18n.translatePlace(p.place),
        緯度: c[1],
        経度: c[0],
        USGS津波関連フラグ: p.tsunami ? 'あり' : 'なし',
        状態: I18n.translateTerm(p.status) || p.status,
        USGS_ID: p.ids,
        詳細URL: p.url,
      };
    });

    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
    triggerDownload(blob, filename);
  }

  /**
   * GeoJSON形式そのままでダウンロード（GIS用途）
   */
  function asGeoJSON(geojson, filename = 'earthquakes.geojson') {
    if (!geojson) return;
    const json = JSON.stringify(geojson, null, 2);
    const blob = new Blob([json], { type: 'application/geo+json;charset=utf-8' });
    triggerDownload(blob, filename);
  }

  function spectrumToCSV(specData, type = 'sa') {
    const typeLabels = {
      sa: 'Sa_gal',
      sv: 'Sv_cm_per_s',
      sd: 'Sd_cm',
    };
    if (!specData || !Array.isArray(specData.periods) || !specData.results || !typeLabels[type]) {
      throw new TypeError('応答スペクトルデータが不正です');
    }

    const entries = Object.entries(specData.results);
    const waveform = specData.meta?.waveform;
    const provenance = waveform && typeof waveform === 'object' && !Array.isArray(waveform)
      ? [
          ['waveform_station_id', waveform._stationId || waveform._seriesId],
          ['waveform_start_utc', waveform._startTime],
          ['input_unit', waveform._inputUnitReported],
          ['conversion_to_gal', waveform._conversionToGal],
          ['unit_evidence', waveform._unitEvidence],
          ['waveform_source', waveform._source],
          ['waveform_url', waveform._dataUrl],
          ['processing', waveform._processing || waveform._filterLabel],
          ['response_correction_requested', waveform._responseCorrectionRequested],
          ['raw_header', waveform._rawHeader],
          ['evaluation_start_s', specData.meta.evaluationStart],
          ['evaluation_end_s', specData.meta.evaluationEnd],
          ['header_unit_verified', waveform._unitVerified],
        ]
      : [];
    const provenanceValues = provenance.map(([, value]) => {
      const serialized = value !== null && typeof value === 'object' ? JSON.stringify(value) : value ?? '';
      // 外部メタデータは改行を含めて保存し、空白に続く数式も文字列として扱う。
      return typeof serialized === 'string' && /^\s*[=+\-@]/.test(serialized)
        ? `'${serialized}`
        : serialized;
    });
    const header = [
      'period_s',
      ...entries.map(([damping]) => `${typeLabels[type]}_h${(Number(damping) * 100).toFixed(2)}pct`),
      ...provenance.map(([name]) => name),
    ];
    const rows = specData.periods.map((period, index) => [
      period,
      ...entries.map(([, values]) => values[type]?.[index] ?? ''),
      ...provenanceValues,
    ]);

    return '\uFEFF' + [header, ...rows]
      .map(row => row.map(AppUtils.escapeCsvCell).join(','))
      .join('\n');
  }

  function asSpectrumCSV(specData, type = 'sa', filename = 'response-spectrum.csv') {
    const csv = spectrumToCSV(specData, type);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    triggerDownload(blob, filename);
  }

  return {
    asCSV,
    earthquakeToCSV,
    asJSON,
    asGeoJSON,
    spectrumToCSV,
    asSpectrumCSV,
  };
})();
