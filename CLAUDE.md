# 国道走破アプリ（スマホ版） — プロジェクト情報

走った国道を赤で塗る地図を、**スマホの中だけで完結**させる版。通信が要るのは
最初にインストールするときと、データを更新するときだけ。記録は端末の IndexedDB に置き、
PC 版とは CSV の書き出し・読み込みでやり取りする。作者は日本語話者、Windows 環境。

PC 版（`../国道管理v2/`、`kokudo_map.py`）とは**別物として開発する**。PC 版のコードには
手を入れない。PC 版から借りるのは、`cache/derived/` の導出データを `tools/export_data.py` で
書き出すときだけ（`import kokudo_map` して関数を呼ぶ）。

## 環境と制約

- 素の HTML / CSS / JavaScript。**ビルド工程を持たない**（bundler・npm・TypeScript は使わない）。
  ファイルをそのまま配れば動くことを保つ
- 外部ライブラリは `vendor/` に同梱した Leaflet 1.9.4 だけ。CDN は使わない（オフライン前提）
- Python の道具（`tools/`）は標準ライブラリのみ。PC 版と同じ方針
- 出力・コメント・ドキュメントはすべて日本語
- 都道府県・市町村での区間指定は**扱わない**（Overpass の area 切り出しが要るため）。
  区間は `全線` と `A〜B`（交差点名・`名前@km`・`名前@緯度/経度`・`@緯度/経度`）だけ

## ファイル構成

```
index.html           画面（1枚）
app.css              見た目。760px 以下は地図が全画面で、パネルは下から引き出すシート
js/graph.js          計算。RouteGraph（Dijkstra・最近傍）、区間の解釈、走破辺の集合、線の切り分け
js/store.js          IndexedDB の記録と、routes.csv / michinoeki.csv との相互変換
js/app.js            Leaflet と DOM。起動、描画、注記 canvas、ポップアップ、記録タブ、CSV の入出力
sw.js                サービスワーカー。画面とデータを端末に保存してオフラインで動かす
manifest.json        ホーム画面に追加するための情報
icons/               アイコン（tools/make_icons.py が描く）
vendor/              Leaflet 一式（LICENSE.leaflet も）
data/                tools/export_data.py の出力。git に入れる（配信に要る。33MB）
  index.json           路線一覧（番号・延長・範囲）、総延長、名前の区切り、地点の種類の番号
  lines.json           全路線の間引いた線（起動時に全国を描く）
  nodes.json           地図に出す地点 [緯度, 経度, 名前, 種類, [[路線番号, km], ...]]（PC 版と同じ）
  eki.json             道の駅 [緯度, 経度, 名前, 都道府県]
  routes/r{ref}.json   1路線の形状とグラフ。記録のある路線だけ読む
tools/
  export_data.py       PC 版の導出データから data/ を作る
  compare.py           同じ routes.csv を PC 版と JS で解いて辺の集合と km を突き合わせる
  smoke.py             ヘッドレス Edge で起動・記録・削除・再読み込みを通す
  headless.py          DevTools Protocol の最小クライアント（smoke.py が使う）
  make_icons.py        アイコンを描く
docs/仕様.md          画面・操作・データ・計算の仕様
README.md            使う人向け
```

## データ形式（`data/`）

座標は **1e-7 度単位の整数**。PC 版の `node_key()` と同じ丸め（`round((lon+180)*1e7)` から
オフセットを引いたもの）なので、「同じ座標＝同じノード」の突き合わせが JS 側でもそのまま成り立つ。
way は `[x0, y0, dx1, dy1, ...]` の差分列（`Graph.decodeWay`）。lines.json も同じ差分列。

`routes/r{ref}.json`:
```
{ "ref": "17", "km": 679.879, "bounds": [[minLat, minLon], [maxLat, maxLon]],
  "ways": [[x0, y0, dx, dy, ...], ...],      heavy["ways"] と同じ順
  "keep": ["1010011...", ...],                各点を間引きで残すか（Douglas-Peucker の印）
  "bridges": [[ax, ay, bx, by], ...],         形状に無いが導出時に繋いだ辺（隙間の橋渡し）
  "points": [[名前, 緯度, 経度, 種類, km], ...] }  km は丸めていない値（null は距離不明）
```

