# SeismoWatch Lab

世界の地震データを日本語で検索・閲覧・ダウンロードできる静的Webアプリケーションです。
サーバー不要でブラウザ上のみで動作し、GitHub Pagesで公開しています。

## 概要

[USGS (アメリカ地質調査所) Earthquake API](https://earthquake.usgs.gov/fdsnws/event/1/) から取得した地震データを、日本語に変換して表示します。地名・方角・専門用語を辞書ベースで翻訳し、英語が苦手な方でも直感的に利用できるよう設計しています。

**本アプリは情報の閲覧・取得を目的としたツールです。防災上の判断には、必ず[気象庁](https://www.jma.go.jp/bosai/map.html#contents=earthquake_information)等の公式情報をご確認ください。**

## 機能

### 地震データ検索
- 期間・マグニチュード・深さ・地域を指定した詳細検索
- 地域プリセット（日本周辺、環太平洋、東南アジア、南米、地中海、中央アジア）
- 緯度・経度の範囲を直接指定するカスタム検索
- ワンクリックで最近の地震を取得できるクイック検索

### 日本語表示
- 約100か国の国名を日本語に変換
- 約60の海域・地域名に対応
- 16方位（北北東、南南西など）の日本語化
- マグニチュード規模の日本語ラベル表示

### 震央マップ
- Leafletによるインタラクティブな地図表示
- マグニチュードに応じた色分け・サイズ分けマーカー
- マーカークリックで日本語の詳細情報を表示

### データダウンロード
- **CSV** : BOM付きUTF-8でExcelに対応、日本語カラム名
- **JSON** : 日本語ラベル付きの整形済みデータ
- **GeoJSON** : GISソフトウェアで利用可能な形式

### 参考情報リンク
気象庁・防災科学技術研究所・USGS等の関連情報へのリンクを掲載しています。

## 技術構成

| 項目 | 内容 |
|------|------|
| フロントエンド | HTML / CSS / JavaScript (Vanilla JS) |
| 地図ライブラリ | [Leaflet](https://leafletjs.com/) 1.9.4 |
| 地図タイル | [OpenStreetMap](https://www.openstreetmap.org/) |
| データソース | [USGS Earthquake API](https://earthquake.usgs.gov/fdsnws/event/1/) |
| ホスティング | GitHub Pages |
| ビルドツール | 不要（静的ファイルのみ） |

## ローカルでの実行

静的ファイルのみで構成されているため、ビルド手順は不要です。

```bash
git clone https://github.com/Takayuki-Minagawa/seismo-watch-lab.git
cd seismo-watch-lab
```

任意のHTTPサーバーで配信するか、`index.html` をブラウザで直接開いてください。

```bash
# Python の場合
python3 -m http.server 8000

# Node.js の場合
npx serve .
```

## データ出典・ライセンス

### 本アプリケーション

[MIT License](LICENSE)

### 利用しているデータ・ライブラリ

| 名称 | 用途 | ライセンス |
|------|------|------------|
| [USGS Earthquake Hazards Program](https://earthquake.usgs.gov/) | 地震データ | パブリックドメイン |
| [Leaflet](https://leafletjs.com/) | 地図表示ライブラリ | BSD-2-Clause |
| [OpenStreetMap](https://www.openstreetmap.org/copyright) | 地図タイル | ODbL (帰属表示必須) |

### 参考情報として掲載している外部サイト

- [気象庁](https://www.jma.go.jp/) - 地震情報、震度データベース、震央分布図
- [防災科学技術研究所 (NIED)](https://www.bosai.go.jp/) - K-NET/KiK-net、Hi-net、J-SHIS
- [IRIS / NSF SAGE](https://www.iris.edu/hq/) - Seismic Monitor、Web Services (FDSN)、Data Management Center
- [EMSC (欧州地中海地震学センター)](https://www.emsc-csem.org/)

各外部サイトのデータ利用については、それぞれの利用規約に従ってください。

## 免責事項

- 本アプリケーションが表示するデータは USGS API から取得したものであり、その正確性・即時性を保証するものではありません。
- 地名の日本語翻訳は辞書ベースの簡易的なものです。すべての地名が正確に翻訳されるわけではありません。
- 防災に関する判断には、気象庁をはじめとする各国の公式機関が発表する情報を必ずご参照ください。
