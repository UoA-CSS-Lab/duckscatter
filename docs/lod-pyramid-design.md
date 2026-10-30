# duckscatter: DuckDB 製 LOD ピラミッド + ビューポートカリング 設計書

> 状態: 過去の設計提案。ピラミッド本体は未実装。Phase 0 の計測基盤は実装済み。
> 目的: deepscatter 相当の「タイル + LOD で可視点だけ描く」高速化を、duckscatter の
> DuckDB-WASM 分析フィルタ（keyword / engagement / cluster / spatial / time、投稿一覧・件数・
> stats・時系列）を**一切犠牲にせず**導入する。

## 現行実装との差分

この文書は採用済み ADR ではなく、提案時点の設計とレビュー記録を保存したもの。以下はコミット `6e55edd`（package version `1.22.0`）との照合結果であり、実装着手前に提案を見直す必要がある。現行の説明は [現行アーキテクチャ](architecture.md) を参照。

- 現行 LOD は、俯瞰ではサイズ順位、ズームインでは PCG ハッシュを使う。本文の PCG のみを前提とした比較や `1.11.0` との互換性の記述を、現在の契約として扱わない。
- compute の storage binding `8` は現在 `lodPriority` が使用している。uniform の slot `17` と `18` も `useSizePriority` と `keepFraction` が使用しており、本文の空き領域の想定は古い。
- 選択点・ホバー強調点・フィルター一致点を LOD から除外する foreground 規則は未実装。
- 今回の設計レビューでは、選択・ホバー強調による点本体の強制描画を採らず、通常の LOD・フィルター判定に従う方針を確認した（[ADR-0003](adr/0003-selection-independent-of-drawing.md)）。本文の foreground 案を再検討する場合は、この判断との差を扱う必要がある。
- 現在の `visiblePointLimit` の既定値は `5_000_000`。読み込み点数の上限や、厳密な描画点数の上限ではない。
- `E:/duckscatter`、`scatterPlotConfig`、`useScatterPlot`、投稿一覧などは提案元の利用アプリの文脈を含む。本リポジトリの構成や一般的な利用契約とは区別する。

以下の本文は提案時点の記録として残す。本文中の「採用」「不変条件」「検証済み」は、現行実装に対する承認や再検証を意味しない。

---

## 0. 結論（先に要点）

- **タイル化と DuckDB 分析は両立する**。実コード上、両者は既に分離レイヤ:
  - DuckDB = 全データに対する分析（フィルタ一致 rowid・色/サイズ・一覧・集計）。フィルタ変更時のみ実行（毎フレームでない）。
  - レンダラ = 毎フレーム描画。**ここだけ**を「全点走査」から「可視点だけ」に変える。
- 骨格は**非破壊**: 重いバッファ（`allPoints` 16B/pt・`filterColumns` 16B/pt・visibility/selection/hover bitset）は **rowid 順のまま据え置き**。追加するのは **index 配列 `binSortedIndices`（値=rowid、(level,tile,rowid) 昇順）＋小さなメタ**のみ。
- 効果の出どころは2つ。**俯瞰** = LOD（浅 level の疎サンプルだけ dispatch）、**ズームイン** = タイルカリング（可視タイルだけ dispatch）。1 つのピラミッド構造で両方を供給する。
- フィルタ忠実 LOD（粗視化しても一致点を消さない）は **DuckDB が一致 rowid を知っている**ことで担保。むしろ DuckDB がある方が正確にできる。

---

## 1. 不変条件（絶対に崩さない）

実コードで検証済み。設計はすべてこれらを保持する。

