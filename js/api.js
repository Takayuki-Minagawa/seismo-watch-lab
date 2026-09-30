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

    if (responses.length === 1) return withResultMetadata(responses[0], params.limit);
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

  function buildQuery(params, bounds = params) {
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

    if (hasValue(params.latitude)) query.set('latitude', params.latitude);
    if (hasValue(params.longitude)) query.set('longitude', params.longitude);
    if (hasValue(params.maxradiuskm)) query.set('maxradiuskm', params.maxradiuskm);

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

    if (response.status === 204) {
      return { type: 'FeatureCollection', features: [], metadata: { count: 0 } };
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch (_) {
      throw new Error('USGS APIの応答をJSONとして解釈できませんでした');
    }
    validateGeoJSONResponse(data);
    return data;
  }

  function validateGeoJSONResponse(data) {
    const validObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
    if (!validObject(data) || data.type !== 'FeatureCollection' || !Array.isArray(data.features)
        || (data.metadata !== undefined && !validObject(data.metadata))) {
      throw new Error('USGS APIの応答が有効な地震GeoJSONではありません');
    }

    const invalidFeature = data.features.some(feature => {
      if (!validObject(feature) || feature.type !== 'Feature' || !validObject(feature.properties)
          || !validObject(feature.geometry) || feature.geometry.type !== 'Point') return true;
      const coordinates = feature.geometry.coordinates;
      const properties = feature.properties;
      return !Array.isArray(coordinates) || coordinates.length < 3
        || !coordinates.slice(0, 2).every(Number.isFinite)
        || (coordinates[2] !== null && !Number.isFinite(coordinates[2]))
        || !Number.isFinite(properties.time)
        || (properties.mag !== null && !Number.isFinite(properties.mag))
        || ['place', 'status', 'magType', 'type'].some(key => properties[key] != null && typeof properties[key] !== 'string');
    });
    if (invalidFeature) {
      throw new Error('USGS APIの応答に無効な地震データが含まれています');
    }
  }

  function withResultMetadata(data, limit, limitReached = false) {
    const numericLimit = Number(limit);
    const hasLimit = Number.isInteger(numericLimit) && numericLimit > 0;
    return {
      ...data,
      metadata: {
        ...(data.metadata || {}),
        count: data.features.length,
        // 上限と同数でも実際に省略されたとは限らないため、可能性だけを通知する。
        limitReached: limitReached || (hasLimit && data.features.length >= numericLimit),
      },
    };
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
    validateNumberParam(params.maxdepth, '最大深さ', -100, 1000);
    validateIntegerParam(params.limit, '最大取得件数', 1, 20000);

    if (hasValue(params.minmagnitude) && hasValue(params.maxmagnitude)
        && Number(params.minmagnitude) > Number(params.maxmagnitude)) {
      throw new RangeError('最小マグニチュードは最大マグニチュード以下にしてください');
    }
    if (hasValue(params.mindepth) && hasValue(params.maxdepth)
        && Number(params.mindepth) > Number(params.maxdepth)) {
      throw new RangeError('最小深さは最大深さ以下にしてください');
    }

    const rectangleKeys = ['minlat', 'maxlat', 'minlon', 'maxlon'];
    const hasAnyBounds = rectangleKeys.some(key => hasValue(params[key]));
    const circleKeys = ['latitude', 'longitude', 'maxradiuskm'];
    const hasCircle = params.requireCircle || circleKeys.some(key => hasValue(params[key]));
    if (hasCircle) {
      if (params.requireBounds || hasAnyBounds || hasValue(params.boundsList)) {
        throw new RangeError('中心・半径と矩形の地域範囲は同時に指定できません');
      }
      if (circleKeys.some(key => !hasValue(params[key]))) {
        throw new RangeError('中心緯度・中心経度・半径をすべて指定してください');
      }
      validateNumberParam(params.latitude, '中心緯度', -90, 90);
      validateNumberParam(params.longitude, '中心経度', -180, 180);
      validateNumberParam(params.maxradiuskm, '半径', 0, 20001.6);
    }

    if (hasValue(params.boundsList) && !Array.isArray(params.boundsList)) {
      throw new TypeError('地域範囲の一覧が不正です');
    }
    const boundsList = Array.isArray(params.boundsList) ? params.boundsList : null;
    if (boundsList) {
      if (boundsList.length === 0) throw new RangeError('地域範囲が空です');
      boundsList.forEach((bounds, index) => validateBounds(bounds, `地域範囲${index + 1}`));
    } else {
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
    const merged = {
      ...base,
      features,
      metadata: {
        ...(base.metadata || {}),
        count: features.length,
      },
    };
    // 複数リクエストでは先頭レスポンスの範囲・URLは統合結果を表さない。
    if (responses.length > 1) {
      delete merged.bbox;
      delete merged.metadata.url;
    }
    const limitReached = responses.some(data => data.metadata?.limitReached
      || (Number.isFinite(parsedLimit) && parsedLimit > 0 && data.features.length >= parsedLimit))
      || mergedFeatures.length > features.length;
    return withResultMetadata(merged, limit, limitReached);
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
