import type { ParquetData } from './repository.js';

/** ホバー検索で保持する、点 ID 順の座標配列 */
export interface PointCoordinates {
  xArr: ArrayLike<number>;
  yArr: ArrayLike<number>;
  length: number;
}

/** GPU に渡す行形式のデータと、元バッファから独立して保持する検索用データ */
export interface PackedPoints {
  instanceData: Float32Array;
  coordinates: PointCoordinates;
}

/** 数値列で利用する Arrow の公開インターフェイスの部分集合 */
interface NumericColumn {
  readonly data: readonly {
    readonly length: number;
    readonly offset: number;
    readonly nullCount: number;
    readonly dictionary?: unknown;
    readonly values: unknown;
  }[];
  toArray(): ArrayLike<number | bigint>;
}

interface PointChunk {
  readonly words: Uint32Array;
  readonly positions: Uint16Array;
  readonly sourceWord: number;
}

interface PointLayout {
  readonly buffer: ArrayBuffer;
  readonly byteOffset: number;
  readonly chunks: readonly PointChunk[];
}

// 位置と巡回の長さを 16 ビット整数で持ち、ホットループの配列型を固定する。
// 大きいチャンクは従来の詰め替えに回し、入力サイズに比例する巨大な順序表を作らない。
const MAX_CHUNK_WORDS = 0xffff;
const MAX_CACHED_PLAN_BYTES = 256 * 1024;
const TARGET_FIELD = [0, 1, 3, 2] as const;

/**
 * 列ごとの [x, y, size, color] を、点ごとの [x, y, color, size] に移す巡回順を作る。
 * 順序表は [巡回の長さ, 位置, 位置, ...] を繰り返し、固定位置は省く。
 */
function buildRotationPlan(count: number): Uint16Array {
  const wordCount = count * 4;
  const visited = new Uint32Array(Math.ceil(wordCount / 32));
  const positions: number[] = [];
  for (let start = 0; start < wordCount; start++) {
    if (visited[start >>> 5] & (1 << (start & 31))) continue;
    const header = positions.length;
    positions.push(0);
    let index = start;
    do {
      visited[index >>> 5] |= 1 << (index & 31);
      positions.push(index);
      const field = Math.floor(index / count);
      index = (index - field * count) * 4 + TARGET_FIELD[field];
    } while (index !== start);
    const length = positions.length - header - 1;
    if (length === 1) positions.length = header;
    else positions[header] = length;
  }
  return Uint16Array.from(positions);
}

/** 数値として読み直さず、色を含む 32 ビットのビット列をそのまま巡回させる。 */
function rotateCycles(words: Uint32Array, positions: Uint16Array): void {
  let cursor = 0;
  while (cursor < positions.length) {
    const length = positions[cursor++];
    const end = cursor + length;
    const lastIndex = positions[end - 1];
    let carried = words[lastIndex];
    for (; cursor < end - 1; cursor++) {
      const index = positions[cursor];
      const previous = words[index];
      words[index] = carried;
      carried = previous;
    }
    words[lastIndex] = carried;
    cursor = end;
  }
}

/** 既存の検索用配列が、変更対象の元領域を参照しているか調べる。 */
function sharesBuffer(values: ArrayLike<number>, buffer: ArrayBuffer): boolean {
  return ArrayBuffer.isView(values) && values.buffer === buffer;
}

/**
 * このクエリ専用の Arrow 結果を消費し、GPU 用の行形式にする。
 * 巡回置換が使える場合は結果の元バッファを上書きするため、呼び出し後に列を再利用しない。
 */
export class PointPacker {
  private readonly plans = new Map<number, Uint16Array>();
  private cachedPlanBytes = 0;

  /** 入力を差し替えた時と破棄時に、以前のチャンクサイズ用の順序表を解放する。 */
  clear(): void {
    this.plans.clear();
    this.cachedPlanBytes = 0;
  }

  private getPlan(count: number): Uint16Array {
    const cached = this.plans.get(count);
    if (cached) return cached;
    const plan = buildRotationPlan(count);
    if (this.cachedPlanBytes + plan.byteLength > MAX_CACHED_PLAN_BYTES) this.clear();
    this.plans.set(count, plan);
    this.cachedPlanBytes += plan.byteLength;
    return plan;
  }

