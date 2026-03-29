/**
 * waveform.js - IRIS波形ビューアモジュール
 * IRIS FDSN Web Servicesを利用して地震波形を表示
 */
const WaveformViewer = (() => {
  const STATION_URL = 'https://service.iris.edu/fdsnws/station/1/query';
  const TIMESERIES_URL = 'https://service.iris.edu/irisws/timeseries/1/query';

  let stationData = [];

  /**
   * 震央付近の観測点を検索
   * @param {number} lat - 緯度
   * @param {number} lon - 経度
   * @param {number} maxRadius - 検索半径(度)
   * @returns {Promise<Array>} 観測点リスト
   */
  async function searchStations(lat, lon, maxRadius = 5) {
    const params = new URLSearchParams({
      latitude: lat,
      longitude: lon,
      maxradius: maxRadius,
      level: 'channel',
      format: 'text',
      nodata: '404',
      channel: 'BH?,HH?',
    });

    const url = `${STATION_URL}?${params.toString()}`;
    const resp = await fetch(url);

    if (!resp.ok) {
      if (resp.status === 404) return [];
      throw new Error(`観測点検索エラー (HTTP ${resp.status})`);
    }

    const text = await resp.text();
    stationData = parseStationText(text);
    return stationData;
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
   * 波形画像のURLを生成
   * @param {Object} station - 観測点情報
   * @param {string} starttime - ISO形式の開始時刻
   * @param {string} endtime - ISO形式の終了時刻
   * @returns {string} 画像URL
   */
  function getWaveformImageURL(station, starttime, endtime) {
    const params = new URLSearchParams({
      net: station.network,
      sta: station.station,
      loc: station.location || '--',
      cha: station.channel,
      starttime: starttime,
      endtime: endtime,
      output: 'plot',
      width: 800,
      height: 250,
    });
    return `${TIMESERIES_URL}?${params.toString()}`;
  }

  /**
   * 観測点選択UIを更新
   */
  function populateStationSelect(stations, selectId) {
    const sel = document.getElementById(selectId);
    if (!sel) return;

    sel.innerHTML = '<option value="">-- 観測点を選択 --</option>';

    // ネットワーク・観測点名でグループ化（ユニーク）
    const uniqueStations = new Map();
    stations.forEach(s => {
      const key = `${s.network}.${s.station}`;
      if (!uniqueStations.has(key)) {
        uniqueStations.set(key, []);
      }
      uniqueStations.get(key).push(s);
    });

    uniqueStations.forEach((channels, key) => {
      const first = channels[0];
      const group = document.createElement('optgroup');
      group.label = `${key} (${first.name || '?'})`;

      channels.forEach(ch => {
        const opt = document.createElement('option');
        opt.value = JSON.stringify(ch);
        opt.textContent = `${ch.channel} [${ch.location || '--'}]`;
        group.appendChild(opt);
      });

      sel.appendChild(group);
    });
  }

  /**
   * 地震情報から波形表示時間を設定
   * @param {Object} feature - GeoJSON feature
   * @returns {Object} { starttime, endtime }
   */
  function getTimeWindow(feature) {
    const originTime = new Date(feature.properties.time);
    const mag = feature.properties.mag || 5;

    // マグニチュードに応じて表示時間を調整
    const durationMinutes = Math.max(5, Math.min(30, mag * 3));
    const preSeconds = 60; // 発生60秒前から

    const start = new Date(originTime.getTime() - preSeconds * 1000);
    const end = new Date(originTime.getTime() + durationMinutes * 60 * 1000);

    return {
      starttime: start.toISOString(),
      endtime: end.toISOString(),
    };
  }

  /**
   * 選択された観測点の波形画像を表示
   */
  function displayWaveform(station, starttime, endtime, containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;

    const url = getWaveformImageURL(station, starttime, endtime);

    container.innerHTML = `
      <div class="waveform-loading">波形データを読込中...</div>
    `;

    const img = new Image();
    img.onload = () => {
      container.innerHTML = '';
      img.className = 'waveform-image';
      img.alt = `${station.network}.${station.station}.${station.channel} 波形`;
      container.appendChild(img);

      const info = document.createElement('div');
      info.className = 'waveform-info';
      info.innerHTML = `
        <span>${station.network}.${station.station}.${station.location || '--'}.${station.channel}</span>
        <a href="${url}" target="_blank" rel="noopener" class="btn btn-sm btn-outline">元画像を開く</a>
      `;
      container.appendChild(info);
    };

    img.onerror = () => {
      container.innerHTML = `
        <div class="waveform-error">
          この観測点・時間帯のデータは取得できませんでした。<br>
          別の観測点またはチャンネルをお試しください。
        </div>
      `;
    };

    img.src = url;
  }

  return {
    searchStations,
    populateStationSelect,
    getTimeWindow,
    displayWaveform,
    getWaveformImageURL,
  };
})();
