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
  async function search(params, options = {}) {
    validateSearchParams(params);
    const boundsList = Array.isArray(params.boundsList) && params.boundsList.length > 0
      ? params.boundsList
      : [params];

    const responses = await Promise.all(boundsList.map(bounds => {
      const query = buildQuery(params, bounds);
      return fetchGeoJSON(query, options);
    }));

    if (responses.length === 1) return responses[0];
    return mergeGeoJSONResponses(responses, params.limit);
  }

  /**
   * クイック検索（最近の地震）
   */
  function recentSearch(hours, minMag, limit = 200, options = {}) {
    const now = new Date();
    const start = new Date(now.getTime() - hours * 60 * 60 * 1000);
    return search({
      starttime: start.toISOString(),
      endtime: now.toISOString(),
      minmagnitude: minMag,
      limit: limit,
    }, options);
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
      eventtype: 'earthquake',
    });

    if (hasValue(params.starttime)) query.set('starttime', params.starttime);
    if (hasValue(params.endtime)) query.set('endtime', params.endtime);
    if (hasValue(params.minmagnitude)) query.set('minmagnitude', params.minmagnitude);
    if (hasValue(params.maxmagnitude)) query.set('maxmagnitude', params.maxmagnitude);
    if (hasValue(params.mindepth)) query.set('mindepth', params.mindepth);
    if (hasValue(params.maxdepth)) query.set('maxdepth', params.maxdepth);
    if (hasValue(params.limit)) query.set('limit', params.limit);

    if (bounds.minlat !== undefined) query.set('minlatitude', bounds.minlat);
    if (bounds.maxlat !== undefined) query.set('maxlatitude', bounds.maxlat);
    if (bounds.minlon !== undefined) query.set('minlongitude', bounds.minlon);
    if (bounds.maxlon !== undefined) query.set('maxlongitude', bounds.maxlon);

    return query;
  }

  async function fetchGeoJSON(query, options = {}) {
    const url = `${BASE_URL}?${query.toString()}`;
    const { response, text } = await AppUtils.fetchTextWithTimeout(url, {
      signal: options.signal,
      timeoutMs: options.timeoutMs || 20000,
      timeoutMessage: 'USGS APIの応答がタイムアウトしました',
    });

    if (!response.ok) {
      if (response.status === 400) {
        throw new Error(`検索条件にエラーがあります: ${text}`);
      }
      throw new Error(`APIエラー (HTTP ${response.status})`);
    }

    try {
      return JSON.parse(text);
    } catch (_) {
      throw new Error('USGS APIの応答をJSONとして解釈できませんでした');
    }
  }

  function hasValue(value) {
    return value !== undefined && value !== null && value !== '';
  }

  function validateSearchParams(params) {
    if (!params || typeof params !== 'object' || Array.isArray(params)) {
      throw new TypeError('検索条件が不正です');
    }

    const start = parseDateParam(params.starttime, '開始日時');
    const end = parseDateParam(params.endtime, '終了日時');
    if (start && end && start > end) {
      throw new RangeError('開始日は終了日以前にしてください');
    }

    validateNumberParam(params.minmagnitude, '最小マグニチュード', -10, 10);
    validateNumberParam(params.maxmagnitude, '最大マグニチュード', -10, 10);
    validateNumberParam(params.mindepth, '最小深さ', -100, 1000);
    validateNumberParam(params.maxdepth, '最大深さ', 0, 1000);
    validateIntegerParam(params.limit, '最大取得件数', 1, 20000);

    if (hasValue(params.minmagnitude) && hasValue(params.maxmagnitude)
        && Number(params.minmagnitude) > Number(params.maxmagnitude)) {
      throw new RangeError('最小マグニチュードは最大マグニチュード以下にしてください');
    }
    if (hasValue(params.mindepth) && hasValue(params.maxdepth)
        && Number(params.mindepth) > Number(params.maxdepth)) {
      throw new RangeError('最小深さは最大深さ以下にしてください');
    }

    const boundsList = Array.isArray(params.boundsList) ? params.boundsList : null;
    if (boundsList) {
      if (boundsList.length === 0) throw new RangeError('地域範囲が空です');
      boundsList.forEach((bounds, index) => validateBounds(bounds, `地域範囲${index + 1}`));
    } else {
      const hasAnyBounds = ['minlat', 'maxlat', 'minlon', 'maxlon'].some(key => hasValue(params[key]));
      if (params.requireBounds || hasAnyBounds) validateBounds(params, 'カスタム範囲');
    }

    return true;
  }

  function parseDateParam(value, label) {
    if (!hasValue(value)) return null;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) throw new TypeError(`${label}が不正です`);
    return date;
  }

  function validateNumberParam(value, label, min, max) {
    if (!hasValue(value)) return;
    const number = Number(value);
    if (!Number.isFinite(number) || number < min || number > max) {
      throw new RangeError(`${label}は${min}〜${max}の範囲で指定してください`);
    }
  }

  function validateIntegerParam(value, label, min, max) {
    if (!hasValue(value)) return;
    const number = Number(value);
    if (!Number.isInteger(number) || number < min || number > max) {
      throw new RangeError(`${label}は${min}〜${max}の整数で指定してください`);
    }
  }

  function validateBounds(bounds, label) {
    if (!bounds || typeof bounds !== 'object') throw new TypeError(`${label}が不正です`);
    const keys = ['minlat', 'maxlat', 'minlon', 'maxlon'];
    if (keys.some(key => !hasValue(bounds[key]))) {
      throw new RangeError(`${label}は南端・北端・西端・東端をすべて指定してください`);
    }

    validateNumberParam(bounds.minlat, `${label}の南端緯度`, -90, 90);
    validateNumberParam(bounds.maxlat, `${label}の北端緯度`, -90, 90);
    validateNumberParam(bounds.minlon, `${label}の西端経度`, -180, 180);
    validateNumberParam(bounds.maxlon, `${label}の東端経度`, -180, 180);
    if (Number(bounds.minlat) > Number(bounds.maxlat)) {
      throw new RangeError(`${label}の南端緯度は北端緯度以下にしてください`);
    }
    if (Number(bounds.minlon) > Number(bounds.maxlon)) {
      throw new RangeError(`${label}の西端経度は東端経度以下にしてください`);
    }
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
    validateSearchParams,
    buildQuery,
    mergeGeoJSONResponses,
    BASE_URL,
  };
})();
