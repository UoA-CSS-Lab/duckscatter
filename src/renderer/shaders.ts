/**
 * 散布図レンダリング用WGSLシェーダーコード
 */

/**
 * ビューポート境界とLODに基づいて可視ポイントをフィルタリングするコンピュートシェーダー
 * ワークグループローカルのアトミック操作を使用してグローバルアトミックの競合を軽減
 */
export const filterComputeShader = `
struct Point {
  x: f32,
  y: f32,
  color: u32,
  size: f32,
}

struct FilterUniforms {
  worldBoundsMin: vec2<f32>,
  worldBoundsMax: vec2<f32>,
  lodThreshold: u32,
  totalPoints: u32,
  activeFilterMask: u32,
  whereFilterEnabled: u32,
  filterRangeMin: vec4<f32>,
  filterRangeMax: vec4<f32>,
  filteredDisplayMode: u32, // computeUint32View[16]
  useSizeCutoff: u32,      // computeUint32View[17]（CPU と byte 位置を揃える）
  sizeCutoff: f32,         // computeFloatView[18]（これより大きいサイズは全て残す）
  tieHashThreshold: u32,   // computeUint32View[19]（同サイズだけハッシュで間引く。合計 80 byte）
}

@group(0) @binding(0) var<storage, read> allPoints: array<Point>;
@group(0) @binding(1) var<storage, read_write> visibleIndices: array<u32>;
@group(0) @binding(2) var<storage, read_write> counter: atomic<u32>;
@group(0) @binding(3) var<uniform> uniforms: FilterUniforms;
@group(0) @binding(4) var<storage, read> filterColumns: array<vec4<f32>>;
@group(0) @binding(5) var<storage, read> visibilityFlags: array<u32>;
@group(0) @binding(6) var<storage, read_write> filteredIndices: array<u32>;
@group(0) @binding(7) var<storage, read_write> filteredCounter: atomic<u32>;

var<workgroup> localCount: atomic<u32>;
var<workgroup> localIndices: array<u32, 256>;
var<workgroup> globalOffset: u32;

var<workgroup> localFilteredCount: atomic<u32>;
var<workgroup> localFilteredIndices: array<u32, 256>;
var<workgroup> globalFilteredOffset: u32;

fn pcgHash(input: u32) -> u32 {
    let state = input * 747796405u + 2891336453u;
    let word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
    return (word >> 22u) ^ word;
}

fn isVisibleByWhereFilter(idx: u32) -> bool {
  if (uniforms.whereFilterEnabled == 0u) {
    return true;
  }
  let wordIndex = idx / 32u;
  let bitIndex = idx % 32u;
  let word = visibilityFlags[wordIndex];
  return (word & (1u << bitIndex)) != 0u;
}

@compute @workgroup_size(256)
fn main(
  @builtin(global_invocation_id) globalId: vec3<u32>,
  @builtin(local_invocation_id) localId: vec3<u32>
) {
  let idx = globalId.x;
  let lid = localId.x;

  if (lid == 0u) {
    atomicStore(&localCount, 0u);
    atomicStore(&localFilteredCount, 0u);
  }
  workgroupBarrier();

  var myLocalSlot: u32 = 0xFFFFFFFFu;
  var myLocalFilteredSlot: u32 = 0xFFFFFFFFu;

  if (idx < uniforms.totalPoints) {
    let passesWhere = isVisibleByWhereFilter(idx);

    // 俯瞰のサイズ境界より大きい点は全て残し、同サイズだけ固定ハッシュで間引く。
    // 均一サイズやズームインではサイズを読む前に従来のハッシュで間引ける。
    var passesLOD = true;
    if (uniforms.useSizeCutoff != 0u) {
      let size = allPoints[idx].size;
      passesLOD = size > uniforms.sizeCutoff ||
        (size == uniforms.sizeCutoff && pcgHash(idx) <= uniforms.tieHashThreshold);
    } else {
      let hash = pcgHash(idx);
      passesLOD = uniforms.lodThreshold > 0u && hash <= uniforms.lodThreshold;
    }

    // ビューポート境界チェック（全ポイント共通）
    var passesBounds = false;
    if (passesLOD) {
      let point = allPoints[idx];
      passesBounds = point.x >= uniforms.worldBoundsMin.x && point.x <= uniforms.worldBoundsMax.x &&
                     point.y >= uniforms.worldBoundsMin.y && point.y <= uniforms.worldBoundsMax.y;
    }

    // GPUレンジフィルター（WHERE通過分のみ適用）
    var passesGpuFilter = true;
    if (passesBounds && passesWhere && uniforms.activeFilterMask != 0u) {
      let filterData = filterColumns[idx];

      if ((uniforms.activeFilterMask & 1u) != 0u) {
        passesGpuFilter = passesGpuFilter &&
                    filterData.x >= uniforms.filterRangeMin.x &&
                    filterData.x <= uniforms.filterRangeMax.x;
      }
      if ((uniforms.activeFilterMask & 2u) != 0u) {
        passesGpuFilter = passesGpuFilter &&
                    filterData.y >= uniforms.filterRangeMin.y &&
                    filterData.y <= uniforms.filterRangeMax.y;
      }
      if ((uniforms.activeFilterMask & 4u) != 0u) {
        passesGpuFilter = passesGpuFilter &&
                    filterData.z >= uniforms.filterRangeMin.z &&
                    filterData.z <= uniforms.filterRangeMax.z;
      }
      if ((uniforms.activeFilterMask & 8u) != 0u) {
        passesGpuFilter = passesGpuFilter &&
                    filterData.w >= uniforms.filterRangeMin.w &&
                    filterData.w <= uniforms.filterRangeMax.w;
      }
    }

    let isFullyVisible = passesLOD && passesBounds && passesWhere && passesGpuFilter;
    let isFilteredVisible = passesLOD && passesBounds && (!passesWhere || !passesGpuFilter) && uniforms.filteredDisplayMode == 1u;

    if (isFullyVisible) {
      myLocalSlot = atomicAdd(&localCount, 1u);
      localIndices[myLocalSlot] = idx;
    } else if (isFilteredVisible) {
      myLocalFilteredSlot = atomicAdd(&localFilteredCount, 1u);
      localFilteredIndices[myLocalFilteredSlot] = idx;
    }
  }
  workgroupBarrier();

  // 可視ポイントのフラッシュ
  let count = atomicLoad(&localCount);
  if (lid == 0u && count > 0u) {
    globalOffset = atomicAdd(&counter, count);
  }
  workgroupBarrier();

  if (lid < count) {
    visibleIndices[globalOffset + lid] = localIndices[lid];
  }

  // フィルター済みポイントのフラッシュ
  let filteredCount = atomicLoad(&localFilteredCount);
  if (lid == 0u && filteredCount > 0u) {
    globalFilteredOffset = atomicAdd(&filteredCounter, filteredCount);
  }
  workgroupBarrier();

  if (lid < filteredCount) {
    filteredIndices[globalFilteredOffset + lid] = localFilteredIndices[lid];
  }
}
`;

