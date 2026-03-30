/**
 * waveform.js - IRIS波形ビューアモジュール
 * IRIS FDSN Web Servicesを利用して計器補正済み加速度波形を表示
 */
const WaveformViewer = (() => {
  const STATION_URL = 'https://service.iris.edu/fdsnws/station/1/query';
  const TIMESERIES_URL = 'https://service.iris.edu/irisws/timeseries/1/query';
  const MAX_PLOT_POINTS = 4000;
  const AVAILABILITY_CHECK_CONCURRENCY = 6;

  let stationData = [];
  let waveformChart = null;

  /**
   * 震央付近の観測点を検索
   * @param {number} lat - 緯度
   * @param {number} lon - 経度
   * @param {number} maxRadius - 検索半径(度)
   * @param {number|string|Date} eventTime - 地震発生時刻
   * @returns {Promise<Array>} 観測点リスト
   */
  async function searchStations(lat, lon, maxRadius = 5, eventTime = null, options = {}) {
    const params = new URLSearchParams({
      latitude: lat,
      longitude: lon,
      maxradius: maxRadius,
      level: 'channel',
      format: 'text',
      nodata: '404',
      channel: 'BH?,HH?',
    });

    if (eventTime) {
      const irisTime = formatIRISTime(eventTime);
      params.set('startbefore', irisTime);
      params.set('endafter', irisTime);
    }

    const url = `${STATION_URL}?${params.toString()}`;
    const resp = await fetch(url);

    if (!resp.ok) {
      if (resp.status === 404) return [];
      throw new Error(`観測点検索エラー (HTTP ${resp.status})`);
    }

    const text = await resp.text();
    const stations = parseStationText(text);

    if (!options.requireWaveform || !options.starttime || !options.endtime) {
      stationData = stations;
      return {
        stations: stationData,
        candidateCount: stationData.length,
        availableCount: stationData.length,
      };
    }

    const availableStations = await filterStationsByWaveformAvailability(
      stations,
      options.starttime,
      options.endtime,
      { filterPreset: options.filterPreset || 'none' }
    );

    stationData = availableStations;
    return {
      stations: stationData,
      candidateCount: stations.length,
      availableCount: stationData.length,
    };
  }

  /**
   * FDSN text形式の観測点データをパース
   */
  function parseStationText(text) {
    const lines = text.trim().split('\n');
    const stations = [];
    const seen = new Set();

    for (const line of lines) {
      if (line.startsWith('#')) continue;
      const parts = line.split('|');
      if (parts.length < 6) continue;

      const key = `${parts[0]}.${parts[1]}.${parts[2]}.${parts[3]}`;
      if (seen.has(key)) continue;
      seen.add(key);

      stations.push({
        network: parts[0].trim(),
        station: parts[1].trim(),
        location: parts[2].trim(),
        channel: parts[3].trim(),
        lat: parseFloat(parts[4]),
        lon: parseFloat(parts[5]),
        name: parts.length > 6 ? parts[6]?.trim() : '',
      });
    }

    return stations;
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
      group.label = `${key} (${first.name || '?'})`;

      channels.forEach(channel => {
        const opt = document.createElement('option');
        opt.value = JSON.stringify(channel);
        opt.textContent = `${channel.channel} [${channel.location || '--'}]`;
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
    const params = new URLSearchParams({
      net: station.network,
      sta: station.station,
      loc: station.location || '--',
      cha: station.channel,
      starttime: normalizeIRISTimeValue(starttime),
      endtime: normalizeIRISTimeValue(endtime),
      correct: 'true',
      units: 'ACC',
      demean: 'true',
    });

    applyFilterPreset(params, options.filterPreset);
    params.set('format', format);
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
        return 'なし (demean)';
    }
  }

  async function fetchWaveformData(station, starttime, endtime, options = {}) {
    const dataUrl = getWaveformDataURL(station, starttime, endtime, options);
    const plotUrl = getWaveformImageURL(station, starttime, endtime, options);
    const resp = await fetch(dataUrl);

    if (!resp.ok) {
      if (resp.status === 404) {
        throw new Error('この観測点・時間帯の波形データは見つかりませんでした');
      }
      throw new Error(`波形取得エラー (HTTP ${resp.status})`);
    }

    const text = await resp.text();
    return parseWaveformText(text, {
      station,
      starttime,
      endtime,
      dataUrl,
      plotUrl,
      filterPreset: options.filterPreset || 'none',
    });
  }

  async function filterStationsByWaveformAvailability(stations, starttime, endtime, options = {}) {
    if (!stations.length) return [];

    const available = [];
    let currentIndex = 0;

    async function worker() {
      while (currentIndex < stations.length) {
        const index = currentIndex++;
        const station = stations[index];
        const ok = await canFetchWaveform(station, starttime, endtime, options);
        if (ok) available.push({ index, station });
      }
    }

    const workerCount = Math.min(AVAILABILITY_CHECK_CONCURRENCY, stations.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    return available
      .sort((a, b) => a.index - b.index)
      .map(entry => entry.station);
  }

  async function canFetchWaveform(station, starttime, endtime, options = {}) {
    const url = getWaveformImageURL(station, starttime, endtime, {
      ...options,
      width: 10,
      height: 10,
    });

    try {
      const resp = await fetch(url, { cache: 'no-store' });
      return resp.ok;
    } catch (_) {
      return false;
    }
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

    const acc = [];
    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].trim().split(/\s+/);
      if (parts.length < 2) continue;

      const value = parseFloat(parts[parts.length - 1]);
      if (!isNaN(value)) {
        acc.push(value * 100); // IRIS ACC は m/s² とみなし gal に変換
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
    const station = context.station || {};
    const stationId = `${station.network || ''}.${station.station || ''}.${station.location || '--'}.${station.channel || ''}`;

    return {
      acc,
      dt,
      meta: {
        _npts: acc.length,
        _dt: dt,
        _duration: duration,
        _maxAcc: Math.max(...acc.map(Math.abs)),
        _sampleRate: sampleRateMatch ? parseFloat(sampleRateMatch[1]) : 1 / dt,
        _sampleCountHeader: sampleCountMatch ? parseInt(sampleCountMatch[1], 10) : acc.length,
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
        _source: 'IRIS corrected acceleration',
      },
    };
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
    const safeStart = Number.isFinite(rangeStart) ? Math.max(0, rangeStart) : 0;
    let safeEnd = Number.isFinite(rangeEnd) ? Math.min(rangeEnd, totalDuration) : totalDuration;

    if (!Number.isFinite(safeEnd) || safeEnd <= safeStart) {
      safeEnd = Math.min(totalDuration, safeStart + Math.max(data.dt * 10, 1));
    }
    if (safeEnd <= safeStart) {
      safeEnd = totalDuration;
    }

    return { start: safeStart, end: safeEnd };
  }

  function sliceWaveformData(data, rangeStart = 0, rangeEnd = null) {
    const range = normalizeRange(data, rangeStart, rangeEnd);
    const startIndex = Math.max(0, Math.floor(range.start / data.dt));
    const endIndex = Math.min(data.acc.length, Math.ceil(range.end / data.dt) + 1);
    const slicedAcc = data.acc.slice(startIndex, endIndex);

    return {
      acc: slicedAcc,
      dt: data.dt,
      meta: {
        ...data.meta,
        _npts: slicedAcc.length,
        _duration: Math.max(0, (slicedAcc.length - 1) * data.dt),
        _maxAcc: slicedAcc.length > 0 ? Math.max(...slicedAcc.map(Math.abs)) : 0,
        _analysisWindowStart: range.start,
        _analysisWindowEnd: range.end,
      },
    };
  }

  function renderWaveform(data, containerId, options = {}) {
    const container = document.getElementById(containerId);
    if (!container) return { start: 0, end: 0 };

    const range = normalizeRange(data, options.rangeStart, options.rangeEnd);
    const waveformSlice = sliceWaveformData(data, range.start, range.end);
    const chartPoints = buildChartPoints(waveformSlice.acc, waveformSlice.dt, range.start);
    const canvasId = `${containerId}-canvas`;

    container.innerHTML = `
      <div class="waveform-chart-box">
        <canvas id="${canvasId}"></canvas>
      </div>
      <div class="waveform-meta">
        <span>観測点: ${escapeHtml(data.meta._stationId || '?')}</span>
        <span>点数: ${waveformSlice.meta._npts}</span>
        <span>dt: ${waveformSlice.meta._dt.toFixed(4)} 秒</span>
        <span>表示範囲: ${range.start.toFixed(1)} - ${range.end.toFixed(1)} 秒</span>
        <span>最大加速度: ${waveformSlice.meta._maxAcc.toFixed(2)} gal</span>
        <span>フィルタ: ${escapeHtml(data.meta._filterLabel || 'なし')}</span>
      </div>
      <div class="waveform-info">
        <span>${escapeHtml(data.meta._source)} / 単位: gal</span>
        <span>
          <a href="${data.meta._dataUrl}" target="_blank" rel="noopener" class="btn btn-sm btn-outline">ASCII2</a>
          <a href="${data.meta._plotUrl}" target="_blank" rel="noopener" class="btn btn-sm btn-outline">IRISプロット</a>
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
          label: '加速度 (gal)',
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
            text: 'IRIS 生波形 (加速度)',
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
              text: '加速度 (gal)',
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
      <div class="waveform-loading">IRIS から生波形データを取得中...</div>
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
        地震を選択し、観測点を検索してから生波形を表示してください
      </div>
    `;
  }

  function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  return {
    searchStations,
    populateStationSelect,
    getTimeWindow,
    displayWaveform,
    fetchWaveformData,
    renderWaveform,
    resetDisplay,
    sliceWaveformData,
    getWaveformDataURL,
    getWaveformImageURL,
    formatIRISTime,
  };
})();
