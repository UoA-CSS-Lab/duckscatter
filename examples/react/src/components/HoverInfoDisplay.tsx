import { useLayoutEffect, useMemo, useRef } from 'react';
import { useScatterPlot } from '../context/ScatterPlotContext';
import { formatPublishDate } from '../utils/formatPublishDate';

/** 空の説明や型の異なる値を、そのまま本文として表示しない。 */
function readText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

interface HoverInfoDisplayProps {
  mousePosition: { x: number; y: number };
}

export function HoverInfoDisplay({ mousePosition }: HoverInfoDisplayProps) {
  const { state } = useScatterPlot();
  const cardRef = useRef<HTMLDivElement>(null);

  const content = useMemo(() => {
    const label = state.hoveredLabel;
    if (label) {
      return {
        title: label.text,
        description:
          readText(label.properties?.cluster_description) ?? readText(label.properties?.summary),
        publishedDate: null,
        count: typeof label.count === 'number' && Number.isFinite(label.count) ? label.count : null,
      };
    }

    const point = state.hoveredPoint;
    if (!point) return null;
    const headline = readText(point.headline_text);
    const publishedDate = point.publish_date == null ? null : formatPublishDate(point.publish_date);
    if (!headline && !publishedDate) return null;
    // 点の見出しと日付だけを表示し、内部の描画属性や補助的な見出しは出さない。
    return {
      title: headline,
      description: null,
      publishedDate,
      count: null,
    };
  }, [state.hoveredLabel, state.hoveredPoint]);

  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!card || !content) return;
    const { width, height } = card.getBoundingClientRect();
    const margin = 12;
    const gap = 16;
    // 右端・下端ではカーソルの反対側へ置き、カード全体を画面内に収める。
    const left =
      mousePosition.x + gap + width <= window.innerWidth - margin
        ? mousePosition.x + gap
        : mousePosition.x - gap - width;
    const top =
      mousePosition.y + gap + height <= window.innerHeight - margin
        ? mousePosition.y + gap
        : mousePosition.y - gap - height;
    card.style.left = `${Math.max(margin, Math.min(left, window.innerWidth - width - margin))}px`;
    card.style.top = `${Math.max(margin, Math.min(top, window.innerHeight - height - margin))}px`;
  }, [content, mousePosition.x, mousePosition.y]);

  if (!content) return null;

  return (
    <div
      ref={cardRef}
      role="tooltip"
      className="fixed z-50 pointer-events-none w-80 max-w-[calc(100vw-24px)] max-h-[calc(100vh-24px)] overflow-hidden rounded border border-zinc-300 bg-white p-3 text-sm text-zinc-800 shadow-md"
      style={{
        left: mousePosition.x + 16,
        top: mousePosition.y + 16,
      }}
    >
      {content.title && <h3 className="break-words font-medium leading-5">{content.title}</h3>}
      {content.description && (
        <p className="mt-2 whitespace-pre-line break-words text-xs leading-5 text-zinc-600">
          {content.description}
        </p>
      )}
      {(content.publishedDate || content.count !== null) && (
        <div className="mt-2 text-xs text-zinc-500 tabular-nums">
          {content.publishedDate && <time>{content.publishedDate}</time>}
          {content.count !== null && <span>{content.count.toLocaleString('ja-JP')} 件</span>}
        </div>
      )}
    </div>
  );
}
