import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useScatterPlot } from '../context/ScatterPlotContext';
import { PointCardStore } from '../utils/pointCardStore';
import {
  layoutPointCards,
  projectPoint,
  type CardSize,
  type PointCardPlacement,
} from '../utils/pointCardLayout';

interface PointCardOverlayProps {
  onVisiblePointIdsChange: (ids: readonly number[]) => void;
}

/** 点の候補取得をライブラリに任せ、HTML と CSS ピクセルでの配置を example が担当する。 */
export function PointCardOverlay({ onVisiblePointIdsChange }: PointCardOverlayProps) {
  const { plot, state } = useScatterPlot();
  const store = useMemo(() => new PointCardStore(plot), [plot]);
  useLayoutEffect(() => {
    store.configure(state.pointCardLimit);
  }, [store, state.pointCardLimit]);
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const rootRef = useRef<HTMLDivElement>(null);
  const cardRefs = useRef(new Map<number, HTMLElement>());
  const previousVisibleIds = useRef<readonly number[]>([]);
  const [size, setSize] = useState<CardSize>({ width: 0, height: 0 });
  const [placements, setPlacements] = useState<PointCardPlacement[]>([]);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const resize = () => {
      const rect = root.getBoundingClientRect();
      setSize((previous) =>
        previous.width === rect.width && previous.height === rect.height
          ? previous
          : { width: rect.width, height: rect.height }
      );
    };
    const observer = new ResizeObserver(resize);
    observer.observe(root);
    resize();
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    if (!snapshot.layoutView) {
      setPlacements([]);
      return;
    }
    const sizes = new Map<number, CardSize>();
    for (const [id, card] of cardRefs.current) {
      const rect = card.getBoundingClientRect();
      sizes.set(id, { width: rect.width, height: rect.height });
    }
    setPlacements(layoutPointCards(snapshot.points, sizes, snapshot.layoutView, size));
  }, [snapshot.points, snapshot.layoutView, size]);

  const cards = useMemo(() => {
    const placementById = new Map(placements.map((placement) => [placement.id, placement]));
    return snapshot.points.map((point) => {
      const placement = placementById.get(point.id);
      const anchor = snapshot.view ? projectPoint(point, snapshot.view, size) : { x: 0, y: 0 };
      const left = anchor.x + (placement?.offsetX ?? 0);
      const top = anchor.y + (placement?.offsetY ?? 0);
      // 操作中に画面外へ出た点やカードは隠し、停止するまで配置を切り替えない。
      const visible =
        placement !== undefined &&
        anchor.x >= 0 &&
        anchor.x <= size.width &&
        anchor.y >= 0 &&
        anchor.y <= size.height &&
        left >= 0 &&
        left + placement.width <= size.width &&
        top >= 0 &&
        top + placement.height <= size.height;
      return { point, placement, anchor, visible };
    });
  }, [snapshot.points, snapshot.view, placements, size]);

  useLayoutEffect(() => {
    const ids = cards
      .filter((card) => card.visible)
      .map((card) => card.point.id)
      .sort((a, b) => a - b);
    const previous = previousVisibleIds.current;
    if (ids.length !== previous.length || ids.some((id, index) => id !== previous[index])) {
      previousVisibleIds.current = ids;
      onVisiblePointIdsChange(ids);
    }
  }, [cards, onVisiblePointIdsChange]);

  useEffect(() => () => onVisiblePointIdsChange([]), [onVisiblePointIdsChange]);

  return (
    <div ref={rootRef} className="pointer-events-none absolute inset-0 z-10 overflow-hidden">
      {cards.map(({ point, placement, anchor, visible }) => (
        <div
          key={point.id}
          className="absolute"
          style={{ left: anchor.x, top: anchor.y, visibility: visible ? 'visible' : 'hidden' }}
        >
          <article
            ref={(element) => {
              if (element) cardRefs.current.set(point.id, element);
              else cardRefs.current.delete(point.id);
            }}
            className="pointer-events-none absolute select-none overflow-hidden rounded-xl border border-zinc-300 bg-white p-3 text-sm text-zinc-800 shadow-md"
            style={{
              left: placement?.offsetX ?? 0,
              top: placement?.offsetY ?? 0,
              width: Math.max(0, Math.min(280, size.width - 16)),
              maxHeight: Math.max(0, size.height - 16),
            }}
          >
            {point.headline && (
              <h3 className="break-words font-medium leading-5">{point.headline}</h3>
            )}
            {point.publishedDate && (
              <time className="mt-2 block text-xs text-zinc-500 tabular-nums">
                {point.publishedDate}
              </time>
            )}
          </article>
          {placement?.tailPath && (
            <svg
              aria-hidden="true"
              focusable="false"
              className="pointer-events-none absolute left-0 top-0 h-px w-px overflow-visible fill-white stroke-zinc-300"
            >
              <path d={placement.tailPath} strokeWidth={1} strokeLinejoin="round" />
            </svg>
          )}
        </div>
      ))}
      {snapshot.error && (
        <p
          role="status"
          className="absolute top-3 right-3 rounded bg-white p-2 text-sm text-red-700"
        >
          {snapshot.error}
        </p>
      )}
    </div>
  );
}
