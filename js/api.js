/**
 * api.js - USGS Earthquake API 通信モジュール
 * https://earthquake.usgs.gov/fdsnws/event/1/
 */
const EarthquakeAPI = (() => {
  const BASE_URL = 'https://earthquake.usgs.gov/fdsnws/event/1/query';

  // 地域プリセット（緯度経度範囲）
  const regionPresets = {
    global: { label: '世界全体', bounds: null },
    japan: {
      label: '日本周辺',
      bounds: { minlat: 20, maxlat: 50, minlon: 120, maxlon: 155 },
    },
    pacific: {
      label: '環太平洋',
      boundsList: [
        { minlat: -60, maxlat: 65, minlon: 100, maxlon: 180 },
        { minlat: -60, maxlat: 65, minlon: -180, maxlon: -60 },
      ],
    },
    southeast_asia: {
      label: '東南アジア',
      bounds: { minlat: -15, maxlat: 25, minlon: 90, maxlon: 145 },
    },
    south_america: {
      label: '南米',
      bounds: { minlat: -60, maxlat: 15, minlon: -90, maxlon: -30 },
    },
    mediterranean: {
      label: '地中海',
      bounds: { minlat: 28, maxlat: 48, minlon: -10, maxlon: 45 },
    },
    central_asia: {
      label: '中央アジア',
      bounds: { minlat: 20, maxlat: 50, minlon: 55, maxlon: 95 },
    },
  };

  /**
   * 検索パラメータを組み立ててAPIにリクエスト
   * @param {Object} params - 検索条件
   * @returns {Promise<Object>} GeoJSON形式のレスポンス
   */
  async function search(params) {
    const boundsList = Array.isArray(params.boundsList) && params.boundsList.length > 0
      ? params.boundsList
      : [params];

    const responses = await Promise.all(boundsList.map(bounds => {
      const query = buildQuery(params, bounds);
      return fetchGeoJSON(query);
    }));

    if (responses.length === 1) return responses[0];
    return mergeGeoJSONResponses(responses, params.limit);
  }

  /**
   * クイック検索（最近の地震）
   */
  function recentSearch(hours, minMag, limit = 200) {
    const now = new Date();
    const start = new Date(now.getTime() - hours * 60 * 60 * 1000);
    return search({
      starttime: start.toISOString(),
      endtime: now.toISOString(),
      minmagnitude: minMag,
      limit: limit,
    });
  }

  /**
   * 地域プリセットの取得
   */
  function getRegionPresets() {
    return regionPresets;
  }

  function buildQuery(params, bounds) {
    const query = new URLSearchParams({
      format: 'geojson',
      orderby: 'time',
    });

    if (params.starttime) query.set('starttime', params.starttime);
    if (params.endtime) query.set('endtime', params.endtime);
    if (params.minmagnitude) query.set('minmagnitude', params.minmagnitude);
    if (params.maxmagnitude) query.set('maxmagnitude', params.maxmagnitude);
    if (params.mindepth) query.set('mindepth', params.mindepth);
    if (params.maxdepth) query.set('maxdepth', params.maxdepth);
    if (params.limit) query.set('limit', params.limit);

    if (bounds.minlat !== undefined) query.set('minlatitude', bounds.minlat);
    if (bounds.maxlat !== undefined) query.set('maxlatitude', bounds.maxlat);
    if (bounds.minlon !== undefined) query.set('minlongitude', bounds.minlon);
    if (bounds.maxlon !== undefined) query.set('maxlongitude', bounds.maxlon);

    return query;
  }

  async function fetchGeoJSON(query) {
    const url = `${BASE_URL}?${query.toString()}`;
    const response = await fetch(url);

    if (!response.ok) {
      if (response.status === 400) {
        const text = await response.text();
        throw new Error(`検索条件にエラーがあります: ${text}`);
      }
      throw new Error(`APIエラー (HTTP ${response.status})`);
    }

    return response.json();
  }

  function mergeGeoJSONResponses(responses, limit) {
    const featureMap = new Map();

    responses.forEach(data => {
      (data.features || []).forEach(feature => {
        const key = feature.id || [
          feature.properties?.time,
          feature.geometry?.coordinates?.join(','),
          feature.properties?.mag,
        ].join(':');

        if (!featureMap.has(key)) {
          featureMap.set(key, feature);
        }
      });
    });

    const mergedFeatures = [...featureMap.values()]
      .sort((a, b) => (b.properties?.time || 0) - (a.properties?.time || 0));

    const parsedLimit = Number.parseInt(limit, 10);
    const features = Number.isFinite(parsedLimit) && parsedLimit > 0
      ? mergedFeatures.slice(0, parsedLimit)
      : mergedFeatures;

    const base = responses[0] || {};
    return {
      ...base,
      features,
      metadata: {
        ...(base.metadata || {}),
        count: features.length,
      },
    };
  }

  return {
    search,
    recentSearch,
    getRegionPresets,
    BASE_URL,
  };
})();
