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
  let lastSearchType = 'manual';  // 'manual' | 'quick'
  let lastQuickType = null;       // '24h-4.5' 等
  let spectrumInputData = null;
  let currentWaveformData = null;
  let currentWaveformView = { start: 0, end: null };
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

    // 拡張モジュール初期化
    Settings.initDarkMode();
    Settings.initAutoRefresh(() => {
      if (lastSearchType === 'quick' && lastQuickType) {
        quickSearch(lastQuickType);
      } else {
        executeSearch();
      }
    });
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
    const params = buildSearchParams();
    if (!params) return;

    showLoading(true);
    clearError();

    try {
      const data = await EarthquakeAPI.search(params);
      lastSearchType = 'manual';
      lastQuickType = null;
      Settings.setActiveQuickType(null);
      handleResults(data);
    } catch (err) {
      showError(err.message);
    } finally {
      showLoading(false);
    }
  }

  // --- クイック検索 ---
  // プリセット定義（ローリング時間帯と正確なマグニチュード閾値）
  const quickPresets = {
    '24h-4.5':  { hours: 24,   minMag: 4.5, limit: 200, label: '24時間 M4.5+' },
    '7d-5.0':   { hours: 168,  minMag: 5.0, limit: 200, label: '7日間 M5.0+' },
    '30d-6.0':  { hours: 720,  minMag: 6.0, limit: 200, label: '30日間 M6.0+' },
    '365d-7.0': { hours: 8760, minMag: 7.0, limit: 500, label: '1年間 M7.0+' },
  };

  async function quickSearch(type) {
    const preset = quickPresets[type];
    if (!preset) return;

    showLoading(true);
    clearError();

    try {
      const data = await EarthquakeAPI.recentSearch(preset.hours, preset.minMag, preset.limit);
      lastSearchType = 'quick';
      lastQuickType = type;
      Settings.setActiveQuickType(type);
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
      const end = new Date(els.enddate.value);
      end.setDate(end.getDate() + 1);
      params.endtime = formatDateInput(end);
    }
    if (els.minmag.value) params.minmagnitude = els.minmag.value;
    if (els.maxdepth.value) params.maxdepth = els.maxdepth.value;
    if (els.limit.value) params.limit = els.limit.value;

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

    const waveformLabel = $('#waveform-eq-label');
    if (waveformLabel) waveformLabel.value = '';
    resetWaveformViewerState();

    const count = data.features ? data.features.length : 0;
    els.resultsCount.textContent = `検索結果: ${count}件`;

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

      html += `<tr data-index="${globalIdx}" data-lat="${c[1]}" data-lon="${c[0]}">
        <td class="col-time">${time}</td>
        <td class="col-mag"><span class="mag-badge ${magClass}">${mag !== null ? mag.toFixed(1) : '?'}</span></td>
        <td class="col-depth">${depth !== null ? depth.toFixed(1) : '-'}</td>
        <td class="col-place" title="${escapeHtml(p.place)}">${escapeHtml(place)}</td>
        <td>${p.tsunami ? '<span class="tsunami-icon">&#x1F30A; あり</span>' : '-'}</td>
        <td>${escapeHtml(status)}</td>
        <td><a href="${p.url}" target="_blank" rel="noopener" data-stop-row-click="true">USGS</a></td>
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
      tr.addEventListener('click', () => {
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

  // ===== 分析タブ =====
  function initTabs() {
    $$('.tab-bar .tab-btn').forEach(btn => {
      btn.addEventListener('click', () => activateTab(btn.dataset.tab));
    });
  }

  function activateTab(target) {
    $$('.tab-bar .tab-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tab === target);
    });

    $$('#analysis-section .tab-content').forEach(tc => {
      tc.classList.toggle('hidden', tc.id !== `tab-${target}`);
    });
  }

  // ===== 応答スペクトルツール =====
  function initSpectrumTool() {
    const btnCalc = $('#btn-calc-spectrum');
    resetSpectrumState();
    btnCalc.addEventListener('click', calculateSpectrumForLoadedData);
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

    resetWaveformViewerState();

    stationSel.addEventListener('change', updateSelectedWaveformStationSummary);

    btnSearch.addEventListener('click', async () => {
      if (!selectedFeature) {
        Settings.showToast('先にテーブルから地震を選択してください');
        return;
      }

      const coords = selectedFeature.geometry.coordinates;
      const radius = parseFloat($('#waveform-radius').value);
      const timeWindow = WaveformViewer.getTimeWindow(selectedFeature);

      btnSearch.disabled = true;
      btnSearch.textContent = '検索・確認中...';

      try {
        const result = await WaveformViewer.searchStations(
          coords[1],
          coords[0],
          radius,
          selectedFeature.properties.time,
          {
            requireWaveform: true,
            starttime: timeWindow.starttime,
            endtime: timeWindow.endtime,
            filterPreset: filterSel.value,
          }
        );
        WaveformViewer.populateStationSelect(result.stations, 'waveform-station');
        renderWaveformStationSummary(result.stations, result.candidateCount, result.availableCount);

        if (result.stations.length > 0 && stationSel.options.length > 1) {
          stationSel.selectedIndex = 1;
          updateSelectedWaveformStationSummary();
        }

        if (result.candidateCount === 0) {
          Settings.showToast('周辺に観測点が見つかりませんでした。検索半径を広げてください。');
        } else if (result.availableCount === 0) {
          Settings.showToast(`候補 ${result.candidateCount} チャンネルを確認しましたが、波形取得可能な観測点はありませんでした`);
        } else if (result.availableCount !== result.candidateCount) {
          Settings.showToast(`${result.candidateCount} チャンネルを確認し、${result.availableCount} チャンネルが波形取得可能でした`);
        } else {
          Settings.showToast(`${result.availableCount} チャンネルが見つかりました`);
        }
      } catch (err) {
        Settings.showToast(`観測点検索エラー: ${err.message}`);
      } finally {
        btnSearch.disabled = false;
        btnSearch.textContent = '観測点を検索';
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
      btnShow.disabled = true;
      btnShow.textContent = '取得中...';

      try {
        currentWaveformData = await WaveformViewer.displayWaveform(
          station,
          timeWindow.starttime,
          timeWindow.endtime,
          'waveform-display',
          { filterPreset: filterSel.value }
        );
        currentWaveformView = {
          start: 0,
          end: currentWaveformData.meta._duration,
        };
        setWaveformViewControlsEnabled(true, currentWaveformView.end);
        updateWaveformViewInputs(currentWaveformView.start, currentWaveformView.end);
        syncWaveformToSpectrum('IRIS 加速度波形');
        Settings.showToast('IRIS 生波形を取得しました');
      } catch (err) {
        currentWaveformData = null;
        currentWaveformView = { start: 0, end: null };
        setWaveformViewControlsEnabled(false);
        WaveformViewer.resetDisplay('waveform-display');
        Settings.showToast(`波形取得エラー: ${err.message}`);
      } finally {
        btnShow.disabled = false;
        btnShow.textContent = '波形を表示';
      }
    });

    btnApplyView.addEventListener('click', () => {
      if (!currentWaveformData) {
        Settings.showToast('先に生波形を表示してください');
        return;
      }

      try {
        currentWaveformView = getWaveformViewRangeFromInputs();
        WaveformViewer.renderWaveform(currentWaveformData, 'waveform-display', currentWaveformView);
        syncWaveformToSpectrum('IRIS 加速度波形');
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
      syncWaveformToSpectrum('IRIS 加速度波形');
    });

    btnSpectrum.addEventListener('click', () => {
      if (!currentWaveformData) {
        Settings.showToast('先に生波形を表示してください');
        return;
      }

      syncWaveformToSpectrum('IRIS 加速度波形');
      activateTab('spectrum');
      calculateSpectrumForLoadedData();
    });
  }

  function setSpectrumInput(data, sourceLabel = '') {
    spectrumInputData = data;
    Spectrum.renderWaveform(data.acc, data.dt, 'chart-waveform-input');

    const btnCalc = $('#btn-calc-spectrum');
    if (btnCalc) btnCalc.disabled = false;

    const info = $('#spectrum-info');
    if (info) {
      info.style.display = '';
      info.innerHTML = buildSpectrumInfoHtml(data.meta, sourceLabel);
    }
  }

  function buildSpectrumInfoHtml(meta = {}, sourceLabel = '') {
    const parts = [];
    parts.push(`<strong>${escapeHtml(sourceLabel || '入力データをセットしました')}</strong>`);
    parts.push(`データ点数: ${meta._npts}`);
    parts.push(`サンプリング間隔: ${meta._dt.toFixed(4)}秒`);
    parts.push(`継続時間: ${meta._duration.toFixed(1)}秒`);
    parts.push(`最大加速度: ${meta._maxAcc.toFixed(2)} ${meta._displayUnit || 'gal'}`);

    if (meta['Station Code']) parts.push(`観測点: ${escapeHtml(meta['Station Code'])}`);
    if (meta['Dir.']) parts.push(`成分: ${escapeHtml(meta['Dir.'])}`);
    if (meta._stationId) parts.push(`観測点: ${escapeHtml(meta._stationId)}`);
    if (meta._filterLabel) parts.push(`フィルタ: ${escapeHtml(meta._filterLabel)}`);
    if (Number.isFinite(meta._analysisWindowStart) && Number.isFinite(meta._analysisWindowEnd)) {
      parts.push(`解析区間: ${meta._analysisWindowStart.toFixed(1)} - ${meta._analysisWindowEnd.toFixed(1)} 秒`);
    }

    return parts.join(' / ');
  }

  function calculateSpectrumForLoadedData() {
    if (!spectrumInputData) {
      Settings.showToast('先に検索結果から地震を選び、波形ビューアで生波形を表示してください');
      return;
    }

    const dampingStr = $('#spectrum-damping').value;
    const dampings = dampingStr.split(',').map(s => parseFloat(s.trim()) / 100).filter(d => !isNaN(d) && d > 0);
    if (dampings.length === 0) {
      Settings.showToast('減衰定数を正しく入力してください');
      return;
    }

    Settings.showToast('応答スペクトルを計算中...');

    setTimeout(() => {
      try {
        const result = Spectrum.computeSpectrum(spectrumInputData.acc, spectrumInputData.dt, {
          hList: dampings,
          periodMin: 0.02,
          periodMax: 10.0,
          periodCount: 100,
        });

        const type = $('#spectrum-type').value;
        Spectrum.renderSpectrum(result, 'chart-spectrum', type);
        Settings.showToast('応答スペクトルの計算が完了しました');
      } catch (err) {
        Settings.showToast(`計算エラー: ${err.message}`);
      }
    }, 50);
  }

  function syncWaveformToSpectrum(sourceLabel = 'IRIS 加速度波形') {
    if (!currentWaveformData) return null;

    const spectrumData = WaveformViewer.sliceWaveformData(
      currentWaveformData,
      currentWaveformView.start,
      currentWaveformView.end
    );
    setSpectrumInput(spectrumData, sourceLabel);
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
      throw new Error(`表示終了秒は表示開始秒より ${minSpan.toFixed(2)} 秒以上大きくしてください`);
    }

    updateWaveformViewInputs(start, end);
    return { start, end };
  }

  function updateWaveformViewInputs(start, end) {
    const startInput = $('#waveform-view-start');
    const endInput = $('#waveform-view-end');
    if (startInput) startInput.value = start.toFixed(1);
    if (endInput) endInput.value = end.toFixed(1);
  }

  function setWaveformViewControlsEnabled(enabled, duration = 0) {
    ['#waveform-view-start', '#waveform-view-end', '#btn-apply-waveform-view', '#btn-reset-waveform-view', '#btn-waveform-spectrum']
      .forEach(selector => {
        const el = $(selector);
        if (el) el.disabled = !enabled;
      });

    const endInput = $('#waveform-view-end');
    if (endInput) {
      endInput.max = enabled ? duration.toFixed(1) : '0';
    }
    const startInput = $('#waveform-view-start');
    if (startInput) {
      startInput.max = enabled ? duration.toFixed(1) : '0';
    }
  }

  function resetWaveformViewerState() {
    currentWaveformData = null;
    currentWaveformView = { start: 0, end: null };
    WaveformViewer.clearCache();

    const stationSel = $('#waveform-station');
    if (stationSel) {
      stationSel.innerHTML = '<option value="">-- 先に観測点を検索 --</option>';
    }

    const stationSummary = $('#waveform-station-summary');
    if (stationSummary) {
      stationSummary.innerHTML = '';
      stationSummary.classList.add('hidden');
    }

    updateWaveformViewInputs(0, 0);
    setWaveformViewControlsEnabled(false);
    WaveformViewer.resetDisplay('waveform-display');
    resetSpectrumState();
  }

  function resetSpectrumState() {
    spectrumInputData = null;
    Spectrum.clearCharts();

    const btnCalc = $('#btn-calc-spectrum');
    if (btnCalc) btnCalc.disabled = true;

    const info = $('#spectrum-info');
    if (info) {
      info.style.display = '';
      info.innerHTML = '検索結果から地震を選択し、波形ビューアで生波形を表示すると、ここに応答スペクトル入力情報が表示されます。';
    }
  }

  function renderWaveformStationSummary(stations, candidateCount = 0, availableCount = 0) {
    const container = $('#waveform-station-summary');
    if (!container) return;

    if (!stations.length) {
      container.innerHTML = '';
      container.classList.add('hidden');
      return;
    }

    const rows = stations.map((station, index) => `
      <tr data-station-key="${escapeHtml(station.stationKey)}">
        <td>${index + 1}</td>
        <td class="station-summary-code">${escapeHtml(station.stationKey)}</td>
        <td>${station.distanceKm.toFixed(1)} km</td>
        <td>${station.previewMaxAcc.toFixed(2)} ${station.previewUnit || 'gal'}</td>
      </tr>
    `).join('');

    container.innerHTML = `
      <div class="station-summary-header">
        <strong>観測点候補</strong>
        <span>${availableCount} / ${candidateCount} チャンネルで加速度波形を取得可能</span>
      </div>
      <div class="station-summary-table-wrap">
        <table class="station-summary-table">
          <thead>
            <tr>
              <th>#</th>
              <th>観測点</th>
              <th>距離</th>
              <th>最大加速度</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
    container.classList.remove('hidden');

    container.querySelectorAll('tbody tr[data-station-key]').forEach(row => {
      row.addEventListener('click', () => {
        const stationKey = row.dataset.stationKey;
        const stationSel = $('#waveform-station');
        if (!stationSel) return;

        const option = Array.from(stationSel.options).find(opt => opt.dataset.stationKey === stationKey);
        if (!option) return;

        stationSel.value = option.value;
        updateSelectedWaveformStationSummary();
      });
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
