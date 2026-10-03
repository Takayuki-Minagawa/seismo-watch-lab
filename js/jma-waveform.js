/** 気象庁の公開強震記録を、地震・観測点の一覧から直接取得する。 */
const JmaWaveform = (() => {
  const INDEX_URL = 'https://www.data.jma.go.jp/eqev/data/kyoshin/jishin/index.html';
  const ROOT_PATH = '/eqev/data/kyoshin/jishin/';
  const MAX_HTML_BYTES = 2 * 1024 * 1024;
  const MAX_CSV_BYTES = 20 * 1024 * 1024;
  const COMPONENTS = ['NS', 'EW', 'UD'];
  const NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

  function officialUrl(value, base = INDEX_URL) {
    const url = new URL(value, base);
    if (url.origin !== new URL(INDEX_URL).origin || !url.pathname.startsWith(ROOT_PATH)
        || url.username || url.password) throw new Error('気象庁の公開強震データURLではありません');
    return url.href;
  }

  async function fetchText(url, limit, options = {}) {
    officialUrl(url);
    const { body } = await AppUtils.fetchWithTimeout(url, {
      signal: options.signal,
      timeoutMs: 30000,
      timeoutMessage: '気象庁データの取得がタイムアウトしました',
      credentials: 'omit',
    }, async response => {
      if (!response.ok) throw new Error(`気象庁データを取得できませんでした (HTTP ${response.status})`);
      if (response.url) officialUrl(response.url);
      if (Number(response.headers?.get('Content-Length')) > limit) {
        await response.body?.cancel().catch(() => {});
        throw new Error('気象庁データが読込上限を超えています');
      }
      const chunks = [];
      let size = 0;
      if (response.body?.getReader) {
        const reader = response.body.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > limit) throw new Error('気象庁データが読込上限を超えています');
            chunks.push(value);
          }
        } catch (error) {
          await reader.cancel().catch(() => {});
          throw error;
        } finally { reader.releaseLock(); }
      } else {
        const value = new Uint8Array(await response.arrayBuffer());
        size = value.byteLength;
        if (size > limit) throw new Error('気象庁データが読込上限を超えています');
        chunks.push(value);
      }
      if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      // CSV の日本語観測点名は Shift_JIS、現行 HTML は UTF-8。
      // 先に厳密な UTF-8 を試し、MS-DOS 形式の既存 CSV も扱う。
      try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
      catch (_) { return new TextDecoder('shift_jis', { fatal: true }).decode(bytes); }
    });
    return body;
  }

  function elements(node, tag) { return Array.from(node.getElementsByTagName(tag)); }
  function clean(value) { return String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim(); }
  function htmlDocument(text) { return new DOMParser().parseFromString(text, 'text/html'); }

  function jstDate(parts) {
    const [year, month, day, hour, minute, seconds = 0] = parts.map(Number);
    if (!parts.slice(0, 5).every(value => /^\d+$/.test(String(value)))
        || ![year, month, day, hour, minute, seconds].every(Number.isFinite)
        || year < 1900 || year > 2200 || month < 1 || month > 12 || day < 1 || day > 31
        || hour < 0 || hour > 23 || minute < 0 || minute > 59 || seconds < 0 || seconds >= 60) {
      throw new Error('気象庁データの日時が不正です');
    }
    const local = new Date(Date.UTC(year, month - 1, day, hour, minute, Math.floor(seconds), Math.round((seconds % 1) * 1000)));
    if (local.getUTCFullYear() !== year || local.getUTCMonth() !== month - 1 || local.getUTCDate() !== day) {
      throw new Error('気象庁データの日時が不正です');
    }
    return local.getTime() - 9 * 3600000;
  }

  function parseEventIndex(text) {
    const events = [];
    const seen = new Set();
    for (const anchor of elements(htmlDocument(text), 'a')) {
      const title = clean(anchor.textContent);
      const match = title.match(/^(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日\s*(\d{1,2})時\s*(\d{1,2})分/);
      if (!match || !anchor.getAttribute('href')) continue;
      let url;
      try { url = officialUrl(anchor.getAttribute('href')); } catch (_) { continue; }
      if (!/\.html?(?:[?#]|$)/i.test(url) || seen.has(url)) continue;
      seen.add(url);
      events.push({ title, url, time: jstDate(match.slice(1)) });
    }
    return events;
  }

  function chooseEvent(events, eventTime) {
    const target = new Date(eventTime).getTime();
    if (!Number.isFinite(target)) throw new Error('気象庁の検索には地震の選択が必要です');
    // 一覧は分までの時刻。前後の別地震を取り違えないよう、1分以内の候補が一意であることを要求。
    const matches = events.filter(event => Math.abs(target - event.time) <= 60000);
    if (matches.length > 1) throw new Error('近い時刻に複数の気象庁公開地震があり、自動照合できません');
    if (!matches.length) throw new Error('この地震は気象庁の公開強震記録一覧にありません。気象庁は主な地震の記録を公開しています');
    return matches[0];
  }

  function distanceKm(lat1, lon1, lat2, lon2) {
    const rad = Math.PI / 180;
    const a = Math.sin((lat2 - lat1) * rad / 2) ** 2
      + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin((lon2 - lon1) * rad / 2) ** 2;
    return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
  }

  function parseStationPage(text, event, lat, lon, radius = 5) {
    const document = htmlDocument(text);
    const pageText = clean(document.documentElement.textContent);
    const latitude = pageText.match(/北緯\s*(\d+)度\s*([\d.]+)分/);
    const longitude = pageText.match(/東経\s*(\d+)度\s*([\d.]+)分/);
    if (latitude && longitude && Number.isFinite(lat) && Number.isFinite(lon)) {
      const eventLat = Number(latitude[1]) + Number(latitude[2]) / 60;
      const eventLon = Number(longitude[1]) + Number(longitude[2]) / 60;
      if (distanceKm(lat, lon, eventLat, eventLon) > 150) {
        throw new Error('選択した地震と気象庁公開記録の震央が一致しません');
      }
    }
    const notices = elements(document, 'li').map(item => clean(item.textContent))
      .filter(value => /不良|異常|時刻精度|修正不可能/.test(value));
    const stations = [];
    const seen = new Set();
    for (const table of elements(document, 'table')) {
      const headings = elements(table, 'th').map(cell => clean(cell.textContent));
      if (!headings.some(value => value.includes('観測点名')) || !headings.some(value => value.includes('震央距離'))) continue;
      for (const row of elements(table, 'tr')) {
        const cells = elements(row, 'td');
        if (cells.length < 4) continue;
        const anchor = elements(row, 'a').find(item => /\.csv(?:[?#]|$)/i.test(item.getAttribute('href') || ''));
        if (!anchor) continue;
        let csvUrl;
        try { csvUrl = officialUrl(anchor.getAttribute('href'), event.url); } catch (_) { continue; }
        if (seen.has(csvUrl)) continue;
        seen.add(csvUrl);
        // ダウンロード・波形画像の直前が震央距離。旧様式には計測震度列がない。
        const distanceCell = cells[cells.length - 3];
        const distanceText = clean(distanceCell.textContent);
        const distance = NUMBER.test(distanceText) ? Number(distanceText) : NaN;
        if (!Number.isFinite(distance) || distance < 0) continue;
        if (Number.isFinite(radius) && distance > radius * Math.PI / 180 * 6371) continue;
        const recordId = new URL(csvUrl).pathname.split('/').pop().replace(/\.csv$/i, '');
        if (!/^[A-Za-z0-9_-]+$/.test(recordId)) continue;
        const name = clean(cells[1].textContent);
        const prefecture = clean(cells[0].textContent);
        for (const channel of COMPONENTS) {
          stations.push({
            network: 'JMA', station: recordId, location: '', channel,
            stationKey: `JMA.${recordId}.--.${channel}`, name, prefecture,
            distanceKm: distance, _distanceSource: '気象庁掲載の震央距離',
            _datacenter: 'jma', _datacenterLabel: '気象庁',
            _csvUrl: csvUrl, _sourcePageUrl: event.url, _eventTitle: event.title,
            _eventTime: event.time, _sourceNotices: [...new Set(notices)],
            sensor: '気象庁公開強震記録', scaleUnits: 'gal',
          });
        }
      }
    }
    return stations.sort((a, b) => a.distanceKm - b.distanceKm || a.station.localeCompare(b.station)
      || COMPONENTS.indexOf(a.channel) - COMPONENTS.indexOf(b.channel));
  }

  async function searchStations(lat, lon, radius = 5, eventTime, options = {}) {
    options.onProgress?.('気象庁の公開地震一覧を照合中…');
    const index = await fetchText(INDEX_URL, MAX_HTML_BYTES, options);
    const event = chooseEvent(parseEventIndex(index), eventTime);
    options.onProgress?.('気象庁の公開観測点を取得中…');
    const html = await fetchText(event.url, MAX_HTML_BYTES, options);
    const stations = parseStationPage(html, event, lat, lon, radius);
    if (!stations.length) throw new Error('この地震・検索半径には対応する気象庁CSV記録がありません');
    return { stations, candidateCount: stations.length, checkedCount: 0, availableCount: 0 };
  }

  function parseCsv(text, station, context = {}) {
    const rawLines = String(text).replace(/^\uFEFF/, '').trim().split(/\r?\n/);
    // 気象庁の一部の Excel 保存CSVには末尾に空の列が付く。
    // 行の途中の空欄は残して、後段の3成分検証で欠測として拒否する。
    const lines = rawLines.map(line => line.replace(/(?:,\s*)+$/, ''));
    if (lines.length < 9) throw new Error('気象庁CSVのヘッダーまたは波形サンプルが不足しています');
    if (lines.length - 7 > 500000) throw new Error('気象庁CSVのサンプル数が処理上限を超えています');
    const site = lines[0].match(/^\s*SITE CODE\s*=\s*([A-Za-z0-9]+)([^,]*)/i);
    const latitude = lines[1].match(/^\s*LAT\.\s*=\s*([+-]?[\d.]+)\s*$/i);
    const longitude = lines[2].match(/^\s*LON\.\s*=\s*([+-]?[\d.]+)\s*$/i);
    const sampling = lines[3].match(/^\s*SAMPLING RATE\s*=\s*([\d.]+)\s*Hz\s*$/i);
    const units = lines[4].match(/^\s*UNIT\s*=\s*(.*?)\s*$/i);
    const initial = lines[5].match(/^\s*INITIAL TIME\s*=\s*(\d{4}|\d{2})\s+(\d{1,2})\s+(\d{1,2})\s+(\d{1,2})\s+(\d{1,2})\s+([\d.]+)\s*$/i);
    const components = lines[6].split(',').map(value => value.trim().toUpperCase());
    if (!site || !latitude || !longitude || !sampling || !units || !initial
        || components.length !== 3 || new Set(components).size !== 3
        || !COMPONENTS.every(component => components.includes(component))) {
      throw new Error('気象庁CSVのヘッダー形式を確認できません');
    }
    if (!/^gal\s*\(\s*cm\/s\/s\s*\)$/i.test(units[1])) {
      throw new Error('気象庁CSVの加速度単位を確認できません');
    }
    const rate = Number(sampling[1]);
    const lat = Number(latitude[1]);
    const lon = Number(longitude[1]);
    if (!Number.isFinite(rate) || rate <= 0 || rate > 1000
        || !Number.isFinite(lat) || Math.abs(lat) > 90 || !Number.isFinite(lon) || Math.abs(lon) > 180) {
      throw new Error('気象庁CSVの周波数または観測点座標が不正です');
    }
    const componentIndex = components.indexOf(station.channel);
    if (componentIndex < 0) throw new Error('気象庁CSVに要求した成分がありません');
    const initialParts = initial.slice(1);
    if (initialParts[0].length === 2) {
      // 87型の記録は年が2桁。照合済みの地震の年で世紀を確定する。
      if (!Number.isFinite(station._eventTime)) throw new Error('年が2桁の気象庁CSVには地震との照合が必要です');
      const eventYear = new Date(station._eventTime + 9 * 3600000).getUTCFullYear();
      if (eventYear % 100 !== Number(initialParts[0])) throw new Error('気象庁CSVの年が選択した地震と一致しません');
      initialParts[0] = String(eventYear);
    }
    const start = jstDate(initialParts);
    const acc = [];
    for (let index = 7; index < lines.length; index++) {
      const values = lines[index].split(',').map(value => value.trim());
      if (values.length !== 3 || values.some(value => !NUMBER.test(value) || !Number.isFinite(Number(value)))) {
        throw new Error(`気象庁CSVの${index + 1}行目に欠測または不正な加速度値があります`);
      }
      acc.push(Number(values[componentIndex]));
    }
    if (acc.length < 2) throw new Error('波形サンプルは2点以上必要です');
    const dt = 1 / rate;
    const end = start + (acc.length - 1) * dt * 1000;
    if (Number.isFinite(station._eventTime)
        && (start > station._eventTime + 3600000 || end < station._eventTime - 300000)) {
      throw new Error('気象庁CSVの記録日時が選択した地震と一致しません');
    }
    return {
      acc, dt,
      meta: {
        _npts: acc.length, _dt: dt, _duration: (acc.length - 1) * dt,
        _maxAcc: AppUtils.maxAbs(acc), _sampleRate: rate, _sampleCountHeader: acc.length,
        _seriesId: `JMA.${site[1]}.--.${station.channel}`,
        _startTime: new Date(start).toISOString(), _stationId: `JMA.${site[1]}.--.${station.channel}`,
        _stationName: station.name || clean(site[2]), _latitude: lat, _longitude: lon,
        _dataUrl: station._csvUrl || '', _sourcePageUrl: station._sourcePageUrl || INDEX_URL,
        _sourceNotices: station._sourceNotices || [],
        _source: `気象庁公開強震記録 / ${station.name || clean(site[2])} / ${station.channel}`,
        _filterPreset: '', _filterLabel: '気象庁公開加速度（追加の計器補正なし）',
        _timeWindowStart: context.starttime || '', _timeWindowEnd: context.endtime || '',
        _inputUnit: 'gal', _inputUnitReported: 'gal', _rawUnitReported: units[1],
        _rawHeader: rawLines.slice(0, 7).join('\n'), _rawDataFormat: 'JMA CSV',
        _unitVerified: true, _unitEvidence: 'header', _conversionToGal: 1,
        _responseCorrectionRequested: false, _responseCorrectionApplied: false, _displayUnit: 'gal',
        _hasTimingGap: false, _maxSampleGap: dt, _timingIssues: [],
        _processing: {
          method: 'JMA published acceleration CSV', component: station.channel,
          reportedUnit: units[1], conversionToGal: 1, originalTimeZone: 'Asia/Tokyo',
          additionalInstrumentCorrection: false, timeRange: '公開された記録全体',
          dataUrl: station._csvUrl || '', sourcePageUrl: station._sourcePageUrl || INDEX_URL,
          sourceNotices: station._sourceNotices || [],
        },
      },
    };
  }

  async function fetchWaveformData(station, starttime, endtime, options = {}) {
    if (!station?._csvUrl || station._datacenter !== 'jma') throw new Error('気象庁の観測点を選択してください');
    const url = officialUrl(station._csvUrl);
    if (!/\.csv$/i.test(new URL(url).pathname)) throw new Error('気象庁CSVのURLではありません');
    options.onProgress?.('気象庁の加速度記録を取得中…');
    const text = await fetchText(url, MAX_CSV_BYTES, options);
    options.onProgress?.('加速度の単位・成分・記録日時を確認中…');
    return parseCsv(text, station, { starttime, endtime });
  }

  return Object.freeze({ INDEX_URL, searchStations, fetchWaveformData, parseEventIndex, chooseEvent, parseStationPage, parseCsv });
})();
