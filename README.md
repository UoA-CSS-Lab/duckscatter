# duckscatter

[![GitHub license](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/UoA-CSS-Lab/duckscatter/blob/main/LICENSE)
[![npm version](https://img.shields.io/npm/v/@uoa-css-lab/duckscatter.svg?style=flat)](https://www.npmjs.com/package/@uoa-css-lab/duckscatter)
[![CI](https://github.com/UoA-CSS-Lab/duckscatter/actions/workflows/ci.yaml/badge.svg)](https://github.com/UoA-CSS-Lab/duckscatter/actions/workflows/ci.yaml)
[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/UoA-CSS-Lab/duckscatter)

> duckscatterは大規模な散布図を描画するための、TypeScriptライブラリです。

duckscatterは、DuckDB-WASMによるSQLでのデータ処理と、WebGPUによる並列レンダリングを組み合わせます。座標計算済みの数十万〜数百万点の探索を主な対象とし、複雑な条件による絞り込みと、数値範囲を頻繁に変える操作を支えます。性能の対応範囲は、データと端末を揃えた実測で確認します。

* **WebGPUによるレンダリング:** GPUの能力を活用し、ブラウザ上で大規模な散布図を高速に描画します。CanvasやSVGでは扱えきれないような大量のデータポイントであっても、スムーズな操作を実現します。

* **DuckDB-WASMによる高速なデータ分析:** DuckDB-WASMを内蔵しており、標準的なSQLを実行できます。SQLを使って動的に描画データをフィルタリングしたり、点の色やサイズを計算したりすることが可能です。

* **ラベル表示:** データポイントにテキストラベルを表示できます。クラスタリングの結果を可視化する際に、各クラスタの中心や代表点にラベルを表示したり、特定のデータポイントに注釈を付けたりするのに最適です。

## 画面イメージ

<img src="./docs/image.png" alt="screen image" width="600">

## 最小の利用例

点の描画には WebGPU が利用できるブラウザ環境が必要です。DuckDB-WASM の初期化では jsDelivr から Worker / WASM を取得します。

現行の依存宣言では DuckDB-WASM の明示的なインストールも必要です。

```bash
npm install @uoa-css-lab/duckscatter "@duckdb/duckdb-wasm@^1.30.0"
```

```html
<canvas id="scatterplot" width="800" height="600"></canvas>
```

バンドラーを使う TypeScript アプリから初期化します。

```typescript
import { ScatterPlot } from '@uoa-css-lab/duckscatter';

const canvas = document.querySelector<HTMLCanvasElement>('#scatterplot');
if (!canvas) throw new Error('描画先の canvas がありません');

const plot = new ScatterPlot({
  canvas,
  dataUrl: '/points.parquet',
  data: {},
});

// 現行の initialize() は失敗をイベントで通知するため、呼び出す前に購読します。
let initializationFailed = false;
plot.on('error', (error) => {
  console.error(error);
  if (error.severity !== 'warning') initializationFailed = true;
});

await plot.initialize();
if (initializationFailed) {
  await plot.destroy();
  throw new Error('散布図の初期化に失敗しました');
}
plot.render();
```

`/points.parquet` には `x` / `y` を持つデータを配置してください。ローカルファイルを扱う場合は `dataUrl` の代わりに `dataFile: file`（`File` / `ArrayBuffer`）を指定できます。

## データについて

### Parquetファイル

duckscatterは、Parquet形式のデータファイルを読み込みます。以下のカラムが必要です:

| カラム | 型 | 説明 |
|--------|------|------|
| `x` | double | X座標 |
| `y` | double | Y座標 |

その他のカラムはSQLで参照でき、色やサイズの計算に利用できます。

初期化後は行集合と座標を固定し、差し替え時は散布図を作り直します。数値の前提、GPU フィルターの float32 精度、現状の検証不足は [データ契約](./docs/data-contract.md) を参照してください。

### GeoJSONファイル（ラベル用）

ラベルを表示するには、GeoJSON形式のファイルを指定します:

```json
{
  "type": "FeatureCollection",
  "features": [
    {
      "type": "Feature",
      "geometry": {
        "type": "Point",
        "coordinates": [x, y]
      },
      "properties": {
        "cluster_label": "ラベルテキスト"
      }
    }
  ]
}
```

## API

以下は設定項目を示す型の擬似コードです。実行可能な初期化例は「最小の利用例」を参照してください。

```typescript
const plot = new ScatterPlot({
  canvas: HTMLCanvasElement,  // 描画先のcanvas要素
  dataUrl: string,            // ParquetファイルのURL
  data: {
    visiblePointLimit?: number,               // LOD の描画予算（デフォルト: 5,000,000、厳密な上限ではない）
    sizeSql?: string,                         // サイズ計算SQL式（デフォルト: "3"）
    colorSql?: string,                        // 色計算SQL式（ARGB 32bit整数、デフォルト: "0x4D4D4DCC"）
    whereConditions?: WhereCondition[],       // フィルタ条件（CPU側）
    gpuFilterColumns?: string[],              // GPUフィルタリング用カラム名（最大4つ）
    gpuWhereConditions?: GpuWhereCondition[], // GPUフィルター条件
  },
  gpu?: {
    backgroundColor?: Color4f,  // 背景色
    pointAlpha?: number,          // グローバル透明度（0.0-1.0、デフォルト: 1.0）
    pointSizeScale?: number,      // グローバルサイズスケール（デフォルト: 1.0）
  },
  labels?: {
    url?: string,                             // GeoJSONファイルのURL
    fontSize?: number,                        // フォントサイズ（デフォルト: 12）
    filterLambda?: LabelFilterLambda,         // ラベル表示フィルタ（false=非マッチ）
    unmatchedLabelOpacity?: number,           // 非マッチラベルをグレー化せず元色のまま dim（0-1）
    onClick?: (label: Label) => void,         // クリックコールバック
    hoverOutlineOptions?: HoverOutlineOptions, // ホバーアウトライン設定
  },
  interaction?: {
    onPointHover?: PointHoverCallback,   // ポイントホバーコールバック
    onLabelHover?: LabelHoverCallback,   // ラベルホバーコールバック
  },
});

await plot.initialize();
```

主要メソッド:

* `render()`: 描画
* `resize(width, height)`: キャンバスリサイズ
* `setZoom(zoom)` / `getZoom()` / `zoomIn()` / `zoomOut()`: ズーム操作
* `zoomToPoint(newZoom, screenX, screenY)`: 指定座標を中心にズーム
* `setPan(x, y)` / `getPan()` / `pan(dx, dy)`: パン操作
* `resetView()`: ビューリセット
* `update(options)`: オプション更新
* `getLastUpdatePlan()`: 直近の `update()` が DuckDB / GPU / label のどの更新経路を通ったかを取得
* `runQuery(sql)`: カスタムSQLクエリ実行
* `getLabels()`: ラベル全件取得
* `destroy()`: リソース解放

**ポイント表示属性制御:**

* `setPointAlpha(alpha)`: グローバル透明度を設定（0.0-1.0）
* `getPointAlpha()`: 現在のグローバル透明度を取得
* `setPointSizeScale(scale)`: グローバルサイズスケールを設定
* `getPointSizeScale()`: 現在のグローバルサイズスケールを取得

**選択（ブラシ）API:**

GPU 常駐の選択マスク（1 bit/point）を矩形ブラシや ID 指定で操作します（詳細は「ブラシ選択（Selection）」節を参照）。

* `brushSelect(bounds, options?)`: データ空間矩形で選択を更新
* `brushSelectScreenRect(rect, options?)`: キャンバス画面座標（物理px）矩形で選択を更新
* `setSelectedPointIds(ids)`: ポイント ID（rowid）集合で選択を直接設定
* `clearSelection()`: 選択を全クリア
* `setSelectionStyle(style)`: 選択の描画スタイルを更新
* `getSelectionCount()`: 現在の選択数を取得（`Promise<number>`）
* `setBrushActive(active)`: 選択点が0でも選択 dim を強制（ブラシ開始時に背景を即 dim、終了時に `false` へ戻す）

**ホバーマスク（クラスタ強調）API（selection とは独立）:**

選択の dim 表示中に、ホバー中クラスタのノードだけを dim 解除して強調するための GPU 常駐マスク（1 bit/point）。selection とは別バッファで、`getSelectionCount()` / ブラシ / 選択状態を一切汚染しません。

* `setHoveredPointIds(ids)`: ポイント ID（rowid）集合を hover-mask に設定（該当点の selection dim を解除し元の明度へ戻す）
* `clearHover()`: hover-mask を全クリア（selection には影響しない）

**ホバー制御API:**

外部コンポーネントからプログラム的にホバー状態を制御できます。

* `setPointHover(pointId)`: ポイントをホバー状態に（`Promise<boolean>`）
* `clearPointHover()`: ポイントホバー解除
* `getHoveredPoint()`: ホバー中のポイント取得
* `setLabelHover(identifier)`: ラベルをホバー状態に（`boolean`を返す）
* `clearLabelHover()`: ラベルホバー解除
* `getHoveredLabel()`: ホバー中のラベル取得
* `clearAllHover()`: 全ホバー解除

```typescript
// 使用例
await plot.setPointHover(12345);           // rowidでポイントをホバー
plot.setLabelHover({ text: 'Cluster A' }); // テキストでラベルをホバー
plot.setLabelHover({ cluster: 5 });        // クラスタ番号でラベルをホバー
plot.clearAllHover();                      // 全ホバー解除
```

## GPUフィルタリング

GPUフィルタリングを使用すると、数値カラムの範囲フィルタをGPU側で高速に実行できます。データの再フェッチなしにリアルタイムでフィルタリングが可能です。

```typescript
const plot = new ScatterPlot({
  // ...
  data: {
    // GPUフィルタリング用のカラムを指定（最大4つ）
    gpuFilterColumns: ['frequency', 'length'],
    // フィルター条件を指定
    gpuWhereConditions: [
      { column: 'frequency', min: 100, max: 10000 },
      { column: 'length', min: 3 },
    ],
  },
});

// 実行時にフィルター条件を更新
await plot.update({
  data: {
    gpuWhereConditions: [
      { column: 'frequency', min: 500 },
    ],
  },
});
```

**CPUフィルタ（`whereConditions`）との違い:**

| | CPUフィルタ | GPUフィルタ |
|---|---|---|
| **対応演算子** | 数値比較、文字列検索、生SQL | 範囲のみ（min/max） |
| **更新速度** | SQLクエリ再実行が必要 | 即座に反映 |
| **用途** | 複雑な条件、全文検索 | スライダーなどリアルタイム操作 |

### soft-edge フェード（`fade`）

`gpuWhereConditions` の各条件に `fade` を付けると、フィルタ範囲 `[min,max]` の端で
ポイントの不透明度（alpha）を連続的にランプさせられます。範囲外のハードカットは
そのままで、端から内側へ `width` 分だけフェードします。`colorSql` の再評価を伴わず
GPU の uniform 更新のみで反映されるため、フィルタ範囲をスライドさせながら毎フレーム
安価にフェードできます（例: 時間窓スライド時のノードのフェードイン/アウト）。

```typescript
await plot.update({
  data: {
    gpuWhereConditions: [
      {
        column: 'created_at',
        min: t0,
        max: t1,
        fade: { width: dt, edges: 'both' }, // 窓の両端から dt 分フェード
      },
    ],
  },
});
```

* `width`: 端のランプ幅（`column` と同じ単位、`> 0`。`0` 以下でフェード無効）
* `edges`: フェードする端（`'both'`（既定） / `'min'` / `'max'`）。`min`/`max` を省略した
  無限端は自動的にフェード無効。

> `gpuFilterColumns` は最大 4 列です。5 列目以降は無視され、`CONFIG_WARNING` イベントが発火します。

## 更新経路の確認

`update()` の実行後、`getLastUpdatePlan()` でその更新がどの経路を通ったかを確認できます。
UI 操作が DuckDB の再クエリを伴うのか、GPU uniform 更新だけで済んだのかをデバッグできます。

```typescript
await plot.update({ data: { gpuWhereConditions: [{ column: 'frequency', min: 500 }] } });
console.log(plot.getLastUpdatePlan()?.paths);
// ['gpu-filter-uniforms']
```

| 経路 | 意味 |
|---|---|
| `duckdb-all-points` | `sizeSql` / `colorSql` 変更により DuckDB で GPU 用 point buffer を再生成 |
| `duckdb-visibility-flags` | `whereConditions` 変更により DuckDB で visibility bitmap を再生成 |
| `gpu-filter-columns-buffer` | `gpuFilterColumns` 変更により GPU filter column buffer を再アップロード |
| `gpu-filter-uniforms` | `gpuWhereConditions` / `filteredPointDisplayMode` 変更。高頻度操作向け |
| `gpu-render-uniforms` | 背景色・透明度・サイズスケール・`visiblePointLimit` などの更新 |
| `label-layer` | ラベル設定またはラベルデータの更新 |
| `interaction-callbacks` | hover などの callback 更新 |

## ブラシ選択（Selection）

矩形ブラシで点集合を選択し、GPU 常駐の選択マスク（1 bit/point）として保持できます。選択状態は GPU 上のビットセットに直接書き込まれ、CPU へ読み戻さずレンダリングに反映されるため、数百万点規模でも高速です。選択が 1 点以上あるときだけ選択点を強調色で描画し、非選択点を減衰させます（選択が空のときは通常表示のまま）。

```typescript
// データ空間の矩形で選択（既定: mode='replace' / target='filtered-data'）
plot.brushSelect({ minX, maxX, minY, maxY });

// キャンバス画面座標（物理ピクセル）の矩形で選択
plot.brushSelectScreenRect({ x0, y0, x1, y1 }, { mode: 'add', target: 'all-data' });

// ポイント ID（rowid）集合で直接選択
plot.setSelectedPointIds([0, 12, 345]);

// 選択数の取得（GPU からの非同期読み戻し）
const n = await plot.getSelectionCount();

// 選択解除 / スタイル変更
plot.clearSelection();
plot.setSelectionStyle({ selectedColor: { r: 1, g: 0.2, b: 0.2, a: 1 }, unselectedAlpha: 0.15 });

// hover-mask: 選択の dim 中、ホバー中クラスタのノードだけ dim を解除して強調（selection とは独立）
plot.setHoveredPointIds([2, 5, 9]);
plot.clearHover();

// ブラシ操作の開始/終了で「選択 dim」を即時に出す/消す（0 選択でも背景を dim）
plot.setBrushActive(true);   // 右ドラッグ開始時など
plot.setBrushActive(false);  // ジェスチャ終了時
```

**`BrushOptions`:**

* `mode`: 既存選択との合成方法
  * `'replace'`（既定）: ブラシ内を選択し、ブラシ外を解除
  * `'add'`: ブラシ内を選択に追加
  * `'subtract'`: ブラシ内を選択から除外
  * `'toggle'`: ブラシ内の選択状態を反転
* `target`: 選択対象の集合
  * `'filtered-data'`（既定）: 現在の `whereConditions` / `gpuWhereConditions` を通過した点のみ
  * `'all-data'`: フィルタ状態に関係なく全点

**`SelectionStyle`（コンストラクタの `gpu.selection` または `setSelectionStyle` で指定）:**

* `selectedColor`: 選択点の色（既定: 黄系の強調色）
* `unselectedAlpha`: 選択有効時の非選択点の alpha 係数（既定 `0.25`）
* `selectedSizeScale`: 選択点のサイズ倍率（既定 `1.35`、`highlightSelected: true` のときのみ適用）
* `highlightSelected`: 選択点を強調するか（既定 `true`）。`true` で選択点を `selectedColor` に塗り替え `selectedSizeScale` で拡大。`false` にすると選択点は**色もサイズも元のまま**保持し、非選択点の減衰（`unselectedAlpha`）のみ行う（クラスタ配色などを保ったまま「非選択を暗くする」dim-only 表示）

> ポイント ID は Parquet の行順（rowid = ポイントバッファの index）に対応します。

## 型定義

主な型定義:

```typescript
// GPUフィルター条件
interface GpuWhereCondition {
  column: string;  // gpuFilterColumnsで指定したカラム名
  min?: number;    // 最小値（省略時: -Infinity）
  max?: number;    // 最大値（省略時: +Infinity）
  fade?: {         // オプション: 範囲端の soft-edge フェード
    width: number;                       // 端のランプ幅（> 0）
    edges?: 'both' | 'min' | 'max';      // フェードする端（既定 'both'）
  };
}

// ホバーアウトラインオプション
interface HoverOutlineOptions {
  enabled?: boolean;           // 有効化（デフォルト: true）
  color?: string;              // 線色（デフォルト: 白）
  width?: number;              // 線幅（ピクセル、デフォルト: 2）
  minimumHoverSize?: number;   // 最小ホバーサイズ
  outlinedPointAddition?: number;
}

// WHERE条件フィルター
type WhereCondition = NumericFilter | StringFilter | RawSqlFilter;

interface NumericFilter {
  type: 'numeric';
  column: string;
  operator: '>=' | '>' | '<=' | '<';
  value: number;
}

interface StringFilter {
  type: 'string';
  column: string;
  operator: 'contains' | 'equals' | 'startsWith' | 'endsWith';
  value: string;
}

interface RawSqlFilter {
  type: 'raw';
  sql: string;
}
```

## Examples

Vite + React + TypeScript を使ったサンプルアプリです。

### 実行方法

```bash
# ライブラリのビルド（ルートディレクトリで）
npm install
npm run build

# サンプルアプリの実行
cd examples/react
npm install
npm run dev
```

ブラウザで http://localhost:3000 を開きます。

本番用の静的ファイルは `examples/react` で `npm run build` を実行すると `dist/` に生成されます。
`npm run preview` でビルド結果をローカル確認できます。

### サンプルデータ

サンプルでは、GloVe 6B単語ベクトルをUMAPで2次元に投影したデータを使用しています（約40万単語）。

* データセット: https://huggingface.co/datasets/mt0rm0/glove.6B.50d.umap.2d

### ラベル生成

ラベルはDBSCANクラスタリングとOpenAI APIを使って生成できます:

```bash
cd examples/react
export OPENAI_API_KEY="your-api-key"
python scripts/generate_labels.py
```

## 開発者向けドキュメント

設計や変更時の前提は [ドキュメント一覧](./docs/README.md) を参照してください。[用語集](./CONTEXT.md)、[現行アーキテクチャ](./docs/architecture.md)、設計判断を記録した ADR をまとめています。

## ライセンス

このライブラリは [MIT License](./LICENSE) の下でライセンスされています。
