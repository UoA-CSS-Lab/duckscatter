/**
 * 四分木ベースの空間インデックス
 * ホバーポイント検出を O(n) の全探索から O(log n) に高速化する
 */

/** 軸平行境界矩形 */
interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** リーフノードの最大ポイント数 */
const NODE_CAPACITY = 64;
/** 四分木の最大深さ */
const MAX_DEPTH = 20;

/**
 * 四分木のノード
 * リーフノード: indices にポイントインデックスを保持
 * 内部ノード: children に4子ノード（NW/NE/SW/SE）を保持
 */
class QuadTreeNode {
  readonly bounds: Bounds;
  children: [QuadTreeNode, QuadTreeNode, QuadTreeNode, QuadTreeNode] | null = null;
  indices: number[] | null;

  constructor(bounds: Bounds) {
    this.bounds = bounds;
    this.indices = [];
  }
}

/**
 * 検索点から境界矩形までの距離の二乗を計算する
 * 検索点が矩形内にある場合は0を返す
 */
function distSqToBounds(bounds: Bounds, x: number, y: number): number {
  let distSq = 0;
  if (x < bounds.minX) {
    const d = bounds.minX - x;
    distSq += d * d;
  } else if (x > bounds.maxX) {
    const d = x - bounds.maxX;
    distSq += d * d;
  }
  if (y < bounds.minY) {
    const d = bounds.minY - y;
    distSq += d * d;
  } else if (y > bounds.maxY) {
    const d = y - bounds.maxY;
    distSq += d * d;
  }
  return distSq;
}

/**
 * ポイント検索用の四分木空間インデックス
 * 全ポイントを格納し、閾値内の最近傍検索を実行する。
 * フィルタリングは呼び出し元が isVisible コールバックで制御する。
 */
class QuadTree {
  private readonly root: QuadTreeNode;
  private readonly xArr: ArrayLike<number>;
  private readonly yArr: ArrayLike<number>;

  constructor(xArr: ArrayLike<number>, yArr: ArrayLike<number>, length: number) {
    this.xArr = xArr;
    this.yArr = yArr;

    // 全ポイントの境界を算出
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < length; i++) {
      const x = xArr[i];
      const y = yArr[i];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }

    // 境界が退化しないようにパディング
    if (minX === maxX) {
      minX -= 1;
      maxX += 1;
    }
    if (minY === maxY) {
      minY -= 1;
      maxY += 1;
    }

    this.root = new QuadTreeNode({ minX, minY, maxX, maxY });