1. **`rowid == GPU バッファ index == parquet 行順`**。`data-layer.ts` の全クエリが `ORDER BY rowid`（`:225/:304/:378`）。`gpu-layer.ts:1289` に「= rowid = buffer index」コメント。
2. rowid は **dense 0..N-1**（`repository.ts:75` が CREATE TABLE、`data-layer.ts:392` が rowid を直接 bit index 使用）。
3. DuckDB→GPU フィルタは**2経路**: (a) WHERE→DuckDB→**visibility bitset**（rowid 添字, `data-layer.ts:349-408`）、(b) 数値列→**filterColumns**（GPU per-point range, `data-layer.ts:284-343`）。色/サイズは colorSql/sizeSql を DuckDB が rowid 順で materialize し `allPoints[rowid]` の `[x,y,color,size]` 16B に格納。
4. 出力契約: compute が `visibleIndices[counter]` に **rowid** を atomic append（`shaders.ts:128-147`）→ `updateIndirectShader` が `instanceCount=counter`（`:165-185`）→ `drawIndexedIndirect`（`gpu-layer.ts:957`）。vertex は `visibleIndices[instanceIdx]→allPoints[rowid]`（`:306`）。selection/hover は vertex が rowid bitset を直接読む（`:240-251`）。fade は `computeFadeAlpha` が `filterColumns[pointIdx]` を per-visible-point で読む（`:273`）。
5. 毎フレームの実コストは「全点 dispatch そのもの」ではなく **`filterResultValid` ゲート**（`gpu-layer.ts:893`）。pan/zoom/filter で `updateUniforms()`→`filterResultValid=false`（`:739`）→次 `render()` で全点 compute が1回（`:897-904`, `ceil(totalPointCount/256)`）。静止フレームは compute スキップ。**→ LOD の効果は「インタラクション中の compute 再計算コスト」に出る。計測もそこを測る。**

---

## 2. アーキテクチャ概要（非破壊の骨格）

```
[parquet] --ORDER BY rowid--> DuckDB-WASM (全点 materialize, 既存)
   |                                  |
   | (既存) x,y,color,size            | (新規/load時1回) loadLodMetadata()
   v                                  v
allPointsBuffer[rowid] (据え置き)   binSortedIndices[slot]=rowid  ((level,tile,rowid)順)
filterColumns[rowid]    (据え置き)   levelRanges[level]=[start,end)
visibility/selection/hover bitset    tileRanges[tile]={start,count,AABB}
   (すべて rowid 添字・据え置き)
                                      |
   毎フレーム compute (新経路):       v
   CPU: L(z) と 可視タイル を算出 → dispatch する slot 範囲を決定
   GPU: slot→rowid=binSortedIndices[slot] → allPoints/filterColumns/bitset[rowid] を従来どおり評価
        → visibleIndices に rowid を append (出力フォーマット不変)
   描画 (vertex/fragment/selection/hover/fade): 完全に不変
```

毎フレームコストが **O(N)** → **O(Σ_{level≤L(z)} 可視タイルの点数)** になる。

---

## 3. タイル / レベル割り当て（DuckDB, load 時に1回）

### 3.1 方式選定

| 方式 | 概要 | 採否 |
|---|---|---|
| (a) quadtree-overflow（deepscatter/quadfeather 流） | セル毎バジェット B、あふれを子へ。密度適応で俯瞰サンプルが空間均等 | **却下（本線）**: DuckDB-WASM だけで「再帰的にセル点数を数えて子へ押し下げ」を1ラウンドトリップで書くのが重い。将来の密度適応強化 / サイドカー前計算の選択肢として残す |
| (b) 固定多段グリッド + per-cell rank サンプル | world AABB を一様グリッド分割、各点を「自セルで決定的 priority 上位なら浅 level」で**ちょうど1つの level** に割当 | **採用**: 再帰なし・1ラウンドトリップ・各点1 level（複製なし＝binSortedIndices がちょうど N 要素で rowid と 1:1）。priority ハッシュでセル内代表が散り、俯瞰サンプルは実用上十分に均等 |

### 3.2 決定的 priority（再現性・★verify minor 反映）

DuckDB 組込 `hash()` は**使わない**（バージョン間で値が変わり、duckdb-wasm `^1.30` の caret 更新で俯瞰の見え方が変わる）。代わりに **`shaders.ts:49-53` の `pcgHash` と同式の整数ビット演算**を SQL で展開する（例 `rowid*747796405 + 2891336453` 系）。これで PCG フォールバック経路と LOD の代表選抜が同一ハッシュ族になり一貫する。

