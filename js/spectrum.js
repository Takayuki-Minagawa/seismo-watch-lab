/**
 * spectrum.js - 応答スペクトル計算モジュール
 * K-NET形式の加速度データを読み込み、Newmark-β法で応答スペクトルを算出
 */
const Spectrum = (() => {
  let spectrumChart = null;
  let waveformChart = null;

  /**
   * K-NET形式ファイルをパース
   * @param {string} text - ファイル内容
   * @returns {Object} { acc: number[], dt: number, meta: Object }
   */
  function parseKNET(text) {
    const lines = text.split('\n');
    const meta = {};
    let dataStart = -1;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line === 'Memo.' || line === 'Memo') {
        dataStart = i + 1;
        break;
      }
      // メタデータ解析
      const colonIdx = line.indexOf(' ');
      if (colonIdx > 0) {
        const key = line.substring(0, 18).trim();
        const val = line.substring(18).trim();
        if (key && val) meta[key] = val;
      }
    }

    if (dataStart < 0) {
      throw new Error('K-NET形式のデータが見つかりません。"Memo." 行が必要です。');
    }

    // スケールファクター解析: "4508(gal)/6553600" → numerator/denominator
    let scaleFactor = 1;
    const scaleStr = meta['Scale Factor'] || meta['ScaleFactor'] || '';
    const scaleMatch = scaleStr.match(/([\d.]+)\s*\(gal\)\s*\/\s*([\d.]+)/i);
    if (scaleMatch) {
      scaleFactor = parseFloat(scaleMatch[1]) / parseFloat(scaleMatch[2]);
    }

    // サンプリング周波数
    let freq = 100;
    const freqStr = meta['Sampling Freq(Hz)'] || '';
    const freqMatch = freqStr.match(/([\d.]+)/);
    if (freqMatch) freq = parseFloat(freqMatch[1]);
    const dt = 1.0 / freq;

    // 加速度データ読み込み
    const acc = [];
    for (let i = dataStart; i < lines.length; i++) {
      const vals = lines[i].trim().split(/\s+/);
      for (const v of vals) {
        const num = parseFloat(v);
        if (!isNaN(num)) {
          acc.push(num * scaleFactor); // gal (cm/s²)
        }
      }
    }

    if (acc.length === 0) {
      throw new Error('加速度データが読み込めませんでした。');
    }

    meta._freq = freq;
    meta._dt = dt;
    meta._npts = acc.length;
    meta._duration = acc.length * dt;
    meta._maxAcc = Math.max(...acc.map(Math.abs));

    return { acc, dt, meta };
  }

  /**
   * CSV形式をパース（時間,加速度 or 加速度のみ）
   * @param {string} text - CSV内容
   * @param {number} dt - サンプリング間隔(秒)、CSVに時間列がない場合に使用
   * @returns {Object} { acc: number[], dt: number }
   */
  function parseCSV(text, defaultDt = 0.01) {
    const lines = text.trim().split('\n');
    const acc = [];
    let dt = defaultDt;
    let prevTime = null;

    for (const line of lines) {
      if (line.startsWith('#') || line.startsWith('//') || /^[a-zA-Z]/.test(line.trim())) continue;
      const parts = line.trim().split(/[,\s\t]+/);

      if (parts.length >= 2) {
        const t = parseFloat(parts[0]);
        const a = parseFloat(parts[1]);
        if (!isNaN(a)) {
          acc.push(a);
          if (prevTime !== null && !isNaN(t)) {
            dt = t - prevTime;
          }
          if (!isNaN(t)) prevTime = t;
        }
      } else if (parts.length === 1) {
        const a = parseFloat(parts[0]);
        if (!isNaN(a)) acc.push(a);
      }
    }

    return { acc, dt, meta: { _dt: dt, _npts: acc.length, _duration: acc.length * dt, _maxAcc: Math.max(...acc.map(Math.abs)) } };
  }

  /**
   * Newmark-β法による1自由度系応答計算（平均加速度法）
   * @param {number[]} ag - 地動加速度配列 (gal)
   * @param {number} dt - 時間刻み (秒)
   * @param {number} T - 固有周期 (秒)
   * @param {number} h - 減衰定数
   * @returns {Object} { sd, sv, sa } 最大応答値
   */
  function sdofNewmark(ag, dt, T, h) {
    if (T < 1e-10) {
      // T=0 → PGA
      let pga = 0;
      for (let i = 0; i < ag.length; i++) {
        const abs = Math.abs(ag[i]);
        if (abs > pga) pga = abs;
      }
      return { sd: 0, sv: 0, sa: pga };
    }

    const omega = 2 * Math.PI / T;
    const omega2 = omega * omega;
    const c = 2 * h * omega;  // m = 1

    // Newmark average acceleration: gamma = 0.5, beta = 0.25
    const dt2 = dt * dt;
    const khat = omega2 + 2 * c / dt + 4 / dt2;

    let u = 0, v = 0;
    let a = -ag[0]; // 初期加速度 (m=1: a = -ag - c*v - k*u)

    let maxU = 0;
    let maxV = 0;
    let maxAbsA = Math.abs(ag[0]);

    for (let i = 1; i < ag.length; i++) {
      // 有効荷重増分
      const dphat = -(ag[i] - ag[i - 1]) + (4 / dt) * v + 2 * a
        + c * (2 * v + dt * a) / 1; // 簡略化

      // 正しいNewmark平均加速度法の実装
      const rhs = -ag[i] + (4 / dt2) * u + (4 / dt) * v + a
        + c * ((2 / dt) * u + v);

      const u_new = rhs / khat;
      const v_new = (2 / dt) * (u_new - u) - v;
      const a_new = -ag[i] - c * v_new - omega2 * u_new;

      u = u_new;
      v = v_new;
      a = a_new;

      const absU = Math.abs(u);
      const absV = Math.abs(v);
      const absA = Math.abs(ag[i] + a); // 絶対加速度

      if (absU > maxU) maxU = absU;
      if (absV > maxV) maxV = absV;
      if (absA > maxAbsA) maxAbsA = absA;
    }

    return { sd: maxU, sv: maxV, sa: maxAbsA };
  }

  /**
   * 応答スペクトルを計算
   * @param {number[]} ag - 加速度配列 (gal)
   * @param {number} dt - 時間刻み (秒)
   * @param {Object} options - { hList, periodMin, periodMax, periodCount }
   * @returns {Object} { periods, results: { [h]: { sa, sv, sd } } }
   */
  function computeSpectrum(ag, dt, options = {}) {
    const {
      hList = [0.05],
      periodMin = 0.02,
      periodMax = 10.0,
      periodCount = 100,
    } = options;

    // 対数スケールで周期を生成
    const periods = [0]; // T=0 (PGA)
    const logMin = Math.log10(periodMin);
    const logMax = Math.log10(periodMax);
    for (let i = 0; i < periodCount; i++) {
      const logT = logMin + (logMax - logMin) * i / (periodCount - 1);
      periods.push(Math.pow(10, logT));
    }

    const results = {};
    for (const h of hList) {
      const sa = [], sv = [], sd = [];
      for (const T of periods) {
        const resp = sdofNewmark(ag, dt, T, h);
        sa.push(resp.sa);
        sv.push(resp.sv);
        sd.push(resp.sd);
      }
      results[h] = { sa, sv, sd };
    }

    return { periods, results };
  }

  /**
   * 入力波形をChart.jsで描画
   */
  function renderWaveform(acc, dt, canvasId) {
    const ctx = document.getElementById(canvasId);
    if (!ctx) return;

    // データが多い場合は間引き
    const maxPoints = 2000;
    let plotAcc = acc;
    let plotDt = dt;
    if (acc.length > maxPoints) {
      const step = Math.ceil(acc.length / maxPoints);
      plotAcc = acc.filter((_, i) => i % step === 0);
      plotDt = dt * step;
    }

    const labels = plotAcc.map((_, i) => (i * plotDt).toFixed(2));

    if (waveformChart) waveformChart.destroy();
    waveformChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: labels,
        datasets: [{
          label: '加速度 (gal)',
          data: plotAcc,
          borderColor: '#e53e3e',
          borderWidth: 1,
          pointRadius: 0,
          fill: false,
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        plugins: {
          title: { display: true, text: '入力加速度波形' },
          legend: { display: false },
        },
        scales: {
          x: {
            title: { display: true, text: '時間 (秒)' },
            ticks: { maxTicksLimit: 10 },
          },
          y: {
            title: { display: true, text: '加速度 (gal)' },
          },
        },
      },
    });
  }

  /**
   * 応答スペクトルをChart.jsで描画
   */
  function renderSpectrum(specData, canvasId, type = 'sa') {
    const ctx = document.getElementById(canvasId);
    if (!ctx) return;

    const typeLabels = { sa: '加速度応答スペクトル Sa (gal)', sv: '速度応答スペクトル Sv (cm/s)', sd: '変位応答スペクトル Sd (cm)' };
    const colors = ['#e53e3e', '#3182ce', '#38a169', '#d69e2e', '#805ad5'];

    const datasets = [];
    let colorIdx = 0;
    for (const [h, data] of Object.entries(specData.results)) {
      // T=0を除外（対数軸のため）
      const values = data[type].slice(1);
      datasets.push({
        label: `h=${(parseFloat(h) * 100).toFixed(0)}%`,
        data: values,
        borderColor: colors[colorIdx % colors.length],
        borderWidth: 2,
        pointRadius: 0,
        fill: false,
      });
      colorIdx++;
    }

    const periods = specData.periods.slice(1); // T=0を除外

    if (spectrumChart) spectrumChart.destroy();
    spectrumChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: periods.map(t => t.toFixed(3)),
        datasets: datasets,
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          title: { display: true, text: typeLabels[type] || type },
          legend: { display: datasets.length > 1 },
        },
        scales: {
          x: {
            type: 'logarithmic',
            title: { display: true, text: '固有周期 (秒)' },
            ticks: {
              callback: (val) => {
                if ([0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10].includes(val)) return val;
                return '';
              },
            },
          },
          y: {
            type: 'logarithmic',
            title: { display: true, text: typeLabels[type]?.split(' ').pop() || '' },
          },
        },
      },
    });
  }

  /**
   * チャートをクリア
   */
  function clearCharts() {
    if (spectrumChart) { spectrumChart.destroy(); spectrumChart = null; }
    if (waveformChart) { waveformChart.destroy(); waveformChart = null; }
  }

  return {
    parseKNET,
    parseCSV,
    computeSpectrum,
    renderWaveform,
    renderSpectrum,
    clearCharts,
  };
})();