    // 全ポイントを挿入
    for (let i = 0; i < length; i++) {
      this.insert(this.root, i, 0);
    }
  }

  /**
   * ポイントをノードに挿入する
   */
  private insert(node: QuadTreeNode, index: number, depth: number): void {
    // 内部ノードの場合、適切な子ノードに挿入
    if (node.children) {
      const childIndex = this.getChildIndex(node.bounds, this.xArr[index], this.yArr[index]);
      this.insert(node.children[childIndex], index, depth + 1);
      return;
    }

    // リーフノードにポイントを追加
    node.indices!.push(index);

    // 容量超過かつ最大深度未満なら分割
    if (node.indices!.length > NODE_CAPACITY && depth < MAX_DEPTH) {
      this.subdivide(node, depth);
    }
  }

  /**
   * リーフノードを4つの子ノードに分割する
   */
  private subdivide(node: QuadTreeNode, depth: number): void {
    const { minX, minY, maxX, maxY } = node.bounds;
    const midX = (minX + maxX) / 2;
    const midY = (minY + maxY) / 2;

    node.children = [
      new QuadTreeNode({ minX, minY: midY, maxX: midX, maxY }), // NW (左上)
      new QuadTreeNode({ minX: midX, minY: midY, maxX, maxY }), // NE (右上)
      new QuadTreeNode({ minX, minY, maxX: midX, maxY: midY }), // SW (左下)
      new QuadTreeNode({ minX: midX, minY, maxX, maxY: midY }), // SE (右下)
    ];

    // 既存ポイントを子ノードに再配分
    const indices = node.indices!;
    node.indices = null;
    for (let i = 0; i < indices.length; i++) {
      const idx = indices[i];
      const childIndex = this.getChildIndex(node.bounds, this.xArr[idx], this.yArr[idx]);
      this.insert(node.children[childIndex], idx, depth + 1);
    }
  }

  /**
   * ポイントが属する子ノードのインデックスを返す
   * 0=NW, 1=NE, 2=SW, 3=SE
   */
  private getChildIndex(bounds: Bounds, x: number, y: number): number {
    const midX = (bounds.minX + bounds.maxX) / 2;
    const midY = (bounds.minY + bounds.maxY) / 2;
    const east = x >= midX ? 1 : 0;
    const south = y < midY ? 2 : 0;
    return south | east;
  }

  /**
   * 閾値内の最近傍ポイントを検索する
   * @param queryX 検索中心のX座標（ワールド空間）
   * @param queryY 検索中心のY座標（ワールド空間）
   * @param thresholdSq 閾値の二乗（ワールド空間距離²）
   * @param isVisible ポイントが可視かどうかを判定するコールバック
   * @returns 最近傍ポイントのインデックス、見つからない場合は null
   */
  findNearest(
    queryX: number,
    queryY: number,
    thresholdSq: number,
    isVisible: (index: number) => boolean
  ): number | null {
    const result = this.searchNode(this.root, queryX, queryY, thresholdSq, null, isVisible);
    return result.index;
  }

  /**
   * ノードを再帰的に探索して最近傍を見つける
   */
  private searchNode(
    node: QuadTreeNode,
    queryX: number,
    queryY: number,
    bestDistSq: number,
    bestIndex: number | null,
    isVisible: (index: number) => boolean
  ): { index: number | null; distSq: number } {
    // 枝刈り: ノード境界が現在のベスト距離以上なら探索スキップ
    if (distSqToBounds(node.bounds, queryX, queryY) >= bestDistSq) {
      return { index: bestIndex, distSq: bestDistSq };
    }

    // リーフノード: 各ポイントをチェック
    if (node.indices) {
      const indices = node.indices;
      const xArr = this.xArr;
      const yArr = this.yArr;
      for (let i = 0; i < indices.length; i++) {
        const idx = indices[i];
        if (!isVisible(idx)) continue;
        const dx = xArr[idx] - queryX;
        const dy = yArr[idx] - queryY;
        const distSq = dx * dx + dy * dy;
        if (distSq < bestDistSq) {
          bestDistSq = distSq;
          bestIndex = idx;
        }
      }
      return { index: bestIndex, distSq: bestDistSq };
    }

    // 内部ノード: 検索点に近い子ノードから探索
    const children = node.children!;
    const midX = (node.bounds.minX + node.bounds.maxX) / 2;
    const midY = (node.bounds.minY + node.bounds.maxY) / 2;
    const east = queryX >= midX ? 1 : 0;
    const south = queryY < midY ? 2 : 0;
    const firstChild = south | east;

    // 検索点を含む象限を最初に探索
    const order = [firstChild, firstChild ^ 1, firstChild ^ 2, firstChild ^ 3];
    for (let i = 0; i < 4; i++) {
      const result = this.searchNode(
        children[order[i]],
        queryX,
        queryY,
        bestDistSq,
        bestIndex,
        isVisible
      );
      if (result.distSq < bestDistSq) {
        bestDistSq = result.distSq;
        bestIndex = result.index;
      }
    }

    return { index: bestIndex, distSq: bestDistSq };
  }
}

/**
 * フィルタリング対応の空間ポイントインデックス
 * QuadTree をラップし、ビジビリティフラグと GPU フィルターレンジによる
 * フィルタリングを検索時に適用する。
 */
export class SpatialPointIndex {
  private quadTree: QuadTree | null = null;

  /**
   * ポイントデータから空間インデックスを構築する
   * @param xArr X座標配列
   * @param yArr Y座標配列
   * @param length ポイント数
   */
  build(xArr: ArrayLike<number>, yArr: ArrayLike<number>, length: number): void {
    if (length === 0) {
      this.quadTree = null;
      return;
    }
    this.quadTree = new QuadTree(xArr, yArr, length);
  }

  /**
   * 最近傍の可視ポイントを検索する
   * @param queryX ワールド空間のX座標
   * @param queryY ワールド空間のY座標
   * @param thresholdSq 閾値の二乗（ワールド空間距離²）
   * @param visibilityFlags ビジビリティフラグ（WHERE条件用ビットマップ）
   * @param filterColumnData GPUフィルターカラムデータ
   * @param gpuFilterRanges GPUフィルターレンジ配列
   * @returns 最近傍のポイントインデックス、見つからない場合は null
   */
  findNearest(
    queryX: number,
    queryY: number,
    thresholdSq: number,
    visibilityFlags: Uint32Array,
    filterColumnData: Float32Array,
    gpuFilterRanges: { columnIndex: number; min: number; max: number }[]
  ): number | null {
    if (!this.quadTree) return null;

    const checkVisibility = visibilityFlags.length > 0;
    const checkGpuFilter = filterColumnData.length > 0 && gpuFilterRanges.length > 0;

    const isVisible = (index: number): boolean => {
      if (checkVisibility) {
        if ((visibilityFlags[index >> 5] & (1 << (index & 31))) === 0) return false;
      }
      if (checkGpuFilter) {
        const base = index * 4;
        for (const r of gpuFilterRanges) {
          const v = filterColumnData[base + r.columnIndex];
          if (v < r.min || v > r.max) return false;
        }
      }
      return true;
    };

    return this.quadTree.findNearest(queryX, queryY, thresholdSq, isVisible);
  }

  /**
   * インデックスが構築済みかどうか
   */
  isBuilt(): boolean {
    return this.quadTree !== null;
  }

  /**
   * リソースを解放する
   */
  destroy(): void {
    this.quadTree = null;
  }
}