### 3.3 退化・ゼロ幅処理（★verify major 反映）

正規化は **`spatial-index.ts:91-97` と同一規則**に揃える（`NULLIF`/`1e-9` は使わない。CPU 経路と AABB がズレるため）:

```
denomX = CASE WHEN mxx = mnx THEN 1.0 ELSE mxx - mnx END   -- 幅0なら「幅1」を補う＝spatial-index と同じ
nx = (x - mnx) / denomX
```

可能なら build 時に `spatial-index` が既に算出した `worldBounds` を SQL に bind し、AABB の二重計算と不一致を根絶する。

### 3.4 生成 SQL（概念・1ラウンドトリップ・`ORDER BY rowid` 規約と同居）

`data-layer.ts` に `loadLodMetadata(maxLevel, budget)` を追加し、`loadAllPoints`（`:221`）後・`scatter-plot.ts:104` の initialize で1回呼ぶ。`__lod_level__/__lod_tile__` は parquet に永続せず計算列（再構築容易）。

```sql
WITH bounds AS (SELECT MIN(x) mnx, MAX(x) mxx, MIN(y) mny, MAX(y) mxy FROM parquet_data),
norm AS (
  SELECT rowid, x, y,
    (x-mnx)/(CASE WHEN mxx=mnx THEN 1.0 ELSE mxx-mnx END) AS nx,
    (y-mny)/(CASE WHEN mxy=mny THEN 1.0 ELSE mxy-mny END) AS ny,
    -- pcgHash 同型の決定的 priority（組込 hash 不使用）
    ((CAST(rowid AS UBIGINT)*747796405 + 2891336453) & 4294967295) AS pri
  FROM parquet_data, bounds),
lvl AS (   -- 各 level k のセル内 priority ランク
  SELECT rowid, k,
    LEAST(CAST(nx*(1<<k) AS INT), (1<<k)-1) AS tx,
    LEAST(CAST(ny*(1<<k) AS INT), (1<<k)-1) AS ty,
    ROW_NUMBER() OVER (PARTITION BY k, tx, ty ORDER BY pri) AS rank_in_cell
  FROM norm CROSS JOIN range(0, $Lmax+1) t(k)),
assigned AS (  -- 各点が「セル代表(rank=1)」になる最浅 level を採用。なければ最深 Lmax
  SELECT rowid, MIN(CASE WHEN rank_in_cell=1 THEN k ELSE $Lmax END) AS level
  FROM lvl GROUP BY rowid),
final AS (
  SELECT a.rowid, a.level,
    (l.ty*(1<<a.level) + l.tx) AS tile      -- level 内 row-major（or Morton, §4.4）
  FROM assigned a JOIN lvl l ON l.rowid=a.rowid AND l.k=a.level)
SELECT rowid, level, tile FROM final
ORDER BY level, tile, rowid;                 -- ★この rowid 列がそのまま binSortedIndices
```

per-tile AABB は別集計（近似でなく正本）:
```sql
SELECT level, tile, MIN(x) AS mnx, MIN(y) AS mny, MAX(x) AS mxx, MAX(y) AS mxy, COUNT(*) AS cnt
FROM final GROUP BY level, tile;
```

**パラメータ**: `Lmax = clamp(ceil(log2(sqrt(N))) - 2, 4, 12)`（N=2e5 で ≈6–7、タイル数 4^7=16384）。budget は per-cell 代表数。

### 3.5 大規模時の SQL（★verify minor 反映）

