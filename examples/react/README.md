# DuckScatter React Example

Vite + React + TypeScript を使った DuckScatter のサンプルです。
同梱データで散布図・ラベル・検索・時間フィルター・ホバー表示を試せます。

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

## サンプルデータ

ABC News の英語ニュース見出し 1,244,184 件と、417 個のクラスタラベルを同梱しています。

| ファイル | 内容 |
| --- | --- |
| `public/abcnews-embeddinggemma2-umap.parquet` | EmbeddingGemma 2 の埋め込みを UMAP で 2 次元に投影した見出しデータ |
| `public/abcnews-clusters.geojson` | クラスタの座標、英語ラベル・説明文、件数、色 |

Parquet の列は `x` / `y`（座標）、`headline_text`（見出し）、`publish_date`（YYYYMMDD 形式の公開日）、`cluster_id`（クラスタ番号、`-1` はノイズ）です。
検索は `headline_text` を対象とし、一覧に見出しと公開日を表示します。日付フィルターは `publish_date` を UNIX 秒に変換し、UTC の日付を 1 日単位で GPU 上で絞り込みます。
ラベル一覧には `cluster_description` の説明文を表示し、ラベルの検索では名前と説明文の両方を対象にします。
クラスタは 5 次元の UMAP 座標に HDBSCAN を適用して作成したものです。

元データは [A Million News Headlines](https://www.kaggle.com/datasets/therohk/million-headlines) です。データ配布元のライセンス表記は CC0-1.0 です。
埋め込み・座標・クラスタリングの生成条件は、Parquet の `duckscatter_provenance` / `duckscatter_clustering` メタデータに保存されています。