/**
 * カウンターから間接描画バッファを更新するコンピュートシェーダー
 */
export const updateIndirectShader = `
struct DrawIndexedIndirect {
  indexCount: u32,
  instanceCount: u32,
  firstIndex: u32,
  baseVertex: u32,
  firstInstance: u32,
}

@group(0) @binding(0) var<storage, read> counter: u32;
@group(0) @binding(1) var<storage, read_write> indirect: DrawIndexedIndirect;

@compute @workgroup_size(1)
fn main() {
  indirect.indexCount = 6u;
  indirect.instanceCount = counter;
  indirect.firstIndex = 0u;
  indirect.baseVertex = 0u;
  indirect.firstInstance = 0u;
}
`;

export const scatterVertexShader = `
struct Point {
  x: f32,
  y: f32,
  color: u32,
  size: f32,
}

struct Uniforms {
  viewMatrix: mat4x4<f32>,
  zoomScale: f32,
  viewportWidth: f32,
  viewportHeight: f32,
  pointAlpha: f32,
  pointSizeScale: f32,
  grayedMode: f32,
  // --- per-column soft-edge フェード（gpuWhereConditions.fade）---
  // 2bit/列: bit(2c)=min端をフェード, bit(2c+1)=max端をフェード
  fadeEdgeFlags: u32,
  _fadePad: u32,
  filterRangeMin: vec4<f32>,  // フィルタ下端（= フェード窓の下端）
  filterRangeMax: vec4<f32>,  // フィルタ上端（= フェード窓の上端）
  fadeWidth: vec4<f32>,       // 列ごとの端ランプ幅（0 = フェード無効）
  // --- selection / brushing ---
  selectionColor: vec4<f32>,        // 選択点の色
  selectionUnselectedAlpha: f32,    // 非選択点の alpha 係数（selection 有効時）
  selectionSelectedSizeScale: f32,  // 選択点のサイズ倍率
  selectionHighlight: f32,          // 1=選択点を強調（色+サイズ）, 0=元の色・サイズを保持（dim-only）
  forceSelectionActive: f32,        // 1=選択点が0でも選択 dim を強制（ブラシ操作中など）
  // --- 受動層オーバードロークランプ ---
  renderMode: u32,                  // 0=全描画(従来), 1=受動(dim/gray)のみ, 2=焦点のみ
  recededR: f32,                    // 受動とみなす予約色 RGB（負で無効＝色ベース判定なし）
  recededG: f32,
  recededB: f32,
}

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) color: vec4<f32>,
  @location(1) pointCoord: vec2<f32>,
  @location(2) fadeAlpha: f32,
  @location(3) isReceded: f32,       // 1=受動層（dim/gray）, 0=焦点層
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var<storage, read> allPoints: array<Point>;
@group(0) @binding(2) var<storage, read> visibleIndices: array<u32>;
@group(0) @binding(3) var<storage, read> filterColumns: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read> selectionFlags: array<u32>;
@group(0) @binding(5) var<storage, read> selectionCount: array<u32>;
@group(0) @binding(6) var<storage, read> hoverFlags: array<u32>;

// selection が有効か（1点以上選択されている、または forceSelectionActive で明示的に有効化）。
// 空 selection では通常は強調/減衰しない（空 brush で全点が薄くなるバグを防ぐ）が、
// forceSelectionActive=1 のときはブラシ操作中などとして 0 選択でも dim を有効にする。
fn isSelectionActive() -> bool {
  return selectionCount[0] > 0u || uniforms.forceSelectionActive > 0.5;
}

fn isSelected(pointIdx: u32) -> bool {
  let wordIndex = pointIdx / 32u;
  let bitIndex = pointIdx % 32u;
  return (selectionFlags[wordIndex] & (1u << bitIndex)) != 0u;
}

// hover-mask: ホバー中クラスタのノード（CPU で setHoveredPointIds 済み）。selection とは別 bitset。
// hover は「selection dim を解除する」だけなので、空 bitset（全 0）なら自動的に無効＝ count ゲート不要。
fn isHovered(pointIdx: u32) -> bool {
  let wordIndex = pointIdx / 32u;
  let bitIndex = pointIdx % 32u;
  return (hoverFlags[wordIndex] & (1u << bitIndex)) != 0u;
}

// 1列ぶんの soft-edge フェード係数。width<=0 で 1.0（無効）。
// fadeMin/fadeMax はそれぞれ下端/上端でランプするか。無限端は clamp により自動で 1.0。
fn fadeForColumn(t: f32, lo: f32, hi: f32, width: f32, fadeMin: bool, fadeMax: bool) -> f32 {
  if (width <= 0.0) {
    return 1.0;
  }
  var a: f32 = 1.0;
  if (fadeMin) {
    a = a * clamp((t - lo) / width, 0.0, 1.0);
  }
  if (fadeMax) {
    a = a * clamp((hi - t) / width, 0.0, 1.0);
  }
  return a;
}

// gpuWhereConditions.fade に基づく per-point の alpha フェード係数。
// 各列の値を filterColumns から読み、フィルタ範囲 [min,max] の端でランプする。
// どの列もフェード無し（fadeEdgeFlags==0）なら filterColumns を読まず即 1.0。
fn computeFadeAlpha(pointIdx: u32) -> f32 {
  let flags = uniforms.fadeEdgeFlags;
  if (flags == 0u) {
    return 1.0;
  }
  let fc = filterColumns[pointIdx];
  var a: f32 = 1.0;
  a = a * fadeForColumn(fc.x, uniforms.filterRangeMin.x, uniforms.filterRangeMax.x,
                        uniforms.fadeWidth.x, (flags & 1u) != 0u, (flags & 2u) != 0u);
  a = a * fadeForColumn(fc.y, uniforms.filterRangeMin.y, uniforms.filterRangeMax.y,
                        uniforms.fadeWidth.y, (flags & 4u) != 0u, (flags & 8u) != 0u);
  a = a * fadeForColumn(fc.z, uniforms.filterRangeMin.z, uniforms.filterRangeMax.z,
                        uniforms.fadeWidth.z, (flags & 16u) != 0u, (flags & 32u) != 0u);
  a = a * fadeForColumn(fc.w, uniforms.filterRangeMin.w, uniforms.filterRangeMax.w,
                        uniforms.fadeWidth.w, (flags & 64u) != 0u, (flags & 128u) != 0u);
  return a;
}

fn unpackColor(argb: u32) -> vec4<f32> {
  let a = f32((argb >> 24u) & 0xFFu) / 255.0;
  let r = f32((argb >> 16u) & 0xFFu) / 255.0;
  let g = f32((argb >> 8u) & 0xFFu) / 255.0;
  let b = f32(argb & 0xFFu) / 255.0;
  return vec4<f32>(r, g, b, a);
}

@vertex
fn vertexMain(
  @location(0) quadPosition: vec2<f32>,
  @builtin(instance_index) instanceIdx: u32
) -> VertexOutput {
  var output: VertexOutput;

  let pointIdx = visibleIndices[instanceIdx];
  let point = allPoints[pointIdx];

  let clipPos = uniforms.viewMatrix * vec4<f32>(point.x, point.y, 0.0, 1.0);

  let pixelToClipX = 2.0 / uniforms.viewportWidth;
  let pixelToClipY = 2.0 / uniforms.viewportHeight;
  let zoomScale = uniforms.zoomScale;

  let selectionActive = isSelectionActive();
  let selected = selectionActive && isSelected(pointIdx);
  let hovered = isHovered(pointIdx);

  var effectiveSizeScale = uniforms.pointSizeScale;
  // highlightSelected=true のときだけ選択点を強調する。dim-only（=0）では色もサイズも変えない。
  if (uniforms.grayedMode <= 0.5 && selected && uniforms.selectionHighlight > 0.5) {
    effectiveSizeScale = effectiveSizeScale * uniforms.selectionSelectedSizeScale;
  }

  let scaledSize = point.size * effectiveSizeScale;
  let offsetClip = vec2<f32>(
    quadPosition.x * scaledSize * pixelToClipX * zoomScale,
    quadPosition.y * scaledSize * pixelToClipY * zoomScale
  );

  output.position = clipPos + vec4<f32>(offsetClip, 0.0, 0.0);

  if (uniforms.grayedMode > 0.5) {
    output.color = vec4<f32>(0.6, 0.6, 0.6, 0.35);
    output.isReceded = 1.0; // 時間フィルタ層（grayed）も受動扱い
  } else {
    var color = unpackColor(point.color);
    // 受動判定は選択減衰前の素の色で行う：非選択 dim、または予約色（フィルタ非該当のグレー）一致。
    let isDim = selectionActive && !selected && !hovered;
    // 予約色は厳密値（u8/255 は f32 で正確に往復）なので、しきい値は丸め誤差吸収用に狭く取り、
    // クラスタ配色がグレー近傍に当たる誤検出面を最小化する（±1/255 程度）。
    let isGrayColor = uniforms.recededR >= 0.0 &&
      abs(color.r - uniforms.recededR) < 0.004 &&
      abs(color.g - uniforms.recededG) < 0.004 &&
      abs(color.b - uniforms.recededB) < 0.004;
    output.isReceded = select(0.0, 1.0, isDim || isGrayColor);
    if (selectionActive) {
      if (selected && uniforms.selectionHighlight > 0.5) {
        color = uniforms.selectionColor;
      } else if (!selected && !hovered) {
        // 非選択かつ非ホバーのみ減衰。ホバー中の点は dim を解除して元の色・明度に戻す（＝強調）。
        color = vec4<f32>(color.rgb, color.a * uniforms.selectionUnselectedAlpha);
      }
    }
    output.color = color;
  }

  output.pointCoord = (quadPosition + 1.0) * 0.5;
  output.fadeAlpha = computeFadeAlpha(pointIdx);

  return output;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
  // 受動/焦点パスの振り分け（1=受動のみ, 2=焦点のみ, 0=全描画）。
  if (uniforms.renderMode == 1u && input.isReceded < 0.5) {
    discard;
  }
  if (uniforms.renderMode == 2u && input.isReceded > 0.5) {
    discard;
  }

  let d = input.pointCoord - vec2<f32>(0.5);
  let distSq = dot(d, d);

  if (distSq > 0.25) {
    discard;
  }

  let alpha = smoothstep(0.25, 0.23, distSq);

  return vec4<f32>(input.color.rgb, input.color.a * alpha * uniforms.pointAlpha * input.fadeAlpha);
}
`;

