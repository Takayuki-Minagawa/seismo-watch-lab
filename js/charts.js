/**
 * charts.js - 統計グラフモジュール
 * Chart.js を使用して検索結果の統計情報を可視化
 */
const Charts = (() => {
  let magChart = null;
  let depthChart = null;
  let timelineChart = null;
  let magDepthChart = null;

  // ダークモード対応の色取得
  function getTextColor() {
    return document.documentElement.dataset.theme === 'dark' ? '#cbd5e0' : '#4a5568';
  }
  function getGridColor() {
    return document.documentElement.dataset.theme === 'dark' ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.08)';
  }

  // マグニチュード帯の色
  const magColors = [
    '#48bb78', '#a0c45a', '#ecc94b', '#ed8936', '#e53e3e', '#9b2c2c', '#4a0000'
  ];
  const magLabels = ['M<3', 'M3-4', 'M4-5', 'M5-6', 'M6-7', 'M7-8', 'M8+'];

  /**
   * 全チャートを描画
   */
  function render(geojson) {
    if (!geojson || !geojson.features || geojson.features.length === 0) {
      clearAll();
      return;
    }
    const features = geojson.features;

    renderMagnitudeDistribution(features);
    renderDepthDistribution(features);
    renderTimeline(features);
    renderMagDepthScatter(features);
  }

  /**
   * マグニチュード分布（棒グラフ）
   */
  function renderMagnitudeDistribution(features) {
    const bins = [0, 0, 0, 0, 0, 0, 0]; // <3, 3-4, 4-5, 5-6, 6-7, 7-8, 8+
    features.forEach(f => {
      const m = f.properties.mag;
      if (m === null || m === undefined) return;
      if (m < 3) bins[0]++;
      else if (m < 4) bins[1]++;
      else if (m < 5) bins[2]++;
      else if (m < 6) bins[3]++;
      else if (m < 7) bins[4]++;
      else if (m < 8) bins[5]++;
      else bins[6]++;
    });

    const ctx = document.getElementById('chart-mag');
    if (!ctx) return;

    if (magChart) magChart.destroy();
    magChart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: magLabels,
        datasets: [{
          label: '件数',
          data: bins,
          backgroundColor: magColors,
          borderRadius: 3,
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          title: { display: true, text: 'マグニチュード分布', color: getTextColor() },
          legend: { display: false },
        },
        scales: {
          x: { ticks: { color: getTextColor() }, grid: { color: getGridColor() } },
          y: {
            beginAtZero: true,
            ticks: { color: getTextColor(), precision: 0 },
            grid: { color: getGridColor() },
            title: { display: true, text: '件数', color: getTextColor() },
          },
        },
      },
    });
  }

  /**
   * 深さ分布（棒グラフ）
   */
  function renderDepthDistribution(features) {
    const binEdges = [0, 10, 30, 70, 150, 300, 700];
    const binLabels = ['0-10', '10-30', '30-70', '70-150', '150-300', '300-700', '700+'];
    const bins = new Array(binLabels.length).fill(0);

    features.forEach(f => {
      const d = f.geometry.coordinates[2];
      if (d === null || d === undefined) return;
      let placed = false;
      for (let i = 0; i < binEdges.length; i++) {
        if (d < binEdges[i + 1] || i === binEdges.length - 1) {
          bins[i]++;
          placed = true;
          break;
        }
      }
      if (!placed) bins[bins.length - 1]++;
    });

    const ctx = document.getElementById('chart-depth');
    if (!ctx) return;

    if (depthChart) depthChart.destroy();
    depthChart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: binLabels,
        datasets: [{
          label: '件数',
          data: bins,
          backgroundColor: '#4299e1',
          borderRadius: 3,
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          title: { display: true, text: '深さ分布 (km)', color: getTextColor() },
          legend: { display: false },
        },
        scales: {
          x: { ticks: { color: getTextColor() }, grid: { color: getGridColor() } },
          y: {
            beginAtZero: true,
            ticks: { color: getTextColor(), precision: 0 },
            grid: { color: getGridColor() },
            title: { display: true, text: '件数', color: getTextColor() },
          },
        },
      },
    });
  }

  /**
   * 時系列グラフ（散布図：時間 vs マグニチュード）
   */
  function renderTimeline(features) {
    const data = features
      .filter(f => f.properties.mag !== null)
      .map(f => ({
        x: f.properties.time,
        y: f.properties.mag,
      }));

    const ctx = document.getElementById('chart-timeline');
    if (!ctx) return;

    if (timelineChart) timelineChart.destroy();
    timelineChart = new Chart(ctx, {
      type: 'scatter',
      data: {
        datasets: [{
          label: 'マグニチュード',
          data: data,
          backgroundColor: data.map(d => {
            if (d.y < 3) return '#48bb78';
            if (d.y < 5) return '#ecc94b';
            if (d.y < 7) return '#e53e3e';
            return '#4a0000';
          }),
          pointRadius: data.map(d => Math.max(2, (d.y || 0) * 0.8)),
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          title: { display: true, text: '地震発生タイムライン', color: getTextColor() },
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (ctx) => {
                const d = new Date(ctx.raw.x);
                return `M${ctx.raw.y.toFixed(1)} - ${d.toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo' })}`;
              }
            }
          }
        },
        scales: {
          x: {
            type: 'linear',
            ticks: {
              color: getTextColor(),
              callback: (val) => {
                const d = new Date(val);
                return `${d.getMonth() + 1}/${d.getDate()}`;
              },
              maxTicksLimit: 10,
            },
            grid: { color: getGridColor() },
            title: { display: true, text: '日付', color: getTextColor() },
          },
          y: {
            ticks: { color: getTextColor() },
            grid: { color: getGridColor() },
            title: { display: true, text: 'マグニチュード', color: getTextColor() },
          },
        },
      },
    });
  }

  /**
   * マグニチュード vs 深さ（散布図）
   */
  function renderMagDepthScatter(features) {
    const data = features
      .filter(f => f.properties.mag !== null && f.geometry.coordinates[2] !== null)
      .map(f => ({
        x: f.properties.mag,
        y: f.geometry.coordinates[2],
      }));

    const ctx = document.getElementById('chart-magdepth');
    if (!ctx) return;

    if (magDepthChart) magDepthChart.destroy();
    magDepthChart = new Chart(ctx, {
      type: 'scatter',
      data: {
        datasets: [{
          label: '地震',
          data: data,
          backgroundColor: 'rgba(229, 62, 62, 0.5)',
          pointRadius: 4,
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          title: { display: true, text: 'マグニチュード vs 深さ', color: getTextColor() },
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (ctx) => `M${ctx.raw.x.toFixed(1)} / 深さ ${ctx.raw.y.toFixed(1)} km`
            }
          }
        },
        scales: {
          x: {
            ticks: { color: getTextColor() },
            grid: { color: getGridColor() },
            title: { display: true, text: 'マグニチュード', color: getTextColor() },
          },
          y: {
            reverse: true,
            ticks: { color: getTextColor() },
            grid: { color: getGridColor() },
            title: { display: true, text: '深さ (km)', color: getTextColor() },
          },
        },
      },
    });
  }

  /**
   * 全チャートをクリア
   */
  function clearAll() {
    [magChart, depthChart, timelineChart, magDepthChart].forEach(c => {
      if (c) c.destroy();
    });
    magChart = depthChart = timelineChart = magDepthChart = null;
  }

  /**
   * テーマ変更時にチャートを再描画
   */
  function refreshTheme(geojson) {
    if (geojson) render(geojson);
  }

  return { render, clearAll, refreshTheme };
})();
