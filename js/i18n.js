/**
 * i18n.js - 地震データ日本語化モジュール
 * 地名・方角・国名・専門用語の翻訳辞書とテキスト変換処理
 */
const I18n = (() => {

  // 国名・地域名辞書
  const countries = {
    'Afghanistan': 'アフガニスタン',
    'Alaska': 'アラスカ',
    'Albania': 'アルバニア',
    'Algeria': 'アルジェリア',
    'Argentina': 'アルゼンチン',
    'Armenia': 'アルメニア',
    'Australia': 'オーストラリア',
    'Azerbaijan': 'アゼルバイジャン',
    'Bangladesh': 'バングラデシュ',
    'Bolivia': 'ボリビア',
    'Bosnia and Herzegovina': 'ボスニア・ヘルツェゴビナ',
    'Brazil': 'ブラジル',
    'CA': 'カリフォルニア州',
    'California': 'カリフォルニア',
    'Canada': 'カナダ',
    'Chile': 'チリ',
    'China': '中国',
    'Colombia': 'コロンビア',
    'Costa Rica': 'コスタリカ',
    'Croatia': 'クロアチア',
    'Cuba': 'キューバ',
    'Cyprus': 'キプロス',
    'Dominican Republic': 'ドミニカ共和国',
    'East Timor': '東ティモール',
    'Ecuador': 'エクアドル',
    'Egypt': 'エジプト',
    'El Salvador': 'エルサルバドル',
    'Fiji': 'フィジー',
    'France': 'フランス',
    'Georgia': 'ジョージア',
    'Germany': 'ドイツ',
    'Greece': 'ギリシャ',
    'Greenland': 'グリーンランド',
    'Guam': 'グアム',
    'Guatemala': 'グアテマラ',
    'Haiti': 'ハイチ',
    'Hawaii': 'ハワイ',
    'Honduras': 'ホンジュラス',
    'Iceland': 'アイスランド',
    'India': 'インド',
    'Indonesia': 'インドネシア',
    'Iran': 'イラン',
    'Iraq': 'イラク',
    'Israel': 'イスラエル',
    'Italy': 'イタリア',
    'Jamaica': 'ジャマイカ',
    'Japan': '日本',
    'Jordan': 'ヨルダン',
    'Kazakhstan': 'カザフスタン',
    'Kenya': 'ケニア',
    'Kuril Islands': '千島列島',
    'Kyrgyzstan': 'キルギスタン',
    'Laos': 'ラオス',
    'Lebanon': 'レバノン',
    'Libya': 'リビア',
    'Madagascar': 'マダガスカル',
    'Malaysia': 'マレーシア',
    'Maldives': 'モルディブ',
    'Mexico': 'メキシコ',
    'Mongolia': 'モンゴル',
    'Montenegro': 'モンテネグロ',
    'Morocco': 'モロッコ',
    'Mozambique': 'モザンビーク',
    'Myanmar': 'ミャンマー',
    'Nepal': 'ネパール',
    'Nevada': 'ネバダ州',
    'New Caledonia': 'ニューカレドニア',
    'New Zealand': 'ニュージーランド',
    'Nicaragua': 'ニカラグア',
    'Nigeria': 'ナイジェリア',
    'North Korea': '北朝鮮',
    'North Macedonia': '北マケドニア',
    'Oklahoma': 'オクラホマ州',
    'Oregon': 'オレゴン州',
    'Pakistan': 'パキスタン',
    'Palau': 'パラオ',
    'Panama': 'パナマ',
    'Papua New Guinea': 'パプアニューギニア',
    'Paraguay': 'パラグアイ',
    'Peru': 'ペルー',
    'Philippines': 'フィリピン',
    'Poland': 'ポーランド',
    'Portugal': 'ポルトガル',
    'Puerto Rico': 'プエルトリコ',
    'Romania': 'ルーマニア',
    'Russia': 'ロシア',
    'Samoa': 'サモア',
    'Saudi Arabia': 'サウジアラビア',
    'Serbia': 'セルビア',
    'Slovenia': 'スロベニア',
    'Solomon Islands': 'ソロモン諸島',
    'Somalia': 'ソマリア',
    'South Africa': '南アフリカ',
    'South Korea': '韓国',
    'Spain': 'スペイン',
    'Sri Lanka': 'スリランカ',
    'Sudan': 'スーダン',
    'Sweden': 'スウェーデン',
    'Switzerland': 'スイス',
    'Syria': 'シリア',
    'Taiwan': '台湾',
    'Tajikistan': 'タジキスタン',
    'Tanzania': 'タンザニア',
    'Tennessee': 'テネシー州',
    'Texas': 'テキサス州',
    'Thailand': 'タイ',
    'Tonga': 'トンガ',
    'Trinidad and Tobago': 'トリニダード・トバゴ',
    'Tunisia': 'チュニジア',
    'Turkey': 'トルコ',
    'Turkmenistan': 'トルクメニスタン',
    'Türkiye': 'トルコ',
    'U.S. Virgin Islands': '米領ヴァージン諸島',
    'Uganda': 'ウガンダ',
    'Ukraine': 'ウクライナ',
    'United Kingdom': 'イギリス',
    'United States': 'アメリカ',
    'Uruguay': 'ウルグアイ',
    'Utah': 'ユタ州',
    'Uzbekistan': 'ウズベキスタン',
    'Vanuatu': 'バヌアツ',
    'Venezuela': 'ベネズエラ',
    'Vietnam': 'ベトナム',
    'Washington': 'ワシントン州',
    'Yemen': 'イエメン',
  };

  // 海域・地域名
  const regions = {
    'Mid-Atlantic Ridge': '大西洋中央海嶺',
    'East Pacific Rise': '東太平洋海膨',
    'Mid-Indian Ridge': 'インド洋中央海嶺',
    'Pacific-Antarctic Ridge': '太平洋南極海嶺',
    'Carlsberg Ridge': 'カールスバーグ海嶺',
    'Mariana Trench': 'マリアナ海溝',
    'Philippine Sea': 'フィリピン海',
    'South China Sea': '南シナ海',
    'Sea of Japan': '日本海',
    'Sea of Okhotsk': 'オホーツク海',
    'Bering Sea': 'ベーリング海',
    'Coral Sea': '珊瑚海',
    'Tasman Sea': 'タスマン海',
    'Banda Sea': 'バンダ海',
    'Celebes Sea': 'セレベス海',
    'Molucca Sea': 'モルッカ海',
    'Sulu Sea': 'スールー海',
    'Java Sea': 'ジャワ海',
    'Flores Sea': 'フローレス海',
    'Timor Sea': 'ティモール海',
    'Arafura Sea': 'アラフラ海',
    'Bismarck Sea': 'ビスマルク海',
    'Solomon Sea': 'ソロモン海',
    'Arabian Sea': 'アラビア海',
    'Bay of Bengal': 'ベンガル湾',
    'Mediterranean Sea': '地中海',
    'Black Sea': '黒海',
    'Caspian Sea': 'カスピ海',
    'Red Sea': '紅海',
    'Gulf of Mexico': 'メキシコ湾',
    'Gulf of California': 'カリフォルニア湾',
    'Gulf of Alaska': 'アラスカ湾',
    'Caribbean Sea': 'カリブ海',
    'Scotia Sea': 'スコシア海',
    'Drake Passage': 'ドレーク海峡',
    'Strait of Malacca': 'マラッカ海峡',
    'Aleutian Islands': 'アリューシャン列島',
    'Andreanof Islands': 'アンドレアノフ諸島',
    'Bonin Islands': '小笠原諸島',
    'Fox Islands': 'フォックス諸島',
    'Kermadec Islands': 'ケルマディック諸島',
    'Loyalty Islands': 'ロイヤルティ諸島',
    'Mariana Islands': 'マリアナ諸島',
    'Rat Islands': 'ラット諸島',
    'Ryukyu Islands': '琉球諸島',
    'Santa Cruz Islands': 'サンタクルーズ諸島',
    'South Sandwich Islands': 'サウスサンドウィッチ諸島',
    'Sumatra': 'スマトラ',
    'Sulawesi': 'スラウェシ',
    'Mindanao': 'ミンダナオ',
    'Luzon': 'ルソン',
    'Honshu': '本州',
    'Hokkaido': '北海道',
    'Shikoku': '四国',
    'Kyushu': '九州',
    'Okinawa': '沖縄',
    'Java': 'ジャワ',
    'Bali': 'バリ',
    'Borneo': 'ボルネオ',
    'Celebes': 'セレベス',
    'Halmahera': 'ハルマヘラ',
    'Seram': 'セラム',
    'Timor': 'ティモール',
    'Crete': 'クレタ',
    'Sicily': 'シチリア',
    'Kamchatka': 'カムチャツカ',
    'Sakhalin': 'サハリン',
    'Kuril Islands': '千島列島',
    'Hindu Kush': 'ヒンドゥークシュ',
    'Himalaya': 'ヒマラヤ',
    'Andes': 'アンデス',
    'Tonga': 'トンガ',
    'Fiji Islands': 'フィジー諸島',
    'Samoa Islands': 'サモア諸島',
    'New Britain': 'ニューブリテン',
    'New Ireland': 'ニューアイルランド',
    'Bougainville': 'ブーゲンビル',
    'Volcano Islands': '火山列島',
    'Izu Islands': '伊豆諸島',
    'Nansei Islands': '南西諸島',
  };

  // 方角辞書（16方位対応）
  const directions = {
    'N': '北',
    'S': '南',
    'E': '東',
    'W': '西',
    'NNE': '北北東',
    'NE': '北東',
    'ENE': '東北東',
    'ESE': '東南東',
    'SE': '南東',
    'SSE': '南南東',
    'SSW': '南南西',
    'SW': '南西',
    'WSW': '西南西',
    'WNW': '西北西',
    'NW': '北西',
    'NNW': '北北西',
  };

  // 地震関連用語
  const terms = {
    'earthquake': '地震',
    'Earthquake': '地震',
    'explosion': '爆発',
    'Explosion': '爆発',
    'quarry blast': '採石場爆発',
    'nuclear explosion': '核爆発',
    'volcanic eruption': '火山噴火',
    'ice quake': '氷震',
    'sonic boom': 'ソニックブーム',
    'reviewed': '検証済み',
    'automatic': '自動検出',
    'deleted': '削除済み',
    'green': '注意なし',
    'yellow': '注意',
    'orange': '警戒',
    'red': '重大警戒',
    'tsunami': '津波',
    'felt': '体感あり',
    'not felt': '体感なし',
  };

  // "of" の前後のフレーズ翻訳
  const locationPhrases = {
    'south of': '南方',
    'north of': '北方',
    'east of': '東方',
    'west of': '西方',
    'near the coast of': '沿岸付近',
    'off the coast of': '沖合',
    'off the east coast of': '東岸沖',
    'off the west coast of': '西岸沖',
    'near': '付近',
    'region': '地域',
    'border region': '国境地域',
    'the ': '',
  };

  /**
   * USGS place文字列を日本語に変換
   * 例: "10km WNW of Tokyo, Japan" → "日本 東京の西北西10km"
   */
  function translatePlace(place) {
    if (!place) return '不明';
    let result = place;

    // パターン1: "XXkm DIR of PLACE, REGION"
    const distPattern = /^(\d+)\s*km\s+([NSEW]{1,3})\s+of\s+(.+)$/i;
    const match = result.match(distPattern);
    if (match) {
      const dist = match[1];
      const dir = directions[match[2].toUpperCase()] || match[2];
      const locationPart = translateLocationPart(match[3]);
      return `${locationPart}の${dir} ${dist}km`;
    }

    // パターン2: "South of the Fiji Islands" 等
    for (const [phrase, ja] of Object.entries(locationPhrases)) {
      const regex = new RegExp(phrase, 'gi');
      if (regex.test(result)) {
        result = result.replace(regex, ja);
      }
    }

    // 地域名・国名を置換
    result = translateLocationPart(result);

    return result;
  }

  /**
   * 場所文字列のコンマ区切り各部を翻訳
   */
  function translateLocationPart(text) {
    let result = text;

    // 海域・広域地名の置換（長い名前を先に）
    const sortedRegions = Object.entries(regions)
      .sort((a, b) => b[0].length - a[0].length);
    for (const [en, ja] of sortedRegions) {
      const regex = new RegExp(en.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
      result = result.replace(regex, ja);
    }

    // 国名の置換
    const sortedCountries = Object.entries(countries)
      .sort((a, b) => b[0].length - a[0].length);
    for (const [en, ja] of sortedCountries) {
      const regex = new RegExp(`\\b${en.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
      result = result.replace(regex, ja);
    }

    return result.trim();
  }

  /**
   * 用語を翻訳
   */
  function translateTerm(term) {
    if (!term) return '';
    return terms[term] || terms[term.toLowerCase()] || term;
  }

  /**
   * UNIXタイムスタンプをJST日時文字列に変換
   */
  function formatDateJST(timestamp) {
    const d = new Date(timestamp);
    const options = {
      timeZone: 'Asia/Tokyo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    };
    return d.toLocaleString('ja-JP', options) + ' JST';
  }

  /**
   * UTC日時文字列に変換
   */
  function formatDateUTC(timestamp) {
    const d = new Date(timestamp);
    return d.toISOString().replace('T', ' ').replace('.000Z', '') + ' UTC';
  }

  /**
   * マグニチュードの規模を日本語で返す
   */
  function magnitudeLabel(mag) {
    if (mag === null || mag === undefined) return '不明';
    if (mag < 3) return '微小';
    if (mag < 4) return '小規模';
    if (mag < 5) return '中規模';
    if (mag < 6) return 'やや大きい';
    if (mag < 7) return '大きい';
    if (mag < 8) return '巨大';
    return '超巨大';
  }

  /**
   * マグニチュードに対応するCSSクラス名
   */
  function magnitudeClass(mag) {
    if (mag === null || mag === undefined) return 'mag-unknown';
    if (mag < 3) return 'mag-micro';
    if (mag < 4) return 'mag-minor';
    if (mag < 5) return 'mag-moderate';
    if (mag < 6) return 'mag-strong';
    if (mag < 7) return 'mag-major';
    if (mag < 8) return 'mag-great';
    return 'mag-extreme';
  }

  return {
    translatePlace,
    translateTerm,
    formatDateJST,
    formatDateUTC,
    magnitudeLabel,
    magnitudeClass,
    countries,
    regions,
    directions,
    terms,
  };
})();
