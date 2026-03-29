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
      '津波情報',
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
        `"${(p.place || '').replace(/"/g, '""')}"`,
        `"${I18n.translatePlace(p.place).replace(/"/g, '""')}"`,
        c[1],
        c[0],
        p.tsunami ? 'あり' : 'なし',
        I18n.translateTerm(p.status) || p.status,
        p.ids || '',
        p.url || '',
      ].join(',');
    });

    const csv = BOM + headers.join(',') + '\n' + rows.join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    triggerDownload(blob, filename);
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
        津波情報: p.tsunami ? 'あり' : 'なし',
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

  return {
    asCSV,
    asJSON,
    asGeoJSON,
  };
})();