`CROSS JOIN range(0,Lmax+1)` は中間を N×(Lmax+1) 行に膨らませる（Lmax≈7 で 8N）。DuckDB-WASM はシングルスレッド・prepared statement 無し・毎ロード再パースなので、実 N が数百万で `≤500ms` を割りうる。対策（N 閾値で自動切替）:
1. **単一 window 版**: 最深セルで `ROW_NUMBER` を1回だけ計算し `rank→level` を `log4` で閉形式導出（精度わずか低下・高速）。
2. **サイドカー前計算**: Python/quadfeather で (level,tile) を算出し parquet 追加列 / 別 parquet で配布（load 時 SQL ゼロ、(a) 密度適応も可）。**大規模本番の最有力**。欠如時は §3.4 SQL に runtime フォールバック。

### 3.6 生成物（すべて追加のみ・非破壊）

| 名前 | 型 | 内容 |
|---|---|---|
| `binSortedIndices` | `Uint32Array(N)` | 値=rowid、(level,tile,rowid) 昇順。GPU は `allPoints[binSortedIndices[slot]]` で参照 |
| `levelRanges` | `Uint32Array((Lmax+1)*2)` | level→`[start,end)`（binSortedIndices 内）。**level 昇順連続**なので俯瞰は `[0, levelRanges[L*2+1])` の連続範囲で取れる |
| `tileRanges` + `Map<tileKey,{start,count}>` | 配列 | tile→binSortedIndices 範囲。可視タイル dispatch のオフセット |
| `tileAABB` | `Float32Array(K*4)` | tile→`[minX,minY,maxX,maxY]`（非空タイルのみ、K=非空タイル数） |
| `tileLevel` | `Uint32Array(K)` | tile→level |

### 3.7 再構築トリガ（★verify minor 反映）

- **再構築する**: x,y が変わる真のデータ差し替え（initialize / x,y 列が変わる reload）。
- **しない**: ズーム/パン（CPU メタ参照のみ・SQL 非実行）、WHERE 変更（visibility bitset 経路のみ）、range スライダ、selection/hover、**colorSql/sizeSql 変更（x,y 不変＝level/tile は座標のみ依存）**。
- 注意: 既存 `uploadAllPoints` は `countChanged` 時のみ rebind（`gpu-layer.ts:642`）。**同一行数で座標だけ差し替え**だと countChanged=false で再構築されず LOD が陳腐化する。判定を **「count 変化」でなく「x,y 変化（データソース identity / x,y ハッシュ）」**に紐づけた専用メソッドを設ける。再構築完了まで `enablePyramid=0` に倒す過渡安全弁を併用。

---

## 4. GPU バッファ / バインディング / dispatch

### 4.1 ★BLOCKER: WebGPU device limits（最優先・前提修正）

`webgpu-context.ts:65` が `adapter.requestDevice()` を **`requiredLimits` 無し**で呼ぶ。WebGPU 仕様上、device は **default tier** を受け取り `maxStorageBuffersPerShaderStage=8` に固定される（ハードが 10 対応でも `device.limits` は 8 を返す）。→「modern desktop は 10 だから 9 個でも OK」は現コードのままでは成立せず、9 個目で `createBindGroup` が validation error。

**修正**:
```ts
// webgpu-context.ts:65
adapter.requestDevice({
  requiredLimits: {
    maxStorageBuffersPerShaderStage: Math.min(10, adapter.limits.maxStorageBuffersPerShaderStage),
  },
})
```
（adapter 上限以下なら必ず成功。10 未満のハードでは 8 へ自動縮退。）

### 4.2 バインディング戦略（★verify blocker/minor 反映）

`filterBindGroup` は既に **binding 0-7 = 7 storage + 1 uniform**（`gpu-layer.ts:514-523`: allPoints, visibleIndices, counter, computeUniform[uniform], filterColumns, visibilityFlags, filteredIndices, filteredCounter）。

- **`binSortedIndices` 1本だけ追加 → 8 storage（default 上限ちょうど・安全）**。これを Phase 3 本命の最小経路にする。
- foreground 用に selection/hover 等を**この bind group に足すと 9-10+ storage で破綻**。→ **foreground/拡張は「第2 compute パイプライン＋専用 bind group」に分離**する。これは (i) 1 group の storage 上限回避、(ii) `layout:'auto'`（`gpu-layer.ts:236`）の「未参照 binding は entry にできない」問題の構造的回避、の両方を解く。
- 単一パイプラインで進める場合は `binSortedIndices` を WGSL の**全分岐で必ず1回 load** して静的参照を保ち、ビルド後に `getBindGroupLayout` の entry 数を assert する CI チェックを追加（`check-package-files` 隣）。

