/**
 * monitor.js - 検索結果から監視ダッシュボードを生成
 * World Monitor の「状況把握」の要素を地震データ向けに独自実装する。
 */
const MonitorDashboard = (() => {
  // 上から順に優先判定する。重複する境界は、より狭く用途が明確な地域を先に置く。
  // minlon > maxlon の地域は日付変更線をまたぐ範囲として扱う。
  const regions = [
    { name: '日本周辺', minlat: 20, maxlat: 50, minlon: 120, maxlon: 155 },
    { name: '東南アジア', minlat: -15, maxlat: 25, minlon: 90, maxlon: 145 },
    { name: '北米西岸', minlat: 25, maxlat: 65, minlon: -170, maxlon: -110 },
    { name: '中南米太平洋側', minlat: -60, maxlat: 25, minlon: -90, maxlon: -60 },
    { name: '南太平洋', minlat: -55, maxlat: 5, minlon: 130, maxlon: -120 },
    { name: '地中海・中東', minlat: 20, maxlat: 48, minlon: -10, maxlon: 60 },
    { name: '中央アジア', minlat: 20, maxlat: 50, minlon: 55, maxlon: 95 },
    { name: '大西洋', minlat: -60, maxlat: 70, minlon: -60, maxlon: 20 },
  ];

  function init() {
    clear();
  }

  function render(geojson) {
    const features = Array.isArray(geojson?.features) ? geojson.features : [];
    if (features.length === 0) {
      clear();
      return;
    }

    const summaries = buildSummaries(features);
    renderCards(summaries);
    renderHotspots(summaries.hotspots);
    renderWatchlist(summaries.watchlist);
  }

  function clear() {
    const cards = document.getElementById('monitor-cards');
    const hotspots = document.getElementById('monitor-hotspots');
    const watchlist = document.getElementById('monitor-watchlist');
    if (cards) {
      cards.innerHTML = '<div class="monitor-empty">検索結果が表示されると監視サマリーを描画します</div>';
    }
    if (hotspots) {
      hotspots.classList.add('empty');
      hotspots.textContent = '--';
    }
    if (watchlist) {
      watchlist.classList.add('empty');
      watchlist.textContent = '--';
    }
  }

  function buildSummaries(features) {
    const ordered = [...features].sort((a, b) => (b.properties?.time || 0) - (a.properties?.time || 0));
    const latest = ordered[0];
    const maxMagEvent = features.reduce((best, feature) => {
      const mag = feature.properties?.mag ?? -Infinity;
      const bestMag = best?.properties?.mag ?? -Infinity;
      return mag > bestMag ? feature : best;
    }, null);
    const strongEvents = features.filter(feature => (feature.properties?.mag ?? 0) >= 6);
    const tsunamiEvents = features.filter(feature => feature.properties?.tsunami);
    const shallowStrong = features.filter(feature => {
      const mag = feature.properties?.mag ?? 0;
      const depth = feature.geometry?.coordinates?.[2] ?? 999;
      return mag >= 5.5 && depth <= 70;
    });
    const hotspots = buildHotspots(features);
    const watchlist = buildWatchlist(features);
    const status = buildStatus(features, strongEvents, tsunamiEvents, shallowStrong);

    return {
      total: features.length,
      latest,
      maxMagEvent,
      strongEvents,
      tsunamiEvents,
      shallowStrong,
      hotspots,
      watchlist,
      status,
    };
  }

  function buildStatus(features, strongEvents, tsunamiEvents, shallowStrong) {
    if (!features.length) {
      return { label: '通常', className: 'normal', note: '検索範囲内にデータなし' };
    }

    const maxMag = Math.max(...features.map(feature => feature.properties?.mag ?? 0));
    if (tsunamiEvents.length > 0 || maxMag >= 7.5) {
      return { label: '高', className: 'high', note: '津波フラグまたはM7.5以上を検出' };
    }
    if (strongEvents.length > 0 || shallowStrong.length >= 2) {
      return { label: '中', className: 'medium', note: 'M6以上または浅い強震を検出' };
    }
    return { label: '通常', className: 'normal', note: '検索範囲内に顕著な警戒条件なし' };
  }

  function buildHotspots(features) {
    const counts = new Map();
    features.forEach(feature => {
      const region = classifyRegion(feature);
      const current = counts.get(region) || { name: region, count: 0, maxMag: 0, latestTime: 0 };
      current.count += 1;
      current.maxMag = Math.max(current.maxMag, feature.properties?.mag || 0);
      current.latestTime = Math.max(current.latestTime, feature.properties?.time || 0);
      counts.set(region, current);
    });

    return [...counts.values()]
      .sort((a, b) => b.count - a.count || b.maxMag - a.maxMag || b.latestTime - a.latestTime)
      .slice(0, 5);
  }

  function buildWatchlist(features) {
    return [...features]
      .map(feature => ({ feature, score: riskScore(feature) }))
      .filter(item => item.score >= 5.5)
      .sort((a, b) => b.score - a.score || (b.feature.properties?.time || 0) - (a.feature.properties?.time || 0))
      .slice(0, 5);
  }

  function classifyRegion(feature) {
    const coords = feature.geometry?.coordinates || [];
    const lon = coords[0];
    const lat = coords[1];
    const hit = regions.find(region => (
      lat >= region.minlat &&
      lat <= region.maxlat &&
      lonInRange(lon, region.minlon, region.maxlon)
    ));
    return hit ? hit.name : 'その他地域';
  }

  function lonInRange(lon, minlon, maxlon) {
    if (!Number.isFinite(lon)) return false;
    if (minlon <= maxlon) return lon >= minlon && lon <= maxlon;
    return lon >= minlon || lon <= maxlon;
  }

  function riskScore(feature) {
    const mag = feature.properties?.mag || 0;
    const depth = feature.geometry?.coordinates?.[2] ?? 999;
    let score = mag;
    if (mag >= 7) score += 3;
    else if (mag >= 6) score += 2;
    else if (mag >= 5.5) score += 1;
    if (depth <= 30) score += 1.25;
    else if (depth <= 70) score += 0.75;
    if (feature.properties?.tsunami) score += 2.5;
    return score;
  }

  function renderCards(summary) {
    const cards = document.getElementById('monitor-cards');
    if (!cards) return;

    cards.innerHTML = [
      cardHtml('監視判定', summary.status.label, summary.status.note, `status-${summary.status.className}`),
      eventCardHtml('最大M', summary.maxMagEvent),
      cardHtml('M6以上', `${summary.strongEvents.length}件`, `${summary.total}件中`, summary.strongEvents.length ? 'status-medium' : ''),
      cardHtml('津波フラグ', `${summary.tsunamiEvents.length}件`, 'USGS tsunami flag', summary.tsunamiEvents.length ? 'status-high' : ''),
      cardHtml('浅い強震', `${summary.shallowStrong.length}件`, 'M5.5以上・深さ70km以下', summary.shallowStrong.length ? 'status-medium' : ''),
      eventCardHtml('最新', summary.latest),
    ].join('');
  }

  function renderHotspots(hotspots) {
    const el = document.getElementById('monitor-hotspots');
    if (!el) return;
    if (hotspots.length === 0) {
      el.classList.add('empty');
      el.textContent = '--';
      return;
    }

    el.classList.remove('empty');
    el.innerHTML = hotspots.map(item => `
      <div class="monitor-row">
        <span class="monitor-row-title">${escapeHtml(item.name)}</span>
        <span>${item.count}件 / 最大M${item.maxMag.toFixed(1)}</span>
      </div>
    `).join('');
  }

  function renderWatchlist(items) {
    const el = document.getElementById('monitor-watchlist');
    if (!el) return;
    if (items.length === 0) {
      el.classList.add('empty');
      el.textContent = '要注意条件に該当するイベントはありません';
      return;
    }

    el.classList.remove('empty');
    el.innerHTML = items.map(({ feature, score }) => {
      const props = feature.properties || {};
      const depth = feature.geometry?.coordinates?.[2];
      const level = riskLevel(score);
      return `
        <div class="monitor-row">
          <span class="monitor-row-title">M${formatNumber(props.mag, 1)} ${escapeHtml(I18n.translatePlace(props.place))}</span>
          <span><span class="monitor-risk ${level.className}">${level.label}</span> ${formatDepth(depth)}</span>
        </div>
      `;
    }).join('');
  }

  function riskLevel(score) {
    if (score >= 9) return { label: '高', className: 'high' };
    if (score >= 7) return { label: '中', className: 'medium' };
    return { label: '注意', className: 'watch' };
  }

  function cardHtml(label, value, note, className = '') {
    return `
      <div class="monitor-card ${className}">
        <span class="monitor-label">${escapeHtml(label)}</span>
        <strong>${escapeHtml(value)}</strong>
        <span class="monitor-note">${escapeHtml(note)}</span>
      </div>
    `;
  }

  function eventCardHtml(label, feature) {
    if (!feature) return cardHtml(label, '--', 'データなし');
    const props = feature.properties || {};
    const place = I18n.translatePlace(props.place);
    const time = I18n.formatDateJST(props.time);
    return `
      <div class="monitor-card">
        <span class="monitor-label">${escapeHtml(label)}</span>
        <strong>M${formatNumber(props.mag, 1)}</strong>
        <span class="monitor-note">${escapeHtml(place)}</span>
        <span class="monitor-time">${escapeHtml(time)}</span>
      </div>
    `;
  }

  function formatNumber(value, digits = 0) {
    return Number.isFinite(value) ? value.toFixed(digits) : '?';
  }

  function formatDepth(value) {
    return Number.isFinite(value) ? `${value.toFixed(1)}km` : '深さ不明';
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str == null ? '' : String(str);
    return div.innerHTML;
  }

  return {
    init,
    render,
    clear,
  };
})();
