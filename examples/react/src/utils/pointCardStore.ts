import type {
  ScatterPlot,
  PointPosition,
  ScatterPlotView,
  PointDataChangeEvent,
} from '@uoa-css-lab/duckscatter';
import { formatPublishDate } from './formatPublishDate';

interface PointCardContent {
  headline: string | null;
  publishedDate: string | null;
  size: number;
}

export interface PointCardItem extends PointPosition, PointCardContent {}

interface PointCardSnapshot {
  points: PointCardItem[];
  view: ScatterPlotView | null;
  /** 候補の取得が完了した表示状態。操作中はこの状態で決めた配置を維持する。 */
  layoutView: ScatterPlotView | null;
  error: string | null;
}

const EMPTY_SNAPSHOT: PointCardSnapshot = {
  points: [],
  view: null,
  layoutView: null,
  error: null,
};
const SETTLE_MS = 150;

/**
 * 画面変更の通知と非同期の属性取得をつなぐ外部ストア。
 * React の描画中にはクエリを開始せず、購読解除と世代の変更で古い結果を破棄する。
 */
export class PointCardStore {
  private snapshot = EMPTY_SNAPSHOT;
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private active = false;
  private generation = 0;
  private running = false;
  private queued = false;
  private limit = 0;
  /** 全点分に増やさず、直近の候補に対応する属性だけを保持する。 */
  private cache = new Map<number, PointCardContent>();

  constructor(private readonly plot: ScatterPlot | null) {}

  /** 上限の入力中も同じストアを維持し、古いクエリの完了前に次を並行発行しない。 */
  configure(limit: number): void {
    if (limit === this.limit) return;
    if (limit === 0) this.cache.clear();
    this.limit = limit;
    this.invalidate();
    this.publish({
      ...EMPTY_SNAPSHOT,
      view: this.active ? (this.plot?.getViewState() ?? null) : null,
    });
    if (this.active && this.plot && limit > 0) this.schedule();
  }

  getSnapshot = (): PointCardSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    if (this.listeners.size === 1) this.start();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.stop();
    };
  };

  private publish(snapshot: PointCardSnapshot): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }

  private start(): void {
    this.active = true;
    this.generation++;
    if (!this.plot) return;
    this.plot.on('viewchange', this.onViewChange);
    this.plot.on('pointdatachange', this.onDataChange);
    this.plot.on('destroy', this.onDestroy);
    this.publish({ ...EMPTY_SNAPSHOT, view: this.plot.getViewState() });
    if (this.limit > 0) this.schedule(0);
  }

  private stop(): void {
    this.active = false;
    this.invalidate();
    this.plot?.off('viewchange', this.onViewChange);
    this.plot?.off('pointdatachange', this.onDataChange);
    this.plot?.off('destroy', this.onDestroy);
  }

  /** 実行中の取得は取り消せなくても、その結果と途中の更新要求を無効にする。 */
  private invalidate(): void {
    this.generation++;
    this.queued = false;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(delay = SETTLE_MS): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.refresh();
    }, delay);
  }

  private onViewChange = (view: ScatterPlotView): void => {
    if (this.limit === 0) return;
    this.invalidate();
    this.publish({ ...this.snapshot, view });
    this.schedule();
  };

  private onDataChange = (event: PointDataChangeEvent): void => {
    this.invalidate();
    if (event.attributesChanged) this.cache.clear();
    // フィルターが変わった直後は、古い条件のカードを表示し続けない。
    this.publish({ ...EMPTY_SNAPSHOT, view: this.plot!.getViewState() });
    if (!event.pending && this.limit > 0) this.schedule();
  };

  private onDestroy = (): void => {
    this.stop();
    this.cache.clear();
    this.publish(EMPTY_SNAPSHOT);
  };

  private async refresh(): Promise<void> {
    if (!this.active || !this.plot || this.limit === 0) return;
    // 完了前に別の要求が来たら最新の表示状態だけを控え、クエリを積み上げない。
    if (this.running) {
      this.queued = true;
      return;
    }
    const result = this.plot.getPointsInViewport(this.limit);
    if (!result.ready || result.limitExceeded || result.points.length === 0) {
      this.cache.clear();
      this.publish({ ...EMPTY_SNAPSHOT, view: this.plot.getViewState() });
      return;
    }
    const generation = this.generation;
    const missing = result.points.filter((point) => !this.cache.has(point.id));
    this.running = true;
    try {
      const content = new Map(this.cache);
      if (missing.length > 0) {
        const rows = await this.plot.getPointsByIds(missing.map((point) => point.id));
        for (const row of rows) {
          const headline = row.headline_text;
          const date = row.publish_date;
          // GPU の点サイズと同じ f32 に揃える。無効な値は配置の優先順位を最後にする。
          const size = Math.fround(Number(row.__size__));
          content.set(row.__point_id__, {
            headline: typeof headline === 'string' && headline.trim() ? headline.trim() : null,
            publishedDate: date == null ? null : formatPublishDate(date),
            size: Number.isFinite(size) ? size : -Infinity,
          });
        }
      }
      if (!this.active || generation !== this.generation) return;
      this.cache = new Map();
      const points: PointCardItem[] = [];
      for (const point of result.points) {
        const attributes = content.get(point.id);
        if (!attributes) continue;
        this.cache.set(point.id, attributes);
        if (attributes.headline || attributes.publishedDate)
          points.push({ ...point, ...attributes });
      }
      const view = this.plot.getViewState();
      this.publish({ points, view, layoutView: view, error: null });
    } catch (error) {
      if (this.active && generation === this.generation) {
        console.error('Failed to load point cards.', error);
        this.publish({
          ...EMPTY_SNAPSHOT,
          view: this.plot.getViewState(),
          error: '点の詳細を取得できませんでした。',
        });
      }
    } finally {
      this.running = false;
      if (this.active && this.queued) {
        this.queued = false;
        void this.refresh();
      }
    }
  }
}
