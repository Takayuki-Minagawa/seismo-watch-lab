/**
 * app.js - SeismoWatch Lab メインアプリケーション
 * UI制御、検索実行、結果表示、ソート、ページネーション
 */
;(() => {
  'use strict';

  // --- 状態管理 ---
  let currentData = null;        // 現在の検索結果 (GeoJSON)
  let sortedFeatures = [];       // ソート済みfeature配列
  let currentSort = { key: 'time', asc: false };
  let currentPage = 1;
  const PAGE_SIZE = 50;

  // --- DOM要素 ---
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const els = {
    startdate: $('#startdate'),
    enddate: $('#enddate'),
    minmag: $('#minmag'),
    maxdepth: $('#maxdepth'),
    region: $('#region'),
    limit: $('#limit'),
    customBounds: $('#custom-bounds'),
    btnSearch: $('#btn-search'),
    btnReset: $('#btn-reset'),
    loading: $('#loading'),
    resultsCount: $('#results-count'),
    tbody: $('#eq-tbody'),
    btnCSV: $('#btn-csv'),
    btnJSON: $('#btn-json'),
    btnGeoJSON: $('#btn-geojson'),
    pagination: $('#pagination'),
    pageInfo: $('#page-info'),
    pagePrev: $('#page-prev'),
    pageNext: $('#page-next'),
  };

  // --- 初期化 ---
  function init() {
    // デフォルト日付（過去7日〜本日）
    const today = new Date();
    const weekAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
    els.startdate.value = formatDateInput(weekAgo);
    els.enddate.value = formatDateInput(today);

    // 地図初期化
    EarthquakeMap.init('map');

    // イベントリスナー
    els.btnSearch.addEventListener('click', executeSearch);
    els.btnReset.addEventListener('click', resetForm);
    els.region.addEventListener('change', onRegionChange);

    // クイック検索ボタン
    $$('[data-quick]').forEach(btn => {
      btn.addEventListener('click', () => quickSearch(btn.dataset.quick));
    });

    // ダウンロードボタン
    els.btnCSV.addEventListener('click', () => {
      if (currentData) Download.asCSV(currentData, generateFilename('csv'));
    });
    els.btnJSON.addEventListener('click', () => {
      if (currentData) Download.asJSON(currentData, generateFilename('json'));
    });
    els.btnGeoJSON.addEventListener('click', () => {
      if (currentData) Download.asGeoJSON(currentData, generateFilename('geojson'));
    });

    // テーブルヘッダーソート
    $$('.eq-table thead th[data-sort]').forEach(th => {
      th.addEventListener('click', () => onSortClick(th.dataset.sort));
    });

    // ページネーション
    els.pagePrev.addEventListener('click', () => changePage(-1));
    els.pageNext.addEventListener('click', () => changePage(1));

    // Enterキーで検索
    $$('.search-panel input').forEach(input => {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') executeSearch();
      });
    });
  }

  // --- 検索実行 ---
  async function executeSearch() {
    const params = buildSearchParams();
    if (!params) return;

    showLoading(true);
    clearError();

    try {
      const data = await EarthquakeAPI.search(params);
      handleResults(data);
    } catch (err) {
      showError(err.message);
    } finally {
      showLoading(false);
    }
  }

  // --- クイック検索 ---
  async function quickSearch(type) {
    showLoading(true);
    clearError();

    try {
      let data;
      switch (type) {
        case '24h-4.5':
          data = await EarthquakeAPI.recentSearch(24, 4.5);
          break;
        case '7d-5.0':
          data = await EarthquakeAPI.recentSearch(168, 5.0);
          break;
        case '30d-6.0':
          data = await EarthquakeAPI.recentSearch(720, 6.0);
          break;
        case '365d-7.0':
          data = await EarthquakeAPI.recentSearch(8760, 7.0, 500);
          break;
        default:
          return;
      }
      handleResults(data);
    } catch (err) {
      showError(err.message);
    } finally {
      showLoading(false);
    }
  }

  // --- 検索パラメータ組み立て ---
  function buildSearchParams() {
    const params = {};

    if (els.startdate.value) params.starttime = els.startdate.value;
    if (els.enddate.value) {
      // 終了日は翌日の0時まで含める
      const end = new Date(els.enddate.value);
      end.setDate(end.getDate() + 1);
      params.endtime = formatDateInput(end);
    }
    if (els.minmag.value) params.minmagnitude = els.minmag.value;
    if (els.maxdepth.value) params.maxdepth = els.maxdepth.value;
    if (els.limit.value) params.limit = els.limit.value;

    // 地域フィルタ
    const regionKey = els.region.value;
    if (regionKey === 'custom') {
      const minlat = $('#custom-minlat').value;
      const maxlat = $('#custom-maxlat').value;
      const minlon = $('#custom-minlon').value;
      const maxlon = $('#custom-maxlon').value;
      if (minlat) params.minlat = minlat;
      if (maxlat) params.maxlat = maxlat;
      if (minlon) params.minlon = minlon;
      if (maxlon) params.maxlon = maxlon;
    } else if (regionKey !== 'global') {
      const presets = EarthquakeAPI.getRegionPresets();
      const preset = presets[regionKey];
      if (preset && preset.bounds) {
        params.minlat = preset.bounds.minlat;
        params.maxlat = preset.bounds.maxlat;
        params.minlon = preset.bounds.minlon;
        params.maxlon = preset.bounds.maxlon;
      }
    }

    return params;
  }

  // --- 結果処理 ---
  function handleResults(data) {
    currentData = data;
    currentPage = 1;
    currentSort = { key: 'time', asc: false };

    const count = data.features ? data.features.length : 0;
    els.resultsCount.textContent = `検索結果: ${count}件`;

    // ダウンロードボタン有効化
    const hasData = count > 0;
    els.btnCSV.disabled = !hasData;
    els.btnJSON.disabled = !hasData;
    els.btnGeoJSON.disabled = !hasData;

    if (count === 0) {
      els.tbody.innerHTML = `
        <tr><td colspan="7">
          <div class="empty-state">
            <div class="icon">&#x1F50D;</div>
            <div>該当する地震データが見つかりませんでした</div>
            <div style="margin-top:0.5rem; font-size:0.8rem;">検索条件を変更してお試しください</div>
          </div>
        </td></tr>`;
      els.pagination.style.display = 'none';
      EarthquakeMap.clearMarkers();
      return;
    }

    // ソート＆表示
    sortFeatures();
    renderTable();
    updateSortHeaders();

    // 地図表示
    EarthquakeMap.displayEarthquakes(data, onMarkerClick);

    // 結果セクションまでスクロール
    $('#results-section').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // --- テーブル描画 ---
  function renderTable() {
    const totalPages = Math.ceil(sortedFeatures.length / PAGE_SIZE);
    const start = (currentPage - 1) * PAGE_SIZE;
    const end = start + PAGE_SIZE;
    const pageFeatures = sortedFeatures.slice(start, end);

    let html = '';
    pageFeatures.forEach((feature, idx) => {
      const p = feature.properties;
      const c = feature.geometry.coordinates;
      const mag = p.mag;
      const depth = c[2];
      const magClass = I18n.magnitudeClass(mag);
      const place = I18n.translatePlace(p.place);
      const time = I18n.formatDateJST(p.time);
      const status = I18n.translateTerm(p.status) || p.status;
      const globalIdx = currentData.features.indexOf(feature);

      html += `<tr data-index="${globalIdx}" data-lat="${c[1]}" data-lon="${c[0]}">
        <td class="col-time">${time}</td>
        <td class="col-mag"><span class="mag-badge ${magClass}">${mag !== null ? mag.toFixed(1) : '?'}</span></td>
        <td class="col-depth">${depth !== null ? depth.toFixed(1) : '-'}</td>
        <td class="col-place" title="${escapeHtml(p.place)}">${escapeHtml(place)}</td>
        <td>${p.tsunami ? '<span class="tsunami-icon">&#x1F30A; あり</span>' : '-'}</td>
        <td>${escapeHtml(status)}</td>
        <td><a href="${p.url}" target="_blank" rel="noopener" onclick="event.stopPropagation()">USGS</a></td>
      </tr>`;
    });

    els.tbody.innerHTML = html;

    // 行クリックで地図フォーカス
    els.tbody.querySelectorAll('tr[data-lat]').forEach(tr => {
      tr.addEventListener('click', () => {
        const lat = parseFloat(tr.dataset.lat);
        const lon = parseFloat(tr.dataset.lon);
        EarthquakeMap.focusOn(lat, lon);
        // ハイライト
        els.tbody.querySelectorAll('tr').forEach(r => r.classList.remove('highlighted'));
        tr.classList.add('highlighted');
      });
    });

    // ページネーション
    if (totalPages > 1) {
      els.pagination.style.display = 'flex';
      els.pageInfo.textContent = `${currentPage} / ${totalPages}`;
      els.pagePrev.disabled = currentPage <= 1;
      els.pageNext.disabled = currentPage >= totalPages;
    } else {
      els.pagination.style.display = 'none';
    }
  }

  // --- ソート ---
  function sortFeatures() {
    if (!currentData || !currentData.features) return;

    sortedFeatures = [...currentData.features];
    const { key, asc } = currentSort;

    sortedFeatures.sort((a, b) => {
      let va, vb;
      switch (key) {
        case 'time':
          va = a.properties.time || 0;
          vb = b.properties.time || 0;
          break;
        case 'mag':
          va = a.properties.mag ?? -1;
          vb = b.properties.mag ?? -1;
          break;
        case 'depth':
          va = a.geometry.coordinates[2] ?? -1;
          vb = b.geometry.coordinates[2] ?? -1;
          break;
        case 'place':
          va = I18n.translatePlace(a.properties.place);
          vb = I18n.translatePlace(b.properties.place);
          return asc ? va.localeCompare(vb, 'ja') : vb.localeCompare(va, 'ja');
        default:
          return 0;
      }
      return asc ? va - vb : vb - va;
    });
  }

  function onSortClick(key) {
    if (currentSort.key === key) {
      currentSort.asc = !currentSort.asc;
    } else {
      currentSort.key = key;
      currentSort.asc = key === 'place'; // 地名は昇順デフォルト、他は降順
    }
    currentPage = 1;
    sortFeatures();
    renderTable();
    updateSortHeaders();
  }

  function updateSortHeaders() {
    $$('.eq-table thead th[data-sort]').forEach(th => {
      const isActive = th.dataset.sort === currentSort.key;
      th.classList.toggle('sorted', isActive);
      const icon = th.querySelector('.sort-icon');
      if (icon) {
        if (isActive) {
          icon.textContent = currentSort.asc ? '\u25B2' : '\u25BC';
        } else {
          icon.textContent = '\u25B2\u25BC';
        }
      }
    });
  }

  // --- ページネーション ---
  function changePage(delta) {
    const totalPages = Math.ceil(sortedFeatures.length / PAGE_SIZE);
    const newPage = currentPage + delta;
    if (newPage < 1 || newPage > totalPages) return;
    currentPage = newPage;
    renderTable();
    $('#results-section').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // --- マーカークリック時 ---
  function onMarkerClick(index) {
    // テーブル内の対応行をハイライト
    const row = els.tbody.querySelector(`tr[data-index="${index}"]`);
    if (row) {
      els.tbody.querySelectorAll('tr').forEach(r => r.classList.remove('highlighted'));
      row.classList.add('highlighted');
      row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  // --- 地域選択変更 ---
  function onRegionChange() {
    els.customBounds.style.display = els.region.value === 'custom' ? 'grid' : 'none';
  }

  // --- フォームリセット ---
  function resetForm() {
    const today = new Date();
    const weekAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
    els.startdate.value = formatDateInput(weekAgo);
    els.enddate.value = formatDateInput(today);
    els.minmag.value = '4';
    els.maxdepth.value = '';
    els.region.value = 'global';
    els.limit.value = '200';
    els.customBounds.style.display = 'none';
    $('#custom-minlat').value = '';
    $('#custom-maxlat').value = '';
    $('#custom-minlon').value = '';
    $('#custom-maxlon').value = '';
  }

  // --- UI ヘルパー ---
  function showLoading(show) {
    els.loading.classList.toggle('active', show);
    els.btnSearch.disabled = show;
  }

  function showError(message) {
    clearError();
    const div = document.createElement('div');
    div.className = 'error-msg';
    div.id = 'error-msg';
    div.textContent = message;
    els.tbody.closest('.card').insertBefore(div, els.tbody.closest('.table-wrapper'));
  }

  function clearError() {
    const existing = $('#error-msg');
    if (existing) existing.remove();
  }

  function formatDateInput(date) {
    return date.toISOString().split('T')[0];
  }

  function generateFilename(ext) {
    const now = new Date();
    const ts = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
    return `earthquakes_${ts}.${ext}`;
  }

  function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // --- 起動 ---
  document.addEventListener('DOMContentLoaded', init);
})();