**points の km は丸めないこと。** PC 版の `match_named_nodes()` は「本町@104.6」の候補を
丸める前の `node_dist` で選ぶ。地図に出す 0.1km 刻みの値を使うと、同名の地点が近くに
2つあるときに選択がずれ、経路が1ノードぶん変わる（実測で 48 路線中 5 路線がずれた）。

## 設計上の重要な判断

### 計算は PC 版の移植で、結果は完全一致させる

`graph.js` は `RouteGraph` / `parse_section` / `match_named_nodes` / `resolve_node_section` /
`route_covered` / `route_features` の移植。**`tools/compare.py` で辺の集合まで一致することを
確かめてある**（2026-09-08、48 路線）。計算方法を変えたら必ず compare を回すこと。

- ノードのキーは `"x,y"` の文字列、辺のキーは `"x,y|x,y"`（(経度, 緯度) の辞書順で並べる）。
  JS の整数は 53 ビットなので PC 版の 64 ビット詰め込みは使えない
- 辺の km はハバーサインを PC 版と同じ式で（`12742 * asin(sqrt(h))`）。JS の Math と
  Python の math で最下位桁がずれうるが、compare では 3 桁まで一致している
- グラフは ways の隣接点 + bridges から組む。`_bridge_gaps()` はやり直さない（結果を持ってくる）
- 走破距離は「走破した辺の集合の和」（`coveredByRef` を路線ごとに Map で持ち、
  `refreshStats()` で全部の和を取る）。重複区間を二重に数えない
- 線の切り分けは `keep` の印を使う（`splitLines`）。境目で形が揺れない

### 記録は端末の中（IndexedDB）

- `records`（keyPath: id, autoIncrement）… {ref, section, date, note}。id の順が routes.csv の行の順
- `eki`（keyPath: key = "県|駅名"）… {pref, name, date, note}。同名の駅が県をまたいで実在する
- 起動時に `navigator.storage.persist()` を頼む。ホーム画面に追加した PWA は Chrome が永続扱いにする
- routes.csv / michinoeki.csv の**形式は PC 版とまったく同じ**（BOM 付き UTF-8・LF・同じ見出し）。
  書き出したものを PC 版の `記録/` に置けばそのまま読める。読み込みは「置き換え」（追記ではない）
- ref は保存時に `Graph.normRef()` で数字だけにする（`R17`・`国道17号` を吸収）

### オフライン（`sw.js`）

- install で画面・Leaflet・index/lines/nodes/eki をまとめて保存。`routes/*.json` は最初に使ったときに保存
- 「全路線を端末に保存」ボタンが `cacheAll` メッセージで残りを全部入れる（25MB）
- 同一オリジンの GET だけ扱う。地図タイル（国土地理院）は素通し。既定の背景は
  オフラインなら「背景なし」、オンラインなら白地図
- **中身を更新したら `CACHE` の名前を上げること。** 上げないと古いものが配られ続ける

### 描画（PC 版から移植）

PC 版の CLAUDE.md にある注意はそのまま当てはまる。特に:

- 線・道の駅は1枚のキャンバス（`featPane` の `featRenderer`）。pane を分けるとクリックが飲み込まれる。
  重ね順は `stackLayers()` で作り直す
- 地図を押したときの判定は `map.on("click")` の1か所でやる。線は `interactive: false` にして
  Leaflet の判定を使わない（線の幅ぶんしか当たらず指には狭い）。近くに描いた地点の印
  （`drawn`、名前を描けなかった地点も含む）があればその地点、無ければ `routesAtPoint()` で
  線（重複区間では全路線）。地点は必ず線の上にあるので、この順でないと線に取られる
- 当たり幅は `(pointer: coarse)` で切り替える。地点は指 24px／マウス 14px、線は 40m 相当を
  画素に換算した値と指 18px／マウス 6px の大きい方（上限 30px）。`?pointer=fine|coarse` で固定できる
