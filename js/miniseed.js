/**
 * Strict miniSEED 2 reader for a single, continuous NSLC trace.
 * Sample decompression is provided by the bundled MIT seisplotjs SeedCodec.
 * No gap filling, overlap trimming, channel mixing, or unit assumptions occur here.
 */
const MiniSeedDecoder = (() => {
  const MAX_SAMPLES = 4000000;
  const fail = message => { throw new Error(`miniSEED: ${message}`); };
  const code = (view, offset, length) => {
    let value = '';
    for (let i = 0; i < length; i++) value += String.fromCharCode(view.getUint8(offset + i));
    return value.trim();
  };
  const locationCode = value => value === '--' ? '' : (value || '').trim();
  const stationId = station => [station.network, station.station, locationCode(station.location), station.channel].join('.');
  const validYear = year => year >= 1900 && year <= 2500;

  function readRecord(buffer, offset) {
    if (buffer.byteLength - offset < 48) fail('レコードのヘッダーが途中で切れています');
    const view = new DataView(buffer, offset);
    if (!['D', 'R', 'Q', 'M'].includes(code(view, 6, 1))) fail('対応形式は miniSEED 2 の波形レコードです');
    const bigYear = view.getUint16(20, false);
    const littleYear = view.getUint16(20, true);
    if (validYear(bigYear) === validYear(littleYear)) fail('時刻ヘッダーのバイト順を特定できません');
    const little = validYear(littleYear);
    const year = view.getUint16(20, little);
    const day = view.getUint16(22, little);
    const hour = view.getUint8(24), minute = view.getUint8(25), second = view.getUint8(26);
    const fraction = view.getUint16(28, little);
    const daysInYear = (Date.UTC(year + 1, 0, 1) - Date.UTC(year, 0, 1)) / 86400000;
    if (day < 1 || day > daysInYear || hour > 23 || minute > 59 || second > 59 || fraction > 9999) {
      fail('時刻が不正、または未対応の閏秒を含んでいます');
    }
    const activity = view.getUint8(36);
    if (activity & 0x30) fail('閏秒を含むレコードには対応していません');
    let startUs = Date.UTC(year, 0, day, hour, minute, second) * 1000 + fraction * 100;
    // SEED fixed-header corrections are in 0.0001 s and must not be applied twice.
    if (!(activity & 0x02)) startUs += view.getInt32(40, little) * 100;
    const network = code(view, 18, 2), station = code(view, 8, 5);
    const location = locationCode(code(view, 13, 2)), channel = code(view, 15, 3);
    if (![network, station, channel].every(value => /^[A-Za-z0-9]+$/.test(value))
        || !/^[A-Za-z0-9]*$/.test(location)) fail('観測点コードが不正です');
    const id = [network, station, location, channel].join('.');
    const sampleCount = view.getUint16(30, little);
    if (!sampleCount) fail('サンプルを含まないレコードです');
    const rateFactor = view.getInt16(32, little), rateMultiplier = view.getInt16(34, little);
    let sampleRate = rateFactor && rateMultiplier
      ? (rateFactor > 0 ? rateFactor : -1 / rateFactor) * (rateMultiplier > 0 ? rateMultiplier : -1 / rateMultiplier)
      : 0;
    const dataOffset = view.getUint16(44, little);
    let blockette = view.getUint16(46, little);
    const declaredBlockettes = view.getUint8(39);
    const visited = new Set();
    let encoding, recordLength, dataLittle, microsecondSeen = false;
    let timingQuality = null, frameCount = 0;
    while (blockette) {
      if (visited.has(blockette) || blockette < 48 || blockette + 4 > dataOffset || blockette + 4 > view.byteLength) {
        fail('ブロケット参照が不正です');
      }
      visited.add(blockette);
      const type = view.getUint16(blockette, little);
      const next = view.getUint16(blockette + 2, little);
      const requiredLength = type === 100 ? 12 : (type === 1000 || type === 1001 ? 8 : 4);
      if (blockette + requiredLength > dataOffset || blockette + requiredLength > view.byteLength
          || (next && next < blockette + requiredLength)) fail('ブロケットが途中で切れています');
      if (type === 1000) {
        if (recordLength !== undefined) fail('レコード長の指定が重複しています');
        encoding = view.getUint8(blockette + 4);
        const byteOrder = view.getUint8(blockette + 5);
        const exponent = view.getUint8(blockette + 6);
        if (byteOrder > 1 || exponent < 8 || exponent > 20) fail('データ形式またはレコード長が不正です');
        dataLittle = byteOrder === 0;
        recordLength = 2 ** exponent;
      } else if (type === 100) {
        sampleRate = view.getFloat32(blockette + 4, little);
      } else if (type === 1001) {
        if (microsecondSeen) fail('時刻補正の指定が重複しています');
        microsecondSeen = true;
        timingQuality = view.getUint8(blockette + 4);
        startUs += view.getInt8(blockette + 5);
        frameCount = view.getUint8(blockette + 7);
      }
      blockette = next;
    }
    if (visited.size !== declaredBlockettes) fail('ブロケット数がヘッダーと一致しません');
    if (!recordLength || recordLength > view.byteLength || dataOffset < 48 || dataOffset >= recordLength) {
      fail('レコード長が不明、または波形レコードが途中で切れています');
    }
    if (!Number.isFinite(sampleRate) || sampleRate <= 0 || sampleRate > 100000) fail('サンプリング周波数が不正です');
    let dataLength = recordLength - dataOffset;
    if ([10, 11].includes(encoding)) {
      if (dataOffset % 64 || dataLength % 64) fail('Steim データのフレーム境界が不正です');
      if (frameCount) {
        if (frameCount * 64 > dataLength) fail('Steim フレーム数がレコード長を超えています');
        dataLength = frameCount * 64;
      }
    }
    const data = new DataView(buffer, offset + dataOffset, dataLength);
    const samples = SeedCodec.decompress(encoding, data, sampleCount, dataLittle);
    if (samples.length !== sampleCount || !samples.every(Number.isFinite)) fail('サンプル数または波形の値が不正です');
    // Upstream codec does not verify Steim's Xn; verify both integration constants here.
    if ([10, 11].includes(encoding)
        && (data.byteLength < 64 || samples[0] !== data.getInt32(4, dataLittle)
          || samples[samples.length - 1] !== data.getInt32(8, dataLittle))) {
      fail('Steim 復号結果が記録内の整合性確認値と一致しません');
    }
    return { id, network, station, location, channel, sampleRate, startUs, samples,
      recordLength, precisionUs: microsecondSeen ? 1 : 100, timingQuality };
  }

  function decode(buffer, expectedStation) {
    if (!buffer || Object.prototype.toString.call(buffer) !== '[object ArrayBuffer]' || !buffer.byteLength) {
      fail('波形データが空、またはバイナリ形式ではありません');
    }
    if (typeof SeedCodec === 'undefined') fail('波形の復号ライブラリを読み込めませんでした');
    const records = [];
    let offset = 0, total = 0;
    while (offset < buffer.byteLength) {
      const record = readRecord(buffer, offset);
      total += record.samples.length;
      if (total > MAX_SAMPLES) fail('サンプル数が上限を超えました。取得時間を短くしてください');
      records.push(record);
      offset += record.recordLength;
    }
    records.sort((a, b) => a.startUs - b.startUs);
    const first = records[0];
    const requestedId = expectedStation && stationId(expectedStation);
    let previous, samplesBefore = 0;
    for (const record of records) {
      if (record.id !== first.id || (requestedId && record.id !== requestedId)) fail('観測点・成分が要求と一致しません');
      if (Math.abs(record.sampleRate - first.sampleRate) > first.sampleRate * 1e-8) fail('記録中にサンプリング周波数が変わっています');
      if (previous) {
        const expectedUs = previous.startUs + previous.samples.length * 1e6 / previous.sampleRate;
        // Account for header rounding, but never allow an entire missing/duplicate sample.
        const toleranceUs = Math.min(0.05 * 1e6 / first.sampleRate,
          Math.max(2, record.precisionUs, previous.precisionUs));
        const globalExpectedUs = first.startUs + samplesBefore * 1e6 / first.sampleRate;
        const globalToleranceUs = Math.min(0.05 * 1e6 / first.sampleRate,
          Math.max(2, record.precisionUs, first.precisionUs));
        if (Math.abs(record.startUs - expectedUs) > toleranceUs
            || Math.abs(record.startUs - globalExpectedUs) > globalToleranceUs) {
          fail('記録に欠測または重複があります。連続した取得時間を指定してください');
        }
      }
      previous = record;
      samplesBefore += record.samples.length;
    }
    if (total < 2) fail('波形には 2 点以上のサンプルが必要です');
    const samples = new Float64Array(total);
    let index = 0;
    for (const record of records) { samples.set(record.samples, index); index += record.samples.length; }
    const startMs = first.startUs / 1000;
    const endMs = startMs + (total - 1) * 1000 / first.sampleRate;
    const wholeMs = Math.floor(startMs);
    const micros = Math.round(first.startUs - wholeMs * 1000);
    const startTime = new Date(wholeMs).toISOString().replace('Z', `${String(micros).padStart(3, '0')}Z`);
    return { samples, sampleRate: first.sampleRate, startTime, startMs, endMs, id: first.id,
      network: first.network, station: first.station, location: first.location, channel: first.channel,
      recordCount: records.length };
  }

  return { decode };
})();