  /** 全チャンクの配置を検査してから、元バッファを変更してよい領域を返す。 */
  private findLayout(columns: readonly NumericColumn[], rowCount: number): PointLayout | null {
    if (rowCount === 0) return null;
    const first = columns[0].data[0]?.values;
    if (!(first instanceof Float32Array) || !(first.buffer instanceof ArrayBuffer)) return null;
    const buffer = first.buffer;
    const chunkCount = columns[0].data.length;
    if (columns.some((column) => column.data.length !== chunkCount)) return null;
    const chunks: PointChunk[] = [];
    let rows = 0;
    let previousEnd = first.byteOffset;
    let destination = first.byteOffset;
    for (let index = 0; index < chunkCount; index++) {
      const count = columns[0].data[index].length;
      if (count <= 0 || count * 4 > MAX_CHUNK_WORDS) return null;
      const firstValues = columns[0].data[index].values;
      if (!(firstValues instanceof Float32Array)) return null;
      const offset = firstValues.byteOffset;
      // スライスや結合で領域が重複・逆転している場合は、後続の入力を壊さない従来方式を使う。
      if (offset < previousEnd || destination > offset) return null;
      for (let field = 0; field < 4; field++) {
        const chunk = columns[field].data[index];
        const values = chunk.values;
        const correctType =
          field === 3
            ? values instanceof Int32Array || values instanceof Uint32Array
            : values instanceof Float32Array;
        if (
          !correctType ||
          !ArrayBuffer.isView(values) ||
          chunk.offset !== 0 ||
          chunk.nullCount !== 0 ||
          (chunk.dictionary !== undefined && chunk.dictionary !== null) ||
          chunk.length !== count ||
          values.buffer !== buffer ||
          values.byteOffset !== offset + field * count * 4 ||
          values.byteLength !== count * 4
        ) {
          return null;
        }
      }
      chunks.push({
        words: new Uint32Array(buffer, offset, count * 4),
        positions: this.getPlan(count),
        sourceWord: offset / 4,
      });
      previousEnd = offset + count * 16;
      destination += count * 16;
      rows += count;
    }
    return rows === rowCount ? { buffer, byteOffset: first.byteOffset, chunks } : null;
  }

  pack(data: ParquetData, cachedCoordinates?: PointCoordinates): PackedPoints {
    const columns = ['x', 'y', '__size__', '__color__'].map(
      (name) => data.columnData.get(name) as NumericColumn
    );
    let layout = this.findLayout(columns, data.rowCount);
    // 既に検索に使っている座標が同じバッファを参照する場合は、そのバッファを変更しない。
    if (
      layout &&
      cachedCoordinates &&
      (sharesBuffer(cachedCoordinates.xArr, layout.buffer) ||
        sharesBuffer(cachedCoordinates.yArr, layout.buffer))
    ) {
      layout = null;
    }

    let coordinates = cachedCoordinates;
    if (!coordinates) {
      // 座標は既存の入力契約どおり、JavaScript の number で扱える数値列を使う。
      let xArr = columns[0].toArray() as ArrayLike<number>;
      let yArr = columns[1].toArray() as ArrayLike<number>;
      // 単一チャンクの toArray() は元領域のビューになるため、破壊的な並べ替えから座標を守る。
      if (layout && sharesBuffer(xArr, layout.buffer)) xArr = new Float32Array(xArr);
      if (layout && sharesBuffer(yArr, layout.buffer)) yArr = new Float32Array(yArr);
      coordinates = { xArr, yArr, length: data.rowCount };
    }

    let instanceData: Float32Array;
    if (layout) {
      const chunks = layout.chunks;
      for (let index = 0; index < chunks.length; index++) {
        rotateCycles(chunks[index].words, chunks[index].positions);
      }
      const wholeBuffer = new Uint32Array(
        layout.buffer,
        0,
        Math.floor(layout.buffer.byteLength / 4)
      );
      let destination = layout.byteOffset / 4;
      for (let index = 0; index < chunks.length; index++) {
        const chunk = chunks[index];
        // 検査済みの前方領域へ詰める。copyWithin は同じ領域が重なる場合も正しく移動する。
        if (destination !== chunk.sourceWord) {
          wholeBuffer.copyWithin(
            destination,
            chunk.sourceWord,
            chunk.sourceWord + chunk.words.length
          );
        }
        destination += chunk.words.length;
      }
      instanceData = new Float32Array(layout.buffer, layout.byteOffset, data.rowCount * 4);
    } else {
      // 既存の入力形式も維持する。型や配置が合わない場合だけ、別の行バッファを確保する。
      const sizeArr = columns[2].toArray();
      const colorArr = columns[3].toArray();
      const buffer = new ArrayBuffer(data.rowCount * 16);
      instanceData = new Float32Array(buffer);
      const colorView = new Uint32Array(buffer);
      const { xArr, yArr } = coordinates;
      for (let index = 0; index < data.rowCount; index++) {
        const base = index * 4;
        instanceData[base] = xArr[index];
        instanceData[base + 1] = yArr[index];
        // 64 ビット整数列の BigInt は数値へ変換する。通常の 32 ビット経路では実行しない。
        const color = colorArr[index];
        const size = sizeArr[index];
        colorView[base + 2] = typeof color === 'bigint' ? Number(color) : color;
        instanceData[base + 3] = typeof size === 'bigint' ? Number(size) : size;
      }
    }
    return { instanceData, coordinates };
  }
}
