/**
 * settings.js - ダークモード・自動更新・検索条件保存・URL共有
 */
const Settings = (() => {
  const STORAGE_KEY_THEME = 'seismo-theme';
  const STORAGE_KEY_SAVED = 'seismo-saved-searches';
  const QUICK_TYPES = new Set(['24h-4.5', '7d-5.0', '30d-6.0', '365d-7.0']);
  const SEARCH_FIELDS = {
    startdate: 'startdate', enddate: 'enddate', minmag: 'minmag',
    maxdepth: 'maxdepth', region: 'region', limit: 'limit',
    minlat: 'custom-minlat', maxlat: 'custom-maxlat',
    minlon: 'custom-minlon', maxlon: 'custom-maxlon',
    latitude: 'circle-latitude', longitude: 'circle-longitude',
    maxradiuskm: 'circle-radius',
  };
  let autoRefreshTimer = null;
  let autoRefreshCallback = null;
  let themeChangeCallback = null;
  let activeQuickType = null; // クイック検索種別 (null = フォーム検索)

  // ===== ダークモード =====
  function initDarkMode() {
    const saved = readStorage(STORAGE_KEY_THEME);
    if (saved === 'dark') applyTheme('dark');

    const btn = document.getElementById('btn-darkmode');
    if (btn) {
      btn.addEventListener('click', toggleDarkMode);
      updateDarkModeButton();
    }
  }

  function toggleDarkMode() {
    const current = document.documentElement.dataset.theme;
    const next = current === 'dark' ? 'light' : 'dark';
    applyTheme(next);
  }

  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    writeStorage(STORAGE_KEY_THEME, theme);
    updateDarkModeButton();
    if (themeChangeCallback) themeChangeCallback();
  }

  function updateDarkModeButton() {
    const btn = document.getElementById('btn-darkmode');
    if (!btn) return;
    const isDark = document.documentElement.dataset.theme === 'dark';
    btn.textContent = isDark ? '\u2600\uFE0F' : '\uD83C\uDF19';
    btn.title = isDark ? 'ライトモードに切替' : 'ダークモードに切替';
  }

  // ===== 自動更新 =====
  function initAutoRefresh(callback) {
    autoRefreshCallback = callback;
    const btn = document.getElementById('btn-autorefresh');
    const sel = document.getElementById('autorefresh-interval');
    if (btn) btn.addEventListener('click', toggleAutoRefresh);
    if (sel) sel.addEventListener('change', restartAutoRefresh);
  }

  function toggleAutoRefresh() {
    if (autoRefreshTimer) {
      stopAutoRefresh();
    } else {
      startAutoRefresh();
    }
  }

  function startAutoRefresh() {
    const sel = document.getElementById('autorefresh-interval');
    const minutes = sel ? parseInt(sel.value, 10) : 5;
    const ms = minutes * 60 * 1000;

    if (autoRefreshCallback) {
      autoRefreshTimer = setInterval(autoRefreshCallback, ms);
    }
    updateAutoRefreshButton(true, minutes);
  }

  function stopAutoRefresh() {
    if (autoRefreshTimer) {
      clearInterval(autoRefreshTimer);
      autoRefreshTimer = null;
    }
    updateAutoRefreshButton(false);
  }

  function restartAutoRefresh() {
    if (autoRefreshTimer) {
      stopAutoRefresh();
      startAutoRefresh();
    }
  }

  function updateAutoRefreshButton(active, minutes) {
    const btn = document.getElementById('btn-autorefresh');
    if (!btn) return;
    if (active) {
      btn.classList.add('active');
      btn.textContent = `\u23F8 ${minutes}分`;
      btn.title = '自動更新を停止';
    } else {
      btn.classList.remove('active');
      btn.textContent = '\u25B6 自動更新';
      btn.title = '自動更新を開始';
    }
  }

  // ===== 検索条件の保存・読込 =====
  function initSavedSearches() {
    updateSavedSearchList();

    const btnSave = document.getElementById('btn-save-condition');
    const btnDelete = document.getElementById('btn-delete-condition');
    const sel = document.getElementById('saved-conditions');

    if (btnSave) btnSave.addEventListener('click', saveCurrentSearch);
    if (btnDelete) btnDelete.addEventListener('click', deleteSelectedSearch);
    if (sel) sel.addEventListener('change', loadSelectedSearch);

    // 手入力やリセット後の保存・共有には、以前のクイック検索を混ぜない。
    const useManualSearch = () => setActiveQuickType(null);
    Object.values(SEARCH_FIELDS).forEach(id => {
      const field = document.getElementById(id);
      field?.addEventListener('input', useManualSearch);
      field?.addEventListener('change', useManualSearch);
    });
    document.getElementById('btn-reset')?.addEventListener('click', useManualSearch);
  }

  function getSavedSearches() {
    try {
      const parsed = JSON.parse(readStorage(STORAGE_KEY_SAVED) || '[]');
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(item => (
        item
        && typeof item.name === 'string'
        && item.name.trim()
        && item.params
        && typeof item.params === 'object'
        && !Array.isArray(item.params)
      ));
    } catch {
      return [];
    }
  }

  function saveCurrentSearch() {
    const name = prompt('検索条件の名前を入力してください:');
    if (!name) return;

    const params = getCurrentSearchParams();
    const saved = getSavedSearches();
    // 同名は上書き
    const idx = saved.findIndex(s => s.name === name);
    if (idx >= 0) {
      saved[idx].params = params;
    } else {
      saved.push({ name, params });
    }
    if (!writeStorage(STORAGE_KEY_SAVED, JSON.stringify(saved))) {
      showToast('検索条件を保存できませんでした');
      return;
    }
    updateSavedSearchList();
  }

  function deleteSelectedSearch() {
    const sel = document.getElementById('saved-conditions');
    if (!sel || sel.value === '') return;

    const saved = getSavedSearches();
    const filtered = saved.filter(s => s.name !== sel.value);
    if (!writeStorage(STORAGE_KEY_SAVED, JSON.stringify(filtered))) {
      showToast('保存済み条件を削除できませんでした');
      return;
    }
    updateSavedSearchList();
  }

  function loadSelectedSearch() {
    const sel = document.getElementById('saved-conditions');
    if (!sel || sel.value === '') return;

    const saved = getSavedSearches();
    const item = saved.find(s => s.name === sel.value);
    if (item) applySearchParams(item.params);
  }

  function updateSavedSearchList() {
    const sel = document.getElementById('saved-conditions');
    if (!sel) return;

    const saved = getSavedSearches();
    sel.innerHTML = '<option value="">-- 保存済み条件 --</option>';
    saved.forEach(s => {
      const opt = document.createElement('option');
      opt.value = s.name;
      opt.textContent = s.name;
      sel.appendChild(opt);
    });
  }

  function setActiveQuickType(type) {
    activeQuickType = QUICK_TYPES.has(type) ? type : null;
    const labels = {
      '24h-4.5': '24時間 M4.5+', '7d-5.0': '7日間 M5.0+',
      '30d-6.0': '30日間 M6.0+', '365d-7.0': '1年間 M7.0+',
    };
    const status = document.getElementById('search-mode-status');
    if (status) status.textContent = activeQuickType
      ? `クイック検索: ${labels[activeQuickType]}（世界全体）。フォームを編集すると通常検索に戻ります。`
      : 'フォームの条件で検索します。';
  }

  function getActiveQuickType() {
    return activeQuickType;
  }

  function getCurrentSearchParams() {
    const params = {};
    Object.entries(SEARCH_FIELDS).forEach(([key, id]) => {
      params[key] = document.getElementById(id)?.value || '';
    });
    // クイック検索の場合はその種別も記録
    if (activeQuickType) {
      params.quick = activeQuickType;
    }
    return params;
  }

  function applySearchParams(params) {
    setActiveQuickType(params.quick);
    Object.entries(SEARCH_FIELDS).forEach(([key, id]) => {
      const el = document.getElementById(id);
      if (el && params[key] !== undefined) el.value = params[key];
    });
    // URLの一部だけを復元する場合も、実際の地域選択と表示を合わせる。
    const region = document.getElementById('region')?.value;
    const customBounds = document.getElementById('custom-bounds');
    if (customBounds) {
      customBounds.style.display = region === 'custom' ? 'grid' : 'none';
    }
    const circleBounds = document.getElementById('circle-bounds');
    if (circleBounds) {
      circleBounds.style.display = region === 'circle' ? 'grid' : 'none';
    }
  }

  // ===== URL共有 =====
  function initShare() {
    const btn = document.getElementById('btn-share');
    if (btn) btn.addEventListener('click', shareCurrentSearch);
  }

  function shareCurrentSearch() {
    const params = getCurrentSearchParams();
    const searchParams = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => {
      // 空欄も保存して、共有先の初期値で検索条件が変わらないようにする。
      searchParams.set(k, v);
    });
    const url = `${location.origin}${location.pathname}?${searchParams.toString()}`;

    if (navigator.clipboard) {
      navigator.clipboard.writeText(url).then(() => {
        showToast('共有URLをクリップボードにコピーしました');
      }).catch(() => prompt('以下のURLをコピーしてください:', url));
    } else {
      prompt('以下のURLをコピーしてください:', url);
    }
  }

  function restoreFromURL() {
    const params = new URLSearchParams(location.search);
    if (params.toString() === '') return false;

    // クイック検索パラメータ優先
    const quickType = params.get('quick');
    setActiveQuickType(quickType);
    if (activeQuickType) {
      return 'quick';
    }

    const restored = {};
    let hasAny = false;
    Object.keys(SEARCH_FIELDS).forEach(key => {
      if (params.has(key)) {
        restored[key] = params.get(key);
        hasAny = true;
      }
    });

    if (hasAny) {
      applySearchParams(restored);
      return 'manual';
    }
    return false;
  }

  // ===== トースト通知 =====
  function showToast(message) {
    let toast = document.getElementById('toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'toast';
      toast.className = 'toast';
      toast.setAttribute('role', 'status');
      toast.setAttribute('aria-live', 'polite');
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 2500);
  }

  function onThemeChange(callback) {
    themeChangeCallback = callback;
  }

  function readStorage(key) {
    try {
      return localStorage.getItem(key);
    } catch (_) {
      return null;
    }
  }

  function writeStorage(key, value) {
    try {
      localStorage.setItem(key, value);
      return true;
    } catch (_) {
      return false;
    }
  }

  return {
    initDarkMode,
    initAutoRefresh,
    stopAutoRefresh,
    initSavedSearches,
    initShare,
    restoreFromURL,
    showToast,
    getCurrentSearchParams,
    getSavedSearches,
    applySearchParams,
    setActiveQuickType,
    getActiveQuickType,
    onThemeChange,
  };
})();
