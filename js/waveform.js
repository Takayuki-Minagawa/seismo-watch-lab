/**
 * waveform.js - IRIS波形ビューアモジュール
 * IRIS FDSN Web Servicesを利用して計器補正済み加速度波形を表示
 */
const WaveformViewer = (() => {
  const IRIS_STATION_URL = 'https://service.iris.edu/fdsnws/station/1/query';
  const TIMESERIES_URL = 'https://service.iris.edu/irisws/timeseries/1/query';
  const MAX_PLOT_POINTS = 4000;
  const STATION_PREVIEW_CONCURRENCY = 4;
  const STATION_PREVIEW_LIMIT = 12;
  const WAVEFORM_CACHE_LIMIT = 8;
  const STATION_INFO_CACHE_LIMIT = 20;
  const CHANNEL_PATTERN = 'HN?,BN?,EN?,HH?,BH?';

  /** FDSN準拠データセンター定義 */
  const FDSN_DATACENTERS = {
    iris: {
      label: 'IRIS / EarthScope',
      region: 'グローバル',
      stationUrl: 'https://service.iris.edu/fdsnws/station/1/query',
    },
    geofon: {
      label: 'GEOFON (GFZ)',
      region: 'グローバル・欧州',
      stationUrl: 'https://geofon.gfz-potsdam.de/fdsnws/station/1/query',
    },
    geonet: {
      label: 'GeoNet',
      region: 'ニュージーランド',
      stationUrl: 'https://service.geonet.org.nz/fdsnws/station/1/query',
    },
    ncedc: {
      label: 'NCEDC',
      region: '北カリフォルニア',
      stationUrl: 'https://service.ncedc.org/fdsnws/station/1/query',
    },
    scedc: {
      label: 'SCEDC',
      region: '南カリフォルニア',
      stationUrl: 'https://service.scedc.caltech.edu/fdsnws/station/1/query',
    },
    orfeus: {
      label: 'ORFEUS (ODC)',
      region: '欧州',
      stationUrl: 'https://www.orfeus-eu.org/fdsnws/station/1/query',
    },
    ingv: {
      label: 'INGV',
      region: 'イタリア',
      stationUrl: 'https://webservices.ingv.it/fdsnws/station/1/query',
    },
    resif: {
      label: 'RESIF',
      region: 'フランス',
      stationUrl: 'https://ws.resif.fr/fdsnws/station/1/query',
    },
    ethz: {
      label: 'ETH Zürich',
      region: 'スイス',
      stationUrl: 'https://eida.ethz.ch/fdsnws/station/1/query',
    },
  };

  let stationData = [];
  let waveformChart = null;
  const waveformDataCache = new Map();
  const stationPublicInfoCache = new Map();
  let stationPublicInfoCacheGeneration = 0;

  /**
   * 震央付近の観測点を検索
   * @param {number} lat - 緯度
   * @param {number} lon - 経度
   * @param {number} maxRadius - 検索半径(度)
   * @param {number|string|Date} eventTime - 地震発生時刻
   * @returns {Promise<Object>} 観測点リストと集計
   */
  async function searchStations(lat, lon, maxRadius = 5, eventTime = null, options = {}) {
    const dcId = options.datacenter || 'iris';
    const dc = FDSN_DATACENTERS[dcId] || FDSN_DATACENTERS.iris;
    const searchUrl = dc.stationUrl;

    const params = new URLSearchParams({
      latitude: lat,
      longitude: lon,
      maxradius: maxRadius,
      level: 'channel',
      format: 'text',
      nodata: '404',
      channel: CHANNEL_PATTERN,
    });

    if (eventTime) {
      const irisTime = formatIRISTime(eventTime);
      params.set('startbefore', irisTime);
      params.set('endafter', irisTime);
    }

    const url = `${searchUrl}?${params.toString()}`;

    let resp;
    let text;
    try {
      const result = await AppUtils.fetchTextWithTimeout(url, {
        signal: options.signal,
        timeoutMs: options.timeoutMs || 20000,
        timeoutMessage: `${dc.label} の観測点検索がタイムアウトしました`,
      });
      resp = result.response;
      text = result.text;
    } catch (networkErr) {
      if (AppUtils.isAbortError(networkErr)) throw networkErr;
      if (networkErr?.message?.includes('タイムアウト')) throw networkErr;
      throw new Error(`${dc.label} に接続できませんでした。ネットワーク接続またはCORS制限の可能性があります`);
    }

    if (!resp.ok) {
      if (resp.status === 404) return { stations: [], candidateCount: 0, checkedCount: 0, availableCount: 0 };
      throw new Error(`観測点検索エラー (${dc.label}: HTTP ${resp.status})`);
    }

    if (!text || !text.trim()) {
      return { stations: [], candidateCount: 0, checkedCount: 0, availableCount: 0 };
    }

    const stations = sortStationsByDistance(parseStationText(text), lat, lon);

    stations.forEach(s => {
      s._datacenter = dcId;
      s._datacenterLabel = dc.label;
    });

    if (!options.requireWaveform || !options.starttime || !options.endtime) {
      stationData = stations;
      return {
        stations: stationData,
        candidateCount: stationData.length,
        checkedCount: stationData.length,
        availableCount: stationData.length,
      };
    }

    const previewLimit = normalizePreviewLimit(options.previewLimit);
    const previewCandidates = stations.slice(0, previewLimit);
    const availableStations = await buildStationPreviews(
      previewCandidates,
      options.starttime,
      options.endtime,
      {
        filterPreset: options.filterPreset || 'none',
        signal: options.signal,
        timeoutMs: options.timeoutMs,
      }
    );

    stationData = availableStations;
    return {
      stations: stationData,
      candidateCount: stations.length,
      checkedCount: previewCandidates.length,
      availableCount: stationData.length,
    };
  }

  function normalizePreviewLimit(value) {
    if (value === undefined || value === null || value === '') return STATION_PREVIEW_LIMIT;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1) return STATION_PREVIEW_LIMIT;
    return Math.min(parsed, 100);
  }

  /**
   * FDSN text形式の観測点データをパース
   */
  function parseStationText(text) {
    const rows = parseFdsnTextTable(text).rows;
    const stations = [];
    const seen = new Set();

    for (const row of rows) {
      const network = getTableRowValue(row, ['Network']);
      const station = getTableRowValue(row, ['Station']);
      const location = getTableRowValue(row, ['Location']);
      const channel = getTableRowValue(row, ['Channel']);
      const lat = parseMaybeFloat(getTableRowValue(row, ['Latitude']));
      const lon = parseMaybeFloat(getTableRowValue(row, ['Longitude']));
      if (!network || !station || !channel || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;

      const key = `${network}.${station}.${location}.${channel}`;
      if (seen.has(key)) continue;
      seen.add(key);

      stations.push({
        network,
        station,
        location,
        channel,
        lat,
        lon,
        elevation: parseMaybeFloat(getTableRowValue(row, ['Elevation'])),
        depth: parseMaybeFloat(getTableRowValue(row, ['Depth'])),
        azimuth: parseMaybeFloat(getTableRowValue(row, ['Azimuth'])),
        dip: parseMaybeFloat(getTableRowValue(row, ['Dip'])),
        sensor: getTableRowValue(row, ['SensorDescription', 'Instrument']),
        scale: getTableRowValue(row, ['Scale']),
        scaleFreq: getTableRowValue(row, ['ScaleFreq']),
        scaleUnits: getTableRowValue(row, ['ScaleUnits']),
        sampleRate: getTableRowValue(row, ['SampleRate']),
        startTime: getTableRowValue(row, ['StartTime']),
        endTime: getTableRowValue(row, ['EndTime']),
        stationKey: `${network}.${station}.${location || '--'}.${channel}`,
        _rawChannelMetadata: row,
      });
    }

    return stations;
  }

  function parseFdsnTextTable(text) {
    const lines = text.trim().split('\n').map(line => line.trim()).filter(Boolean);
    if (!lines.length) return { headers: [], rows: [] };

    const headerLine = lines.find(line => line.startsWith('#'));
    if (!headerLine) return { headers: [], rows: [] };

    const headers = headerLine
      .replace(/^#/, '')
      .split('|')
      .map(trimStationField)
      .filter(Boolean);

    const rows = lines
      .filter(line => !line.startsWith('#'))
      .map(line => {
        const parts = line.split('|');
        const row = {};
        headers.forEach((header, index) => {
          row[header] = trimStationField(parts[index]);
        });
        return row;
      });

    return { headers, rows };
  }

  function trimStationField(value = '') {
    return value.trim();
  }

  function getTableRowValue(row = {}, keys = []) {
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(row, key)) {
        return trimStationField(row[key] || '');
      }
    }
    return '';
  }

  function parseMaybeFloat(value) {
    const num = parseFloat(value);
    return Number.isFinite(num) ? num : null;
  }

  function buildStationQueryURL(station, level = 'channel', format = 'text', eventTime = null) {
    const params = new URLSearchParams({
      net: station.network,
      sta: station.station,
      level,
      format,
      nodata: '404',
    });

    if (level !== 'station') {
      params.set('loc', station.location || '--');
      params.set('cha', station.channel);
    }

    if (eventTime) {
      const irisTime = formatIRISTime(eventTime);
      params.set('startbefore', irisTime);
      params.set('endafter', irisTime);
    }

    return `${IRIS_STATION_URL}?${params.toString()}`;
  }

  function getStationPublicInfoCacheKey(station, eventTime = null) {
    return [
      station.stationKey || `${station.network}.${station.station}.${station.location || '--'}.${station.channel}`,
      eventTime ? normalizeIRISTimeValue(eventTime) : '',
    ].join('|');
  }

  async function fetchStationPublicInfo(station, eventTime = null, options = {}) {
    const cacheKey = getStationPublicInfoCacheKey(station, eventTime);
    if (stationPublicInfoCache.has(cacheKey)) {
      return stationPublicInfoCache.get(cacheKey);
    }

    const cacheGeneration = stationPublicInfoCacheGeneration;
    const stationTextUrl = buildStationQueryURL(station, 'station', 'text', eventTime);
    const channelTextUrl = buildStationQueryURL(station, 'channel', 'text', eventTime);
    const responseXmlUrl = buildStationQueryURL(station, 'response', 'xml', eventTime);
    const siteRow = await fetchStationSiteRow(stationTextUrl, options);
    const info = {
      stationKey: station.stationKey,
      siteRow,
      channelRow: station._rawChannelMetadata || buildFallbackChannelRow(station),
      urls: {
        stationTextUrl,
        channelTextUrl,
        responseXmlUrl,
      },
    };

    if (cacheGeneration === stationPublicInfoCacheGeneration && !options.signal?.aborted) {
      setStationPublicInfoCache(cacheKey, info);
    }
    return info;
  }

  function setStationPublicInfoCache(cacheKey, info) {
    if (stationPublicInfoCache.has(cacheKey)) stationPublicInfoCache.delete(cacheKey);
    stationPublicInfoCache.set(cacheKey, info);
    while (stationPublicInfoCache.size > STATION_INFO_CACHE_LIMIT) {
      stationPublicInfoCache.delete(stationPublicInfoCache.keys().next().value);
    }
  }

  async function fetchStationSiteRow(url, options = {}) {
    const { response: resp, text } = await AppUtils.fetchTextWithTimeout(url, {
      cache: 'no-store',
      signal: options.signal,
      timeoutMs: options.timeoutMs || 15000,
      timeoutMessage: '観測点メタデータ取得がタイムアウトしました',
    });
    if (!resp.ok) {
      if (resp.status === 404) return {};
      throw new Error(`観測点メタデータ取得エラー (HTTP ${resp.status})`);
    }

    const rows = parseFdsnTextTable(text).rows;
    return rows[0] || {};
  }

  function buildFallbackChannelRow(station) {
    return {
      Network: station.network || '',
      Station: station.station || '',
      Location: station.location || '',
      Channel: station.channel || '',
      Latitude: Number.isFinite(station.lat) ? String(station.lat) : '',
      Longitude: Number.isFinite(station.lon) ? String(station.lon) : '',
      Elevation: Number.isFinite(station.elevation) ? String(station.elevation) : '',
      Depth: Number.isFinite(station.depth) ? String(station.depth) : '',
      Azimuth: Number.isFinite(station.azimuth) ? String(station.azimuth) : '',
      Dip: Number.isFinite(station.dip) ? String(station.dip) : '',
      SensorDescription: station.sensor || '',
      Scale: station.scale || '',
      ScaleFreq: station.scaleFreq || '',
      ScaleUnits: station.scaleUnits || '',
      SampleRate: station.sampleRate || '',
      StartTime: station.startTime || '',
      EndTime: station.endTime || '',
    };
  }

  function sortStationsByDistance(stations, originLat, originLon) {
    return stations
      .map(station => ({
        ...station,
        distanceKm: calculateDistanceKm(originLat, originLon, station.lat, station.lon),
      }))
      .sort((a, b) => {
        if (a.distanceKm !== b.distanceKm) return a.distanceKm - b.distanceKm;
        const priorityDifference = channelPriority(a.channel) - channelPriority(b.channel);
        if (priorityDifference !== 0) return priorityDifference;
        return a.stationKey.localeCompare(b.stationKey);
      });
  }

  function channelPriority(channel = '') {
    const normalized = String(channel).toUpperCase();
    const instrument = normalized.slice(0, 2);
    const orientation = normalized.slice(-1);
    const instrumentPriority = ['HN', 'BN', 'EN'].includes(instrument) ? 0 : 10;
    const orientationPriority = ['N', 'E', '1', '2'].includes(orientation)
      ? 0
      : orientation === 'Z' ? 2 : 1;
    return instrumentPriority + orientationPriority;
  }

  /**
   * 観測点選択UIを更新
   */
  function populateStationSelect(stations, selectId) {
    const sel = document.getElementById(selectId);
    if (!sel) return;

    sel.innerHTML = '<option value="">-- 観測点を選択 --</option>';

    const uniqueStations = new Map();
    stations.forEach(station => {
      const key = `${station.network}.${station.station}`;
      if (!uniqueStations.has(key)) {
        uniqueStations.set(key, []);
      }
      uniqueStations.get(key).push(station);
    });

    uniqueStations.forEach((channels, key) => {
      const first = channels[0];
      const group = document.createElement('optgroup');
      const distanceText = Number.isFinite(first.distanceKm) ? `${first.distanceKm.toFixed(1)} km` : '? km';
      group.label = `${key} / ${distanceText}`;

      channels.forEach(channel => {
        const opt = document.createElement('option');
        opt.value = JSON.stringify(channel);
        opt.dataset.stationKey = channel.stationKey;
        opt.textContent = `${channel.channel} [${channel.location || '--'}] / ${formatDistance(channel.distanceKm)} / ${formatMaxAcc(channel.previewMaxAcc, channel.previewUnit)}`;
        group.appendChild(opt);
      });

      sel.appendChild(group);
    });
  }

  function getWaveformDataURL(station, starttime, endtime, options = {}) {
    const params = buildWaveformParams(station, starttime, endtime, options, 'ascii2');
    return `${TIMESERIES_URL}?${params.toString()}`;
  }

  function getWaveformImageURL(station, starttime, endtime, options = {}) {
    const params = buildWaveformParams(station, starttime, endtime, options, 'plot');
    params.set('width', String(options.width || 1000));
    params.set('height', String(options.height || 300));
    return `${TIMESERIES_URL}?${params.toString()}`;
  }

  function buildWaveformParams(station, starttime, endtime, options = {}, format = 'ascii2') {
    const params = new URLSearchParams();
    params.append('net', station.network);
    params.append('sta', station.station);
    params.append('loc', station.location || '--');
    params.append('cha', station.channel);
    params.append('starttime', normalizeIRISTimeValue(starttime));
    params.append('endtime', normalizeIRISTimeValue(endtime));
    params.append('taper', '0.05');
    params.append('demean', 'true');
    params.append('correct', 'true');
    params.append('units', 'ACC');

    applyFilterPreset(params, options.filterPreset);
    params.append('format', format);
    return params;
  }

  function applyFilterPreset(params, filterPreset = 'none') {
    switch (filterPreset) {
      case 'lp-1':
        params.set('lpfilter', '1');
        break;
      case 'lp-5':
        params.set('lpfilter', '5');
        break;
      case 'hp-0.1':
        params.set('hpfilter', '0.1');
        break;
      case 'hp-1':
        params.set('hpfilter', '1');
        break;
      default:
        break;
    }
  }

  function getFilterLabel(filterPreset = 'none') {
    switch (filterPreset) {
      case 'lp-1':
        return 'Low-pass 1 Hz';
      case 'lp-5':
        return 'Low-pass 5 Hz';
      case 'hp-0.1':
        return 'High-pass 0.1 Hz';
      case 'hp-1':
        return 'High-pass 1 Hz';
      default:
        return 'なし (taper + demean)';
    }
  }

  async function fetchWaveformData(station, starttime, endtime, options = {}) {
    return getOrFetchWaveformData(station, starttime, endtime, options);
  }

  async function buildStationPreviews(stations, starttime, endtime, options = {}) {
    if (!stations.length) return [];

    const available = [];
    let currentIndex = 0;

    async function worker() {
      while (currentIndex < stations.length) {
        if (options.signal?.aborted) throw options.signal.reason || new DOMException('Aborted', 'AbortError');
        const index = currentIndex++;
        const station = stations[index];
        const preview = await fetchStationPreview(station, starttime, endtime, options);
        if (preview) available.push({ index, station: preview });
      }
    }

    const workerCount = Math.min(STATION_PREVIEW_CONCURRENCY, stations.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    return available
      .sort((a, b) => a.index - b.index)
      .map(entry => entry.station);
  }

  async function fetchStationPreview(station, starttime, endtime, options = {}) {
    try {
      const data = await getOrFetchWaveformData(station, starttime, endtime, options);
      return {
        ...station,
        previewMaxAcc: data.meta._maxAcc,
        previewDuration: data.meta._duration,
        previewNpts: data.meta._npts,
        previewSampleRate: data.meta._sampleRate,
        previewUnit: data.meta._displayUnit || 'gal',
      };
    } catch (_) {
      if (AppUtils.isAbortError(_)) throw _;
      return null;
    }
  }

  async function getOrFetchWaveformData(station, starttime, endtime, options = {}) {
    const cacheKey = getWaveformCacheKey(station, starttime, endtime, options);
    if (waveformDataCache.has(cacheKey)) {
      return waveformDataCache.get(cacheKey);
    }

    const dataUrl = getWaveformDataURL(station, starttime, endtime, options);
    const plotUrl = getWaveformImageURL(station, starttime, endtime, options);
    const { response: resp, text } = await AppUtils.fetchTextWithTimeout(dataUrl, {
      cache: 'no-store',
      signal: options.signal,
      timeoutMs: options.timeoutMs || 30000,
      timeoutMessage: '波形取得がタイムアウトしました',
    });

    if (!resp.ok) {
      if (resp.status === 404) {
        throw new Error('この観測点・時間帯の波形データは見つかりませんでした');
      }
      throw new Error(`波形取得エラー (HTTP ${resp.status})`);
    }

    const data = parseWaveformText(text, {
      station,
      starttime,
      endtime,
      dataUrl,
      plotUrl,
      filterPreset: options.filterPreset || 'none',
      requestedUnit: 'ACC',
      responseCorrected: true,
    });
    setWaveformCache(cacheKey, data);
    return data;
  }

  function setWaveformCache(cacheKey, data) {
    if (waveformDataCache.has(cacheKey)) waveformDataCache.delete(cacheKey);
    waveformDataCache.set(cacheKey, data);
    while (waveformDataCache.size > WAVEFORM_CACHE_LIMIT) {
      const oldestKey = waveformDataCache.keys().next().value;
      waveformDataCache.delete(oldestKey);
    }
  }

  function getWaveformCacheKey(station, starttime, endtime, options = {}) {
    return [
      station.stationKey || `${station.network}.${station.station}.${station.location || '--'}.${station.channel}`,
      normalizeIRISTimeValue(starttime),
      normalizeIRISTimeValue(endtime),
      options.filterPreset || 'none',
    ].join('|');
  }

  function parseWaveformText(text, context = {}) {
    const lines = text.trim().split('\n').filter(Boolean);
    if (lines.length < 2 || !lines[0].startsWith('TIMESERIES')) {
      throw new Error('IRIS波形データの形式を解釈できませんでした');
    }

    const header = lines[0].trim();
    const seriesIdMatch = header.match(/^TIMESERIES\s+([^,]+),/);
    const sampleCountMatch = header.match(/,\s*(\d+)\s+samples,/);
    const sampleRateMatch = header.match(/,\s*([\d.]+)\s+sps,/);
    const startTimeMatch = header.match(/,\s*([\d-]{4}-\d{2}-\d{2}T[\d:.]+),\s*TSPAIR/);
    const headerUnit = extractWaveformHeaderUnit(header);
    const headerSampleType = extractWaveformHeaderSampleType(header);
    const unitInfo = getAccelerationUnitInfo({
      reportedUnit: headerUnit,
      sampleType: headerSampleType,
      requestedUnit: context.requestedUnit || 'ACC',
      responseCorrected: Boolean(context.responseCorrected),
    });

    if (!unitInfo) {
      if (normalizeWaveformUnit(headerUnit) === 'COUNTS') {
        throw new Error('IRIS が COUNTS の生波形を返しました。加速度として扱うには計器特性補正が必要です');
      }
      throw new Error(`IRIS が加速度単位として解釈できない波形を返しました (${headerUnit || 'unknown'})`);
    }

    const acc = [];
    const sampleTimes = [];
    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].trim().split(/\s+/);
      if (parts.length < 2) continue;

      const value = parseFloat(parts[parts.length - 1]);
      if (!isNaN(value)) {
        acc.push(value * unitInfo.toGalFactor);
        sampleTimes.push(parseIRISTimestamp(parts[0]));
      }
    }

    if (acc.length === 0) {
      throw new Error('波形サンプルが取得できませんでした');
    }

    let dt = sampleRateMatch ? 1 / parseFloat(sampleRateMatch[1]) : null;
    if (!dt || !isFinite(dt) || dt <= 0) {
      dt = estimateDtFromDataLines(lines);
    }
    if (!dt || !isFinite(dt) || dt <= 0) {
      throw new Error('サンプリング間隔を特定できませんでした');
    }

    const duration = Math.max(0, (acc.length - 1) * dt);
    const declaredSampleCount = sampleCountMatch ? parseInt(sampleCountMatch[1], 10) : null;
    const timingQuality = inspectSampleTiming(sampleTimes, dt);
    const sampleCountMismatch = Number.isInteger(declaredSampleCount) && declaredSampleCount !== acc.length;
    const timingIssues = [...timingQuality.issues];
    if (sampleCountMismatch) {
      timingIssues.push(`ヘッダー宣言 ${declaredSampleCount} 点に対して ${acc.length} 点を読み込みました`);
    }
    const station = context.station || {};
    const stationId = `${station.network || ''}.${station.station || ''}.${station.location || '--'}.${station.channel || ''}`;

    return {
      acc,
      dt,
      meta: {
        _npts: acc.length,
        _dt: dt,
        _duration: duration,
        _maxAcc: AppUtils.maxAbs(acc),
        _sampleRate: sampleRateMatch ? parseFloat(sampleRateMatch[1]) : 1 / dt,
        _sampleCountHeader: declaredSampleCount ?? acc.length,
        _seriesId: seriesIdMatch ? seriesIdMatch[1] : '',
        _startTime: startTimeMatch ? `${startTimeMatch[1]}Z` : '',
        _stationId: stationId.replace(/^\.+|\.+$/g, ''),
        _stationName: station.name || '',
        _dataUrl: context.dataUrl || '',
        _plotUrl: context.plotUrl || '',
        _filterPreset: context.filterPreset || 'none',
        _filterLabel: getFilterLabel(context.filterPreset),
        _timeWindowStart: normalizeIRISTimeValue(context.starttime),
        _timeWindowEnd: normalizeIRISTimeValue(context.endtime),
        _source: buildWaveformSourceLabel(unitInfo),
        _inputUnit: unitInfo.inputLabel,
        _inputUnitReported: headerUnit || '',
        _displayUnit: unitInfo.displayUnit,
        _hasTimingGap: timingQuality.hasGap || sampleCountMismatch,
        _maxSampleGap: timingQuality.maxGap,
        _timingIssues: timingIssues,
      },
    };
  }

  function inspectSampleTiming(sampleTimes, expectedDt) {
    let hasGap = false;
    let maxGap = 0;
    const issues = [];
    const tolerance = Math.max(expectedDt * 0.25, 0.002);

    const invalidTimestampCount = sampleTimes.filter(time => !(time instanceof Date) || Number.isNaN(time.getTime())).length;
    if (invalidTimestampCount > 0) {
      hasGap = true;
      issues.push(`${invalidTimestampCount} 点の時刻を解析できませんでした`);
    }

    for (let index = 1; index < sampleTimes.length; index++) {
      const previous = sampleTimes[index - 1];
      const current = sampleTimes[index];
      if (!(previous instanceof Date) || Number.isNaN(previous.getTime())
          || !(current instanceof Date) || Number.isNaN(current.getTime())) continue;
      const gap = (current.getTime() - previous.getTime()) / 1000;
      maxGap = Math.max(maxGap, gap);
      if (gap <= 0 || Math.abs(gap - expectedDt) > tolerance) {
        hasGap = true;
        if (issues.length === 0) issues.push('サンプル時刻の不連続を検出しました');
      }
    }

    return { hasGap, maxGap, issues };
  }

  function extractWaveformHeaderUnit(header = '') {
    const parts = header.split(',').map(part => part.trim()).filter(Boolean);
    return parts.length > 0 ? parts[parts.length - 1] : '';
  }

  function extractWaveformHeaderSampleType(header = '') {
    const parts = header.split(',').map(part => part.trim()).filter(Boolean);
    return parts.length > 1 ? parts[parts.length - 2] : '';
  }

  function normalizeWaveformUnit(unit = '') {
    return unit.toUpperCase().replace(/\s+/g, '');
  }

  function normalizeWaveformSampleType(sampleType = '') {
    return sampleType.toUpperCase().replace(/\s+/g, '');
  }

  function isFloatWaveformSampleType(sampleType = '') {
    return ['FLOAT', 'DOUBLE', 'REAL'].includes(sampleType);
  }

  function getAccelerationUnitInfo({
    reportedUnit = '',
    sampleType = '',
    requestedUnit = 'ACC',
    responseCorrected = false,
  } = {}) {
    const normalized = normalizeWaveformUnit(reportedUnit);
    const normalizedSampleType = normalizeWaveformSampleType(sampleType);

    if (normalized === 'GAL') {
      return {
        toGalFactor: 1,
        displayUnit: 'gal',
        inputLabel: 'gal',
        inferredFromRequest: false,
      };
    }

    const match = normalized.match(/^([A-Z]+)\/(?:(?:S|SEC)(?:\*\*2|\^2|2)|(?:S|SEC)\/(?:S|SEC))$/);
    if (match) {
      const factorByPrefix = {
        M: 100,
        CM: 1,
        MM: 0.1,
        UM: 0.0001,
        NM: 0.0000001,
      };

      const toGalFactor = factorByPrefix[match[1]];
      if (!toGalFactor) return null;

      return {
        toGalFactor,
        displayUnit: 'gal',
        inputLabel: reportedUnit,
        inferredFromRequest: false,
      };
    }

    if (
      normalized === 'COUNTS'
      && responseCorrected
      && requestedUnit === 'ACC'
      && isFloatWaveformSampleType(normalizedSampleType)
    ) {
      return {
        toGalFactor: 100,
        displayUnit: 'gal',
        inputLabel: 'm/s^2 (ACC request; header reported COUNTS)',
        inferredFromRequest: true,
      };
    }

    return null;
  }

  function buildWaveformSourceLabel(unitInfo) {
    if (unitInfo.inferredFromRequest) {
      return 'IRIS 計器補正済み加速度 (correct=true, units=ACC / ヘッダー単位: COUNTS)';
    }

    return 'IRIS 計器補正済み加速度';
  }

  function estimateDtFromDataLines(lines) {
    if (lines.length < 3) return null;

    const first = parseIRISTimestamp(lines[1].trim().split(/\s+/)[0]);
    const second = parseIRISTimestamp(lines[2].trim().split(/\s+/)[0]);
    if (!first || !second) return null;

    return (second.getTime() - first.getTime()) / 1000;
  }

  function parseIRISTimestamp(value) {
    if (!value) return null;
    const normalized = /Z$/.test(value) ? value : `${value}Z`;
    const date = new Date(normalized);
    return isNaN(date.getTime()) ? null : date;
  }

  /**
   * 地震情報から波形表示時間を設定
   * @param {Object} feature - GeoJSON feature
   * @returns {Object} { starttime, endtime }
   */
  function getTimeWindow(feature) {
    const originTime = new Date(feature.properties.time);
    const mag = feature.properties.mag || 5;

    const durationMinutes = Math.max(5, Math.min(30, mag * 3));
    const preSeconds = 60;

    const start = new Date(originTime.getTime() - preSeconds * 1000);
    const end = new Date(originTime.getTime() + durationMinutes * 60 * 1000);

    return {
      starttime: formatIRISTime(start),
      endtime: formatIRISTime(end),
    };
  }

  function normalizeIRISTimeValue(value) {
    if (value instanceof Date || typeof value === 'number') {
      return formatIRISTime(value);
    }

    if (typeof value !== 'string') {
      return value;
    }

    return value.replace(/\.\d+Z$/, '').replace(/Z$/, '');
  }

  function formatIRISTime(value) {
    const date = value instanceof Date ? value : new Date(value);
    return date.toISOString().replace(/\.\d{3}Z$/, '');
  }

  function normalizeRange(data, rangeStart = 0, rangeEnd = null) {
    const totalDuration = data.meta?._duration ?? Math.max(0, (data.acc.length - 1) * data.dt);
    let safeStart = Number.isFinite(rangeStart) ? Math.max(0, Math.min(rangeStart, totalDuration)) : 0;
    let safeEnd = Number.isFinite(rangeEnd) ? Math.min(rangeEnd, totalDuration) : totalDuration;

    if (!Number.isFinite(safeEnd) || safeEnd <= safeStart) {
      safeEnd = Math.min(totalDuration, safeStart + Math.max(data.dt * 10, 1));
    }
    if (safeEnd <= safeStart) {
      const fallbackSpan = Math.max(data.dt * 10, 1);
      safeStart = Math.max(0, totalDuration - fallbackSpan);
      safeEnd = totalDuration;
    }

    return { start: safeStart, end: safeEnd };
  }

  function sliceWaveformData(data, rangeStart = 0, rangeEnd = null) {
    const range = normalizeRange(data, rangeStart, rangeEnd);
    const startIndex = Math.max(0, AppUtils.sampleIndexAtOrAfter(range.start, data.dt));
    const endIndex = Math.min(data.acc.length - 1, AppUtils.sampleIndexAtOrBefore(range.end, data.dt));
    if (endIndex <= startIndex) throw new RangeError('表示区間には2点以上のサンプルが必要です');
    const slicedAcc = data.acc.slice(startIndex, endIndex + 1);
    const effectiveStart = startIndex * data.dt;
    const effectiveEnd = endIndex * data.dt;

    return {
      acc: slicedAcc,
      dt: data.dt,
      meta: {
        ...data.meta,
        _npts: slicedAcc.length,
        _duration: Math.max(0, (slicedAcc.length - 1) * data.dt),
        _maxAcc: AppUtils.maxAbs(slicedAcc),
        _requestedWindowStart: range.start,
        _requestedWindowEnd: range.end,
        _analysisWindowStart: effectiveStart,
        _analysisWindowEnd: effectiveEnd,
      },
    };
  }

  function renderWaveform(data, containerId, options = {}) {
    const container = document.getElementById(containerId);
    if (!container) return { start: 0, end: 0 };

    const range = normalizeRange(
      data,
      options.start ?? options.rangeStart,
      options.end ?? options.rangeEnd
    );
    const waveformSlice = sliceWaveformData(data, range.start, range.end);
    const chartPoints = buildChartPoints(
      waveformSlice.acc,
      waveformSlice.dt,
      waveformSlice.meta._analysisWindowStart
    );
    const canvasId = `${containerId}-canvas`;
    const dataUrl = AppUtils.sanitizeHttpUrl(data.meta._dataUrl);
    const plotUrl = AppUtils.sanitizeHttpUrl(data.meta._plotUrl);
    const sourceLinks = [
      dataUrl ? `<a href="${escapeHtml(dataUrl)}" target="_blank" rel="noopener" class="btn btn-sm btn-outline">ASCII2</a>` : '',
      plotUrl ? `<a href="${escapeHtml(plotUrl)}" target="_blank" rel="noopener" class="btn btn-sm btn-outline">IRISプロット</a>` : '',
    ].filter(Boolean).join(' ');

    container.innerHTML = `
      <div class="waveform-chart-box">
        <canvas id="${canvasId}"></canvas>
      </div>
      <div class="waveform-meta">
        <span>観測点: ${escapeHtml(data.meta._stationId || '?')}</span>
        <span>点数: ${waveformSlice.meta._npts}</span>
        <span>dt: ${waveformSlice.meta._dt.toFixed(4)} 秒</span>
        <span>表示指定: ${range.start.toFixed(2)} - ${range.end.toFixed(2)} 秒</span>
        <span>実効サンプル範囲: ${waveformSlice.meta._analysisWindowStart.toFixed(2)} - ${waveformSlice.meta._analysisWindowEnd.toFixed(2)} 秒</span>
        <span>最大加速度: ${waveformSlice.meta._maxAcc.toFixed(2)} ${data.meta._displayUnit || 'gal'}</span>
        <span>フィルタ: ${escapeHtml(data.meta._filterLabel || 'なし')}</span>
      </div>
      <div class="waveform-info">
        <span>${escapeHtml(data.meta._source)} / 返却ヘッダー: ${escapeHtml(data.meta._inputUnitReported || '?')} / 解析単位: ${escapeHtml(data.meta._inputUnit || '?')} / 表示単位: ${escapeHtml(data.meta._displayUnit || 'gal')}</span>
        <span>
          ${sourceLinks}
        </span>
      </div>
    `;

    const canvas = document.getElementById(canvasId);
    if (!canvas) return range;

    if (waveformChart) {
      waveformChart.destroy();
      waveformChart = null;
    }

    waveformChart = new Chart(canvas, {
      type: 'line',
      data: {
        datasets: [{
          label: `加速度 (${data.meta._displayUnit || 'gal'})`,
          data: chartPoints,
          borderColor: '#dd6b20',
          borderWidth: 1.2,
          pointRadius: 0,
          fill: false,
          parsing: false,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        interaction: {
          mode: 'nearest',
          intersect: false,
        },
        plugins: {
          title: {
            display: true,
            text: 'IRIS 計器補正済み加速度波形',
          },
          legend: {
            display: false,
          },
        },
        scales: {
          x: {
            type: 'linear',
            min: range.start,
            max: range.end,
            title: {
              display: true,
              text: '時間 (秒)',
            },
          },
          y: {
            title: {
              display: true,
              text: `加速度 (${data.meta._displayUnit || 'gal'})`,
            },
          },
        },
      },
    });

    return range;
  }

  function buildChartPoints(acc, dt, offsetSeconds = 0) {
    const pointCount = acc.length;
    const step = Math.max(1, Math.ceil(pointCount / MAX_PLOT_POINTS));
    const points = [];

    for (let i = 0; i < pointCount; i += step) {
      points.push({
        x: offsetSeconds + i * dt,
        y: acc[i],
      });
    }

    const lastIndex = pointCount - 1;
    if (lastIndex >= 0 && (points.length === 0 || points[points.length - 1].x < offsetSeconds + lastIndex * dt)) {
      points.push({
        x: offsetSeconds + lastIndex * dt,
        y: acc[lastIndex],
      });
    }

    return points;
  }

  async function displayWaveform(station, starttime, endtime, containerId, options = {}) {
    const container = document.getElementById(containerId);
    if (!container) return null;

    container.innerHTML = `
      <div class="waveform-loading">IRIS から計器補正済み加速度波形を取得中...</div>
    `;

    const data = await fetchWaveformData(station, starttime, endtime, options);
    const range = renderWaveform(data, containerId, options);
    data.meta._viewStart = range.start;
    data.meta._viewEnd = range.end;
    return data;
  }

  function resetDisplay(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;

    if (waveformChart) {
      waveformChart.destroy();
      waveformChart = null;
    }

    container.innerHTML = `
      <div class="waveform-placeholder">
        地震を選択し、観測点を検索してから波形を表示してください
      </div>
    `;
  }

  function clearCache() {
    waveformDataCache.clear();
    stationPublicInfoCache.clear();
    stationPublicInfoCacheGeneration += 1;
  }

  function calculateDistanceKm(lat1, lon1, lat2, lon2) {
    const toRad = deg => deg * Math.PI / 180;
    const earthRadiusKm = 6371;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2
      + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return earthRadiusKm * c;
  }

  function formatDistance(distanceKm) {
    return Number.isFinite(distanceKm) ? `${distanceKm.toFixed(1)} km` : '-';
  }

  function formatMaxAcc(maxAcc, unit = 'gal') {
    return Number.isFinite(maxAcc) ? `max ${maxAcc.toFixed(2)} ${unit}` : 'max -';
  }

  function escapeHtml(str) {
    return AppUtils.escapeHtml(str);
  }

  function getDatacenters() {
    return FDSN_DATACENTERS;
  }

  return {
    searchStations,
    populateStationSelect,
    getTimeWindow,
    displayWaveform,
    fetchWaveformData,
    fetchStationPublicInfo,
    renderWaveform,
    resetDisplay,
    clearCache,
    sliceWaveformData,
    normalizeRange,
    parseWaveformText,
    channelPriority,
    getWaveformDataURL,
    getWaveformImageURL,
    formatIRISTime,
    getDatacenters,
  };
})();