### 4.3 compute uniform の空きスロット（リサイズ不要）

`computeUniform` は 80B。`_pad1/_pad2/_pad3` = slot **[17][18][19] が空き**（writer は `gpu-layer.ts:861` で [16] 停止）。ここに `enablePyramid:u32 / lodCutoffLevel:u32(=L(z)) / dispatchBase:u32`（または activeRangeCount）を詰める。**`COMPUTE_UNIFORM_SIZE=80` 据え置き**。

### 4.4 dispatch 戦略（★verify major 反映 = Phase 3a の再定義）

`render()` 内の CPU 処理（`gpu-layer.ts:897-904` 置換）。すべて GPU readback 不要:

- **Phase 3a = level-prefix 単一 dispatch（俯瞰削減・最小変更）**:
  - 単一 dispatch だが**幅を `levelRanges[L*2+1]`（= Σ_{k≤L} level k 点数）に絞る**。`binSortedIndices` が level 昇順連続なので、これだけで走査が **O(浅 level 点数)** に落ちる（俯瞰で実効果が出る）。
  - ⚠ 旧設計の「dispatch 幅 N のまま shader 内で level reject」は **O(N) のままで削減しない**（pcgHash と同コスト）。必ず**幅を絞る**こと。
- **Phase 3b = per-tile ビューポートカリング（ズームイン削減・本命）**:
  - CPU で `worldBounds`（`:820-833` 再利用）∩ `tileAABB` を判定し、level≤L(z) かつ可視のタイルの `{start,count}` を収集。
  - **戦略 (ii) 推奨**: 収集した範囲を CPU で連結し「active range ディレクトリ」を小バッファに `writeBuffer` → **1回の `dispatchWorkgroups(ceil(totalActiveSlots/256))`**。各 thread は active range（数十〜数百件）から自分の slot→binSortedIndices slot→rowid を引く。per-tile の多数 `setBindGroup`/`dispatch`（戦略 i）のテール lane 浪費を避ける。
  - 戦略 (i)（タイル毎 dispatch）は正当性リファレンス/初回着地に。戦略 (iii)（GPU indirect cull pre-pass, `dispatchWorkgroupsIndirect` は利用可能）は K が巨大で CPU タイル走査自体が >1ms のときのみ後日検討。
  - tile_key は **Morton**（兄弟が連続→viewport 矩形が少数の連続 run になり active range 数 R を抑える）を推奨。`collectVisibleSlotRanges` は隣接範囲を coalesce すること。

### 4.5 L(z)（ズーム→最大 level）

既存 `calculateLodThreshold()`（`gpu-layer.ts:689`）と同じ density 思想。`visibleAreaFraction=1/zoom^2`（`:708`）を再利用し、「描画見込み点数 ≤ `visiblePointLimit`（既存の予算ノブ `:170`）」を満たす最浅 L を選ぶ。zoom in→viewport 縮小→可視タイル減→L 上昇（詳細増）で単調。`getLodLevel():number` をデバッグ overlay 用に公開（消費側 API は不変）。ピラミッド ON 時 `calculateLodThreshold` は PCG フォールバック専用に温存。

---

## 5. WGSL 変更（`shaders.ts` filterComputeShader, `:9-160`）

- 追加 binding（第2パイプライン側 or 上限内）: `@binding(8) var<storage, read> binSortedIndices: array<u32>;`
- `pcgHash`（`:49-53`）と `passesLOD` ブロック（`:85-88` 等）を**削除**。LOD は「どの slot を dispatch するか」で選ぶ（per-point hash でない）。
- `main()`: `let slot = globalId.x;` を**dispatch slot** とみなす。
  - `enablePyramid==0` → 旧経路（`rowid=slot`、完全後方互換フォールバック）。
  - `==1` → `rowid = binSortedIndices[dispatchBase + slot]`（戦略 i）/ active range マップ（戦略 ii）。
