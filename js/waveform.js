/**
 * waveform.js - 観測サイト波形ビューアモジュール
 * 公開波形・計器情報から加速度を取得し、galで表示
 */
const WaveformViewer = (() => {
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
      stationUrl: 'https://service.earthscope.org/fdsnws/station/1/query',
      dataUrl: 'https://service.earthscope.org/fdsnws/dataselect/1/query',
    },
    geofon: {
      label: 'GEOFON (GFZ)',
      region: 'グローバル・欧州',
      stationUrl: 'https://geofon.gfz.de/fdsnws/station/1/query',
      dataUrl: 'https://geofon.gfz.de/fdsnws/dataselect/1/query',
    },
    geonet: {
      label: 'GeoNet',
      region: 'ニュージーランド',
      stationUrl: 'https://service.geonet.org.nz/fdsnws/station/1/query',
      dataUrl: 'https://service.geonet.org.nz/fdsnws/dataselect/1/query',
    },
    ncedc: {
      label: 'NCEDC',
      region: '北カリフォルニア',
      stationUrl: 'https://service.ncedc.org/fdsnws/station/1/query',
      dataUrl: 'https://service.ncedc.org/fdsnws/dataselect/1/query',
    },
    scedc: {
      label: 'SCEDC',
      region: '南カリフォルニア',
      stationUrl: 'https://service.scedc.caltech.edu/fdsnws/station/1/query',
      dataUrl: 'https://service.scedc.caltech.edu/fdsnws/dataselect/1/query',
    },
    orfeus: {
      label: 'ORFEUS (ODC)',
      region: '欧州',
      stationUrl: 'https://www.orfeus-eu.org/fdsnws/station/1/query',
      dataUrl: 'https://www.orfeus-eu.org/fdsnws/dataselect/1/query',
    },
    ingv: {
      label: 'INGV',
      region: 'イタリア',
      stationUrl: 'https://webservices.ingv.it/fdsnws/station/1/query',
      dataUrl: 'https://webservices.ingv.it/fdsnws/dataselect/1/query',
    },
    resif: {
      label: 'RESIF',
      region: 'フランス',
      stationUrl: 'https://ws.resif.fr/fdsnws/station/1/query',
      dataUrl: 'https://ws.resif.fr/fdsnws/dataselect/1/query',
    },
    ethz: {
      label: 'ETH Zürich',
      region: 'スイス',
      stationUrl: 'https://eida.ethz.ch/fdsnws/station/1/query',
      dataUrl: 'https://eida.ethz.ch/fdsnws/dataselect/1/query',
    },
    jma: { label: '気象庁 公開強震波形', region: '日本・主な地震' },
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
    if (dcId === 'jma') {
      const result = await JmaWaveform.searchStations(lat, lon, maxRadius, eventTime, options);
      stationData = result.stations;
      return result;
    }
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
      throwIfServiceRetired(resp.status, text);
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
        checkedCount: 0,
        availableCount: 0,
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
        scaleFreq: getTableRowValue(row, ['ScaleFrequency', 'ScaleFreq']),
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
    const datacenter = FDSN_DATACENTERS[station._datacenter] || FDSN_DATACENTERS.iris;
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

    return `${datacenter.stationUrl}?${params.toString()}`;
  }

  function getStationPublicInfoCacheKey(station, eventTime = null) {
    const datacenter = FDSN_DATACENTERS[station._datacenter] || FDSN_DATACENTERS.iris;
    return [
      datacenter.stationUrl,
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
      datacenterLabel: (FDSN_DATACENTERS[station._datacenter] || FDSN_DATACENTERS.iris).label,
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
      throwIfServiceRetired(resp.status, text);
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
      const distanceText = Number.isFinite(first.distanceKm) ? `${first.distanceKm.toFixed(1)} km` : '距離情報なし';
      group.label = `${first.name || key} / ${distanceText}`;

      channels.forEach(channel => {
        const opt = document.createElement('option');
        opt.value = JSON.stringify(channel);
        opt.dataset.stationKey = channel.stationKey;
        opt.textContent = `${channel.channel} [${channel.location || '--'}] / ${formatDistance(channel.distanceKm)} / ${channel.name || formatMaxAcc(channel.previewMaxAcc, channel.previewUnit)}`;
        group.appendChild(opt);
      });

      sel.appendChild(group);
    });
  }

  function getWaveformDataURL(station, starttime, endtime) {
    if (station._datacenter === 'jma') return station._csvUrl || '';
    const dc = FDSN_DATACENTERS[station._datacenter || 'iris'];
    if (!dc?.dataUrl) throw new Error('波形配信先が不明です');
    const params = new URLSearchParams({ net: station.network, sta: station.station,
      loc: station.location || '--', cha: station.channel,
      starttime: normalizeIRISTimeValue(starttime), endtime: normalizeIRISTimeValue(endtime), nodata: '404' });
    return `${dc.dataUrl}?${params}`;
  }

  function getWaveformImageURL() { return ''; }

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
      if (_?.code === 'SERVICE_RETIRED') throw _;
      return null;
    }
  }

  async function getOrFetchWaveformData(station, starttime, endtime, options = {}) {
    const cacheKey = getWaveformCacheKey(station, starttime, endtime, options);
    if (waveformDataCache.has(cacheKey)) {
      return waveformDataCache.get(cacheKey);
    }

    const data = station._datacenter === 'jma'
      ? await JmaWaveform.fetchWaveformData(station, starttime, endtime, options)
      : await RemoteWaveform.load(station, normalizeIRISTimeValue(starttime), normalizeIRISTimeValue(endtime),
        FDSN_DATACENTERS[station._datacenter || 'iris'], options);
    if (options.signal?.aborted) throw options.signal.reason || new DOMException('Aborted', 'AbortError');
    validateAccelerationData(data);
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
      station._datacenter || 'iris',
      JSON.stringify(options.preFilter || null),
      station.stationKey || `${station.network}.${station.station}.${station.location || '--'}.${station.channel}`,
      normalizeIRISTimeValue(starttime),
      normalizeIRISTimeValue(endtime),
      options.filterPreset || 'none',
    ].join('|');
  }

  function throwIfServiceRetired(status, text) {
    if (status === 404 && /(?:timeseries|service|endpoint)/i.test(text)
        && /(?:retir(?:ed|ement)|discontinued|decommissioned)/i.test(text)) {
      const error = new Error('データサービスは提供を終了しました。単位を確認できる別の取得元が必要です');
      error.code = 'SERVICE_RETIRED';
      throw error;
    }
  }

  function parseWaveformText(text, context = {}) {
    const lines = String(text).trim().split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    if (lines.length < 3) {
      throw new Error('ASCII2波形データの形式を解釈できませんでした');
    }

    const header = lines[0];
    const fields = header.split(',').map(field => field.trim());
    const seriesIdMatch = fields[0]?.match(/^TIMESERIES\s+(\S+)$/);
    const sampleCountMatch = fields[1]?.match(/^([1-9]\d*)\s+samples$/);
    const sampleRateMatch = fields[2]?.match(/^(\S+)\s+sps$/);
    const sampleCount = sampleCountMatch ? Number(sampleCountMatch[1]) : NaN;
    const sampleRate = sampleRateMatch && isNumericToken(sampleRateMatch[1]) ? Number(sampleRateMatch[1]) : NaN;
    const headerStartTime = fields[3];
    const startDate = parseIRISTimestamp(headerStartTime);
    const validStart = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?$/.test(headerStartTime || '')
      && startDate && startDate.toISOString().slice(0, 19) === headerStartTime.slice(0, 19);
    if (fields.length !== 7 || !seriesIdMatch || !Number.isSafeInteger(sampleCount) || sampleCount < 2
        || !Number.isFinite(sampleRate) || sampleRate <= 0 || !validStart || fields[4] !== 'TSPAIR'
        || !['INTEGER', 'FLOAT', 'DOUBLE', 'REAL'].includes(fields[5])) {
      throw new Error('ASCII2波形ヘッダーが不正です。サンプル数・周波数・時刻・形式を確認してください');
    }
    const identifier = seriesIdMatch[1].split(/[._]/);
    if (identifier.length < 4 || !identifier[0] || !identifier[1] || !identifier[3]) {
      throw new Error('ASCII2波形ヘッダーの観測点識別子が不正です');
    }
    const station = context.station || {};
    if (['network', 'station', 'channel'].every(key => typeof station[key] === 'string' && station[key])) {
      const normalizeCode = value => String(value || '').toUpperCase();
      const normalizeLocation = value => value === '--' ? '' : normalizeCode(value);
      if (identifier.length < 4 || normalizeCode(identifier[0]) !== normalizeCode(station.network)
          || normalizeCode(identifier[1]) !== normalizeCode(station.station)
          || normalizeLocation(identifier[2]) !== normalizeLocation(station.location)
          || normalizeCode(identifier[3]) !== normalizeCode(station.channel)) {
        throw new Error('返却された波形の観測点・チャンネルが要求と一致しません');
      }
    }
    const headerUnit = fields[6];
    const unitInfo = getAccelerationUnitInfo(headerUnit);

    if (!unitInfo) {
      if (normalizeWaveformUnit(headerUnit) === 'COUNTS') {
        throw new Error('COUNTS の波形は加速度単位を確認できないため使用できません。補正要求だけでは物理単位を確定できません');
      }
      throw new Error(`波形ヘッダーの加速度単位を確認できません (${headerUnit || 'unknown'})`);
    }

    const acc = [];
    const sampleTimes = [];
    const sampleTimestampTexts = [];
    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].split(/\s+/);
      if (parts.length !== 2 || !isNumericToken(parts[1])) {
        throw new Error(`波形の${i + 1}行目の加速度値が不正です`);
      }
      const value = Number(parts[1]);
      const converted = value * unitInfo.toGalFactor;
      if (!Number.isFinite(value) || !Number.isFinite(converted)) {
        throw new Error(`波形の${i + 1}行目の加速度値は換算前後とも有限値である必要があります`);
      }
      acc.push(converted);
      sampleTimes.push(parseIRISTimestamp(parts[0]));
      sampleTimestampTexts.push(parts[0]);
    }

    if (acc.length < 2) {
      throw new Error('波形サンプルは2点以上必要です');
    }

    const dt = 1 / sampleRate;
    if (!Number.isFinite(dt) || dt <= 0) {
      throw new Error('サンプリング間隔を特定できませんでした');
    }

    const duration = Math.max(0, (acc.length - 1) * dt);
    if (!Number.isFinite(duration)) {
      throw new Error('波形の継続時間は有限値である必要があります。サンプリング周波数を確認してください');
    }
    const declaredSampleCount = sampleCount;
    const timingQuality = inspectSampleTiming(sampleTimes, dt, sampleTimestampTexts);
    const sampleCountMismatch = Number.isInteger(declaredSampleCount) && declaredSampleCount !== acc.length;
    const timingIssues = [...timingQuality.issues];
    const headerTimeMismatch = sampleTimes[0] && (sampleTimes[0].getTime() !== startDate.getTime()
      || timestampFraction(sampleTimestampTexts[0]).remainder !== timestampFraction(headerStartTime).remainder);
    if (headerTimeMismatch) {
      timingIssues.push('ヘッダーの開始日時と先頭サンプルの日時が一致しません');
    }
    if (sampleCountMismatch) {
      timingIssues.push(`ヘッダー宣言 ${declaredSampleCount} 点に対して ${acc.length} 点を読み込みました`);
    }
    const stationId = `${identifier[0]}.${identifier[1]}.${identifier[2] || '--'}.${identifier[3]}`;

    return {
      acc,
      dt,
      meta: {
        _npts: acc.length,
        _dt: dt,
        _duration: duration,
        _maxAcc: AppUtils.maxAbs(acc),
        _sampleRate: sampleRate,
        _sampleCountHeader: declaredSampleCount,
        _seriesId: seriesIdMatch[1],
        _startTime: headerStartTime.endsWith('Z') ? headerStartTime : `${headerStartTime}Z`,
        _stationId: stationId.replace(/^\.+|\.+$/g, ''),
        _stationName: station.name || '',
        _dataUrl: context.dataUrl || '',
        _plotUrl: context.plotUrl || '',
        _filterPreset: context.filterPreset || '',
        _filterLabel: context.filterPreset ? getFilterLabel(context.filterPreset) : 'ファイル記録を参照（未確認）',
        _timeWindowStart: normalizeIRISTimeValue(context.starttime),
        _timeWindowEnd: normalizeIRISTimeValue(context.endtime),
        _source: typeof context.sourceName === 'string' && context.sourceName.trim()
          ? context.sourceName.trim() : '波形ヘッダーで加速度単位を確認',
        _inputUnit: unitInfo.inputLabel,
        _inputUnitReported: headerUnit,
        _rawHeader: header,
        _unitVerified: true,
        _unitEvidence: 'header',
        _conversionToGal: unitInfo.toGalFactor,
        _responseCorrectionRequested: context.responseCorrected === true,
        _displayUnit: unitInfo.displayUnit,
        _hasTimingGap: timingQuality.hasGap || sampleCountMismatch || Boolean(headerTimeMismatch),
        _maxSampleGap: timingQuality.maxGap,
        _timingIssues: timingIssues,
      },
    };
  }

  function timestampFraction(text = '') {
    const fraction = text.match(/\.(\d+)/)?.[1] || '';
    return {
      remainder: fraction.length > 3 ? Number(`0.${fraction.slice(3)}`) : 0,
      precisionMs: Math.max(1e-6, 10 ** (3 - fraction.length)),
    };
  }

  function inspectSampleTiming(sampleTimes, expectedDt, timestampTexts) {
    let hasGap = false;
    let maxGap = 0;
    const issues = [];
    const expectedMs = expectedDt * 1000;
    if (expectedMs < 1) {
      hasGap = true;
      issues.push('1000 Hzを超えるサンプリング周波数はブラウザー解析に未対応です');
    }
    const fractions = timestampTexts.map(timestampFraction);

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
      // Preserve fractional milliseconds from ASCII2 rather than losing them to Date.
      const gapMs = current.getTime() - previous.getTime()
        + fractions[index].remainder - fractions[index - 1].remainder;
      const gap = gapMs / 1000;
      maxGap = Math.max(maxGap, gap);
      const tolerance = Math.min(expectedMs * 0.25,
        (fractions[index].precisionMs + fractions[index - 1].precisionMs) / 2) + 1e-7;
      const first = sampleTimes[0];
      const offset = first ? current.getTime() - first.getTime()
        + fractions[index].remainder - fractions[0].remainder : NaN;
      const gridTolerance = Math.min(expectedMs * 0.25,
        (fractions[index].precisionMs + fractions[0].precisionMs) / 2) + 1e-7;
      if (gap <= 0 || Math.abs(gapMs - expectedMs) > tolerance
          || (Number.isFinite(offset) && Math.abs(offset - index * expectedMs) > gridTolerance)) {
        hasGap = true;
        if (issues.length === 0) issues.push('サンプル時刻の不連続または時刻精度の不足を検出しました');
      }
    }

    return { hasGap, maxGap, issues };
  }

  function normalizeWaveformUnit(unit = '') {
    return typeof unit === 'string'
      ? unit.replace(/[µμ]/g, 'u').replace(/²/g, '2').toUpperCase().replace(/\s+/g, '')
      : '';
  }

  function isNumericToken(value) {
    return typeof value === 'string' && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value);
  }

  // Return a conversion only for explicitly identified physical acceleration units.
  // Request flags and sample representation never establish the returned unit.
  function getAccelerationUnitInfo(unitOrOptions = '') {
    const reportedUnit = typeof unitOrOptions === 'string' ? unitOrOptions : unitOrOptions?.reportedUnit;
    const normalized = normalizeWaveformUnit(reportedUnit);

    if (normalized === 'GAL') {
      return { toGalFactor: 1, displayUnit: 'gal', inputLabel: 'gal' };
    }
    const gravityUnits = {
      G: { factor: 980.665, label: 'g' },
      MG: { factor: 0.980665, label: 'mg' },
      UG: { factor: 0.000980665, label: 'µg' },
    };
    if (Object.prototype.hasOwnProperty.call(gravityUnits, normalized)) {
      const unit = gravityUnits[normalized];
      return { toGalFactor: unit.factor, displayUnit: 'gal', inputLabel: unit.label };
    }

    const match = normalized.match(/^([A-Z]+)\/(?:(?:S|SEC)(?:\*\*2|\^2|2)|(?:S|SEC)\/(?:S|SEC))$/);
    if (match) {
      const unitByPrefix = {
        M: { factor: 100, label: 'm/s²' },
        CM: { factor: 1, label: 'cm/s²' },
        MM: { factor: 0.1, label: 'mm/s²' },
        UM: { factor: 0.0001, label: 'µm/s²' },
        NM: { factor: 0.0000001, label: 'nm/s²' },
      };
      const unit = unitByPrefix[match[1]];
      if (unit) return { toGalFactor: unit.factor, displayUnit: 'gal', inputLabel: unit.label };
    }

    return null;
  }

  /** Return true for finite gal data with consistent header-unit evidence; otherwise throw. */
  function validateAccelerationData(data) {
    const meta = data?.meta;
    const unitInfo = getAccelerationUnitInfo(meta?._inputUnitReported);
    const validEvidence = meta?._unitEvidence === 'header' || (meta?._unitEvidence === 'stationxml-response'
      && meta._responseCorrectionApplied === true && meta._processing?.outputUnits === 'M/S**2'
      && Boolean(AppUtils.sanitizeHttpUrl(meta._responseUrl)));
    if (!meta || meta._unitVerified !== true || !validEvidence
        || meta._displayUnit !== 'gal' || !unitInfo
        || meta._inputUnit !== unitInfo.inputLabel || meta._conversionToGal !== unitInfo.toGalFactor) {
      throw new TypeError('波形の加速度単位とgalへの換算根拠を確認できません');
    }
    if (!data.acc || !Number.isSafeInteger(data.acc.length) || data.acc.length < 2) {
      throw new TypeError('加速度波形は2点以上必要です');
    }
    if (!Number.isFinite(data.dt) || data.dt <= 0) {
      throw new RangeError('サンプリング間隔は正の有限値である必要があります');
    }
    for (let index = 0; index < data.acc.length; index++) {
      if (!Number.isFinite(data.acc[index])) {
        throw new TypeError(`加速度波形の${index + 1}点目が有限値ではありません`);
      }
    }
    return true;
  }

  function parseIRISTimestamp(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?$/.test(value)) return null;
    const normalized = /Z$/.test(value) ? value : `${value}Z`;
    const date = new Date(normalized);
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 19) !== value.slice(0, 19)) return null;
    return date;
  }

  /**
   * 地震情報から波形表示時間を設定
   * @param {Object} feature - GeoJSON feature
   * @returns {Object} { starttime, endtime }
   */
  function getTimeWindow(feature) {
    const originTime = new Date(feature.properties.time);
    const mag = feature.properties.mag || 5;

    const durationMinutes = Math.max(5, Math.min(12, mag * 2));
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
    const sourcePageUrl = AppUtils.sanitizeHttpUrl(data.meta._sourcePageUrl);
    const plotUrl = AppUtils.sanitizeHttpUrl(data.meta._plotUrl);
    const sourceLinks = [
      dataUrl ? `<a href="${escapeHtml(dataUrl)}" target="_blank" rel="noopener" class="btn btn-sm btn-outline">元データ</a>` : '',
      sourcePageUrl ? `<a href="${escapeHtml(sourcePageUrl)}" target="_blank" rel="noopener" class="btn btn-sm btn-outline">公開元の説明</a>` : '',
      data.meta._responseUrl ? `<a href="${escapeHtml(AppUtils.sanitizeHttpUrl(data.meta._responseUrl))}" target="_blank" rel="noopener" class="btn btn-sm btn-outline">計器情報</a>` : '',
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
        <span>表示指定: ${range.start.toFixed(3)} - ${range.end.toFixed(3)} 秒</span>
        <span>実効サンプル範囲: ${waveformSlice.meta._analysisWindowStart.toFixed(3)} - ${waveformSlice.meta._analysisWindowEnd.toFixed(3)} 秒</span>
        <span>最大加速度: ${waveformSlice.meta._maxAcc.toFixed(2)} ${data.meta._displayUnit || 'gal'}</span>
        <span>フィルタ: ${escapeHtml(data.meta._filterLabel || 'なし')}</span>
      </div>
      <div class="waveform-info">
        <span>${escapeHtml(data.meta._source)} / 入力単位: ${escapeHtml(data.meta._inputUnitReported || '?')} / 表示単位: ${escapeHtml(data.meta._displayUnit || 'gal')}</span>
        <span>換算: 入力値 (${escapeHtml(data.meta._inputUnit || '?')}) × ${escapeHtml(data.meta._conversionToGal ?? '?')} = gal</span>
        <span>元ヘッダー: ${escapeHtml(data.meta._rawHeader || '不明')}</span>
        <span>${data.meta._responseCorrectionApplied ? '公開された計器情報の応答段を補正し、加速度へ変換しました。周波数テーパーの範囲を確認してください。' : 'ヘッダーの単位表記を確認しています。計器補正・校正の実施や精度を検証したものではありません。'}</span>
        <span>
          ${sourceLinks}
        </span>
      </div>
      ${(data.meta._sourceNotices || []).length ? `<div class="waveform-error">${data.meta._sourceNotices.map(escapeHtml).join('<br>')}</div>` : ''}
      ${data.meta._hasTimingGap ? `<div class="waveform-error" role="status">
        時刻不連続・精度不足または未対応サンプリングを検出したため、応答スペクトルは計算できません。横軸はヘッダーのサンプリング間隔で表示しています。
        <ul>${(data.meta._timingIssues || []).map(issue => `<li>${escapeHtml(issue)}</li>`).join('')}</ul>
      </div>` : ''}
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
            text: '加速度波形 (gal)',
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
    return AppUtils.buildPeakPreservingPoints(acc, dt, MAX_PLOT_POINTS, offsetSeconds);
  }

  async function displayWaveform(station, starttime, endtime, containerId, options = {}) {
    const container = document.getElementById(containerId);
    if (!container) return null;

    container.innerHTML = `
      <div class="waveform-loading">波形を取得し、ヘッダーの加速度単位を確認中...</div>
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
        地震と観測点を選択し、「取得して表示」を押してください
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
    getAccelerationUnitInfo,
    validateAccelerationData,
    channelPriority,
    getWaveformDataURL,
    getWaveformImageURL,
    formatIRISTime,
    getDatacenters,
  };
})();
