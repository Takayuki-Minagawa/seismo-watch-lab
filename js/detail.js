/**
 * detail.js - 地震詳細パネルモジュール
 * テーブル行クリックでスライドインする詳細情報パネル
 */
const DetailPanel = (() => {
  let panelEl = null;
  let isOpen = false;

  function init() {
    panelEl = document.getElementById('detail-panel');
    const closeBtn = document.getElementById('detail-close');
    if (closeBtn) closeBtn.addEventListener('click', close);

    // Escキーで閉じる
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && isOpen) close();
    });

    // オーバーレイクリックで閉じる
    const overlay = document.getElementById('detail-overlay');
    if (overlay) overlay.addEventListener('click', close);
  }

  /**
   * 地震の詳細情報を表示
   * @param {Object} feature - GeoJSON feature
   */
  function show(feature) {
    if (!panelEl || !feature) return;

    const p = feature.properties;
    const c = feature.geometry.coordinates;
    const lat = c[1];
    const lon = c[0];
    const depth = c[2];
    const mag = p.mag;

    const place = I18n.translatePlace(p.place);
    const magClass = I18n.magnitudeClass(mag);
    const magLabel = I18n.magnitudeLabel(mag);
    const timeJST = I18n.formatDateJST(p.time);
    const timeUTC = I18n.formatDateUTC(p.time);
    const status = I18n.translateTerm(p.status) || p.status;

    // 日本付近かどうか判定（JMA/K-NETリンク表示用）
    const isNearJapan = lat >= 20 && lat <= 50 && lon >= 120 && lon <= 155;

    const content = document.getElementById('detail-content');
    if (!content) return;

    content.innerHTML = `
      <div class="detail-header-info">
        <span class="mag-badge ${magClass}" style="font-size:1.4rem; padding:0.3rem 0.8rem;">
          M${mag !== null ? mag.toFixed(1) : '?'}
        </span>
        <span class="detail-mag-label">${magLabel}</span>
      </div>

      <h3 class="detail-place">${escapeHtml(place)}</h3>
      <p class="detail-place-orig">${escapeHtml(p.place || '')}</p>

      <div class="detail-grid">
        <div class="detail-item">
          <span class="detail-label">発生日時 (JST)</span>
          <span class="detail-value">${timeJST}</span>
        </div>
        <div class="detail-item">
          <span class="detail-label">発生日時 (UTC)</span>
          <span class="detail-value">${timeUTC}</span>
        </div>
        <div class="detail-item">
          <span class="detail-label">深さ</span>
          <span class="detail-value">${depth !== null ? depth.toFixed(1) + ' km' : '不明'}</span>
        </div>
        <div class="detail-item">
          <span class="detail-label">緯度 / 経度</span>
          <span class="detail-value">${lat.toFixed(4)}° / ${lon.toFixed(4)}°</span>
        </div>
        <div class="detail-item">
          <span class="detail-label">状態</span>
          <span class="detail-value">${escapeHtml(status)}</span>
        </div>
        <div class="detail-item">
          <span class="detail-label">津波情報</span>
          <span class="detail-value">${p.tsunami ? '\uD83C\uDF0A あり' : 'なし'}</span>
        </div>
        ${p.felt ? `<div class="detail-item">
          <span class="detail-label">体感報告数</span>
          <span class="detail-value">${p.felt}件</span>
        </div>` : ''}
        ${p.cdi ? `<div class="detail-item">
          <span class="detail-label">最大体感震度 (MMI)</span>
          <span class="detail-value">${p.cdi.toFixed(1)}</span>
        </div>` : ''}
        ${p.mmi ? `<div class="detail-item">
          <span class="detail-label">最大計測震度 (MMI)</span>
          <span class="detail-value">${p.mmi.toFixed(1)}</span>
        </div>` : ''}
        ${p.sig ? `<div class="detail-item">
          <span class="detail-label">重要度スコア</span>
          <span class="detail-value">${p.sig}</span>
        </div>` : ''}
      </div>

      <div class="detail-links">
        <h4>外部リンク</h4>
        <a href="${p.url}" target="_blank" rel="noopener" class="btn btn-primary btn-sm">USGS 詳細ページ</a>

        ${isNearJapan ? `
          <a href="https://www.jma.go.jp/bosai/map.html#contents=earthquake_information"
             target="_blank" rel="noopener" class="btn btn-outline btn-sm">気象庁 地震情報</a>
          <a href="https://www.kyoshin.bosai.go.jp/"
             target="_blank" rel="noopener" class="btn btn-outline btn-sm">K-NET / KiK-net</a>
          <a href="https://www.hinet.bosai.go.jp/"
             target="_blank" rel="noopener" class="btn btn-outline btn-sm">Hi-net</a>
        ` : ''}

        <a href="https://service.iris.edu/fdsnws/station/1/query?latitude=${lat}&longitude=${lon}&maxradius=5&level=station&format=text&nodata=404"
           target="_blank" rel="noopener" class="btn btn-outline btn-sm">IRIS 周辺観測点</a>
      </div>

      <div class="detail-actions">
        <button class="btn btn-sm btn-secondary" onclick="DetailPanel.focusMap(${lat}, ${lon})">
          地図でフォーカス
        </button>
        <button class="btn btn-sm btn-secondary" onclick="DetailPanel.copyInfo()">
          情報をコピー
        </button>
      </div>
    `;

    open();
  }

  function open() {
    if (!panelEl) return;
    panelEl.classList.add('open');
    const overlay = document.getElementById('detail-overlay');
    if (overlay) overlay.classList.add('active');
    isOpen = true;
  }

  function close() {
    if (!panelEl) return;
    panelEl.classList.remove('open');
    const overlay = document.getElementById('detail-overlay');
    if (overlay) overlay.classList.remove('active');
    isOpen = false;
  }

  function focusMap(lat, lon) {
    EarthquakeMap.focusOn(lat, lon, 8);
  }

  function copyInfo() {
    const content = document.getElementById('detail-content');
    if (!content) return;
    const text = content.innerText;
    if (navigator.clipboard) {
      navigator.clipboard.writeText(text).then(() => {
        Settings.showToast('情報をコピーしました');
      });
    }
  }

  function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  return { init, show, close, focusMap, copyInfo };
})();