- 以降は**そのまま**: `passesWhere = isVisibleByWhereFilter(rowid)`（visibilityFlags は rowid 添字）/ `allPoints[rowid]` / `passesGpuFilter(filterColumns[rowid])`。出力は **rowid** を既存の workgroup-local atomic flush（`:138-158`）で append → vertex 段は不変。

---

## 6. 既存機能互換 + フィルタ忠実 foreground（★verify が裁定）

### 6.1 foreground は「新 bitset 不要」方式を本線にする

design 案の対立を verify が裁定: **専用 foreground bitset + lodLevelBuffer は作らない**。フィルタ一致点は compute 内で `passesWhere && passesGpuFilter` により**既に判定済み**なので:

```
accept = (passesWhere && passesGpuFilter && passesBounds)
         && (filterActive ? true : passesLevel)     // filterActive 時は粗視化を一致集合に適用しない
         || isSelectedOrHovered(rowid)              // 選択/ホバーは level 無視で常に accept
```
- `filterActive = whereFilterEnabled || activeFilterMask != 0`。
- 追加バッファ・追加 DuckDB 往復ゼロ。rowid 不変条件も無傷（既存 bitset を参照するだけ）。
- selection/hover を accept に含めれば、rowid が visibleIndices に入り、描画段（`:240-251`）の dim/色/サイズが自動で効く（`selectionCount==0` なら描画段で誰も強調しないので無害）。

### 6.2 per-tile dispatch と「画面外の一致点」（★verify minor 反映）

per-tile dispatch（3b）は構造的に**可視タイル外の foreground 点を拾えない**。旧案の「WHERE 有効フレームに binSortedIndices 全域を O(N) sweep する専用 dispatch 追加」は**フィルタ操作中（最も再計算が走る）のカリング利得を相殺する**ので採らない。代わりに:

- **foreground 忠実が必要なフレーム（WHERE/selection/hover 有効）に限り、dispatch 戦略を per-tile から「level-prefix 単一 dispatch（全タイル横断・幅=`levelRanges[Lmax]`）」へ動的フォールバック**。専用 O(N) sweep より無駄が少ない。
- 大量一致時の上限: `foregroundCapLevel = L(z)+Δ`（Δ既定 2、UI から締める）で「極端な俯瞰では深 level の一致点は間引く」2段クランプを用意（既定 Δ=∞ で完全忠実）。

### 6.3 fade / colorSql / sizeSql 互換

- **fade**: `computeFadeAlpha`（`:273`）は `filterColumns[rowid]` を per-visible-point で読むだけ。visibleIndices に入った点は必ず vertex を通るので**自動維持**。foreground 点にも fade はかかる（時間窓端で薄くなる＝意図通り）。
- **colorSql/sizeSql**: `allPoints[rowid]` を一切触らないので per-point のまま。**禁止事項**: level/tile 割当や代表選抜に色の集約（GROUP BY 平均色等）を混ぜない。level/tile は **x,y のみ**から決定。代表サンプル（浅 level）は「実点の疎サブセット（rowid 間引き）」であって色の集約ではない。

---

## 7. メモリと N 上限 / 自動フォールバック（★verify major 反映）

- `binSortedIndices = u32×N`。N=2e5（web UI 既定）で 0.8MB（無問題）だが、**10M 点で 40MB**（目安 ~10MB 超過）。
- ⚠ **`totalPointCount ≠ visiblePointLimit`**。`loadAllPoints` は**全点** materialize、`visiblePointLimit`（`scatterPlotConfig.ts:34`=200000）は描画上限であって点数上限ではない。実 N は parquet 行数次第。
- **対策**:
  1. 真のカリング有効化の N 上限を明示（例 **N≤2.5M=10MB**）。超過時は `enablePyramid=0`（PCG）へ**自動縮退**（§8 ランタイムフラグに安全弁）。
  2. 中間段として「`lodKey`（4B/点）のみ常駐＋単一 dispatch（走査 O(N) 据置だが描画削減）」を用意。
  3. メモリ見積りは**実 parquet 行数ベース**で統一。