- 道の駅の星だけは Leaflet の当たり判定（CircleMarker）。`bubblingMouseEvents: false` で
  map の click に流さない（流すと線のポップアップに置き換わる）
- 交差点名は `labelPane` の canvas に表示範囲ぶんだけ描く。マーカーは使えない（数万地点）
- 路線ごとに `L.polyline`（MultiPolyline）を1本ずつ。`routeLayers` に {done, todo} で持つ
- 1地点に複数の呼び名（`NAME_SEP` 区切り）が付くことがある。区間欄には `split(NAME_SEP)[0]` を書く
- 760px 以下ではパネルがボトムシート（`#side` に peek／half／full のクラス。`setSheet()`）。
  地図は `#side` の下にも広がっているので `invalidateSize()` は要らない。地図に寄せるときは
  `showMap()` で畳んでから `fitVisible()`（シートの高さぶん下に余白）を使う

### 動作確認のしかた

- `python tools/export_data.py` … PC 版から data/ を作り直す（13〜30 秒）
- `python tools/compare.py` … PC 版の routes.csv を両方で解いて突き合わせ（都道府県指定の行は除く）
- `python tools/smoke.py` … http.server + ヘッドレス Edge。起動 → 地図を本物のクリックで
  押す（地点の近く・線の上・道の駅の星、指とマウスの両方の当たり幅）→ 記録追加 → タブ →
  CSV → 道の駅 → 削除 → 再読み込みで記録が残る、まで通す
- `?debug` を付けて開くと進み具合が画面下に出る（スマホには開発者ツールが無い）。
  `?nosw` でサービスワーカーを登録しない。`?pointer=fine|coarse` で当たり幅を固定する
  （このマシンのヘッドレス Edge は `pointer: coarse` を真と申告し、CDP のエミュレーションでは
  変えられない）
- `--dump-dom` は IndexedDB の完了を待たないので使わない。`headless.py` が実時間で待つ
- ヒアドキュメントの中のバックスラッシュはこの環境の Bash ツールで潰れる。
  スクリプトは Write ツールで書く

## 検証状況

- 2026-09-08: 書き出し（459 路線、座標 190 万点、33MB / gzip 13MB）。compare で 48 路線の
  辺の集合と km が PC 版と完全一致。smoke（ヘッドレス Edge、412×915）で、起動 0.8 秒 →
  R116 の端から端を記録（86.1 km、走破率 0.1%）→ 走破記録タブに1件 → routes.csv の形式が
  PC 版と同じ → 道の駅の訪問 → 削除で 0% に戻る → もう一度記録して再読み込みしても残る、
  まで確認
- 2026-09-08: ユーザーが GitHub Pages（公開リポジトリの main を配信）経由でスマホから開き、
  「全路線を端末に保存」のあと機内モードでも地図が開くことを確認した

## 既知の弱点・改善候補

- 背景地図はオンラインのときだけ。ただし機内モードでも白地図が「見える」ことがある。
  国土地理院のタイルは Cache-Control 無し・Last-Modified 付きなので、ブラウザが経験則
  （経過日数の 1 割、数週間）で HTTP キャッシュから返す。オンラインで見た範囲・倍率のタイル
  だけが残り、それ以外は真っ白。アプリ側は関与していない（sw.js は他オリジンを素通し、
  設定の `basemap` は localStorage に残る）。海岸線と県境を同梱して canvas に描けば
  オフラインでも形が分かる（1〜2MB の見込み。未着手）
- 実機では起動とオフライン表示まで確認済み。記録の操作感や、古い端末での重さ
  （lines.json 5MB を L.polyline 459 本で描く）はまだ使い込んでいない
- iOS Safari は IndexedDB を長期間使わないと消すことがある。CSV の書き出しを控えにする
- `nearest()` は座標が一致しないときに線形探索（数万ノード）。線のクリックのたびに走るが
  実測で問題になる速さではない
- 記録の読み込みは全置き換え。追記（マージ）は無い
- データ更新の配布は data/ を git に入れて Pages で配る。更新のたびに 13MB 増える
