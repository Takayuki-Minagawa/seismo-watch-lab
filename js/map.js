/**
 * map.js - Leaflet地図管理モジュール
 * 地震の震央をマーカーで表示し、インタラクティブな操作を提供
 */
const EarthquakeMap = (() => {
  let map = null;
  let markerGroup = null;
  let currentGeojson = null;
  let currentClickCallback = null;
  let styleMode = 'magnitude';

  const STYLE_DEFINITIONS = Object.freeze({
    magnitude: {
      title: 'マグニチュード',
      hint: 'Mが大きいほど濃色',
      inclusive: false,
      unknownColor: '#999999',
      items: [
        { max: 3, label: '<3', color: '#48bb78' },
        { max: 4, label: '3–4', color: '#a0c45a' },
        { max: 5, label: '4–5', color: '#ecc94b' },
        { max: 6, label: '5–6', color: '#ed8936' },
        { max: 7, label: '6–7', color: '#c53030' },
        { max: 8, label: '7–8', color: '#9b2c2c' },
        { max: Infinity, label: '8以上', color: '#4a0000' },
      ],
    },
    depth: {
      title: '震源深さ',
      hint: '赤:浅い / 青紫:深い',
      inclusive: false,
      unknownColor: '#999999',
      items: [
        { max: 30, label: '<30 km', color: '#d7263d' },
        { max: 70, label: '30–70 km', color: '#f46036' },
        { max: 300, label: '70–300 km', color: '#2e86ab' },
        { max: Infinity, label: '300 km以上', color: '#4b3f72' },
      ],
    },
    recency: {
      title: '発生からの経過時間',
      hint: '赤:1時間以内 / 橙:24時間以内',
      inclusive: true,
      unknownColor: '#999999',
      items: [
        { max: 1, label: '1時間以内', color: '#d7263d' },
        { max: 24, label: '24時間以内', color: '#f46036' },
        { max: 168, label: '7日以内', color: '#2e86ab' },
        { max: Infinity, label: '7日超', color: '#6b7280' },
      ],
    },
  });

  function scaleColor(mode, value) {
    const definition = STYLE_DEFINITIONS[mode];
    if (!definition || !Number.isFinite(value)) return definition?.unknownColor || '#999999';
    const item = definition.items.find(entry => (
      definition.inclusive ? value <= entry.max : value < entry.max
    ));
    return item?.color || definition.unknownColor;
  }

  // マグニチュードに応じた色
  function magColor(mag) {
    return scaleColor('magnitude', mag);
  }

  // マグニチュードに応じた半径
  function magRadius(mag) {
    if (mag === null || mag === undefined) return 3;
    if (mag < 3) return 3;
    if (mag < 4) return 5;
    if (mag < 5) return 7;
    if (mag < 6) return 10;
    if (mag < 7) return 14;
    if (mag < 8) return 18;
    return 24;
  }

  function depthColor(depth) {
    return scaleColor('depth', depth);
  }

  function recencyColor(time) {
    if (!Number.isFinite(time)) return STYLE_DEFINITIONS.recency.unknownColor;
    const ageHours = (Date.now() - time) / (60 * 60 * 1000);
    return ageHours < 0
      ? STYLE_DEFINITIONS.recency.unknownColor
      : scaleColor('recency', ageHours);
  }

  function markerColor(feature) {
    const coords = feature.geometry.coordinates;
    const props = feature.properties;
    if (styleMode === 'depth') return depthColor(coords[2]);
    if (styleMode === 'recency') return recencyColor(props.time);
    return magColor(props.mag);
  }

  /**
   * 地図を初期化
   */
  function init(containerId) {
    // 地図の読込失敗で、後続の検索ボタンや詳細パネルの初期化を止めない。
    if (typeof L === 'undefined') {
      const container = document.getElementById(containerId);
      if (container) {
        container.innerHTML = '<div id="map-unavailable" class="empty-state" role="status">地図を読み込めませんでした。検索結果の一覧・詳細は利用できます。ページを再読み込みしてください。</div>';
      }
      return null;
    }

    map = L.map(containerId, {
      center: [35.68, 139.69], // 東京
      zoom: 3,
      zoomControl: true,
      attributionControl: true,
    });

    // OpenStreetMap タイルレイヤー (ODbL ライセンス)
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      maxZoom: 18,
    }).addTo(map);

    markerGroup = L.layerGroup().addTo(map);
    updateModeUi();

    return map;
  }

  /**
   * GeoJSONデータからマーカーを表示
   * @param {Object} geojson - USGS GeoJSON レスポンス
   * @param {Function} onClickCallback - マーカークリック時のコールバック
   */
  function displayEarthquakes(geojson, onClickCallback, options = {}) {
    const shouldFit = options.fit !== false;
    currentGeojson = geojson;
    currentClickCallback = onClickCallback;
    clearMarkers();

    if (!map || !markerGroup || !geojson || !geojson.features || geojson.features.length === 0) {
      return;
    }

    const bounds = [];

    geojson.features.forEach((feature, index) => {
      const coords = feature.geometry.coordinates;
      const props = feature.properties;
      const lat = coords[1];
      const lon = coords[0];
      const depth = coords[2];
      const mag = props.mag;

      bounds.push([lat, lon]);

      const color = markerColor(feature);
      const radius = magRadius(mag);

      const marker = L.circleMarker([lat, lon], {
        radius: radius,
        fillColor: color,
        color: '#333',
        weight: 1,
        opacity: 0.8,
        fillOpacity: 0.7,
      });

      // ポップアップ（日本語）
      const place = I18n.translatePlace(props.place);
      const time = I18n.formatDateJST(props.time);
      const detailUrl = AppUtils.sanitizeUrlForOrigins(props.url, ['https://earthquake.usgs.gov']);
      const detailLink = detailUrl
        ? `<div class="popup-link"><a href="${AppUtils.escapeHtml(detailUrl)}" target="_blank" rel="noopener">USGS詳細ページ</a></div>`
        : '';
      const depthText = Number.isFinite(depth) ? `${depth.toFixed(1)} km` : '不明';
      const popup = `
        <div class="eq-popup">
          <strong class="mag-badge ${I18n.magnitudeClass(mag)}">M${mag !== null ? mag.toFixed(1) : '?'}</strong>
          <span class="popup-label">${AppUtils.escapeHtml(I18n.magnitudeLabel(mag))}</span>
          <hr>
          <div><strong>震央:</strong> ${AppUtils.escapeHtml(place)}</div>
          <div><strong>深さ:</strong> ${depthText}</div>
          <div><strong>発生日時:</strong> ${AppUtils.escapeHtml(time)}</div>
          ${props.tsunami ? '<div class="tsunami-warn">USGS津波関連フラグあり（警報ではありません）</div>' : ''}
          ${detailLink}
        </div>
      `;
      marker.bindPopup(popup);

      if (onClickCallback) {
        marker.on('click', () => onClickCallback(index, feature));
      }

      marker.addTo(markerGroup);
    });

    // 全マーカーが見える範囲にフィット
    if (shouldFit && bounds.length > 0) {
      try {
        map.fitBounds(bounds, { padding: [30, 30], maxZoom: 8 });
      } catch (e) {
        // bounds が不正な場合は無視
      }
    }
  }

  /**
   * 特定の地震にフォーカス
   */
  function focusOn(lat, lon, zoom = 8) {
    if (map) {
      map.setView([lat, lon], zoom);
    }
  }

  /**
   * マーカーをクリア
   */
  function clearMarkers() {
    if (markerGroup) {
      markerGroup.clearLayers();
    }
  }

  function reset() {
    currentGeojson = null;
    currentClickCallback = null;
    clearMarkers();
  }

  function setStyleMode(mode) {
    styleMode = ['magnitude', 'depth', 'recency'].includes(mode) ? mode : 'magnitude';
    updateModeUi();
    if (currentGeojson) {
      displayEarthquakes(currentGeojson, currentClickCallback, { fit: false });
    }
  }

  function updateModeUi() {
    const definition = STYLE_DEFINITIONS[styleMode];
    const hint = document.getElementById('map-mode-hint');
    if (hint) hint.textContent = definition.hint;

    const legend = document.getElementById('map-legend');
    if (legend) {
      const items = [
        ...definition.items,
        { label: '不明', color: definition.unknownColor },
      ];
      legend.innerHTML = `
        <span class="legend-title">${AppUtils.escapeHtml(definition.title)}:</span>
        ${items.map(item => `
          <span class="legend-item"><span class="legend-dot" style="background:${item.color}" aria-hidden="true"></span> ${AppUtils.escapeHtml(item.label)}</span>
        `).join('')}
      `;
    }
  }

  /**
   * 地図のリサイズ対応
   */
  function invalidateSize() {
    if (map) {
      map.invalidateSize();
    }
  }

  return {
    init,
    displayEarthquakes,
    setStyleMode,
    focusOn,
    clearMarkers,
    reset,
    invalidateSize,
    magColor,
  };
})();
