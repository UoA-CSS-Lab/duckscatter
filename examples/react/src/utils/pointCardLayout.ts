import type { PointPosition, ScatterPlotView } from '@uoa-css-lab/duckscatter';

export interface CardSize {
  width: number;
  height: number;
}

export interface PointCardPlacement extends CardSize {
  id: number;
  offsetX: number;
  offsetY: number;
  /** 原点にある点へ向かうしっぽ。点がカード内に入る場合は描かない。 */
  tailPath: string | null;
}

interface PointCardCandidate extends PointPosition {
  size: number;
}

/** 物理ピクセルのキャンバスと DOM の表示寸法を対応させ、CSS ピクセルへ投影する。 */
export function projectPoint(point: PointPosition, view: ScatterPlotView, size: CardSize) {
  const aspect = view.width / view.height;
  return {
    x: (((point.x * view.zoom) / aspect + view.panX + 1) / 2) * size.width,
    y: ((1 - (point.y * view.zoom + view.panY)) / 2) * size.height,
  };
}

/**
 * 停止した画面でカードの採否と点からのオフセットを決める。
 * 操作中はこのオフセットを維持し、優先順位による表示の入れ替わりを抑える。
 */
export function layoutPointCards(
  points: readonly PointCardCandidate[],
  sizes: ReadonlyMap<number, CardSize>,
  view: ScatterPlotView,
  viewport: CardSize
): PointCardPlacement[] {
  const margin = 8;
  const gap = 12;
  const spacing = 4;
  // 描画サイズの降順、同じサイズでは内部 ID（rowid）の昇順で並べる。
  const candidates = [...points].sort((a, b) => b.size - a.size || a.id - b.id);
  const accepted: { left: number; top: number; width: number; height: number }[] = [];
  const placements: PointCardPlacement[] = [];
  for (const point of candidates) {
    const anchor = projectPoint(point, view, viewport);
    const size = sizes.get(point.id);
    if (
      !size ||
      size.width <= 0 ||
      size.height <= 0 ||
      size.width > viewport.width - margin * 2 ||
      size.height > viewport.height - margin * 2 ||
      !Number.isFinite(anchor.x) ||
      !Number.isFinite(anchor.y)
    ) {
      continue;
    }
    const left = Math.max(
      margin,
      Math.min(anchor.x - size.width / 2, viewport.width - margin - size.width)
    );
    const above = anchor.y - gap - size.height;
    const top = Math.max(
      margin,
      Math.min(above >= margin ? above : anchor.y + gap, viewport.height - margin - size.height)
    );
    // 本文の矩形だけでなく、点へ伸びるしっぽの領域も含めて重なりを避ける。
    const bounds = {
      left: Math.min(left, anchor.x),
      top: Math.min(top, anchor.y),
      width: Math.max(left + size.width, anchor.x) - Math.min(left, anchor.x),
      height: Math.max(top + size.height, anchor.y) - Math.min(top, anchor.y),
    };
    if (
      accepted.some(
        (other) =>
          bounds.left < other.left + other.width + spacing &&
          bounds.left + bounds.width + spacing > other.left &&
          bounds.top < other.top + other.height + spacing &&
          bounds.top + bounds.height + spacing > other.top
      )
    ) {
      continue;
    }
    accepted.push(bounds);
    const offsetX = left - anchor.x;
    const offsetY = top - anchor.y;
    placements.push({
      id: point.id,
      offsetX,
      offsetY,
      ...size,
      tailPath: createTailPath(offsetX, offsetY, size),
    });
  }
  return placements;
}

/** 角丸を避けた縁から原点へしっぽを伸ばし、画面端で本文を寄せても点を指し続ける。 */
function createTailPath(x: number, y: number, size: CardSize): string | null {
  const base = (start: number, length: number): [number, number] => {
    const halfWidth = Math.min(8, length / 4);
    const inset = Math.min(12 + halfWidth, length / 2);
    const center = Math.max(start + inset, Math.min(0, start + length - inset));
    return [center - halfWidth, center + halfWidth];
  };
  if (y + size.height < 0 || y > 0) {
    const [left, right] = base(x, size.width);
    // 接合部を本文の内側へ 1 px 重ね、カードの直線の縁をしっぽの根元で隠す。
    const edge = y > 0 ? y + 1 : y + size.height - 1;
    return `M ${left} ${edge} L 0 0 L ${right} ${edge}`;
  }
  if (x + size.width < 0 || x > 0) {
    const [top, bottom] = base(y, size.height);
    const edge = x > 0 ? x + 1 : x + size.width - 1;
    return `M ${edge} ${top} L 0 0 L ${edge} ${bottom}`;
  }
  return null;
}