---

## 8. フィーチャフラグ（3層・既定すべて OFF＝既存 PCG 経路が default-safe）

- **(A) 公開 API**: `ScatterPlotOptions.lod?: { mode: 'pcg' | 'pyramid'; budget?: number; foreground?: boolean }`（既定 `mode:'pcg'`）。唯一の新規公開フィールド。未指定なら 1.11.0 と完全同一。
- **(B) ランタイム GPU フラグ**: compute uniform 内 `enablePyramid:u32`。1フレーム単位で PCG↔pyramid 切替（A/B 計測・フォールバック）。**LOD メタ未生成 / N 超過 / 再構築中は強制 0**。
- **(C) 内部 dispatch 戦略 const**: 3a（level-prefix 単一）/ 3b（per-tile）の計測比較用。収束後に削除。
- 優先順位: A=pyramid かつ メタ生成成功 かつ N≤上限 → B=1。それ以外 B=0。foreground は `A.foreground && B==1` のみ。

---

## 9. Phase 分割と受け入れ基準（検証で修正済み・各 Phase 単体で merge/publish/後退可能）

| Phase | 内容 | 受け入れ基準 |
|---|---|---|
| **0 計測基盤** | render() に dev-only タイマ（GPU timestamp-query / 無ければ CPU submit 間隔）＋「compute が走ったか」「処理 idx 数」「instanceCount」を debug overlay | 既存挙動ゼロ変更。俯瞰/ズームインの現状値（処理点数・fps・フレーム内訳）をベースライン記録 |
| **1 ピラミッド構築（未配線）** | load 時に (level,tile) 割当 SQL＋メタ組立。GPU 未アップロード | 構築 ≤500ms（実 N でベンチ）。`Σtile.count==N`、binSortedIndices をソートし直すと 0..N-1（漏れ/重複なし）。空/超高密度セルで例外なし |
| **2 GPU バッファ常駐（経路 OFF）** | binSortedIndices アップロード、`enablePyramid=0` 固定 | 画面・選択・フィルタ・fade が 1.11.0 とピクセル/件数一致。メモリ増が想定内 |
| **3 dispatch カリング（opt-in）** | 3a=level-prefix 単一 dispatch（**幅を絞る**）→ 3b=per-tile（戦略 ii） | (1) 俯瞰: 処理点数が PCG 比 同等以下かつ決定論的、(2) ズームイン: 処理点数が「可視タイル点数」オーダー（viewport 数%→処理数%）、(3) インタラクション中 compute 時間が Phase0 比で有意短縮、(4) 全フィルタ/選択/hover/fade が Phase2 と件数一致 |
| **4 foreground 強制** | §6.1/6.2 | 強い WHERE で粗視化しても一致点・選択点・ホバー点が必ず描画（一致 rowid が常に instanceCount 集合に含まれる）。fade が foreground 点でも正しい |
| **5（任意）PCG 撤去 / z-order** | major | 全消費側で pyramid 既定運用が安定後のみ |

> ★ 3a の受け入れから「処理点削減」を外して 3b に紐づける誤認を避けること。ただし**3a を「level-prefix 幅の単一 dispatch」と定義すれば 3a 単体でも俯瞰削減が出る**（タイルカリングは 3b）。

---

## 10. 計測指標（具体）

- フレーム内訳: filter compute / updateIndirect / render の GPU 時間（timestamp-query、無ければ `onSubmittedWorkDone` 間隔）。
- 処理点数: その frame で実 evaluate した idx 数（3a=dispatch 幅、3b=Σ可視タイル点数）。
- 描画点数: instanceCount（既存 counter）。
- fps: pan/zoom 一定速の平均/p95。**俯瞰（fit zoom）** と **ズームイン（viewport≈全域の 2%）** の2シナリオで **PCG vs pyramid を対で**取る。