/**
 * 受動層オフスクリーン（premultiplied 累積）を main へ合成するシェーダー。
 * 累積 alpha を maxAlpha で頭打ちにして「密集してもオーバードローで不透明化しない」を実現する。
 * フルスクリーン三角形でオフスクリーンをサンプルし、premultiplied を保ったまま rgb を比例スケール。
 */
export const compositeShader = `
struct CompositeUniforms {
  maxAlpha: f32,
}

@group(0) @binding(0) var<uniform> cu: CompositeUniforms;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var tex: texture_2d<f32>;

struct CompositeOut {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
}

@vertex
fn vertexMain(@builtin(vertex_index) vi: u32) -> CompositeOut {
  // フルスクリーン三角形（3頂点でクリップ空間を覆う）
  var positions = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>( 3.0, -1.0),
    vec2<f32>(-1.0,  3.0)
  );
  let p = positions[vi];
  var out: CompositeOut;
  out.position = vec4<f32>(p, 0.0, 1.0);
  // clip → テクスチャ uv（y 反転）。offscreen と canvas は同じ clip→fb 写像なので画面位置が一致する。
  out.uv = vec2<f32>((p.x + 1.0) * 0.5, (1.0 - p.y) * 0.5);
  return out;
}

@fragment
fn fragmentMain(input: CompositeOut) -> @location(0) vec4<f32> {
  // offscreen は premultiplied 累積（rgb は既に ×a）。累積 a を maxAlpha で頭打ちにし、
  // premultiplied を保つよう rgb を同じ比率でスケールする。
  let c = textureSample(tex, samp, input.uv);
  let a = c.a;
  if (a <= 0.0001) {
    discard;
  }
  let aClamped = min(cu.maxAlpha, a);
  let scale = aClamped / a;
  return vec4<f32>(c.rgb * scale, aClamped);
}
`;

