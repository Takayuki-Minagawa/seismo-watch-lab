# 波形の単位とローカルでの応答補正

加速度を解析するには、値の単位と観測機器の応答を確認する必要があります。`COUNTS` はデジタル記録値であり、加速度ではありません。`FLOAT` は数値形式です。`correct=true&units=ACC` という過去のリクエストやファイル名から、実際の値を `m/s²` と推測しないでください。[公式ASCII2仕様](https://ds.iris.edu/ds/nodes/dmc/data/formats/simple-ascii/)でも数値形式と単位は別のフィールドです。

EarthScopeは **2026年8月26日** に `irisws-timeseries` を廃止しました。旧URLの再試行やホスト名の置き換えでは復旧しません。公式の移行先は、FDSNで取得したraw miniSEEDをObsPyなどで処理する方法です。`timeseriesplot` は画像用で、解析用加速度データの代替ではありません。[公式廃止案内](https://www.earthscope.org/news/retirement-of-the-irisws-timeseries-web-service/)

## アプリの加速度単位換算

アプリはヘッダーで確認できた次の加速度単位をGalにそろえます。下表の係数は、入力値へ乗じる値です。

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

**応答補正済みの値を、再びScaleで割ったり、rawとして応答除去したりしないでください。** 二重補正で振幅が誤ります。補正済みのm/s²をGalへ100倍する操作は単位換算であり、機器応答の補正とは別です。このCLIには未補正のraw miniSEEDを渡します。

## 1. 同じチャネル・時刻のraw波形と応答を保存する

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

## 2. ObsPyをローカル環境へ準備する

PythonとObsPyはこの変換を行う場合のみ必要です。GitHub Pagesやブラウザー実行の依存には追加されません。

```sh
python3 -m venv .venv-waveform
. .venv-waveform/bin/activate
python -m pip install obspy
python scripts/prepare_waveform.py --help
```

[ObsPy公式インストール案内](https://docs.obspy.org/installation.html)を参照してください。実際のバージョンは処理記録に残ります。

## 3. チャネルに適した4周波数を指定して変換する

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

## 4. 結果と処理記録を保管する

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
python3 -m unittest discover -s test -p 'test_*.py'
```

検証処理と出力形式のテストはPython標準ライブラリだけで実行できます。ObsPy導入時は、既知の感度を持つ合成加速度の応答除去とminiSEED/StationXML入出力の統合テストも実行します。未導入時はこの統合テストだけがskipになります。
