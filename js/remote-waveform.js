/** Public FDSN data acquisition and browser-side response correction. */
const RemoteWaveform = (() => {
  const MAX_BYTES = 24 * 1024 * 1024;
  const MAX_SAMPLES = 500000;

  function urls(station, starttime, endtime, datacenter) {
    if (!datacenter?.stationUrl || !datacenter?.dataUrl) throw new Error('この取得元の波形配信先が未設定です');
    const params = new URLSearchParams({
      net: station.network, sta: station.station, loc: station.location || '--', cha: station.channel,
      starttime, endtime, nodata: '404',
    });
    return {
      data: `${datacenter.dataUrl}?${params}`,
      response: `${datacenter.stationUrl}?${params}&level=response&format=xml`,
    };
  }

  async function fetchBytes(url, { signal, maxBytes = MAX_BYTES } = {}) {
    let response;
    try {
      response = await fetch(url, { signal, cache: 'no-store', credentials: 'omit' });
    } catch (error) {
      if (signal?.aborted) throw signal.reason || error;
      throw new Error('観測サイトへ接続できません。配信元のブラウザ接続制限（CORS）や通信状況を確認し、別の取得元もお試しください');
    }
    if (response.status === 204 || response.status === 404) throw new Error('この観測点・時間帯の波形または計器情報がありません。別の観測点を選んでください');
    if (response.status === 401 || response.status === 403) throw new Error('配信元が認証を要求しています。この画面は公開データの取得に対応しています');
    if (response.status === 413) throw new Error('配信元の取得上限を超えました。別のチャンネルを選んでください');
    if (!response.ok) throw new Error(`観測サイトの取得エラー (HTTP ${response.status})`);
    if (Number(response.headers.get('content-length')) > maxBytes) {
      await response.body?.cancel();
      throw new Error('波形または計器情報が取得サイズの上限を超えています');
    }
    if (!response.body?.getReader) {
      const buffer = await response.arrayBuffer();
      if (buffer.byteLength > maxBytes) throw new Error('取得サイズの上限を超えています');
      return buffer;
    }
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) throw new Error('取得サイズの上限を超えています');
        chunks.push(value);
      }
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes.buffer;
  }

  function correctInWorker(trace, response, preFilter, signal) {
    if (typeof Worker === 'undefined') throw new Error('このブラウザでは波形変換用のWorkerを使用できません。最新のブラウザで開いてください');
    return new Promise((resolve, reject) => {
      const worker = new Worker('js/waveform-worker.js');
      const finish = (error, value) => {
        signal?.removeEventListener('abort', abort);
        worker.terminate();
        if (error) reject(error); else resolve(value);
      };
      const abort = () => finish(signal.reason || new DOMException('Aborted', 'AbortError'));
      if (signal?.aborted) { abort(); return; }
      signal?.addEventListener('abort', abort, { once: true });
      worker.onerror = () => finish(new Error('波形変換を実行できませんでした。ページを再読み込みしてください'));
      worker.onmessage = ({ data }) => data.error ? finish(new Error(data.error)) : finish(null, data);
      worker.postMessage({ samples: trace.samples, sampleRate: trace.sampleRate, response, preFilter });
    });
  }

  async function load(station, starttime, endtime, datacenter, options = {}) {
    const addresses = urls(station, starttime, endtime, datacenter);
    const controller = new AbortController();
    const abort = () => controller.abort(options.signal.reason || new DOMException('Aborted', 'AbortError'));
    if (options.signal?.aborted) abort();
    options.signal?.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(() => controller.abort(new Error('波形の取得・変換がタイムアウトしました。別の観測点でお試しください')), options.timeoutMs || 90000);
    try {
      options.onProgress?.('波形と計器情報を取得中…');
      const [bytes, xml] = await Promise.all([
        fetchBytes(addresses.data, { signal: controller.signal }),
        fetchBytes(addresses.response, { signal: controller.signal, maxBytes: 8 * 1024 * 1024 }),
      ]);
      if (controller.signal.aborted) throw controller.signal.reason;
      options.onProgress?.('観測記録の連続性と計器情報を確認中…');
      const trace = MiniSeedDecoder.decode(bytes, station);
      if (trace.samples.length > MAX_SAMPLES || trace.sampleRate > 1000) throw new Error('波形のサンプル数または周波数が処理上限を超えています');
      const requestedStart = Date.parse(starttime.endsWith('Z') ? starttime : `${starttime}Z`);
      const requestedEnd = Date.parse(endtime.endsWith('Z') ? endtime : `${endtime}Z`);
      if (trace.endMs < requestedStart || trace.startMs > requestedEnd) throw new Error('返却された波形の時刻が要求期間と一致しません');
      const response = InstrumentResponse.parseStationXML(new TextDecoder().decode(xml), trace);
      const preFilter = options.preFilter || [0.02, 0.05, trace.sampleRate * 0.3, trace.sampleRate * 0.4];
      options.onProgress?.('計器の応答を補正し、加速度へ変換中…');
      const corrected = await correctInWorker(trace, response, preFilter, controller.signal);
      if (controller.signal.aborted) throw controller.signal.reason;
      const acc = Array.from(corrected.acceleration, value => value * 100);
      if (acc.length !== trace.samples.length || acc.some(value => !Number.isFinite(value))) throw new Error('補正後の加速度が不正です');
      const dt = 1 / trace.sampleRate;
      return {
        acc, dt,
        meta: {
          _npts: acc.length, _dt: dt, _duration: (acc.length - 1) * dt,
          _sampleRate: trace.sampleRate, _maxAcc: AppUtils.maxAbs(acc),
          _startTime: trace.startTime, _stationId: trace.id,
          _source: `${datacenter.label} / 波形・StationXMLからアプリ内で加速度へ補正`,
          _dataUrl: addresses.data, _responseUrl: addresses.response, _rawDataFormat: 'miniSEED',
          _inputUnit: 'm/s²', _inputUnitReported: 'M/S**2', _displayUnit: 'gal', _conversionToGal: 100,
          _unitVerified: true, _unitEvidence: 'stationxml-response',
          _responseCorrectionRequested: true, _responseCorrectionApplied: true,
          _processing: { ...corrected.processing, outputUnits: 'M/S**2', responseUrl: addresses.response },
          _filterLabel: `周波数テーパー ${preFilter.map(value => Number(value.toPrecision(5))).join(' / ')} Hz・平均除去・時間テーパー計5%（各端2.5%）`,
          _analysisPeriodMin: Math.max(0.02, 10 * dt, 1 / preFilter[2]),
          _analysisPeriodMax: Math.min(10, 1 / preFilter[1]),
          _rawHeader: `miniSEED ${trace.id}; ${trace.sampleRate} Hz; ${acc.length} samples; raw COUNTS → response-corrected M/S**2`,
          _hasTimingGap: false, _timingIssues: [], _maxSampleGap: dt,
          _timeWindowStart: starttime, _timeWindowEnd: endtime,
        },
      };
    } finally {
      clearTimeout(timeout);
      controller.abort();
      options.signal?.removeEventListener('abort', abort);
    }
  }
  return { load, urls, fetchBytes };
})();