/**
 * データ空間矩形に基づき GPU 常駐 selection bitset（1bit/point）を更新するコンピュートシェーダー。
 * CPU へ読み戻さず render shader から直接参照する。target='filtered-data' のときは
 * whereConditions の visibility bitmap と gpuWhereConditions の range も考慮し、
 * フィルタを通過していない点は brush の内外に関わらず選択対象外とする。
 */
export const brushSelectionShader = `
struct Point {
  x: f32,
  y: f32,
  color: u32,
  size: f32,
}

struct BrushUniforms {
  brushMin: vec2<f32>,
  brushMax: vec2<f32>,
  filterRangeMin: vec4<f32>,
  filterRangeMax: vec4<f32>,
  totalPoints: u32,
  mode: u32,             // 0=replace, 1=add, 2=subtract, 3=toggle
  applyFilter: u32,      // 1=filtered-data（visibility/gpuWhere を考慮）, 0=all-data
  activeFilterMask: u32, // gpuWhere の有効列ビットマスク
  whereFilterEnabled: u32,
  _pad0: u32,
  _pad1: u32,
  _pad2: u32,
}

@group(0) @binding(0) var<storage, read> allPoints: array<Point>;
@group(0) @binding(1) var<storage, read_write> selectionFlags: array<atomic<u32>>;
@group(0) @binding(2) var<uniform> uniforms: BrushUniforms;
@group(0) @binding(3) var<storage, read> filterColumns: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read> visibilityFlags: array<u32>;

// target='filtered-data' のとき、点 idx が現在のフィルタを通過しているか判定する。
fn passesFilter(idx: u32) -> bool {
  if (uniforms.applyFilter == 0u) {
    return true;
  }
  // whereConditions（DuckDB 側）由来の可視ビットマップ
  if (uniforms.whereFilterEnabled != 0u) {
    let word = visibilityFlags[idx / 32u];
    if ((word & (1u << (idx % 32u))) == 0u) {
      return false;
    }
  }
  // gpuWhereConditions（range フィルタ）
  if (uniforms.activeFilterMask != 0u) {
    let fc = filterColumns[idx];
    if ((uniforms.activeFilterMask & 1u) != 0u && (fc.x < uniforms.filterRangeMin.x || fc.x > uniforms.filterRangeMax.x)) { return false; }
    if ((uniforms.activeFilterMask & 2u) != 0u && (fc.y < uniforms.filterRangeMin.y || fc.y > uniforms.filterRangeMax.y)) { return false; }
    if ((uniforms.activeFilterMask & 4u) != 0u && (fc.z < uniforms.filterRangeMin.z || fc.z > uniforms.filterRangeMax.z)) { return false; }
    if ((uniforms.activeFilterMask & 8u) != 0u && (fc.w < uniforms.filterRangeMin.w || fc.w > uniforms.filterRangeMax.w)) { return false; }
  }
  return true;
}

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) globalId: vec3<u32>) {
  let idx = globalId.x;
  if (idx >= uniforms.totalPoints) {
    return;
  }
  let p = allPoints[idx];
  var inside = p.x >= uniforms.brushMin.x && p.x <= uniforms.brushMax.x &&
               p.y >= uniforms.brushMin.y && p.y <= uniforms.brushMax.y;
  if (inside && !passesFilter(idx)) {
    inside = false;
  }
  let wordIndex = idx / 32u;
  let mask = 1u << (idx % 32u);
  // mode ごとの合成。replace は内側を立て・外側を落とす（毎回 bitset を上書き）。
  if (uniforms.mode == 0u) {
    if (inside) { atomicOr(&selectionFlags[wordIndex], mask); }
    else { atomicAnd(&selectionFlags[wordIndex], ~mask); }
  } else if (uniforms.mode == 1u) {
    if (inside) { atomicOr(&selectionFlags[wordIndex], mask); }
  } else if (uniforms.mode == 2u) {
    if (inside) { atomicAnd(&selectionFlags[wordIndex], ~mask); }
  } else if (uniforms.mode == 3u) {
    if (inside) { atomicXor(&selectionFlags[wordIndex], mask); }
  }
}
`;

/**
 * selection bitset の立っている bit 数を GPU 上で集計し selectionCount[0] に書く。
 * render shader はこの値を見て「1点以上選択時のみ」強調/減衰する（空 brush 後に
 * 全点が薄くなるのを防ぐ）。dispatch 前に selectionCount を 0 にリセットしておくこと。
 */
export const countSelectionShader = `
struct CountUniforms {
  wordCount: u32,
  _pad0: u32,
  _pad1: u32,
  _pad2: u32,
}

@group(0) @binding(0) var<storage, read> selectionFlags: array<u32>;
@group(0) @binding(1) var<storage, read_write> selectionCount: atomic<u32>;
@group(0) @binding(2) var<uniform> uniforms: CountUniforms;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) globalId: vec3<u32>) {
  let i = globalId.x;
  if (i >= uniforms.wordCount) {
    return;
  }
  atomicAdd(&selectionCount, countOneBits(selectionFlags[i]));
}
`;
