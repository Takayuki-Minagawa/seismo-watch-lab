/**
 * settings.js - ダークモード・自動更新・検索条件保存・URL共有
 */
const Settings = (() => {
  const STORAGE_KEY_THEME = 'seismo-theme';
  const STORAGE_KEY_SAVED = 'seismo-saved-searches';
  let autoRefreshTimer = null;
  let autoRefreshCallback = null;

  // ===== ダークモード =====
  function initDarkMode() {
    const saved = localStorage.getItem(STORAGE_KEY_THEME);
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
    localStorage.setItem(STORAGE_KEY_THEME, theme);
    updateDarkModeButton();
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
  }

  function getSavedSearches() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY_SAVED)) || [];
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
    localStorage.setItem(STORAGE_KEY_SAVED, JSON.stringify(saved));
    updateSavedSearchList();
  }

  function deleteSelectedSearch() {
    const sel = document.getElementById('saved-conditions');
    if (!sel || sel.value === '') return;

    const saved = getSavedSearches();
    const filtered = saved.filter(s => s.name !== sel.value);
    localStorage.setItem(STORAGE_KEY_SAVED, JSON.stringify(filtered));
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

  function getCurrentSearchParams() {
    return {
      startdate: document.getElementById('startdate')?.value || '',
      enddate: document.getElementById('enddate')?.value || '',
      minmag: document.getElementById('minmag')?.value || '',
      maxdepth: document.getElementById('maxdepth')?.value || '',
      region: document.getElementById('region')?.value || '',
      limit: document.getElementById('limit')?.value || '',
      minlat: document.getElementById('custom-minlat')?.value || '',
      maxlat: document.getElementById('custom-maxlat')?.value || '',
      minlon: document.getElementById('custom-minlon')?.value || '',
      maxlon: document.getElementById('custom-maxlon')?.value || '',
    };
  }

  function applySearchParams(params) {
    const fields = ['startdate', 'enddate', 'minmag', 'maxdepth', 'region', 'limit'];
    fields.forEach(id => {
      const el = document.getElementById(id);
      if (el && params[id] !== undefined) el.value = params[id];
    });
    // カスタム範囲
    ['custom-minlat', 'custom-maxlat', 'custom-minlon', 'custom-maxlon'].forEach(id => {
      const el = document.getElementById(id);
      const key = id.replace('custom-', '');
      if (el && params[key] !== undefined) el.value = params[key];
    });
    // カスタム範囲表示切替
    const customBounds = document.getElementById('custom-bounds');
    if (customBounds) {
      customBounds.style.display = params.region === 'custom' ? 'grid' : 'none';
    }
  }

  // ===== URL共有 =====
  function initShare() {
    const btn = document.getElementById('btn-share');
    if (btn) btn.addEventListener('click', shareCurrentSearch);

    // ページロード時にURLパラメータを復元
    restoreFromURL();
  }

  function shareCurrentSearch() {
    const params = getCurrentSearchParams();
    const searchParams = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => {
      if (v) searchParams.set(k, v);
    });
    const url = `${location.origin}${location.pathname}?${searchParams.toString()}`;

    if (navigator.clipboard) {
      navigator.clipboard.writeText(url).then(() => {
        showToast('共有URLをクリップボードにコピーしました');
      });
    } else {
      prompt('以下のURLをコピーしてください:', url);
    }
  }

  function restoreFromURL() {
    const params = new URLSearchParams(location.search);
    if (params.toString() === '') return false;

    const mapping = {
      startdate: 'startdate', enddate: 'enddate', minmag: 'minmag',
      maxdepth: 'maxdepth', region: 'region', limit: 'limit',
      minlat: 'minlat', maxlat: 'maxlat', minlon: 'minlon', maxlon: 'maxlon',
    };

    const restored = {};
    let hasAny = false;
    Object.entries(mapping).forEach(([urlKey, paramKey]) => {
      const val = params.get(urlKey);
      if (val) {
        restored[paramKey] = val;
        hasAny = true;
      }
    });

    if (hasAny) {
      applySearchParams(restored);
      return true;
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
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 2500);
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
    applySearchParams,
  };
})();