---

## 11. publish フロー / Web UI 取り込み

duckscatter（`E:/duckscatter`）:
1. PR を `development` 向け → `ci.yaml`（build＋`.github/scripts/check-package-files.mjs` の dist 同梱ガード＋lint＋test）通過。
2. merge 後 `release.yml` を `workflow_dispatch`（patch/minor/major）→ `npm version` が bump＋`v*` タグ push。
3. タグ push で `publish` job（`if startsWith(github.ref,'refs/tags/')`）が npm/GitHub Packages へ publish。
4. versioning: Phase 2/3/4（opt-in・挙動不変 or 追加）= **minor**、Phase 5（PCG 撤去・破壊的）= **major**。

Web UI（`@uoa-css-lab/duckscatter: ^1.11.0` を pin）:
- caret なので minor は `npm update` で取得。opt-in 未設定の間は既存挙動維持。
- 有効化は `scatterPlotConfig` で `lod:{mode:'pyramid', foreground:true}` を ScatterPlot 生成に渡すだけ（useScatterPlot の update/zoom/selection は無改修）。
- publish 前に `files:["dist"]` ＋ `check-package-files` ガードが効いていることを確認（既知の罠、二重担保済み）。

---

## 12. 検証で出た修正一覧（実装時チェックリスト）

| 重大度 | 箇所 | 要点 |
|---|---|---|
| **blocker** | `webgpu-context.ts:65` | `requestDevice` に `requiredLimits.maxStorageBuffersPerShaderStage` を明示。さらに foreground/拡張は**第2 compute パイプライン分離**（binding 上限 + auto-layout 回避）。binSortedIndices 1本（=8 storage）が最小安全経路 |
| **major** | Phase 3a の効果 | 「dispatch 幅 N + shader 内 reject」は O(N) で削減しない。**幅を level-prefix `[0, levelRanges[L])` に絞る** |
| **major** | binSortedIndices メモリ | N≤~2.5M を pyramid 有効化上限に。超過は PCG 自動縮退 or lodKey-only 中間段。`totalPointCount≠visiblePointLimit` を明記 |
| **major** | SQL 退化境界 | 正規化を `spatial-index.ts:91-97` と同一（`CASE WHEN mxx=mnx THEN 1.0`）に。NULLIF/1e-9 不使用。可能なら build 時 bounds を bind |
| minor | DuckDB `hash()` | 組込 hash 不使用、pcgHash 同式のビット演算で決定性確保 |
| minor | 再ビン化トリガ | 「count 変化」でなく「x,y 変化」に紐づけ。color/size 変更では再構築しない。過渡は `enablePyramid=0` |
| minor | CROSS JOIN 行膨張 | 大規模は単一 window 版 / サイドカー前計算へ自動切替。Phase1 を実 N でベンチして閾値確定 |
| minor | `layout:'auto'` | 第2パイプライン分離が最善。単一なら binSortedIndices を全分岐で参照＋entry 数 assert を CI に |
| minor | foreground 全域 sweep | O(N) sweep を足さない。`accept = base && (filterActive?true:passesLevel)` ＋ 画面外一致は level-prefix 単一 dispatch へ動的フォールバック |

---

## 付録: 採用しなかった案（将来の選択肢）

- **quadtree-overflow（密度適応）**: 密度が極端に不均一なデータで (b) の俯瞰代表が密領域に偏る場合に、再帰 CTE か Python/quadfeather サイドカーで導入。
- **z-order ソート（点の物理並べ替え）**: cache locality 向上が主目的。数千万点規模で memory-bound が確認されたら Phase 5 で検討（rowid↔index 置換マップ or parquet 側ソートが必要）。
- **戦略 (iii) GPU indirect cull pre-pass**: K が巨大で CPU タイル走査が >1ms のときのみ。
