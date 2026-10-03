/**
 * StationXML response removal for continuous, gap-free counts.
 * Evaluates every supported stage; never substitutes overall sensitivity for
 * a missing response. FIR phase/normalization follows evalresp conventions:
 * https://github.com/obspy/obspy/tree/master/obspy/signal/src/evalresp
 * All corrected results are SI acceleration (m/s²).
 */
const InstrumentResponse = (() => {
  const TWO_PI = 2 * Math.PI;
  const MAX_SAMPLES = 500000;
  const MAX_COEFFICIENTS = 16384;
  const fail = message => { throw new Error(`計器応答: ${message}`); };
  const elements = node => Array.from(node?.childNodes || []).filter(n => n.nodeType === 1);
  const named = (node, name) => elements(node).filter(n => (n.localName || n.nodeName.split(':').pop()) === name);
  function one(node, name, required = true) {
    const matches = named(node, name);
    if (matches.length > 1 || (required && matches.length !== 1)) fail(`${name} が欠落または重複しています。`);
    return matches[0] || null;
  }
  function text(node, name) { return one(node, name).textContent.trim(); }
  function number(node, name) {
    const value = text(node, name);
    if (!value || !Number.isFinite(Number(value))) fail(`${name} が有限数ではありません。`);
    return Number(value);
  }
  function unit(value) {
    const normalized = value.trim().toUpperCase().replace(/\s/g, '').replace(/\*\*/g, '^').replace(/²/g, '^2');
    if (['COUNT', 'COUNTS', 'DIGITALCOUNTS'].includes(normalized)) return 'COUNTS';
    if (['V', 'VOLT', 'VOLTS'].includes(normalized)) return 'V';
    if (normalized === 'M/S/S') return 'M/S^2';
    return normalized.replace(/\/S\/S$/, '/S^2').replace(/\/S2$/, '/S^2');
  }
  function motionUnit(value) {
    const match = /^(M|CM|MM|NM)(?:\/S(?:\^2)?)?$/.exec(value);
    if (!match) fail(`地動の入力単位 ${value} に対応していません。`);
    return { scale: { M: 1, CM: 0.01, MM: 0.001, NM: 1e-9 }[match[1]], order: value.endsWith('^2') ? 2 : value.endsWith('/S') ? 1 : 0 };
  }
  function parseTime(value, label) {
    const result = typeof value === 'number' ? value : Date.parse(value);
    if (!Number.isFinite(result)) fail(`${label} の日時が不正です。`);
    return result;
  }
  function epoch(node) {
    const start = node.getAttribute('startDate');
    const end = node.getAttribute('endDate');
    return [start ? parseTime(start, 'startDate') : -Infinity, end ? parseTime(end, 'endDate') : Infinity];
  }
  function coefficients(node, name) {
    const values = named(node, name);
    if (values.length > MAX_COEFFICIENTS) fail('フィルタ係数が多すぎます。');
    return values.map((element, index) => {
      const indexValue = element.getAttribute('number') || element.getAttribute('i');
      if (indexValue !== null && indexValue !== '' && Number(indexValue) !== index) fail(`${name} の係数順序が不正です。`);
      const value = element.textContent.trim();
      if (!value || !Number.isFinite(Number(value))) fail(`${name} の係数が不正です。`);
      return Number(value);
    });
  }
  function parseStage(node) {
    const sequence = Number(node.getAttribute('number'));
    if (!Number.isInteger(sequence) || sequence < 1) fail('Stage番号が不正です。');
    const filters = elements(node).filter(n => !['StageGain', 'Decimation'].includes(n.localName || n.nodeName));
    if (filters.length !== 1) fail(`Stage ${sequence}: 単位付きのフィルタ定義が必要です。`);
    const filter = filters[0];
    const kind = filter.localName || filter.nodeName;
    if (!['PolesZeros', 'Coefficients', 'FIR'].includes(kind)) fail(`Stage ${sequence}: ${kind} は未対応です。`);
    const gainNode = one(node, 'StageGain');
    const stage = {
      sequence, kind,
      inputUnits: unit(text(one(filter, 'InputUnits'), 'Name')),
      outputUnits: unit(text(one(filter, 'OutputUnits'), 'Name')),
      gain: number(gainNode, 'Value'), gainFrequency: number(gainNode, 'Frequency'),
      factor: 1, correction: 0,
    };
    if (!(stage.gain > 0) || stage.gainFrequency < 0) fail(`Stage ${sequence}: 利得が不正です。`);
    const decimation = one(node, 'Decimation', false);
    if (decimation) {
      stage.inputSampleRate = number(decimation, 'InputSampleRate');
      stage.factor = number(decimation, 'Factor');
      stage.offset = number(decimation, 'Offset');
      stage.delay = number(decimation, 'Delay');
      stage.correction = number(decimation, 'Correction');
      if (!(stage.inputSampleRate > 0) || !Number.isInteger(stage.factor) || stage.factor < 1 ||
          !Number.isInteger(stage.offset) || stage.offset < 0 || stage.offset >= stage.factor || stage.delay < 0) {
        fail(`Stage ${sequence}: 間引き設定が不正です。`);
      }
    }
    if (kind === 'PolesZeros') {
      stage.transferType = text(filter, 'PzTransferFunctionType');
      if (!['LAPLACE (RADIANS/SECOND)', 'LAPLACE (HERTZ)', 'DIGITAL (Z-TRANSFORM)'].includes(stage.transferType)) fail('未対応のPolesZeros形式です。');
      stage.normalizationFactor = number(filter, 'NormalizationFactor');
      stage.normalizationFrequency = number(filter, 'NormalizationFrequency');
      if (!(stage.normalizationFactor > 0) || stage.normalizationFrequency < 0) fail('PolesZeros正規化が不正です。');
      for (const [name, key] of [['Pole', 'poles'], ['Zero', 'zeros']]) {
        stage[key] = named(filter, name).map(n => [number(n, 'Real'), number(n, 'Imaginary')]);
        if (stage[key].length > 256) fail('極・零点が多すぎます。');
      }
      if (stage.transferType === 'DIGITAL (Z-TRANSFORM)' && !decimation) fail('デジタル極・零点には間引き設定が必要です。');
    } else if (kind === 'Coefficients') {
      if (text(filter, 'CfTransferFunctionType') !== 'DIGITAL') fail('アナログ係数形式は未対応です。');
      stage.numerator = coefficients(filter, 'Numerator');
      stage.denominator = coefficients(filter, 'Denominator');
      if (stage.denominator.length && !stage.numerator.length) fail('分子係数がありません。');
      if (!stage.denominator.length) {
        stage.kind = 'FIR';
        stage.coefficients = stage.numerator;
        stage.symmetry = 'NONE';
      }
      if (!decimation) fail('デジタル係数には間引き設定が必要です。');
    } else {
      stage.symmetry = text(filter, 'Symmetry');
      stage.coefficients = coefficients(filter, 'NumeratorCoefficient');
      if (!['NONE', 'ODD', 'EVEN'].includes(stage.symmetry) || !stage.coefficients.length || !decimation) fail('FIR形式または間引き設定が不正です。');
    }
    if (stage.kind === 'FIR' && stage.coefficients.length && stage.symmetry === 'NONE') {
      // evalresp normalizes full FIR arrays at DC, then detects exact symmetry.
      const sum = stage.coefficients.reduce((a, b) => a + b, 0);
      if (Math.abs(sum) < 1e-20) fail('直流利得がゼロのFIRには対応していません。');
      if (Math.abs(sum - 1) > 0.02) {
        stage.coefficients = stage.coefficients.map(value => value / sum);
        stage.firNormalization = sum;
      }
      const a = stage.coefficients;
      if (a.every((value, index) => value === a[a.length - 1 - index])) {
        stage.symmetry = a.length % 2 ? 'ODD' : 'EVEN';
        stage.coefficients = a.slice(0, Math.ceil(a.length / 2));
      }
    }
    return stage;
  }
  function parseStationXML(xmlText, trace, options = {}) {
    if (typeof xmlText !== 'string' || xmlText.length > 16e6 || /<!DOCTYPE|<!ENTITY/i.test(xmlText)) fail('StationXMLが不正または大きすぎます。');
    const Parser = options.DOMParser || globalThis.DOMParser;
    if (!Parser) fail('XMLパーサーがありません。');
    const doc = new Parser().parseFromString(xmlText, 'application/xml');
    if (!doc?.documentElement || doc.getElementsByTagName('parsererror').length || (doc.documentElement.localName || doc.documentElement.nodeName) !== 'FDSNStationXML') fail('StationXMLを読み込めません。');
    const id = trace.id || [trace.network, trace.station, trace.location || '', trace.channel].join('.');
    const parts = id.split('.');
    if (parts.length !== 4 || !parts[0] || !parts[1] || !parts[3]) fail('波形の観測点IDが不正です。');
    const start = parseTime(trace.startMs ?? trace.startTime, '波形開始');
    const end = parseTime(trace.endMs ?? trace.endTime, '波形終了');
    if (end < start || !(trace.sampleRate > 0)) fail('波形時間またはサンプリング周波数が不正です。');
    const matches = [];
    for (const network of named(doc.documentElement, 'Network')) {
      if (network.getAttribute('code') !== parts[0]) continue;
      for (const station of named(network, 'Station')) {
        if (station.getAttribute('code') !== parts[1]) continue;
        for (const channel of named(station, 'Channel')) {
          if (channel.getAttribute('code') !== parts[3] || (channel.getAttribute('locationCode') || '') !== parts[2]) continue;
          const dates = [network, station, channel].map(epoch);
          const from = Math.max(...dates.map(pair => pair[0]));
          const to = Math.min(...dates.map(pair => pair[1]));
          if (from <= end && to >= start) matches.push({ channel, from, to });
        }
      }
    }
    if (matches.length !== 1 || matches[0].from > start || matches[0].to < end) fail('全波形を覆う計器応答の期間を一意に選べません。');
    const { channel, from, to } = matches[0];
    const sampleRate = number(channel, 'SampleRate');
    if (Math.abs(sampleRate / trace.sampleRate - 1) > 1e-6) fail('StationXMLと波形のサンプリング周波数が一致しません。');
    const response = one(channel, 'Response');
    if (named(response, 'InstrumentPolynomial').length) fail('多項式応答は未対応です。');
    const sensitivity = one(response, 'InstrumentSensitivity');
    const model = {
      id, sampleRate, epochStart: Number.isFinite(from) ? new Date(from).toISOString() : null,
      epochEnd: Number.isFinite(to) ? new Date(to).toISOString() : null,
      inputUnits: unit(text(one(sensitivity, 'InputUnits'), 'Name')),
      outputUnits: unit(text(one(sensitivity, 'OutputUnits'), 'Name')),
      sensitivity: number(sensitivity, 'Value'), sensitivityFrequency: number(sensitivity, 'Frequency'),
      stages: named(response, 'Stage').map(parseStage).sort((a, b) => a.sequence - b.sequence),
    };
    if (!(model.sensitivity > 0) || model.sensitivityFrequency < 0 || !model.stages.length || model.stages.length > 64 || model.outputUnits !== 'COUNTS') fail('感度または応答段が不正です。');
    model.motion = motionUnit(model.inputUnits);
    let previousUnit = model.inputUnits;
    let previousRate;
    for (let i = 0; i < model.stages.length; i++) {
      const stage = model.stages[i];
      if (stage.sequence !== i + 1 || !stage.inputUnits || !stage.outputUnits || stage.inputUnits !== previousUnit) fail('応答段の番号または単位の接続が不正です。');
      previousUnit = stage.outputUnits;
      if (stage.inputSampleRate) {
        if (previousRate && Math.abs(previousRate / stage.inputSampleRate - 1) > 1e-6) fail('応答段のサンプリング周波数が接続していません。');
        previousRate = stage.inputSampleRate / stage.factor;
      }
      // Equivalent to evalresp's gain-frequency normalization. Preserve A0 only
      // when both normalization and gain already use the overall frequency.
      const renormalize = stage.gainFrequency !== model.sensitivityFrequency ||
        (stage.kind === 'PolesZeros' && stage.normalizationFrequency !== model.sensitivityFrequency);
      if (renormalize && !(stage.kind === 'FIR' && !stage.coefficients.length)) {
        const atGain = stageShape(stage, stage.gainFrequency);
        const magnitude = Math.hypot(...atGain);
        if (!(magnitude > 0) || !Number.isFinite(magnitude)) fail('応答段を指定周波数で正規化できません。');
        stage.multiplier = stage.gain / magnitude;
      } else stage.multiplier = stage.gain * (stage.kind === 'PolesZeros' ? stage.normalizationFactor : 1);
    }
    if (previousUnit !== model.outputUnits || !previousRate || Math.abs(previousRate / sampleRate - 1) > 1e-6) fail('応答段の最終単位または標本化周波数が一致しません。');
    const overall = nativeResponse(model, model.sensitivityFrequency);
    const calculatedSensitivity = Math.hypot(...overall);
    if (!Number.isFinite(calculatedSensitivity) || Math.abs(calculatedSensitivity / model.sensitivity - 1) > 0.05) fail('応答段から計算した感度が総合感度と5%以上異なります。');
    model.calculatedSensitivity = calculatedSensitivity;
    return model;
  }
  function multiply(a, b) { return [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]]; }
  function divide(a, b) {
    const den = b[0] * b[0] + b[1] * b[1];
    if (den === 0) return [NaN, NaN];
    return [(a[0] * b[0] + a[1] * b[1]) / den, (a[1] * b[0] - a[0] * b[1]) / den];
  }
  function digitalPolynomial(a, angle) {
    let real = 0, imag = 0;
    for (let j = 0; j < a.length; j++) { real += a[j] * Math.cos(j * angle); imag -= a[j] * Math.sin(j * angle); }
    return [real, imag];
  }
  function stageShape(stage, frequency) {
    const omega = TWO_PI * frequency;
    if (stage.kind === 'PolesZeros') {
      const z = stage.transferType === 'DIGITAL (Z-TRANSFORM)' ? [Math.cos(omega / stage.inputSampleRate), Math.sin(omega / stage.inputSampleRate)] :
        [0, stage.transferType === 'LAPLACE (HERTZ)' ? frequency : omega];
      let numerator = [1, 0], denominator = [1, 0];
      for (const zero of stage.zeros) numerator = multiply(numerator, [z[0] - zero[0], z[1] - zero[1]]);
      for (const pole of stage.poles) denominator = multiply(denominator, [z[0] - pole[0], z[1] - pole[1]]);
      return divide(numerator, denominator);
    }
    const angle = omega / stage.inputSampleRate;
    if (stage.kind === 'Coefficients') return divide(digitalPolynomial(stage.numerator, angle), digitalPolynomial(stage.denominator, angle));
    const a = stage.coefficients;
    if (!a.length) return [1, 0];
    // StationXML symmetric FIRs specify only half the coefficients. Their
    // causal group delay is already removed from the recorded timestamps.
    if (stage.symmetry === 'ODD' || stage.symmetry === 'EVEN') {
      let real = stage.symmetry === 'ODD' ? a[a.length - 1] : 0;
      const count = stage.symmetry === 'ODD' ? a.length - 1 : a.length;
      for (let j = 0; j < count; j++) real += 2 * a[j] * Math.cos(angle * (a.length - j - (stage.symmetry === 'ODD' ? 1 : 0.5)));
      return [real, 0];
    }
    return multiply(digitalPolynomial(a, angle), [Math.cos(omega * stage.correction), Math.sin(omega * stage.correction)]);
  }
  function nativeResponse(model, frequency) {
    let result = [1, 0];
    for (const stage of model.stages) {
      const shape = stageShape(stage, frequency);
      result = multiply(result, [shape[0] * stage.multiplier, shape[1] * stage.multiplier]);
    }
    return result;
  }
  function responseAt(model, frequency) {
    if (frequency === 0 && model.motion.order < 2) return [0, 0];
    let value = nativeResponse(model, frequency);
    // Counts per SI acceleration: convert displacement/velocity response by
    // dividing by iω once/twice, and account for the original metric prefix.
    value = [value[0] / model.motion.scale, value[1] / model.motion.scale];
    for (let i = model.motion.order; i < 2; i++) value = [value[1] / (TWO_PI * frequency), -value[0] / (TWO_PI * frequency)];
    return value;
  }
  function evaluateResponse(model, frequencies) {
    const real = new Float64Array(frequencies.length), imag = new Float64Array(frequencies.length);
    for (let i = 0; i < frequencies.length; i++) {
      if (!Number.isFinite(frequencies[i]) || frequencies[i] < 0 || frequencies[i] > model.sampleRate / 2) fail('評価周波数が不正です。');
      [real[i], imag[i]] = responseAt(model, frequencies[i]);
    }
    return { real, imag };
  }
  function fft(real, imag, inverse = false) {
    const n = real.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { [real[i], real[j]] = [real[j], real[i]]; [imag[i], imag[j]] = [imag[j], imag[i]]; }
    }
    for (let size = 2; size <= n; size *= 2) {
      const angle = (inverse ? TWO_PI : -TWO_PI) / size;
      const wrStep = Math.cos(angle), wiStep = Math.sin(angle);
      for (let offset = 0; offset < n; offset += size) {
        let wr = 1, wi = 0;
        for (let j = 0; j < size / 2; j++) {
          const left = offset + j, right = left + size / 2;
          const re = wr * real[right] - wi * imag[right], im = wr * imag[right] + wi * real[right];
          real[right] = real[left] - re; imag[right] = imag[left] - im;
          real[left] += re; imag[left] += im;
          const nextWr = wr * wrStep - wi * wiStep; wi = wr * wiStep + wi * wrStep; wr = nextWr;
        }
      }
    }
    if (inverse) for (let i = 0; i < n; i++) { real[i] /= n; imag[i] /= n; }
  }
  function frequencyTaper(f, corners) {
    const [f1, f2, f3, f4] = corners;
    if (f <= f1 || f >= f4) return 0;
    if (f < f2) return 0.5 * (1 - Math.cos(Math.PI * (f - f1) / (f2 - f1)));
    if (f <= f3) return 1;
    return 0.5 * (1 + Math.cos(Math.PI * (f - f3) / (f4 - f3)));
  }
  function correct(samples, sampleRate, response, options = {}) {
    if (!samples || samples.length < 8 || samples.length > MAX_SAMPLES) fail(`波形は8〜${MAX_SAMPLES}点が必要です。`);
    if (!Number.isFinite(sampleRate) || sampleRate <= 0 || Math.abs(sampleRate / response.sampleRate - 1) > 1e-6) fail('補正時のサンプリング周波数が不正です。');
    const preFilter = Array.from(options.preFilter || [0.02, 0.05, 0.3 * sampleRate, 0.4 * sampleRate]);
    if (preFilter.length !== 4 || !preFilter.every(Number.isFinite) || preFilter[0] <= 0 || preFilter[3] > sampleRate / 2 || !preFilter.every((f, i) => i === 0 || f > preFilter[i - 1])) fail('周波数フィルタは0 < f1 < f2 < f3 < f4 ≤ Nyquistが必要です。');
    const taperFraction = options.taperFraction ?? 0.05;
    if (!Number.isFinite(taperFraction) || taperFraction < 0 || taperFraction > 0.5) fail('テーパー割合が不正です。');
    if (options.waterLevel != null) fail('water-levelによる近似補正は未対応です。');
    let nfft = 1;
    while (nfft < 2 * samples.length) nfft *= 2;
    const real = new Float64Array(nfft), imag = new Float64Array(nfft);
    let mean = 0;
    for (const value of samples) { if (!Number.isFinite(value)) fail('欠測または非数値が含まれています。'); mean += value / samples.length; }
    // ObsPy remove_response uses a quarter cosine with SAC endpoint placement;
    // taperFraction is the total fraction, half at each end.
    const edge = Math.max(1, Math.floor(samples.length * taperFraction / 2 + 0.5));
    for (let i = 0; i < samples.length; i++) {
      let weight = 1;
      if (taperFraction > 0 && edge > 0) {
        if (i <= edge) weight = Math.sin(Math.PI / 2 * i / edge);
        else if (i >= samples.length - edge - 1) weight = Math.sin(Math.PI / 2 * (samples.length - i - 1) / edge);
      }
      real[i] = (samples[i] - mean) * weight;
    }
    fft(real, imag);
    for (let i = 0; i <= nfft / 2; i++) {
      const frequency = i * sampleRate / nfft;
      const taper = frequencyTaper(frequency, preFilter);
      let value = [0, 0];
      if (taper) {
        const transfer = responseAt(response, frequency);
        const magnitude = Math.hypot(...transfer);
        if (!Number.isFinite(magnitude) || magnitude <= 1e-30) fail('通過帯域内に補正できない応答があります。');
        value = divide([real[i] * taper, imag[i] * taper], transfer);
      }
      real[i] = value[0]; imag[i] = i === 0 || i === nfft / 2 ? 0 : value[1];
      if (i > 0 && i < nfft / 2) { real[nfft - i] = value[0]; imag[nfft - i] = -value[1]; }
    }
    fft(real, imag, true);
    const acceleration = real.slice(0, samples.length);
    if (!acceleration.every(Number.isFinite)) fail('補正結果が有限値ではありません。');
    return { acceleration, processing: {
      method: 'StationXML full-stage frequency-domain deconvolution',
      inputUnits: 'counts', outputUnits: 'm/s²', nativeUnits: response.inputUnits,
      responseId: response.id, responseEpochStart: response.epochStart, responseEpochEnd: response.epochEnd,
      sampleRate, preFilter, zeroMean: true, taperFraction, taper: 'quarter cosine, SAC endpoints',
      waterLevel: null, nfft, stageCount: response.stages.length,
      sensitivity: response.sensitivity, calculatedSensitivity: response.calculatedSensitivity,
    } };
  }
  return { parseStationXML, correct, evaluateResponse, MAX_SAMPLES };
})();
