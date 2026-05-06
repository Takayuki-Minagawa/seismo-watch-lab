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

  // マグニチュードに応じた色
  function magColor(mag) {
    if (mag === null || mag === undefined) return '#999';
    if (mag < 3) return '#48bb78';
    if (mag < 4) return '#ecc94b';
    if (mag < 5) return '#ed8936';
    if (mag < 6) return '#e53e3e';
    if (mag < 7) return '#c53030';
    if (mag < 8) return '#9b2c2c';
    return '#4a0000';
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
    if (depth === null || depth === undefined) return '#999';
    if (depth < 30) return '#d7263d';
    if (depth < 70) return '#f46036';
    if (depth < 300) return '#2e86ab';
    return '#4b3f72';
  }

  function recencyColor(time) {
    if (!time) return '#999';
    const ageHours = (Date.now() - time) / (60 * 60 * 1000);
    if (ageHours <= 1) return '#d7263d';
    if (ageHours <= 24) return '#f46036';
    if (ageHours <= 168) return '#2e86ab';
    return '#6b7280';
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

    if (!geojson || !geojson.features || geojson.features.length === 0) {
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
      const popup = `
        <div class="eq-popup">
          <strong class="${I18n.magnitudeClass(mag)}">M${mag !== null ? mag.toFixed(1) : '?'}</strong>
          <span class="popup-label">${I18n.magnitudeLabel(mag)}</span>
          <hr>
          <div><strong>震央:</strong> ${place}</div>
          <div><strong>深さ:</strong> ${depth ? depth.toFixed(1) + ' km' : '不明'}</div>
          <div><strong>発生日時:</strong> ${time}</div>
          ${props.tsunami ? '<div class="tsunami-warn">津波情報あり</div>' : ''}
          <div class="popup-link"><a href="${props.url}" target="_blank" rel="noopener">USGS詳細ページ</a></div>
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
    updateModeHint();
    if (currentGeojson) {
      displayEarthquakes(currentGeojson, currentClickCallback, { fit: false });
    }
  }

  function updateModeHint() {
    const hint = document.getElementById('map-mode-hint');
    if (!hint) return;
    if (styleMode === 'depth') {
      hint.textContent = '赤:浅い / 青紫:深い';
    } else if (styleMode === 'recency') {
      hint.textContent = '赤:1時間以内 / 橙:24時間以内';
    } else {
      hint.textContent = 'Mが大きいほど濃色';
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
