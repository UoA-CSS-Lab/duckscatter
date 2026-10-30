# DuckScatter React Example

Vite + React + TypeScript を使った DuckScatter のサンプルです。
散布図・ラベル・検索・時間フィルター・ホバー表示・ファイル読み込みを試せます。

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

## ラベル生成

サンプルのラベル生成手順とデータセットについては、[ルートの README](../../README.md#ラベル生成) を参照してください。
