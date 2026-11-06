# DuckScatter React Example

Vite + React + TypeScript を使った DuckScatter のサンプルです。
同梱データで散布図・ラベル・検索・時間フィルター・ホバー表示を試せます。

点の GPU 処理時間の目標は、60 fps の 1 フレーム分に相当する `1000 / 60` ms（約 16.67 ms）に固定しています。ライブラリの既定値を使い、時間を変更するスライダーは設けません。点の GPU 処理時間から LOD の保持率を自動調整します。CPU のラベル描画は対象外で、60 fps の達成を保証する上限ではありません。perf 表示で目標・保持率・計測時間・計測方法を確認できます。

## 点カード

画面内のフィルター一致点が「点カードの上限」以下になると、各点の位置に記事見出し・公開日を HTML で表示します。初期上限は 100 個、0 で無効です。判定は LOD 前の集合に対して行い、点本体が間引かれている場合もカードを表示します。フィルター不一致点は灰色で描かれていても候補に含めません。

カードは点を指すしっぽ付きの吹き出しにし、点の上に置きます。上端では下へ、左右端では内側へ寄せます。重なる場合は現在の `size` が大きい点を優先し、同じサイズなら `rowid` が小さい点を優先します。パン・ズーム中は既存の配置で追従し、約 150 ms 操作が止まった後に候補と配置を更新します。吹き出しは表示専用とし、ホバー・クリック・ドラッグ・ホイール操作は図へ通します。表示中のカードと重複する点のホバーツールチップは省略します。

`PointCardOverlay` が HTML と配置、`PointCardStore` が変更通知と属性の一括取得を担当します。`getPointsByIds()` で現在の描画式による `__size__` と元の属性をまとめて取得します。値のない項目は省略し、見出し・日付の両方がない点にはカードを出しません。候補 ID が同じ間は取得済み属性を再利用し、サイズなどの属性更新ではキャッシュを破棄します。

## 開発

Node.js 24 を使用します。リポジトリのルートでライブラリをビルドしてから起動してください。

```bash
npm ci
npm run build
cd examples/react
npm ci
npm run dev
```

ブラウザで http://localhost:3000 を開きます。
開発サーバーは devcontainer からアクセスできるよう `0.0.0.0:3000` で待ち受けます。

`src/App.tsx` が画面のエントリーポイント、`src/context/ScatterPlotContext.tsx` が
DuckScatter の初期化と操作を担当します。サンプルデータは `public/` にあります。

## ビルド

```bash
npm run build
npm run preview
```

`build` は型チェックの後、静的ファイルを `dist/` に出力します。
`preview` はビルド結果を http://localhost:3000 でローカル確認するためのコマンドです。
静的ホスティングには `dist/` を配置してください。

## Lint

```bash
npm run lint
```

## ポイントの色

「Point Color」で「Cluster Colors」と「Single Color」を切り替えられます。初期表示はクラスタ色です。

- クラスタ色は、Parquet の `cluster_id` と GeoJSON の `properties.cluster_id`（なければ `properties.cluster`）を対応付け、`properties.color` の RGB を使います。
- ラベルの読み込み時に RGB を ARGB 整数に変換し、DuckDB の `cluster_color` テーブル（`cluster_id BIGINT PRIMARY KEY`、`color INTEGER NOT NULL`）に保存します。描画用の `colorSql` は、このテーブルを参照するサブクエリです。
- ノイズ（`cluster_id = -1`）や対応する色がない点はグレーになります。取得した ARGB 整数は既存の GPU 描画経路へ渡します。
- 単色では色ピッカーを表示します。選んだ単色はモードを切り替えても保持します。

## サンプルデータ

ABC News の英語ニュース見出し 1,244,184 件と、417 個のクラスタラベルを同梱しています。

| ファイル                                      | 内容                                                               |
| --------------------------------------------- | ------------------------------------------------------------------ |
| `public/abcnews-embeddinggemma2-umap.parquet` | EmbeddingGemma 2 の埋め込みを UMAP で 2 次元に投影した見出しデータ |
| `public/abcnews-clusters.geojson`             | クラスタの座標、英語ラベル・説明文、件数、色                       |

Parquet の列は `x` / `y`（座標）、`headline_text`（見出し）、`publish_date`（YYYYMMDD 形式の公開日）、`cluster_id`（クラスタ番号、`-1` はノイズ）です。
検索は `headline_text` を対象とし、一覧に見出しと公開日を表示します。日付フィルターは `publish_date` を UNIX 秒に変換し、UTC の日付を 1 日単位で GPU 上で絞り込みます。
ラベル一覧とホバー表示には `cluster_description` の説明文を表示し、ラベルの検索では名前と説明文の両方を対象にします。
クラスタは 5 次元の UMAP 座標に HDBSCAN を適用して作成したものです。

元データは [A Million News Headlines](https://www.kaggle.com/datasets/therohk/million-headlines) です。データ配布元のライセンス表記は CC0-1.0 です。
埋め込み・座標・クラスタリングの生成条件は、Parquet の `duckscatter_provenance` / `duckscatter_clustering` メタデータに保存されています。
