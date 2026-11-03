/** ラベルの文字や描画効果が占める、画面座標の矩形。 */
export interface LabelBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 縁取りと影を含めた衝突範囲を求めるための描画設定。 */
export interface LabelPaintExtent {
  strokeWidth: number;
  /** 鋭角の縁取りが伸びる倍率。丸い接合では 1。 */
  miterLimit?: number;
  shadowBlur: number;
  shadowOffsetX: number;
  shadowOffsetY: number;
}

/** 文字の矩形を、縁取り・影・ラベル間の余白の分だけ広げる。 */
export function expandLabelBounds(bounds: LabelBounds, paint: LabelPaintExtent): LabelBounds {
  const stroke = (Math.max(0, paint.strokeWidth) * Math.max(1, paint.miterLimit ?? 1)) / 2;
  // ぼかしの中心付近だけでなく、周囲の薄い影にも保守的な余白を確保する。
  const blur = Math.max(0, paint.shadowBlur) * 2;
  const padding = 2;
  const left = stroke + padding + Math.max(0, blur - paint.shadowOffsetX);
  const right = stroke + padding + Math.max(0, blur + paint.shadowOffsetX);
  const top = stroke + padding + Math.max(0, blur - paint.shadowOffsetY);
  const bottom = stroke + padding + Math.max(0, blur + paint.shadowOffsetY);
  return {
    x: bounds.x - left,
    y: bounds.y - top,
    width: bounds.width + left + right,
    height: bounds.height + top + bottom,
  };
}

interface Entry {
  bounds: LabelBounds;
  centerX: number;
  centerY: number;
  visited: number;
}

/**
 * 採用したラベルを画面上の格子に登録し、近くのラベルだけと衝突判定する。
 * 長い文字列は横切る全セルへ登録する。画面外は切り落とし、文字列長だけでは
 * 格子の登録件数が際限なく増えないようにする。点データの件数には依存しない。
 */
export class LabelCollisionIndex {
  private readonly cellSize = 64;
  private readonly columns: number;
  private readonly cells = new Map<number, Entry[]>();
  private queryId = 0;
  private comparisons = 0;

  constructor(
    private readonly width: number,
    private readonly height: number,
    private readonly minCenterDistance = 0
  ) {
    this.columns = Math.ceil(width / this.cellSize);
  }

  /** 格子による削減効果を検証できるよう、実際に比較した既存ラベル数を数える。 */
  get comparisonCount(): number {
    return this.comparisons;
  }

  /** 巨大な文字矩形でも、格子の数が画面サイズで抑えられていることを検証する。 */
  get cellCount(): number {
    return this.cells.size;
  }

  /** 重なりがなければ登録して true を返す。既存の中心間距離の制約も維持する。 */
  tryInsert(
    bounds: LabelBounds,
    centerX = bounds.x + bounds.width / 2,
    centerY = bounds.y + bounds.height / 2
  ): boolean {
    const right = bounds.x + bounds.width;
    const bottom = bounds.y + bounds.height;
    if (
      bounds.width <= 0 ||
      bounds.height <= 0 ||
      !Number.isFinite(bounds.x) ||
      !Number.isFinite(bounds.y) ||
      !Number.isFinite(right) ||
      !Number.isFinite(bottom) ||
      !Number.isFinite(centerX) ||
      !Number.isFinite(centerY) ||
      right <= 0 ||
      bottom <= 0 ||
      bounds.x >= this.width ||
      bounds.y >= this.height
    ) {
      return false;
    }

    // 中心間距離で衝突する組も必ず共通セルを持つよう、各中心の周囲に最小距離の半分を確保する。
    const radius = this.minCenterDistance / 2;
    const minX = Math.max(0, Math.min(bounds.x, centerX - radius));
    const minY = Math.max(0, Math.min(bounds.y, centerY - radius));
    const maxX = Math.min(this.width, Math.max(right, centerX + radius));
    const maxY = Math.min(this.height, Math.max(bottom, centerY + radius));
    const startColumn = Math.floor(minX / this.cellSize);
    const endColumn = Math.min(this.columns - 1, Math.floor(maxX / this.cellSize));
    const startRow = Math.floor(minY / this.cellSize);
    const endRow = Math.min(
      Math.ceil(this.height / this.cellSize) - 1,
      Math.floor(maxY / this.cellSize)
    );
    const minDistanceSquared = this.minCenterDistance * this.minCenterDistance;
    const queryId = ++this.queryId;

    for (let row = startRow; row <= endRow; row++) {
      for (let column = startColumn; column <= endColumn; column++) {
        const entries = this.cells.get(row * this.columns + column);
        if (!entries) continue;
        for (const entry of entries) {
          // 複数セルにまたがる同じラベルは、候補ごとに一度だけ比較する。
          if (entry.visited === queryId) continue;
          entry.visited = queryId;
          this.comparisons++;
          const other = entry.bounds;
          if (
            bounds.x < other.x + other.width &&
            right > other.x &&
            bounds.y < other.y + other.height &&
            bottom > other.y
          ) {
            return false;
          }
          const dx = centerX - entry.centerX;
          const dy = centerY - entry.centerY;
          if (dx * dx + dy * dy < minDistanceSquared) return false;
        }
      }
    }

    const entry: Entry = { bounds, centerX, centerY, visited: queryId };
    for (let row = startRow; row <= endRow; row++) {
      for (let column = startColumn; column <= endColumn; column++) {
        const key = row * this.columns + column;
        const entries = this.cells.get(key);
        if (entries) entries.push(entry);
        else this.cells.set(key, [entry]);
      }
    }
    return true;
  }
}
