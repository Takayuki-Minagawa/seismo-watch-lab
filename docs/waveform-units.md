# 波形の自動取得・単位・応答補正

通常の利用ではファイルを用意する必要はありません。地震と観測点を選んで `取得して表示` を押すと、アプリが観測サイトからデータを取得して加速度へ変換します。表示した波形は `応答スペクトル作成` からそのまま計算に使えます。

加速度を解析するには、値の単位と観測機器の応答を確認する必要があります。`COUNTS` はデジタル記録値であり、加速度ではありません。`FLOAT` は数値形式です。`correct=true&units=ACC` という過去のリクエストやファイル名から、実際の値を `m/s²` と推測しないでください。[公式ASCII2仕様](https://ds.iris.edu/ds/nodes/dmc/data/formats/simple-ascii/)でも数値形式と単位は別のフィールドです。

EarthScopeは **2026年8月26日** に `irisws-timeseries` を廃止しました。旧URLの再試行やホスト名の置き換えでは復旧しません。公式の移行先は、FDSNで取得したraw miniSEEDをObsPyなどで処理する方法です。`timeseriesplot` は画像用で、解析用加速度データの代替ではありません。[公式廃止案内](https://www.earthscope.org/news/retirement-of-the-irisws-timeseries-web-service/)

本アプリはこの取得・変換をブラウザ内で実装しています。通常の自動取得にPythonやObsPyは不要です。観測サイトとの通信とWeb Workerを利用するため、HTTP/HTTPSで配信したアプリを開いてください。

## 観測サイトから取得する

1. 検索結果から地震を選び、`波形ビューア` を開きます。
2. データセンターと検索半径を選んで `観測点を検索` を押します。
3. 観測点・成分を選び、`取得して表示` を押します。
4. 単位・UTC開始日時・補正内容・取得元の注意事項を確認し、必要な表示区間を指定します。
5. `応答スペクトル作成` で計算し、必要に応じて結果CSVを保存します。

### 気象庁の公開強震記録

気象庁の[主な地震の公開一覧](https://www.data.jma.go.jp/eqev/data/kyoshin/jishin/index.html)を取得し、選択した地震の発生時刻を日本時間へ換算して照合します。近い時刻に候補が複数ある場合や、公開対象に含まれない地震は自動選択しません。震央の位置がページにある場合は、選択した地震との位置の整合性も確認します。

観測点は公式ページにあるCSVリンクから抽出します。検索半径は掲載された震央距離に適用し、NS（南北）・EW（東西）・UD（上下）を選択できます。CSVは[気象庁の形式](https://www.data.jma.go.jp/eqev/data/kyoshin/jishin/format.html)に従ってヘッダーの周波数・単位・開始時刻・成分を検証します。Shift_JISの日本語、末尾の空列、旧記録の2桁年にも対応し、2桁年は照合済みの地震の年から確定します。

値はヘッダーにある `gal(cm/s/s)` を根拠に加速度として利用します。公開加速度へ追加の計器補正は行いません。記録全体を取得し、開始時刻をJSTからUTCへ換算します。気象庁の記録にはFDSN用の周波数テーパー設定を適用しません。

公開ページに時刻精度異常・不良箇所などの注意がある場合は画面へ表示し、処理記録にも残します。注意事項が特定の自治体や観測点だけを対象とする場合もあるため、該当する記録を公式ページで確認してください。取得上限は20 MiB、50万点、1000 Hzです。欠測値や不正な数値は計算へ渡しません。

### FDSNのraw波形と計器情報

選択したデータセンターの `fdsnws/dataselect/1/query` からraw miniSEED 2を、`fdsnws/station/1/query?level=response` から同じ観測点・時刻の全応答段を含むStationXMLを取得します。標準の期間は地震発生60秒前から、マグニチュードに応じて発生後5〜12分までです。配信元が返すminiSEEDレコード境界のため、実際の記録開始・終了は指定期間と少し異なる場合があります。

復号後は観測点・成分・サンプリング周波数・レコードの連続性を検証します。隣接レコードの時刻だけでなく先頭からの累積時刻も検査し、欠測や重複を自動で補間・切り詰めしません。記録全体を覆う応答epochを1つだけ選び、応答段の単位の接続、利得、間引き後の周波数、総合感度との整合性を確認します。

対応する応答段はPolesZeros、デジタルCoefficients、FIRです。全段を周波数領域で評価し、速度計・変位計の場合も周波数に応じた変換を含めてSI加速度（m/s²）を計算します。補正計算はWeb Workerで実行し、結果を100倍してgalへそろえます。

補正前に平均を除去し、時間テーパーを合計5%（両端各2.5%）へ適用します。周波数テーパーは、サンプル周波数を `fs` とすると既定で `0.02 / 0.05 / 0.3fs / 0.4fs Hz` です。`補正の詳細設定` で `f1, f2, f3, f4` を変更できます。条件は `0 < f1 < f2 < f3 < f4 ≤ fs/2` で、f2〜f3を通し、f1未満とf4超を除きます。water levelによる応答の底上げは行いません。

この自動設定は共通の開始設定であり、すべての機器・記録に適した帯域を保証するものではありません。通過帯域と端部の過渡応答を確認し、必要に応じて4周波数を変更して取得し直してください。応答スペクトルの周期は、通常の `max(0.02秒, 10Δt)` に加えて通過帯域の `1/f3〜1/f2` とアプリの上限10秒で制限します。

次の場合は処理を停止します。

- 異なる観測点・成分の混在、欠測・重複・累積時刻の不整合、レコード破損、非有限値。
- 全波形を覆う応答epochが一意でない、または波形とStationXMLの周波数が一致しない場合。
- 感度だけで全応答段がない、多項式応答や未対応形式、応答段の番号・単位・周波数の接続が不正な場合。
- 地動以外・不明な入力単位、COUNTS以外の出力、全応答段から求めた感度と総合感度の相対差が5%を超える場合。
- 自動取得した波形が50万点・1000 Hzを超える場合。通信時のサイズ上限は波形24 MiB、StationXML 8 MiBです。

### 接続制限と確認範囲

観測点の検索結果は波形の存在を保証しません。データが未公開の期間、認証を要するデータ、配信元がブラウザからの取得を許可しない場合（CORS制限）は自動取得できません。本アプリは公開データが対象で、認証情報を入力する機能や制限を迂回する中継サーバーはありません。

2026年10月3日に、2011年東北地方太平洋沖地震について次の2例を、観測点検索から直接取得・加速度表示・減衰5%の応答スペクトルまでブラウザで確認しました。いずれもファイルの事前準備は行っていません。

| 取得元・観測点 | 波形 | 最大加速度 |
| --- | --- | ---: |
| 気象庁・石巻市大瓜 NS | 36,000点、100 Hz | 約537.7 gal |
| EarthScope・IU.MAJO.20.HN1 | 78,000点、100 Hz、StationXMLから補正 | 約8.44 gal |

EarthScope・GEOFON・GeoNetの代表的なStationXMLについては、全応答段の計算と加速度補正をObsPy/evalrespとも数値比較しています。この数値比較は計算処理の検証であり、すべての配信元のブラウザ接続や、すべての記録を取得できるという意味ではありません。

GeoNetのFDSNは確認時にCORS許可がなく、ブラウザからの直接取得に制約があります。また、検証に使ったGeoNetの一部のraw記録は累積時刻の整合性検査で拒否されます。別の処理系で読める記録でも、本アプリが定間隔の連続波形として扱えるとは限りません。

### 取得・処理記録

スペクトルCSVには取得URL、元形式、単位・換算係数、観測点・UTC時刻、元ヘッダー、補正を実行したかを保存します。FDSNでは応答URL、全応答段による補正方法、応答epoch、フィルタなどを `processing` に残します。気象庁では公式ページ・CSVのURL、選択成分、元の単位表記、JSTからの時刻変換、品質注意事項を保存します。

処理記録は計算の由来を追跡する情報です。公開メタデータの正しさや実機の校正を保証する証明ではありません。

## アプリの加速度単位換算

FDSNでは応答補正後のm/s²、気象庁ではヘッダーで確認したgalを利用します。任意のASCII2ファイルを読み込む場合は、ヘッダーで確認できた次の加速度単位をGalにそろえます。下表の係数は、入力値へ乗じる値です。

| 入力単位 | Galへの係数 |
| --- | ---: |
| Gal、cm/s² | 1 |
| m/s² | 100 |
| mm/s² | 0.1 |
| µm/s² | 0.0001 |
| nm/s² | 0.0000001 |
| g | 980.665 |
| mg | 0.980665 |
| µg | 0.000980665 |

ここでgは標準重力加速度 `9.80665 m/s²`、mg・µgはその千分の一・百万分の一を表し、質量単位ではありません。Galは `0.01 m/s²` です。[NISTの公式換算表](https://www.nist.gov/pml/special-publication-811/nist-guide-si-appendix-b-conversion-factors/nist-guide-si-appendix-b9)の定義とSI接頭語から上表を算出しています。速度・変位・COUNTS・不明な単位を、この係数だけで加速度にはできません。

## Scaleは応答補正の代わりにならない

FDSNのチャネル情報には次の欄があります。

| 欄 | 意味 |
| --- | --- |
| `Scale` | 機器全体の感度。StationXMLの`InstrumentSensitivity`に相当 |
| `ScaleFrequency` | その感度が定義される周波数（Hz） |
| `ScaleUnits` | 感度を適用した後の物理単位。raw記録の単位を示す欄ではない |

これらの定義は[FDSN station仕様1.1](https://doi.org/10.7914/8kk4-wr41)に従います。例えば`ScaleUnits=M/S`なら、感度に対応する物理量は速度です。COUNTSをScaleで割るだけでは、全周波数での機器応答を除去した加速度にはなりません。`level=response`の全応答段と、対象時刻に有効なメタデータを使います。

**応答補正済みの値を、再びScaleで割ったり、rawとして応答除去したりしないでください。** 二重補正で振幅が誤ります。補正済みのm/s²をGalへ100倍する操作は単位換算であり、機器応答の補正とは別です。FDSNの自動取得処理も、以下の任意のCLIも、入力は未補正のraw miniSEEDです。

## 任意: 手元のファイルをObsPyで変換する

以下は外部で波形ファイルを作成・保管したい場合の手順です。アプリの `取得して表示` には必要ありません。作成した単位付きASCII2は `手元の加速度ファイルも利用できます` から読み込めます。

### 1. 同じチャネル・時刻のraw波形と応答を保存する

NSLCは `Network.Station.Location.Channel` です。時刻はUTCで指定します。以下は取得方法を示す例です。解析対象に合わせてNSLCと期間を置き換え、開始・終了に十分な余裕を持たせてください。

```sh
curl --fail --location --get \
  'https://service.earthscope.org/fdsnws/dataselect/1/query' \
  --data-urlencode 'net=IU' --data-urlencode 'sta=ANMO' \
  --data-urlencode 'loc=00' --data-urlencode 'cha=BHZ' \
  --data-urlencode 'starttime=2010-02-27T06:30:00' \
  --data-urlencode 'endtime=2010-02-27T06:35:00' \
  --data-urlencode 'format=miniseed' --data-urlencode 'nodata=404' \
  --output raw.mseed

curl --fail --location --get \
  'https://service.earthscope.org/fdsnws/station/1/query' \
  --data-urlencode 'net=IU' --data-urlencode 'sta=ANMO' \
  --data-urlencode 'loc=00' --data-urlencode 'cha=BHZ' \
  --data-urlencode 'starttime=2010-02-27T06:30:00' \
  --data-urlencode 'endtime=2010-02-27T06:35:00' \
  --data-urlencode 'level=response' --data-urlencode 'format=xml' \
  --data-urlencode 'nodata=404' --output response.xml
```

空のlocationはFDSNリクエストでは `loc=--`、CLIのIDでは `IU.ANMO..BHZ` のように空欄にします。`level=response` は全応答段を含むStationXMLの指定です。取得期間に応答変更がある場合、複数のepochが返ることがあります。[dataselect公式仕様](https://service.earthscope.org/fdsnws/dataselect/1/)・[station公式仕様](https://service.earthscope.org/fdsnws/station/1/)

`scale=AUTO` や感度定数での除算だけでは、周波数に依存する応答補正を代用できません。このCLIにはScaleオプションがありません。raw波形、元のStationXML、ダウンロードURL・取得日時を一緒に保管してください。

### 2. ObsPyをローカル環境へ準備する

PythonとObsPyはこの変換を行う場合のみ必要です。GitHub Pagesやブラウザー実行の依存には追加されません。

```sh
python3 -m venv .venv-waveform
. .venv-waveform/bin/activate
python -m pip install obspy
python scripts/prepare_waveform.py --help
```

[ObsPy公式インストール案内](https://docs.obspy.org/installation.html)を参照してください。実際のバージョンは処理記録に残ります。

### 3. チャネルに適した4周波数を指定して変換する

`--pre-filt F1 F2 F3 F4` は必須です。Hzで `0 < F1 < F2 < F3 < F4 < サンプリング周波数/2` を満たす必要があります。機器の応答が信頼できる帯域、記録時間、ノイズ、解析対象の周期帯から利用者が選びます。全チャネルに安全な既定値はありません。

```sh
# F1_HZ〜F4_HZを、そのチャネルに適した数値として設定してから実行する。
python scripts/prepare_waveform.py raw.mseed response.xml \
  --id IU.ANMO.00.BHZ \
  --pre-filt "$F1_HZ" "$F2_HZ" "$F3_HZ" "$F4_HZ" \
  --output acceleration.txt
```

CLIは `Trace.remove_response(output='ACC', water_level=None, pre_filt=(F1,F2,F3,F4), zero_mean=True, taper=True, taper_fraction=0.05)` を実行します。ObsPyのACC出力は **m/s²** です。平均を除去して端部をテーパー処理し、応答を逆変換します。周波数テーパーはF2〜F3を通し、F1未満とF4超を除きます。`water_level=None` と明示フィルタを使う理由は、観測機器の特性と異なる物理量へ変換するときの不要なスペクトル抑制を避けるためです。[ObsPy応答除去仕様](https://docs.obspy.org/packages/autogen/obspy.core.trace.Trace.remove_response.html)・[ACC出力単位の仕様](https://docs.obspy.org/packages/autogen/obspy.core.inventory.response.Response.get_evalresp_response.html)

次の入力は処理を停止します。

- 指定NSLCのトレースが0本または複数本。ギャップ・重複・分割された区間を自動結合・補間しません。
- 非有限値、欠測マスク、2点未満、非正のサンプリング周波数。
- 波形全体を覆う応答epochが1つに定まらない場合。Network/Station/Channelの有効期間を確認し、epochの境界で分割したファイルを別々に処理してください。
- 応答段の不足、感度だけの応答、非線形多項式応答、サンプリング周波数の不一致。
- 地動以外・不明な入力単位、COUNTS以外の応答出力、応答と感度の入力単位の不一致。ObsPyでの換算が明確な単位表記のみ扱います。

処理が成功しても、帯域選択や観測点・機器・メタデータの妥当性を保証しません。ObsPyの警告は端末と処理記録に保存されます。感度不一致などの警告は、解析に使う前に原因を確認してください。端部の過渡応答を評価し、信頼できる区間・帯域に解析を限定してください。

### 4. 結果と処理記録を保管する

`acceleration.txt` は7フィールドのASCII2ヘッダーとUTC時刻・加速度の2列です。コメント行は追加しません。

```text
TIMESERIES IU.ANMO.00.BHZ.M, 3 samples, 20 sps, 2010-02-27T06:30:00.000000Z, TSPAIR, FLOAT, M/S**2
2010-02-27T06:30:00.000000Z 0.0001
2010-02-27T06:30:00.050000Z 0.0002
2010-02-27T06:30:00.100000Z -0.0001
```

上は形式の例で、実測値ではありません。CLIの数値は固定でm/s²です。別のツールでcm/s²として保存する場合は、m/s²の値を100倍し、ヘッダーも `CM/S**2` に変更する必要があります。単位欄だけを変更してはいけません。`1 m/s² = 100 cm/s² = 100 Gal` です。

同時に作成する `acceleration.txt.processing.json` に、入力・出力のSHA-256、NSLC、時刻・サンプリング周波数、応答epoch、フィルタ、処理オプション、Python/ObsPyバージョン、警告、ObsPy処理履歴を保存します。既存の出力・処理記録は上書きしません。

アプリへはASCII2ファイルを読み込みます。処理記録JSONは自動読込しないため、別途確認・保管してください。スペクトルCSVの `processing` はファイル記録の参照を促す表記となり、`response_correction_requested=false` はアプリ自身がWebサービスに補正を要求していないことを表します（ファイル作成時の補正有無ではありません）。

アプリはインポート時にヘッダーの単位とデータの整合性を確認します。**ヘッダー確認は、応答補正を実行した証明や機器の校正証明ではありません。** JSONも処理の追跡用記録であり、計測の正しさを保証する証明書ではありません。元データと一緒に確認してください。

アプリは日時の整数ミリ秒とASCII2の小数ミリ秒を合わせ、隣接サンプル間隔と先頭からの累積時刻を検証します。記録された時刻の精度が不足する波形や、1000 Hzを超える波形では計算を停止します。1000 Hz以下でも、欠測・重複・宣言サンプリング周波数との不一致がある波形は解析できません。CLIの変換成功は、その記録のブラウザー解析対応を保証するものではありません。

## ローカルテスト

```sh
npm run check
python3 -m unittest discover -s test -p 'test_*.py'
```

JavaScriptのテストは、気象庁の地震照合・CSVの形式検証、miniSEEDの復号・連続性、StationXMLの整合性、ObsPy/evalresp参照値との全応答段・加速度補正の比較を含みます。Node.js 20以上で、同梱のテスト用XMLパーサーを使って実行できます。

任意のCLIの検証処理と出力形式のテストはPython標準ライブラリだけで実行できます。ObsPy導入時は、既知の感度を持つ合成加速度の応答除去とminiSEED/StationXML入出力の統合テストも実行します。未導入時はこの統合テストだけがskipになります。
