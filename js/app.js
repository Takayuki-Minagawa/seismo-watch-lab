/**
 * app.js - SeismoWatch Lab メインアプリケーション
 * UI制御、検索実行、結果表示、ソート、ページネーション
 * 拡張モジュール（統計・詳細・スペクトル・波形・設定）の統合
 */
;(() => {
  'use strict';

  // --- 状態管理 ---
  let currentData = null;
  let sortedFeatures = [];
  let currentSort = { key: 'time', asc: false };
  let currentPage = 1;
  let selectedFeature = null;
  let lastSearch = null; // 最後に成功した検索。編集中のフォームとは独立して保持する。
  let spectrumInputData = null;
  let currentSpectrumResult = null;
  let spectrumCalculationSeq = 0;
  let currentWaveformData = null;
  let waveformInputMode = null; // file は観測点検索・選択と独立した入力
  let currentWaveformView = { start: 0, end: null };
  const PAGE_SIZE = 50;
  const searchRequests = AppUtils.createRequestCoordinator();
  const stationSearchRequests = AppUtils.createRequestCoordinator();
  const waveformRequests = AppUtils.createRequestCoordinator();
  const stationInfoRequests = AppUtils.createRequestCoordinator();

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
    chartsEmpty: $('#charts-empty'),
  };

  // --- 初期化 ---
  function init() {
    // デフォルト日付
    const today = new Date();
    const weekAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
    els.startdate.value = formatDateInput(weekAgo);
    els.enddate.value = formatDateInput(today);

    // 地図初期化
    EarthquakeMap.init('map');
    const mapColorMode = $('#map-color-mode');
    if (mapColorMode) {
      mapColorMode.addEventListener('change', () => EarthquakeMap.setStyleMode(mapColorMode.value));
      EarthquakeMap.setStyleMode(mapColorMode.value);
    }

    // 拡張モジュール初期化
    MonitorDashboard.init();
    Settings.initDarkMode();
    Settings.initAutoRefresh(refreshLastSearch);
    Settings.initSavedSearches();
    Settings.initShare();
    Settings.onThemeChange(() => Charts.refreshTheme(currentData));
    DetailPanel.init();

    // 基本イベントリスナー
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
      th.querySelector('.sort-button')?.addEventListener('click', () => onSortClick(th.dataset.sort));
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

    // 分析タブ切替
    initTabs();

    // 応答スペクトルツール
    initSpectrumTool();

    // 波形ビューア
    initWaveformViewer();

    // URL共有パラメータからの復元と自動検索
    const restored = Settings.restoreFromURL();
    if (restored === 'quick') {
      const qt = Settings.getActiveQuickType();
      if (qt) setTimeout(() => quickSearch(qt), 300);
    } else if (restored === 'manual') {
      setTimeout(executeSearch, 300);
    }
  }

  // --- 検索実行 ---
  async function executeSearch() {
    const quickType = Settings.getActiveQuickType();
    if (quickType) return quickSearch(quickType);
    let params;
    try {
      params = buildSearchParams();
      EarthquakeAPI.validateSearchParams(params);
    } catch (error) {
      showError(error.message);
      return;
    }
    return runManualSearch(params);
  }

  async function runManualSearch(params) {
    await runSearch(
      signal => EarthquakeAPI.search(params, { signal }),
      data => {
        lastSearch = { type: 'manual', params: JSON.parse(JSON.stringify(params)) };
        handleResults(data);
      }
    );
  }

  function refreshLastSearch() {
    // 更新タイマーがユーザーの新しい検索を中断しないようにする。
    if (!lastSearch || searchRequests.isActive()) return;
    if (lastSearch.type === 'quick') return quickSearch(lastSearch.quick, { updateDraft: false });
    return runManualSearch(lastSearch.params);
  }

  // --- クイック検索 ---
  // プリセット定義（ローリング時間帯と正確なマグニチュード閾値）
  const quickPresets = {
    '24h-4.5':  { hours: 24,   minMag: 4.5, limit: 200, label: '24時間 M4.5+' },
    '7d-5.0':   { hours: 168,  minMag: 5.0, limit: 200, label: '7日間 M5.0+' },
    '30d-6.0':  { hours: 720,  minMag: 6.0, limit: 200, label: '30日間 M6.0+' },
    '365d-7.0': { hours: 8760, minMag: 7.0, limit: 500, label: '1年間 M7.0+' },
  };

  async function quickSearch(type, { updateDraft = true } = {}) {
    const preset = quickPresets[type];
    if (!preset) return;
    if (updateDraft) Settings.setActiveQuickType(type);

    await runSearch(
      signal => EarthquakeAPI.recentSearch(preset.hours, preset.minMag, preset.limit, { signal }),
      data => {
        lastSearch = { type: 'quick', quick: type };
        handleResults(data);
      }
    );
  }

  async function runSearch(fetchData, onSuccess) {
    const request = searchRequests.begin();
    showLoading(true);
    clearError();

    try {
      const data = await fetchData(request.signal);
      if (!request.isCurrent()) return;
      onSuccess(data);
    } catch (err) {
      if (request.isCurrent() && !AppUtils.isAbortError(err)) showError(err.message);
    } finally {
      if (request.isCurrent()) showLoading(false);
      searchRequests.finish(request.id);
    }
  }

  // --- 検索パラメータ組み立て ---
  function buildSearchParams() {
    const regionKey = els.region.value;
    const activeInputs = [
      [els.startdate, '開始日'],
      [els.enddate, '終了日'],
      [els.maxdepth, '最大深さ'],
    ];
    if (regionKey === 'custom') {
      activeInputs.push(
        [$('#custom-minlat'), '南端緯度'], [$('#custom-maxlat'), '北端緯度'],
        [$('#custom-minlon'), '西端経度'], [$('#custom-maxlon'), '東端経度']
      );
    } else if (regionKey === 'circle') {
      activeInputs.push(
        [$('#circle-latitude'), '中心緯度'], [$('#circle-longitude'), '中心経度'],
        [$('#circle-radius'), '検索半径']
      );
    }
    // 例: 数値欄の「1e」は value が空になる。意図した空欄と区別して条件の脱落を防ぐ。
    for (const [input, label] of activeInputs) {
      if (input?.validity?.badInput) throw new RangeError(`${label}の入力を完成させてください`);
    }

    const params = AppUtils.buildUTCDateRange(els.startdate.value, els.enddate.value);
    if (els.minmag.value) params.minmagnitude = els.minmag.value;
    if (els.maxdepth.value) params.maxdepth = els.maxdepth.value;
    if (els.limit.value) params.limit = els.limit.value;

    if (regionKey === 'custom') {
      params.requireBounds = true;
      params.minlat = $('#custom-minlat').value;
      params.maxlat = $('#custom-maxlat').value;
      params.minlon = $('#custom-minlon').value;
      params.maxlon = $('#custom-maxlon').value;
    } else if (regionKey === 'circle') {
      params.requireCircle = true;
      params.latitude = $('#circle-latitude').value;
      params.longitude = $('#circle-longitude').value;
      params.maxradiuskm = $('#circle-radius').value;
    } else if (regionKey !== 'global') {
      const presets = EarthquakeAPI.getRegionPresets();
      const preset = presets[regionKey];
      if (preset?.boundsList) {
        params.boundsList = preset.boundsList;
      } else if (preset?.bounds) {
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
    selectedFeature = null;
    DetailPanel.close();

    const waveformLabel = $('#waveform-eq-label');
    if (waveformLabel) waveformLabel.value = '';
    resetWaveformViewerState();

    const count = data.features ? data.features.length : 0;
    els.resultsCount.textContent = `検索結果: ${count}件`;
    $('#results-limit-notice').hidden = !data.metadata?.limitReached;

    const hasData = count > 0;
    els.btnCSV.disabled = !hasData;
    els.btnJSON.disabled = !hasData;
    els.btnGeoJSON.disabled = !hasData;

    if (count === 0) {
      sortedFeatures = [];
      updateSortHeaders();
      els.tbody.innerHTML = `
        <tr><td colspan="7">
          <div class="empty-state">
            <div class="icon">&#x1F50D;</div>
            <div>該当する地震データが見つかりませんでした</div>
            <div style="margin-top:0.5rem; font-size:0.8rem;">検索条件を変更してお試しください</div>
          </div>
        </td></tr>`;
      els.pagination.style.display = 'none';
      EarthquakeMap.reset();
      MonitorDashboard.clear();
      Charts.clearAll();
      if (els.chartsEmpty) els.chartsEmpty.style.display = '';
      return;
    }

    // ソート＆表示
    sortFeatures();
    renderTable();
    updateSortHeaders();

    // 地図表示
    EarthquakeMap.displayEarthquakes(data, onMarkerClick);

    // 監視ダッシュボード
    MonitorDashboard.render(data);

    // 統計グラフ
    if (els.chartsEmpty) els.chartsEmpty.style.display = 'none';
    Charts.render(data);

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
    pageFeatures.forEach((feature) => {
      const p = feature.properties;
      const c = feature.geometry.coordinates;
      const mag = p.mag;
      const depth = c[2];
      const magClass = I18n.magnitudeClass(mag);
      const place = I18n.translatePlace(p.place);
      const time = I18n.formatDateJST(p.time);
      const status = I18n.translateTerm(p.status) || p.status;
      const globalIdx = currentData.features.indexOf(feature);
      const detailUrl = AppUtils.sanitizeUrlForOrigins(p.url, ['https://earthquake.usgs.gov']);
      const detailLink = detailUrl
        ? `<a href="${escapeHtml(detailUrl)}" target="_blank" rel="noopener" data-stop-row-click="true">USGS</a>`
        : '-';

      const detailButtonLabel = `M${mag ?? '?'} ${place}の詳細を表示`;
      html += `<tr data-index="${globalIdx}" data-lat="${escapeHtml(c[1])}" data-lon="${escapeHtml(c[0])}">
        <td class="col-time">${escapeHtml(time)}</td>
        <td class="col-mag"><span class="mag-badge ${magClass}">${mag !== null ? mag.toFixed(1) : '?'}</span></td>
        <td class="col-depth">${depth !== null ? depth.toFixed(1) : '-'}</td>
        <td class="col-place" title="${escapeHtml(p.place)}">${escapeHtml(place)}</td>
        <td>${p.tsunami ? '<span class="tsunami-icon" title="USGS津波関連フラグ。津波警報を意味しません">関連あり</span>' : '-'}</td>
        <td>${escapeHtml(status)}</td>
        <td class="row-actions"><button type="button" class="btn btn-sm btn-secondary" data-open-row-detail aria-label="${escapeHtml(detailButtonLabel)}">表示</button>${detailLink}</td>
      </tr>`;
    });

    els.tbody.innerHTML = html;

    els.tbody.querySelectorAll('[data-stop-row-click]').forEach(link => {
      link.addEventListener('click', (event) => {
        event.stopPropagation();
      });
    });

    // 行クリック: 詳細パネル表示 + 地図フォーカス + 波形ビューア連携
    els.tbody.querySelectorAll('tr[data-lat]').forEach(tr => {
      const openRow = () => {
        const idx = parseInt(tr.dataset.index, 10);
        const feature = currentData.features[idx];
        const lat = parseFloat(tr.dataset.lat);
        const lon = parseFloat(tr.dataset.lon);

        // ハイライト
        els.tbody.querySelectorAll('tr').forEach(r => r.classList.remove('highlighted'));
        tr.classList.add('highlighted');

        // 地図フォーカス
        EarthquakeMap.focusOn(lat, lon);

        // 詳細パネル表示
        DetailPanel.show(feature);

        // 波形ビューア用に選択地震を記憶
        selectFeatureForWaveform(feature);
      };
      tr.addEventListener('click', openRow);
      tr.querySelector('[data-open-row-detail]')?.addEventListener('click', event => {
        event.stopPropagation();
        openRow();
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
      currentSort.asc = key === 'place';
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
      th.setAttribute('aria-sort', isActive ? (currentSort.asc ? 'ascending' : 'descending') : 'none');
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

  // --- マーカークリック ---
  function onMarkerClick(index) {
    const row = els.tbody.querySelector(`tr[data-index="${index}"]`);
    if (row) {
      els.tbody.querySelectorAll('tr').forEach(r => r.classList.remove('highlighted'));
      row.classList.add('highlighted');
      row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    if (currentData && currentData.features[index]) {
      DetailPanel.show(currentData.features[index]);
      selectFeatureForWaveform(currentData.features[index]);
    }
  }

  // --- 地域選択変更 ---
  function onRegionChange() {
    els.customBounds.style.display = els.region.value === 'custom' ? 'grid' : 'none';
    $('#circle-bounds').style.display = els.region.value === 'circle' ? 'grid' : 'none';
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
    $('#circle-bounds').style.display = 'none';
    ['#circle-latitude', '#circle-longitude', '#circle-radius'].forEach(id => { $(id).value = ''; });
    Settings.setActiveQuickType(null);
    $('#custom-minlat').value = '';
    $('#custom-maxlat').value = '';
    $('#custom-minlon').value = '';
    $('#custom-maxlon').value = '';
  }

  // ===== 分析タブ =====
  function initTabs() {
    const tabs = Array.from($$('.tab-bar .tab-btn'));
    tabs.forEach((btn, index) => {
      btn.addEventListener('click', () => activateTab(btn.dataset.tab));
      btn.addEventListener('keydown', event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        let nextIndex = index;
        if (event.key === 'ArrowLeft') nextIndex = (index - 1 + tabs.length) % tabs.length;
        if (event.key === 'ArrowRight') nextIndex = (index + 1) % tabs.length;
        if (event.key === 'Home') nextIndex = 0;
        if (event.key === 'End') nextIndex = tabs.length - 1;
        tabs[nextIndex].focus();
        activateTab(tabs[nextIndex].dataset.tab);
      });
    });
  }

  function activateTab(target, { moveFocus = false } = {}) {
    let activeTab = null;
    $$('.tab-bar .tab-btn').forEach(btn => {
      const isActive = btn.dataset.tab === target;
      btn.classList.toggle('active', isActive);
      btn.setAttribute('aria-selected', String(isActive));
      btn.tabIndex = isActive ? 0 : -1;
      if (isActive) activeTab = btn;
    });

    $$('#analysis-section .tab-content').forEach(tc => {
      const isActive = tc.id === `tab-${target}`;
      tc.classList.toggle('hidden', !isActive);
      tc.setAttribute('aria-hidden', String(!isActive));
    });
    if (moveFocus) activeTab?.focus();
  }

  // ===== 応答スペクトルツール =====
  function initSpectrumTool() {
    const btnCalc = $('#btn-calc-spectrum');
    const btnDownload = $('#btn-download-spectrum');
    const typeSelect = $('#spectrum-type');
    resetSpectrumState();
    const dampingInput = $('#spectrum-damping');
    dampingInput?.addEventListener('input', invalidateSpectrumResult);
    dampingInput?.addEventListener('change', invalidateSpectrumResult);
    btnCalc.addEventListener('click', calculateSpectrumForLoadedData);
    btnDownload?.addEventListener('click', () => {
      if (!currentSpectrumResult) return;
      Download.asSpectrumCSV(
        currentSpectrumResult,
        typeSelect.value,
        generateFilename('spectrum.csv')
      );
    });
    typeSelect?.addEventListener('change', () => {
      if (!currentSpectrumResult) return;
      Spectrum.renderSpectrum(currentSpectrumResult, 'chart-spectrum', typeSelect.value);
      renderSpectrumSummary(currentSpectrumResult, typeSelect.value);
    });
  }

  // ===== 波形ビューア =====
  function initWaveformViewer() {
    const btnSearch = $('#btn-search-stations');
    const btnShow = $('#btn-show-waveform');
    const btnApplyView = $('#btn-apply-waveform-view');
    const btnResetView = $('#btn-reset-waveform-view');
    const btnSpectrum = $('#btn-waveform-spectrum');
    const stationSel = $('#waveform-station');
    const filterSel = $('#waveform-filter');
    const datacenterSel = $('#waveform-datacenter');
    const radiusSel = $('#waveform-radius');

    resetWaveformViewerState();
    $('#waveform-file')?.addEventListener('change', importWaveformFile);

    stationSel.addEventListener('change', onWaveformStationSelectionChange);
    filterSel.addEventListener('change', () => handleStationSearchCriteriaChange('フィルタ'));
    datacenterSel.addEventListener('change', () => handleStationSearchCriteriaChange('データセンター'));
    radiusSel.addEventListener('change', () => handleStationSearchCriteriaChange('検索半径'));

    btnSearch.addEventListener('click', async () => {
      if (!selectedFeature) {
        Settings.showToast('先にテーブルから地震を選択してください');
        return;
      }

      const coords = selectedFeature.geometry.coordinates;
      const radiusValue = radiusSel.value;
      const radius = parseFloat(radiusValue);
      const datacenter = datacenterSel.value;
      const filterPreset = filterSel.value;
      const timeWindow = WaveformViewer.getTimeWindow(selectedFeature);

      invalidateWaveformForStationChange();
      stationInfoRequests.cancel();
      resetWaveformStationDetail();
      stationSel.innerHTML = '<option value="">-- 観測点を検索中 --</option>';
      btnShow.disabled = true;
      const stationSummary = $('#waveform-station-summary');
      if (stationSummary) {
        stationSummary.innerHTML = '<p class="station-summary-message">観測点メタデータを検索中です...</p>';
        stationSummary.classList.remove('hidden');
      }
      btnSearch.disabled = true;
      btnSearch.textContent = '検索中...';
      const request = stationSearchRequests.begin();

      try {
        const result = await WaveformViewer.searchStations(
          coords[1],
          coords[0],
          radius,
          selectedFeature.properties.time,
          {
            requireWaveform: false,
            starttime: timeWindow.starttime,
            endtime: timeWindow.endtime,
            filterPreset,
            datacenter: datacenter,
            signal: request.signal,
          }
        );
        if (
          !request.isCurrent()
          || filterSel.value !== filterPreset
          || datacenterSel.value !== datacenter
          || radiusSel.value !== radiusValue
        ) return;
        const dcLabel = (WaveformViewer.getDatacenters()[datacenter] || {}).label || datacenter;
        WaveformViewer.populateStationSelect(result.stations, 'waveform-station');
        renderWaveformStationSummary(
          result.stations,
          result.candidateCount,
          result.checkedCount,
          result.availableCount,
          dcLabel
        );

        if (result.stations.length > 0 && stationSel.options.length > 1) {
          stationSel.selectedIndex = 1;
          onWaveformStationSelectionChange();
        }

        if (result.candidateCount === 0) {
          Settings.showToast(`${dcLabel}: 周辺に観測点が見つかりませんでした。検索半径やデータセンターを変更してください。`);
        } else {
          Settings.showToast(`${dcLabel}: 観測点 ${result.stations.length} チャンネルのメタデータが見つかりました（波形の取得可否は未確認）`);
        }
      } catch (err) {
        if (request.isCurrent() && !AppUtils.isAbortError(err)) {
          stationSel.innerHTML = '<option value="">-- 観測点を再検索してください --</option>';
          btnShow.disabled = true;
          if (stationSummary) {
            stationSummary.innerHTML = '<p class="station-summary-message">観測点を取得できませんでした。条件を確認して再検索してください。</p>';
          }
          Settings.showToast(`観測点検索エラー: ${err.message}`);
        }
      } finally {
        if (request.isCurrent()) {
          btnSearch.disabled = false;
          btnSearch.textContent = '観測点を検索';
        }
        stationSearchRequests.finish(request.id);
      }
    });

    btnShow.addEventListener('click', async () => {
      if (!stationSel.value) {
        Settings.showToast('観測点を選択してください');
        return;
      }
      if (!selectedFeature) {
        Settings.showToast('地震が選択されていません');
        return;
      }

      const station = JSON.parse(stationSel.value);
      const timeWindow = WaveformViewer.getTimeWindow(selectedFeature);
      waveformInputMode = 'remote';
      const requestedStationKey = station.stationKey;
      const requestedFilter = filterSel.value;
      btnShow.disabled = true;
      btnShow.textContent = '取得中...';
      const request = waveformRequests.begin();

      try {
        const waveformData = await WaveformViewer.fetchWaveformData(
          station,
          timeWindow.starttime,
          timeWindow.endtime,
          { filterPreset: requestedFilter, signal: request.signal }
        );
        const activeStation = getSelectedWaveformStation();
        if (
          !request.isCurrent()
          || activeStation?.stationKey !== requestedStationKey
          || filterSel.value !== requestedFilter
        ) return;
        currentWaveformData = waveformData;
        WaveformViewer.renderWaveform(currentWaveformData, 'waveform-display');
        currentWaveformView = {
          start: 0,
          end: currentWaveformData.meta._duration,
        };
        setWaveformViewControlsEnabled(true, currentWaveformView.end);
        updateWaveformViewInputs(currentWaveformView.start, currentWaveformView.end);
        syncWaveformToSpectrum();
        Settings.showToast('ヘッダーの加速度単位を確認し、galへ換算しました');
      } catch (err) {
        if (!request.isCurrent() || AppUtils.isAbortError(err)) return;
        currentWaveformData = null;
        currentWaveformView = { start: 0, end: null };
        setWaveformViewControlsEnabled(false);
        WaveformViewer.resetDisplay('waveform-display');
        resetSpectrumState();
        Settings.showToast(`波形取得エラー: ${err.message}`);
      } finally {
        if (request.isCurrent()) {
          btnShow.disabled = false;
          btnShow.textContent = '波形を表示';
        }
        waveformRequests.finish(request.id);
      }
    });

    btnApplyView.addEventListener('click', () => {
      if (!currentWaveformData) {
        Settings.showToast('先に波形を表示してください');
        return;
      }

      try {
        const range = getWaveformViewRangeFromInputs();
        // 描画の前にサンプル数を検証し、不正区間で現在の解析状態を失わない。
        WaveformViewer.sliceWaveformData(currentWaveformData, range.start, range.end);
        WaveformViewer.renderWaveform(currentWaveformData, 'waveform-display', range);
        currentWaveformView = range;
        updateWaveformViewInputs(range.start, range.end);
        syncWaveformToSpectrum();
      } catch (err) {
        Settings.showToast(err.message);
      }
    });

    btnResetView.addEventListener('click', () => {
      if (!currentWaveformData) return;
      currentWaveformView = {
        start: 0,
        end: currentWaveformData.meta._duration,
      };
      updateWaveformViewInputs(currentWaveformView.start, currentWaveformView.end);
      WaveformViewer.renderWaveform(currentWaveformData, 'waveform-display', currentWaveformView);
      syncWaveformToSpectrum();
    });

    btnSpectrum.addEventListener('click', () => {
      if (!currentWaveformData) {
        Settings.showToast('先に波形を表示してください');
        return;
      }

      syncWaveformToSpectrum();
      activateTab('spectrum', { moveFocus: true });
      calculateSpectrumForLoadedData();
    });
  }

  async function importWaveformFile(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    // 読込開始時に旧波形・旧計算結果を無効化し、遅い読込が後の操作を上書きしないようにする。
    invalidateLoadedWaveform();
    waveformInputMode = 'file';
    const request = waveformRequests.begin();
    const status = $('#waveform-import-status');
    if (status) status.textContent = `${file.name} を読み込み中...`;
    try {
      if (file.size > 20 * 1024 * 1024) throw new Error('ファイルは20 MiB以下にしてください');
      const text = await file.text();
      if (!request.isCurrent()) return;
      const data = WaveformViewer.parseWaveformText(text, { sourceName: `ローカルファイル: ${file.name}` });
      WaveformViewer.validateAccelerationData(data);
      currentWaveformData = data;
      currentWaveformView = { start: 0, end: data.meta._duration };
      WaveformViewer.renderWaveform(data, 'waveform-display');
      updateWaveformViewInputs(0, data.meta._duration);
      setWaveformViewControlsEnabled(true, data.meta._duration);
      syncWaveformToSpectrum();
      if (status) status.textContent = `${file.name}: ${data.meta._npts}点 / ヘッダー単位 ${data.meta._inputUnitReported} → gal。計器補正の内容は作成元の処理記録で確認してください。`;
    } catch (err) {
      if (!request.isCurrent()) return;
      invalidateLoadedWaveform();
      if (status) status.textContent = `読込エラー: ${err.message}`;
      Settings.showToast(`波形読込エラー: ${err.message}`);
    } finally {
      waveformRequests.finish(request.id);
      event.target.value = '';
    }
  }

  function setSpectrumInput(data, sourceLabel = '', displayData = data) {
    WaveformViewer.validateAccelerationData(data);
    spectrumInputData = data;
    invalidateSpectrumResult();
    Spectrum.renderWaveform(displayData.acc, displayData.dt, 'chart-waveform-input');

    const info = $('#spectrum-info');
    if (info) {
      info.style.display = '';
      info.innerHTML = buildSpectrumInfoHtml(data.meta, sourceLabel);
      if (data.meta?._hasTimingGap) {
        info.innerHTML += '<div class="spectrum-warning">欠測または不連続な時刻を検出したため、応答スペクトル計算を停止しました。</div>';
      }
    }
  }

  function buildSpectrumInfoHtml(meta = {}, sourceLabel = '') {
    const parts = [];
    parts.push(`<strong>${escapeHtml(sourceLabel || '入力データをセットしました')}</strong>`);
    parts.push(`データ点数: ${meta._npts}`);
    parts.push(`サンプリング間隔: ${meta._dt.toFixed(4)}秒`);
    parts.push(`継続時間: ${meta._duration.toFixed(3)}秒`);
    parts.push(`最大加速度: ${meta._maxAcc.toFixed(2)} gal`);
    parts.push(`単位根拠: ヘッダー ${escapeHtml(meta._inputUnitReported || '')} / 値 × ${meta._conversionToGal} → gal`);
    parts.push('計器補正・校正の正しさは未検証');
    if (meta._startTime) parts.push(`記録開始 (UTC): ${escapeHtml(meta._startTime)}`);

    if (meta['Station Code']) parts.push(`観測点: ${escapeHtml(meta['Station Code'])}`);
    if (meta['Dir.']) parts.push(`成分: ${escapeHtml(meta['Dir.'])}`);
    if (meta._stationId) parts.push(`観測点: ${escapeHtml(meta._stationId)}`);
    if (meta._filterLabel) parts.push(`フィルタ: ${escapeHtml(meta._filterLabel)}`);
    if (Number.isFinite(meta._analysisWindowStart) && Number.isFinite(meta._analysisWindowEnd)) {
      parts.push(`解析区間: ${meta._analysisWindowStart.toFixed(3)} - ${meta._analysisWindowEnd.toFixed(3)} 秒`);
    }
    if (Number.isFinite(meta._sourceNpts) && meta._sourceNpts !== meta._npts) {
      parts.push(`状態積分: 元波形 ${meta._sourceNpts} 点の先頭から実施`);
    }

    return parts.join(' / ');
  }

  function invalidateSpectrumResult() {
    currentSpectrumResult = null;
    spectrumCalculationSeq += 1;
    Spectrum.clearSpectrumChart();
    const btnCalc = $('#btn-calc-spectrum');
    if (btnCalc) btnCalc.disabled = !spectrumInputData || Boolean(spectrumInputData.meta?._hasTimingGap);
    const btnDownload = $('#btn-download-spectrum');
    if (btnDownload) btnDownload.disabled = true;
    const summary = $('#spectrum-summary');
    if (summary) summary.innerHTML = '';
  }

  function calculateSpectrumForLoadedData() {
    // 入力変更・再計算の失敗後に、以前の条件の結果を出力できないようにする。
    invalidateSpectrumResult();
    if (!spectrumInputData) {
      Settings.showToast('先に波形ビューアで加速度波形ファイルを読み込んでください');
      return;
    }
    try {
      WaveformViewer.validateAccelerationData(spectrumInputData);
    } catch (err) {
      resetSpectrumState();
      Settings.showToast(`単位・データ検証エラー: ${err.message}`);
      return;
    }
    if (spectrumInputData.meta?._hasTimingGap) {
      Settings.showToast('波形に欠測または時刻の不連続があるため計算できません');
      return;
    }

    const dampingStr = $('#spectrum-damping').value;
    const dampingTokens = dampingStr.split(',').map(value => value.trim()).filter(Boolean);
    const parsedDampings = dampingTokens.map(value => Number(value) / 100);
    if (
      dampingTokens.length === 0
      || dampingTokens.length > 10
      || parsedDampings.some(value => !Number.isFinite(value) || value < 0 || value >= 1)
    ) {
      Settings.showToast('減衰定数は0以上100未満を、最大10個まで指定してください');
      return;
    }
    const dampings = [...new Set(parsedDampings)];
    const inputData = spectrumInputData;

    Settings.showToast('応答スペクトルを計算中...');
    const calculationSeq = spectrumCalculationSeq;
    const btnCalc = $('#btn-calc-spectrum');
    if (btnCalc) btnCalc.disabled = true;

    setTimeout(() => {
      if (calculationSeq !== spectrumCalculationSeq) return;
      try {
        const result = Spectrum.computeSpectrum(inputData.acc, inputData.dt, {
          hList: dampings,
          periodMin: 0.02,
          periodMax: 10.0,
          periodCount: 100,
          samplesPerPeriod: 10,
          evaluationStart: inputData.meta?._analysisWindowStart,
          evaluationEnd: inputData.meta?._analysisWindowEnd,
        });
        if (calculationSeq !== spectrumCalculationSeq) return;

        const type = $('#spectrum-type').value;
        result.meta.waveform = { ...inputData.meta };
        Spectrum.renderSpectrum(result, 'chart-spectrum', type);
        renderSpectrumSummary(result, type);
        currentSpectrumResult = result;
        const btnDownload = $('#btn-download-spectrum');
        if (btnDownload) btnDownload.disabled = false;
        Settings.showToast('応答スペクトルの計算が完了しました');
      } catch (err) {
        if (calculationSeq === spectrumCalculationSeq) {
          invalidateSpectrumResult();
          Settings.showToast(`計算エラー: ${err.message}`);
        }
      } finally {
        if (calculationSeq === spectrumCalculationSeq && btnCalc) btnCalc.disabled = false;
      }
    }, 50);
  }

  function renderSpectrumSummary(result, type) {
    const container = $('#spectrum-summary');
    if (!container) return;
    const typeLabels = { sa: 'Sa (gal)', sv: 'Sv (cm/s)', sd: 'Sd (cm)' };
    const peaks = Object.entries(result.results).map(([damping, values]) => {
      let peakValue = -Infinity;
      let peakIndex = 0;
      values[type].forEach((value, index) => {
        if (Number.isFinite(value) && value > peakValue) {
          peakValue = value;
          peakIndex = index;
        }
      });
      return `<li>h=${(Number(damping) * 100).toFixed(1)}%: 最大 ${typeLabels[type]} ${peakValue.toFixed(3)} / T=${result.periods[peakIndex].toFixed(3)}秒</li>`;
    }).join('');
    const samplingNote = result.meta.periodMinAdjusted
      ? `入力刻み Δt=${result.meta.dt.toFixed(4)}秒に対して1周期10点を確保するため、最短周期を ${result.meta.requestedPeriodMin.toFixed(3)}秒から ${result.meta.effectivePeriodMin.toFixed(3)}秒へ調整しました。`
      : `有効周期範囲は ${result.meta.effectivePeriodMin.toFixed(3)}〜${result.meta.periodMax.toFixed(3)}秒です。`;

    container.innerHTML = `
      <strong>計算結果要約</strong>
      <span>PGA: ${result.meta.pga.toFixed(3)} gal / 評価区間: ${result.meta.evaluationStart.toFixed(3)}〜${result.meta.evaluationEnd.toFixed(3)}秒</span>
      <ul>${peaks}</ul>
      <span>${samplingNote}</span>
    `;
  }

  function syncWaveformToSpectrum(sourceLabel = '') {
    if (!currentWaveformData) return null;

    const displayData = WaveformViewer.sliceWaveformData(
      currentWaveformData,
      currentWaveformView.start,
      currentWaveformView.end
    );
    const spectrumData = {
      acc: currentWaveformData.acc,
      dt: currentWaveformData.dt,
      meta: {
        ...displayData.meta,
        _sourceNpts: currentWaveformData.meta._npts,
        _sourceDuration: currentWaveformData.meta._duration,
      },
    };
    setSpectrumInput(spectrumData, sourceLabel || currentWaveformData.meta._source, displayData);
    return spectrumData;
  }

  function getWaveformViewRangeFromInputs() {
    const startInput = $('#waveform-view-start');
    const endInput = $('#waveform-view-end');
    const duration = currentWaveformData?.meta?._duration || 0;
    const minSpan = currentWaveformData?.dt || 0.1;

    let start = parseFloat(startInput?.value || '0');
    let end = parseFloat(endInput?.value || '');
    if (!isFinite(start)) start = 0;
    if (!isFinite(end)) end = duration;

    start = Math.max(0, Math.min(start, duration));
    end = Math.max(0, Math.min(end, duration));

    if (end <= start) {
      throw new Error(`表示終了秒は表示開始秒より ${minSpan} 秒以上大きくしてください`);
    }

    return { start, end };
  }

  function updateWaveformViewInputs(start, end) {
    const startInput = $('#waveform-view-start');
    const endInput = $('#waveform-view-end');
    if (startInput) startInput.value = String(start);
    if (endInput) endInput.value = String(end);
  }

  function setWaveformViewControlsEnabled(enabled, duration = 0) {
    ['#waveform-view-start', '#waveform-view-end', '#btn-apply-waveform-view', '#btn-reset-waveform-view', '#btn-waveform-spectrum']
      .forEach(selector => {
        const el = $(selector);
        if (el) el.disabled = !enabled;
      });

    const spectrumButton = $('#btn-waveform-spectrum');
    if (spectrumButton && enabled) spectrumButton.disabled = Boolean(currentWaveformData?.meta?._hasTimingGap);

    const endInput = $('#waveform-view-end');
    if (endInput) {
      endInput.max = enabled ? String(duration) : '0';
      endInput.step = 'any';
    }
    const startInput = $('#waveform-view-start');
    if (startInput) {
      startInput.max = enabled ? String(duration) : '0';
      startInput.step = 'any';
    }
  }

  function resetWaveformViewerState() {
    stationSearchRequests.cancel();
    stationInfoRequests.cancel();
    WaveformViewer.clearCache();

    const stationSel = $('#waveform-station');
    if (stationSel) {
      stationSel.innerHTML = '<option value="">-- 先に観測点を検索 --</option>';
    }

    const btnSearch = $('#btn-search-stations');
    if (btnSearch) {
      btnSearch.disabled = false;
      btnSearch.textContent = '観測点を検索';
    }
    const btnShow = $('#btn-show-waveform');
    if (btnShow) {
      btnShow.disabled = false;
      btnShow.textContent = '波形を表示';
    }

    const stationSummary = $('#waveform-station-summary');
    if (stationSummary) {
      stationSummary.innerHTML = '';
      stationSummary.classList.add('hidden');
    }

    resetWaveformStationDetail();

    invalidateWaveformForStationChange();
  }

  function invalidateWaveformForStationChange() {
    if (waveformInputMode !== 'file') invalidateLoadedWaveform();
  }

  function invalidateLoadedWaveform() {
    waveformRequests.cancel();
    waveformInputMode = null;
    const status = $('#waveform-import-status');
    if (status) status.textContent = '';
    currentWaveformData = null;
    currentWaveformView = { start: 0, end: null };
    updateWaveformViewInputs(0, 0);
    setWaveformViewControlsEnabled(false);
    WaveformViewer.resetDisplay('waveform-display');
    resetSpectrumState();

    const btnShow = $('#btn-show-waveform');
    if (btnShow) {
      btnShow.disabled = !getSelectedWaveformStation();
      btnShow.textContent = '波形を表示';
    }
  }

  function handleStationSearchCriteriaChange(criteriaLabel) {
    stationSearchRequests.cancel();
    stationInfoRequests.cancel();
    invalidateWaveformForStationChange();

    const stationSel = $('#waveform-station');
    if (stationSel) {
      stationSel.innerHTML = '<option value="">-- 条件変更後は再検索 --</option>';
    }
    const btnSearch = $('#btn-search-stations');
    if (btnSearch) {
      btnSearch.disabled = false;
      btnSearch.textContent = '観測点を検索';
    }
    const btnShow = $('#btn-show-waveform');
    if (btnShow) btnShow.disabled = true;
    const stationSummary = $('#waveform-station-summary');
    if (stationSummary) {
      stationSummary.innerHTML = `<p class="station-summary-message">${escapeHtml(criteriaLabel)}を変更したため、観測点を再検索してください。</p>`;
      stationSummary.classList.remove('hidden');
    }
    resetWaveformStationDetail();
  }

  function resetSpectrumState() {
    spectrumInputData = null;
    currentSpectrumResult = null;
    spectrumCalculationSeq += 1;
    Spectrum.clearCharts();

    const btnCalc = $('#btn-calc-spectrum');
    if (btnCalc) btnCalc.disabled = true;
    const btnDownload = $('#btn-download-spectrum');
    if (btnDownload) btnDownload.disabled = true;
    const summary = $('#spectrum-summary');
    if (summary) summary.innerHTML = '';

    const info = $('#spectrum-info');
    if (info) {
      info.style.display = '';
      info.innerHTML = '波形ビューアで単位付き加速度ファイルを読み込むと、ここに入力単位・換算・観測点の情報が表示されます。';
    }
  }

  function renderWaveformStationSummary(
    stations,
    candidateCount = 0,
    checkedCount = 0,
    availableCount = 0,
    dcLabel = ''
  ) {
    const container = $('#waveform-station-summary');
    if (!container) return;

    if (!stations.length) {
      const noResultReason = candidateCount > 0
        ? `候補 ${candidateCount} 件のうち近傍 ${checkedCount} チャンネルを確認しましたが、IRIS経由で波形取得可能な観測点はありませんでした。`
        : '周辺に観測点が見つかりませんでした。検索半径やデータセンターを変更してお試しください。';
      const dcInfo = dcLabel ? ` <span style="font-size:0.8rem; color:var(--text-secondary);">(${escapeHtml(dcLabel)})</span>` : '';
      container.innerHTML = `
        <div class="station-summary-header">
          <strong>観測点候補</strong>${dcInfo}
        </div>
        <p style="padding:0.5rem 0.75rem; color:var(--text-secondary); margin:0;">${escapeHtml(noResultReason)}</p>
      `;
      container.classList.remove('hidden');
      return;
    }

    const rows = stations.map((station, index) => {
      const dist = Number.isFinite(station.distanceKm) ? `${station.distanceKm.toFixed(1)} km` : '-- km';
      return `
        <tr data-station-key="${escapeHtml(station.stationKey)}">
          <td>${index + 1}</td>
          <td class="station-summary-code">${escapeHtml(station.stationKey)}</td>
          <td>${dist}</td>
        </tr>
      `;
    }).join('');

    const dcInfo = dcLabel ? ` <span style="font-size:0.8rem; color:var(--text-secondary);">(メタデータ提供元: ${escapeHtml(dcLabel)})</span>` : '';

    container.innerHTML = `
      <div class="station-summary-header">
        <strong>観測点候補</strong>
        <span>${candidateCount} チャンネル / 波形の取得可否は未確認${dcInfo}</span>
      </div>
      <div class="station-summary-table-wrap">
        <table class="station-summary-table">
          <thead>
            <tr>
              <th>#</th>
              <th>観測点</th>
              <th>距離</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
    container.classList.remove('hidden');

    container.querySelectorAll('tbody tr[data-station-key]').forEach(row => {
      const selectStation = () => {
        const stationKey = row.dataset.stationKey;
        const stationSel = $('#waveform-station');
        if (!stationSel) return;

        const option = Array.from(stationSel.options).find(opt => opt.dataset.stationKey === stationKey);
        if (!option) return;

        if (stationSel.value !== option.value) {
          stationSel.value = option.value;
          onWaveformStationSelectionChange();
        }
      };
      row.addEventListener('click', selectStation);
    });

    updateSelectedWaveformStationSummary();
  }

  function updateSelectedWaveformStationSummary() {
    const stationSel = $('#waveform-station');
    const stationKey = stationSel?.selectedOptions?.[0]?.dataset?.stationKey || '';
    $$('#waveform-station-summary tbody tr[data-station-key]').forEach(row => {
      row.classList.toggle('active', row.dataset.stationKey === stationKey);
    });
  }

  function onWaveformStationSelectionChange() {
    invalidateWaveformForStationChange();
    handleWaveformStationSelectionChange();
  }

  async function handleWaveformStationSelectionChange() {
    updateSelectedWaveformStationSummary();

    const station = getSelectedWaveformStation();
    if (!station || !selectedFeature) {
      stationInfoRequests.cancel();
      resetWaveformStationDetail();
      return;
    }

    const request = stationInfoRequests.begin();
    renderWaveformStationDetailLoading(station);

    try {
      const info = await WaveformViewer.fetchStationPublicInfo(
        station,
        selectedFeature.properties.time,
        { signal: request.signal }
      );
      if (!request.isCurrent()) return;

      const activeStation = getSelectedWaveformStation();
      if (!activeStation || activeStation.stationKey !== station.stationKey) return;

      renderWaveformStationDetail(info);
    } catch (err) {
      if (request.isCurrent() && !AppUtils.isAbortError(err)) {
        renderWaveformStationDetailError(station, err.message);
      }
    } finally {
      stationInfoRequests.finish(request.id);
    }
  }

  function getSelectedWaveformStation() {
    const stationSel = $('#waveform-station');
    if (!stationSel?.value) return null;

    try {
      return JSON.parse(stationSel.value);
    } catch (_) {
      return null;
    }
  }

  function resetWaveformStationDetail() {
    const container = $('#waveform-station-detail');
    if (!container) return;
    container.innerHTML = '';
    container.classList.add('hidden');
  }

  function renderWaveformStationDetailLoading(station) {
    const container = $('#waveform-station-detail');
    if (!container) return;

    container.innerHTML = `
      <div class="station-detail-header">
        <div class="station-detail-title">
          <strong>観測点公開メタデータ</strong>
          <span>${escapeHtml(station.stationKey || `${station.network}.${station.station}`)}</span>
        </div>
        <span class="station-detail-status">${escapeHtml(station._datacenterLabel || 'IRIS / EarthScope')} から取得中...</span>
      </div>
    `;
    container.classList.remove('hidden');
  }

  function renderWaveformStationDetailError(station, message) {
    const container = $('#waveform-station-detail');
    if (!container) return;

    container.innerHTML = `
      <div class="station-detail-header">
        <div class="station-detail-title">
          <strong>観測点公開メタデータ</strong>
          <span>${escapeHtml(station.stationKey || `${station.network}.${station.station}`)}</span>
        </div>
        <span class="station-detail-status">取得失敗</span>
      </div>
      <div class="waveform-error">${escapeHtml(message || '観測点メタデータを取得できませんでした')}</div>
    `;
    container.classList.remove('hidden');
  }

  function renderWaveformStationDetail(info) {
    const container = $('#waveform-station-detail');
    if (!container) return;

    const siteRow = info.siteRow || {};
    const channelRow = info.channelRow || {};
    const siteName = siteRow.SiteName || channelRow.SiteName || '';
    const titleCode = info.stationKey || `${channelRow.Network || ''}.${channelRow.Station || ''}.${channelRow.Location || '--'}.${channelRow.Channel || ''}`;
    const measurementNote = buildWaveformStationMeasurementNote(channelRow);
    const stationTextUrl = AppUtils.sanitizeHttpUrl(info.urls?.stationTextUrl);
    const channelTextUrl = AppUtils.sanitizeHttpUrl(info.urls?.channelTextUrl);
    const responseXmlUrl = AppUtils.sanitizeHttpUrl(info.urls?.responseXmlUrl);
    const metadataLinks = [
      stationTextUrl ? `<a href="${escapeHtml(stationTextUrl)}" target="_blank" rel="noopener" class="btn btn-sm btn-outline">Station text</a>` : '',
      channelTextUrl ? `<a href="${escapeHtml(channelTextUrl)}" target="_blank" rel="noopener" class="btn btn-sm btn-outline">Channel text</a>` : '',
      responseXmlUrl ? `<a href="${escapeHtml(responseXmlUrl)}" target="_blank" rel="noopener" class="btn btn-sm btn-outline">StationXML</a>` : '',
    ].filter(Boolean).join('');

    const siteItems = [
      ['Network', siteRow.Network || channelRow.Network],
      ['Station', siteRow.Station || channelRow.Station],
      ['SiteName', siteName],
      ['Latitude', siteRow.Latitude],
      ['Longitude', siteRow.Longitude],
      ['Elevation', siteRow.Elevation],
      ['StartTime', siteRow.StartTime],
      ['EndTime', siteRow.EndTime],
    ];

    const channelItems = [
      ['Location', channelRow.Location],
      ['Channel', channelRow.Channel],
      ['Latitude', channelRow.Latitude],
      ['Longitude', channelRow.Longitude],
      ['Elevation', channelRow.Elevation],
      ['Depth', channelRow.Depth],
      ['Azimuth', channelRow.Azimuth],
      ['Dip', channelRow.Dip],
      ['SensorDescription', channelRow.SensorDescription || channelRow.Instrument],
      ['総合感度 (Scale)', channelRow.Scale],
      ['感度の基準周波数 (Hz)', channelRow.ScaleFrequency || channelRow.ScaleFreq],
      ['感度の入力物理単位 (ScaleUnits)', channelRow.ScaleUnits],
      ['SampleRate', channelRow.SampleRate],
      ['StartTime', channelRow.StartTime],
      ['EndTime', channelRow.EndTime],
    ];

    container.innerHTML = `
      <div class="station-detail-header">
        <div class="station-detail-title">
          <strong>観測点公開メタデータ</strong>
          <span>${escapeHtml(titleCode)}</span>
        </div>
        <span class="station-detail-status">メタデータ提供元: ${escapeHtml(info.datacenterLabel || 'FDSN Station metadata')}</span>
      </div>
      <div class="station-detail-grid">
        ${buildWaveformStationDetailSection('Site / Station', siteItems)}
        ${buildWaveformStationDetailSection('Channel / Sensitivity', channelItems)}
      </div>
      <div class="station-detail-note">${escapeHtml(measurementNote)}</div>
      <div class="station-detail-links">
        ${metadataLinks}
      </div>
    `;
    container.classList.remove('hidden');
  }

  function buildWaveformStationDetailSection(title, items = []) {
    const rows = items
      .map(([label, value]) => `
        <dt>${escapeHtml(label)}</dt>
        <dd>${escapeHtml(formatWaveformStationDetailValue(value))}</dd>
      `)
      .join('');

    return `
      <section class="station-detail-section">
        <h4>${escapeHtml(title)}</h4>
        <dl class="station-detail-list">${rows}</dl>
      </section>
    `;
  }

  function formatWaveformStationDetailValue(value) {
    if (value === null || value === undefined) return '-';
    const trimmed = String(value).trim();
    return trimmed ? trimmed : '-';
  }

  function buildWaveformStationMeasurementNote(channelRow = {}) {
    const scaleUnits = String(channelRow.ScaleUnits || '').trim() || '未記載';
    return `ScaleUnits=${scaleUnits} は計器の総合感度に対応する入力物理単位で、読込波形の単位とは別です。Scaleは基準周波数での感度であり、これだけで周波数特性・位相を含む計器補正はできません。補正済み加速度にScaleを再適用しないでください。この公開StationXMLが読み込んだ波形の補正に使われたかは、ファイル作成元の処理記録で確認してください。`;
  }

  function selectFeatureForWaveform(feature) {
    selectedFeature = feature;
    const label = $('#waveform-eq-label');
    if (label) {
      const p = feature.properties;
      const place = I18n.translatePlace(p.place);
      label.value = `M${p.mag?.toFixed(1) || '?'} ${place}`;
    }
    resetWaveformViewerState();
  }

  // --- UI ヘルパー ---
  function showLoading(show) {
    els.loading.classList.toggle('active', show);
    els.loading.setAttribute('aria-hidden', String(!show));
    document.querySelector('main')?.setAttribute('aria-busy', String(show));
    els.btnSearch.disabled = show;
  }

  function showError(message) {
    clearError();
    const div = document.createElement('div');
    div.className = 'error-msg';
    div.id = 'error-msg';
    div.setAttribute('role', 'alert');
    div.setAttribute('aria-live', 'assertive');
    div.tabIndex = -1;
    div.textContent = message;
    els.tbody.closest('.card').insertBefore(div, els.tbody.closest('.table-wrapper'));
    div.focus();
  }

  function clearError() {
    const existing = $('#error-msg');
    if (existing) existing.remove();
  }

  function formatDateInput(date) {
    return date.toISOString().slice(0, 10);
  }

  function generateFilename(ext) {
    const now = new Date();
    const ts = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
    return `earthquakes_${ts}.${ext}`;
  }

  function escapeHtml(str) {
    return AppUtils.escapeHtml(str);
  }

  // --- 起動 ---
  document.addEventListener('DOMContentLoaded', init);
})();
