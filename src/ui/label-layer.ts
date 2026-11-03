import type {
  Label,
  LabelFilterLambda,
  PointHoverCallback,
  HoverOutlineOptions,
  LabelIdentifier,
  LabelHoverCallback,
  MutedLabelStyle,
} from '../types.js';
import type { DataLayer } from '../data/data-layer.js';
import { getPointColor, getPointSize } from '../util/point.js';
import { expandLabelBounds, LabelCollisionIndex } from './label-collision.js';
import type { LabelBounds } from './label-collision.js';

/** 描画するラベルの既定の最大数（クラスタサイズ順 上位 N 件）。俯瞰時の描画負荷の上限。 */
const DEFAULT_MAX_RENDERED_LABELS = 150;

/**
 * ラベルレイヤーの初期化オプション
 */
export interface LabelLayerOptions {
  /** WebGPUキャンバス（位置決めに使用） */
  canvas: HTMLCanvasElement;
  /** ラベル間の最小距離（ピクセル） */
  minLabelDistance?: number;
  /** ラベルのフォントサイズ（ピクセル） */
  labelFontSize?: number;
  /** ラベルのフィルター。更新時の null は解除、undefined は据え置き。 */
  filterLambda?: LabelFilterLambda | null;
  /**
   * filterLambda が false を返した「非マッチ」ラベルの不透明度（0-1）。指定すると非マッチ
   * ラベルをグレー化せず、元のクラスタ色のまま opacity だけ下げて描画する（dim-only）。
   * 未指定時は従来どおりグレー表示。
   */
  unmatchedLabelOpacity?: number;
  /** ミュート（グレー表示）判定関数。true でクラスタ色でなく mutedLabelColor で描く（dim と直交） */
  mutedLambda?: LabelFilterLambda;
  /** ミュート時のストローク色 [r, g, b]（未指定は [102, 102, 102]） */
  mutedLabelColor?: [number, number, number];
  /** ミュートラベルの不透明度（0-1、未指定は 0.4）。沈める表示の塗り α に使う */
  mutedLabelOpacity?: number;
  /** ミュートラベルの見た目（bold / 塗り / 縁取り）。未指定は flat。update() では null で flat に戻す */
  mutedLabelStyle?: MutedLabelStyle | null;
  /** 描画するラベルの最大数（クラスタサイズ順 上位 N 件）。未指定は 150。 */
  maxRenderedLabels?: number;
  /** ラベルクリック時のコールバック */
  onLabelClick?: (label: Label, event: MouseEvent) => void;
  /** ポイントホバー時のコールバック */
  onPointHover?: PointHoverCallback;
  /** ラベルホバー時のコールバック */
  onLabelHover?: LabelHoverCallback;
  /** ホバー時のアウトラインオプション */
  hoverOutlineOptions?: HoverOutlineOptions;
  /** データレイヤー参照 */
  dataLayer?: DataLayer;
}

/**
 * ラベル描画用の2Dキャンバスオーバーレイを管理するクラス
 * テキストラベルの描画、衝突検出、座標変換を担当する
 */
export class LabelLayer {
  /** WebGPUキャンバス（位置決めに使用） */
  private canvas: HTMLCanvasElement;
  /** ラベル描画用の2Dキャンバス */
  private labelCanvas!: HTMLCanvasElement;
  /** 2Dキャンバスの描画コンテキスト */
  private labelContext!: CanvasRenderingContext2D;
  /** 表示するラベルの配列 */
  private labels: Label[] = [];
  /** ラベル間の最小距離（ピクセル） */
  private readonly minLabelDistance: number = 40;
  /** ラベルのフォントサイズ（ピクセル） */
  private labelFontSize: number = 12;
  /** ラベルフィルタリング関数 */
  private filterLambda?: LabelFilterLambda;
  /** 非マッチラベルの dim opacity（指定時は元色を保持して減衰、未指定はグレー表示） */
  private unmatchedLabelOpacity?: number;
  /** ミュート（グレー）判定関数（投稿フィルタ非該当クラスタ等）。dim とは直交 */
  private mutedLambda?: LabelFilterLambda;
  /** ミュート時のストローク色 [r, g, b]（既定は中立グレー） */
  private mutedLabelColor: [number, number, number] = [102, 102, 102];
  /** ミュートラベルの不透明度（沈める表示の塗り α）。既定 0.4 */
  private mutedLabelOpacity: number = 0.4;
  /** ミュートラベルの見た目（未指定は flat: 非bold・mutedLabelColor 塗り・縁取り無し） */
  private mutedLabelStyle?: MutedLabelStyle;
  /** 描画するラベルの最大数（クラスタサイズ順 上位 N 件） */
  private maxRenderedLabels: number = DEFAULT_MAX_RENDERED_LABELS;
  /** 実際のフォントごとの文字矩形キャッシュ。太字・ホバー拡大も分けて計測する。 */
  private textBoundsCache = new Map<string, Map<string, LabelBounds>>();
  /** textBoundsCache を計測したフォントサイズ（変わったらクリア） */
  private textBoundsFontSize = -1;
  /** 直近 render() の入力スナップショット。すべて一致なら再描画を省く（冗長 render の抑止） */
  private rPrev = {
    zoom: NaN,
    panX: NaN,
    panY: NaN,
    font: NaN,
    cw: -1,
    ch: -1,
    labels: null as Label[] | null,
    filter: undefined as LabelFilterLambda | undefined,
    unmatched: undefined as number | undefined,
    muted: undefined as LabelFilterLambda | undefined,
    mutedColor: null as [number, number, number] | null,
    mutedOpacity: NaN,
    mutedStyle: undefined as MutedLabelStyle | undefined,
    hoveredLabel: null as Label | null,
    hoveredPoint: null as Record<string, any> | null,
    maxRendered: -1,
    hoverOutline: null as HoverOutlineOptions | null,
  };

  /** 現在のズーム倍率 */
  private zoom: number = 1.0;
  /** X方向のパン量 */
  private panX: number = 0.0;
  /** Y方向のパン量 */
  private panY: number = 0.0;

  /** ラベルクリック時のコールバック */
  private onLabelClick?: (label: Label, event: MouseEvent) => void;
  /** 描画されたラベルのバウンディングボックス配列 */
  private renderedLabelBounds: Array<{
    label: Label;
    x: number;
    y: number;
    width: number;
    height: number;
  }> = [];
  /** 現在ホバー中のラベル */
  private hoveredLabel: Label | null = null;
  /** 通常時のスケール */
  private readonly normalScale = 1.0;
  /** ホバー時のスケール */
  private readonly hoverScale = 1.3;
  /** ヒット検出用のパディング（ピクセル） */
  private readonly hitPadding = 10;

  /** ポイントホバー時のコールバック */
  private onPointHover?: PointHoverCallback;
  /** ラベルホバー時のコールバック */
  private onLabelHover?: LabelHoverCallback;
  /** 現在ホバー中のポイント */
  private hoveredPoint: Record<string, any> | null = null;
  /** 直近に hover した点の rowid（mousemove ごとの再クエリ抑制用。null=点上に無い） */
  private hoveredRowid: number | null = null;
  /** hover データ取得（findPointById）の世代カウンタ（古い非同期結果の破棄=stale guard 用） */
  private hoverQuerySeq = 0;
  /** findPointById 実行中フラグ（latest-only: 実行中は新規発行せず最新 rowid を控える） */
  private hoverFetchInFlight = false;
  /** 実行中に発生した最新の hover rowid（完了時にこれだけ取りに行く。中間は捨てる） */
  private hoverFetchQueued: number | null = null;
  /** 直近の wheel（ズーム）時刻。ズーム中は hover 処理を抑制して描画と競合させない */
  private lastWheelTime = 0;
  /** ホバーアウトラインのオプション */
  private hoverOutlineOptions: HoverOutlineOptions;
  /** データレイヤー参照 */
  private readonly dataLayer: DataLayer | null = null;

  /**
   * LabelLayerを初期化する
   * @param options 初期化オプション
   */
  constructor(options: LabelLayerOptions) {
    this.canvas = options.canvas;
    this.minLabelDistance = options.minLabelDistance ?? this.minLabelDistance;
    this.labelFontSize = options.labelFontSize ?? this.labelFontSize;
    this.filterLambda = options.filterLambda ?? undefined;
    this.unmatchedLabelOpacity = options.unmatchedLabelOpacity;
    this.mutedLambda = options.mutedLambda;
    this.mutedLabelColor = options.mutedLabelColor ?? [102, 102, 102];
    this.mutedLabelOpacity = options.mutedLabelOpacity ?? 0.4;
    this.mutedLabelStyle = options.mutedLabelStyle ?? undefined;
    this.maxRenderedLabels = options.maxRenderedLabels ?? DEFAULT_MAX_RENDERED_LABELS;
    this.onLabelClick = options.onLabelClick;
    this.onPointHover = options.onPointHover;
    this.onLabelHover = options.onLabelHover;
    this.dataLayer = options.dataLayer ?? null;
    this.hoverOutlineOptions = {
      enabled: options.hoverOutlineOptions?.enabled ?? true,
      color: options.hoverOutlineOptions?.color ?? 'white',
      width: options.hoverOutlineOptions?.width ?? 2,
      minimumHoverSize: options.hoverOutlineOptions?.minimumHoverSize ?? 10,
      outlinedPointAddition: options.hoverOutlineOptions?.outlinedPointAddition ?? 3,
    };

    this.createLabelCanvas();
  }

  /**
   * ラベル描画用の2Dキャンバスを作成してDOMに追加する
   */
  private createLabelCanvas(): void {
    this.labelCanvas = document.createElement('canvas');
    this.labelCanvas.width = this.canvas.width;
    this.labelCanvas.height = this.canvas.height;
    this.labelCanvas.style.position = 'absolute';
    this.labelCanvas.style.pointerEvents = 'none';
    this.labelCanvas.style.top = '0';
    this.labelCanvas.style.left = '0';
    this.labelCanvas.style.width = this.canvas.style.width || `${this.canvas.width}px`;
    this.labelCanvas.style.height = this.canvas.style.height || `${this.canvas.height}px`;

    const parent = this.canvas.parentElement;
    if (parent) {
      if (getComputedStyle(parent).position === 'static') {
        parent.style.position = 'relative';
      }

      this.labelCanvas.style.top = `${this.canvas.offsetTop}px`;
      this.labelCanvas.style.left = `${this.canvas.offsetLeft}px`;

      parent.appendChild(this.labelCanvas);
    }

    this.labelContext = this.labelCanvas.getContext('2d')!;

    this.setupEventListeners();
  }

  /**
   * ビュー変換の状態を更新する
   * @param zoom ズーム倍率
   * @param panX X方向のパン量
   * @param panY Y方向のパン量
   */
  updateViewTransform(zoom: number, panX: number, panY: number): void {
    this.zoom = zoom;
    this.panX = panX;
    this.panY = panY;
  }

  /**
   * ラベルを2Dキャンバスに描画する
   */
  render(): void {
    // 入力が前回と同一なら再描画しない（GPU render 由来の冗長呼び出しや、点ホバー据え置き時の
    // 全ラベル再レイアウトを避ける）。ラベルキャンバスは render() でしか消去しないので保持される。
    const p = this.rPrev;
    if (
      p.zoom === this.zoom &&
      p.panX === this.panX &&
      p.panY === this.panY &&
      p.font === this.labelFontSize &&
      p.cw === this.labelCanvas.width &&
      p.ch === this.labelCanvas.height &&
      p.labels === this.labels &&
      p.filter === this.filterLambda &&
      p.unmatched === this.unmatchedLabelOpacity &&
      p.muted === this.mutedLambda &&
      p.mutedColor === this.mutedLabelColor &&
      p.mutedOpacity === this.mutedLabelOpacity &&
      p.mutedStyle === this.mutedLabelStyle &&
      p.hoveredLabel === this.hoveredLabel &&
      p.hoveredPoint === this.hoveredPoint &&
      p.maxRendered === this.maxRenderedLabels &&
      p.hoverOutline === this.hoverOutlineOptions
    ) {
      return;
    }
    p.zoom = this.zoom;
    p.panX = this.panX;
    p.panY = this.panY;
    p.font = this.labelFontSize;
    p.cw = this.labelCanvas.width;
    p.ch = this.labelCanvas.height;
    p.labels = this.labels;
    p.filter = this.filterLambda;
    p.unmatched = this.unmatchedLabelOpacity;
    p.muted = this.mutedLambda;
    p.mutedColor = this.mutedLabelColor;
    p.mutedOpacity = this.mutedLabelOpacity;
    p.mutedStyle = this.mutedLabelStyle;
    p.hoveredLabel = this.hoveredLabel;
    p.hoveredPoint = this.hoveredPoint;
    p.maxRendered = this.maxRenderedLabels;
    p.hoverOutline = this.hoverOutlineOptions;

    this.labelContext.clearRect(0, 0, this.labelCanvas.width, this.labelCanvas.height);
    this.renderedLabelBounds = [];

    if (this.labels.length === 0) {
      return;
    }

    // サイズ変更時は古いフォントの計測値を破棄し、キャッシュの際限ない増加を防ぐ。
    if (this.textBoundsFontSize !== this.labelFontSize) {
      this.textBoundsCache.clear();
      this.textBoundsFontSize = this.labelFontSize;
    }

    const fontSize = this.labelFontSize;
    // fontSize <= 0（ラベル非表示）のときは描画も当たり判定も行わない。renderedLabelBounds は
    // 既に空にしてあるので、ここで return すれば hit-test 対象が残らない（非表示ラベルが
    // クリックできてしまうのを防ぐ）。
    if (fontSize <= 0) {
      return;
    }
    this.labelContext.fillStyle = 'white';
    this.labelContext.strokeStyle = 'black';
    this.labelContext.lineWidth = 2;
    this.labelContext.textAlign = 'center';
    this.labelContext.textBaseline = 'middle';

    const collisionIndex = new LabelCollisionIndex(
      this.labelCanvas.width,
      this.labelCanvas.height,
      this.minLabelDistance * (fontSize / 12)
    );

    const labelsWithFilter = this.labels.map((label) => ({
      label,
      passedFilter:
        this.filterLambda && label.properties ? this.filterLambda(label.properties) : true,
      isMuted: this.mutedLambda && label.properties ? this.mutedLambda(label.properties) : false,
    }));

    labelsWithFilter.sort((a, b) => {
      // content-relevant（非 muted）を優先し、cap（maxRenderedLabels）内に該当ラベルを残す。
      if (a.isMuted !== b.isMuted) {
        return a.isMuted ? 1 : -1;
      }
      // muted 同一なら従来どおり passedFilter（選択）優先。安定ソートで count 降順を保持。
      if (a.passedFilter !== b.passedFilter) {
        return a.passedFilter ? -1 : 1;
      }
      return 0;
    });

    for (const { label, passedFilter, isMuted } of labelsWithFilter) {
      // 描画本数の上限。this.labels は loadLabels で count 降順に pre-sort 済みで、上の sort は
      // passedFilter での分類のみ（安定ソートで元順序=count 降順を保持）。よって上位 N 件が残る。
      if (this.renderedLabelBounds.length >= this.maxRenderedLabels) break;
      const { x: screenX, y: screenY } = this.worldToScreenCoords(label.x, label.y);

      if (
        screenX >= 0 &&
        screenX <= this.labelCanvas.width &&
        screenY >= 0 &&
        screenY <= this.labelCanvas.height
      ) {
        const isHovered = this.hoveredLabel === label;
        const scale = isHovered ? this.hoverScale : this.normalScale;
        const scaledFontSize = fontSize * scale;
        const bold = !isMuted || this.mutedLabelStyle?.bold === true;
        // 衝突で描画しなかった候補から、次の候補へ影の設定を引き継がない。
        this.labelContext.shadowColor = 'transparent';
        this.labelContext.shadowBlur = 0;
        this.labelContext.shadowOffsetX = 0;
        this.labelContext.shadowOffsetY = 0;

        if (isMuted) {
          // muted（内容フィルタ非該当）= 最優先で「沈める」。元の「白抜き＋色縁＋影＋bold」を
          // そのまま流用すると目立つため、ドロップシャドウは常に付けない。塗り/縁取り/bold は
          // mutedLabelStyle で決める（未指定は flat: 非 bold・mutedLabelColor のグレー塗り・縁取り無し）。
          // 選択 dim 中（!passedFilter）は従来の薄さ（unmatchedLabelOpacity）以下に抑え、浮かせない。
          const a = passedFilter
            ? this.mutedLabelOpacity
            : Math.min(
                this.mutedLabelOpacity,
                this.unmatchedLabelOpacity ?? this.mutedLabelOpacity
              );
          const style = this.mutedLabelStyle;
          const [fr, fg, fb] = style?.fillColor ?? this.mutedLabelColor;
          const stroke = style?.strokeColor ?? null;
          this.labelContext.fillStyle = `rgba(${fr}, ${fg}, ${fb}, ${a})`;
          if (stroke) {
            const [sr, sg, sb] = stroke;
            this.labelContext.strokeStyle = `rgba(${sr}, ${sg}, ${sb}, ${a})`;
            this.labelContext.lineWidth = style?.strokeWidth ?? 2;
          } else {
            this.labelContext.strokeStyle = 'transparent';
            this.labelContext.lineWidth = 0;
          }
        } else if (passedFilter) {
          this.labelContext.shadowColor = 'rgba(0, 0, 0, 0.4)';
          this.labelContext.shadowBlur = 6;
          this.labelContext.shadowOffsetX = 2;
          this.labelContext.shadowOffsetY = 2;

          this.labelContext.fillStyle = 'white';

          if (
            label.properties?.color &&
            Array.isArray(label.properties.color) &&
            label.properties.color.length === 3
          ) {
            const [r, g, b] = label.properties.color;
            this.labelContext.strokeStyle = `rgb(${r}, ${g}, ${b})`;
          } else {
            this.labelContext.strokeStyle = 'white';
          }
          this.labelContext.lineWidth = 2;
        } else if (this.unmatchedLabelOpacity !== undefined) {
          // dim-only: グレー化や非表示ではなく opacity だけ下げる（ノードの dim-only 選択と
          // 視覚を揃える）。色を持つラベルは元のクラスタ色を保持し、color 配列を持たない
          // 標準ラベル（cluster_label/cluster/count のみ）でも要求 opacity
          // を尊重する（中立グレーを同じ opacity で適用）。
          const a = this.unmatchedLabelOpacity;
          const col = label.properties?.color;
          const hasColor = Array.isArray(col) && col.length === 3;
          this.labelContext.shadowColor = 'transparent';
          this.labelContext.shadowBlur = 0;
          this.labelContext.fillStyle = `rgba(255, 255, 255, ${a})`;
          this.labelContext.strokeStyle = hasColor
            ? `rgba(${col[0]}, ${col[1]}, ${col[2]}, ${a})`
            : `rgba(100, 100, 100, ${a})`;
          this.labelContext.lineWidth = 2;
        } else {
          this.labelContext.shadowColor = 'rgba(0, 0, 0, 0.3)';
          this.labelContext.shadowBlur = 4;
          this.labelContext.shadowOffsetX = 2;
          this.labelContext.shadowOffsetY = 2;

          this.labelContext.fillStyle = 'rgba(180, 180, 180, 0.6)';
          this.labelContext.strokeStyle = 'rgba(100, 100, 100, 0.6)';
          this.labelContext.lineWidth = 1.5;
        }

        // 通常時にもホバー時の最大サイズを予約し、拡大で他のラベルへ重なったり、
        // ホバーした途端に自身が衝突判定で消えたりすることを防ぐ。
        const normalBounds = this.measureLabelBounds(label.text, fontSize * this.normalScale, bold);
        const hoverBounds = this.measureLabelBounds(label.text, fontSize * this.hoverScale, bold);
        const textBounds = isHovered ? hoverBounds : normalBounds;
        // フォントの丸めで通常サイズの一部が拡大サイズからはみ出す場合も、両方を包含する。
        const left = Math.min(hoverBounds.x, normalBounds.x);
        const top = Math.min(hoverBounds.y, normalBounds.y);
        const right = Math.max(
          hoverBounds.x + hoverBounds.width,
          normalBounds.x + normalBounds.width
        );
        const bottom = Math.max(
          hoverBounds.y + hoverBounds.height,
          normalBounds.y + normalBounds.height
        );
        const collisionBounds = expandLabelBounds(
          {
            x: screenX + left,
            y: screenY + top,
            width: right - left,
            height: bottom - top,
          },
          {
            strokeWidth: this.labelContext.lineWidth,
            miterLimit: this.labelContext.lineJoin === 'miter' ? this.labelContext.miterLimit : 1,
            shadowBlur: this.labelContext.shadowBlur,
            shadowOffsetX: this.labelContext.shadowOffsetX,
            shadowOffsetY: this.labelContext.shadowOffsetY,
          }
        );
        if (!collisionIndex.tryInsert(collisionBounds, screenX, screenY)) continue;

        this.labelContext.font = `${bold ? 'bold ' : ''}${scaledFontSize}px sans-serif`;
        if (this.labelContext.lineWidth > 0) {
          this.labelContext.strokeText(label.text, screenX, screenY);
        }
        this.labelContext.fillText(label.text, screenX, screenY);

        this.renderedLabelBounds.push({
          label,
          x: screenX + textBounds.x,
          y: screenY + textBounds.y,
          width: textBounds.width,
          height: textBounds.height,
        });
      }
    }

    // 最後の候補が衝突で除外されても、影をポイントのアウトラインへ引き継がない。
    this.labelContext.shadowColor = 'transparent';
    this.labelContext.shadowBlur = 0;
    this.labelContext.shadowOffsetX = 0;
    this.labelContext.shadowOffsetY = 0;
    this.renderPointOutline();
  }

  /** 中央揃えの描画原点から見た文字矩形を、実際のフォントで計測して再利用する。 */
  private measureLabelBounds(text: string, fontSize: number, bold: boolean): LabelBounds {
    const font = `${bold ? 'bold ' : ''}${fontSize}px sans-serif`;
    let cache = this.textBoundsCache.get(font);
    if (!cache) {
      cache = new Map();
      this.textBoundsCache.set(font, cache);
    }
    let bounds = cache.get(text);
    if (!bounds) {
      this.labelContext.font = font;
      const metrics = this.labelContext.measureText(text);
      // advance 幅だけでなく、左右へのはみ出し・アクセント・ディセンダーも含める。
      const left = Math.max(metrics.width / 2, metrics.actualBoundingBoxLeft);
      const right = Math.max(metrics.width / 2, metrics.actualBoundingBoxRight);
      const top = Math.max(fontSize / 2, metrics.actualBoundingBoxAscent);
      const bottom = Math.max(fontSize / 2, metrics.actualBoundingBoxDescent);
      bounds = { x: -left, y: -top, width: left + right, height: top + bottom };
      cache.set(text, bounds);
    }
    return bounds;
  }

  /**
   * ホバー中のポイントにアウトラインを描画する
   */
  private renderPointOutline(): void {
    if (!this.hoveredPoint || !this.dataLayer) {
      return;
    }

    if (!this.hoverOutlineOptions.enabled) {
      return;
    }

    const pointX = this.hoveredPoint['x'];
    const pointY = this.hoveredPoint['y'];

    if (pointX == null || pointY == null) {
      return;
    }

    const { x: screenX, y: screenY } = this.worldToScreenCoords(pointX, pointY);

    const baseSize = getPointSize(this.hoveredPoint);
    const zoomScaledSize = Math.max(
      baseSize * Math.pow(this.zoom, 0.3) + (this.hoverOutlineOptions.outlinedPointAddition ?? 3),
      this.hoverOutlineOptions.minimumHoverSize ?? 10
    );

    const screenRadius = zoomScaledSize;

    this.labelContext.beginPath();
    this.labelContext.arc(screenX, screenY, screenRadius, 0, Math.PI * 2);

    const color = getPointColor(this.hoveredPoint);
    this.labelContext.fillStyle = `rgba(${Math.round(color.r * 255)}, ${Math.round(color.g * 255)}, ${Math.round(color.b * 255)}, ${Math.round(color.a * 255)})`;
    this.labelContext.fill();

    this.labelContext.strokeStyle = this.hoverOutlineOptions.color ?? 'black';
    this.labelContext.lineWidth = this.hoverOutlineOptions.width ?? 2;
    this.labelContext.stroke();
  }

  /**
   * GeoJSONデータからラベルを読み込む
   * @param geojsonData GeoJSON形式のデータ
   */
  loadLabels(geojsonData: any): void {
    if (!geojsonData || !geojsonData.features) {
      return;
    }

    const allLabels = geojsonData.features.map((feature: any) => ({
      text: feature.properties?.cluster_label || '',
      x: feature.geometry?.coordinates?.[0] || 0,
      y: feature.geometry?.coordinates?.[1] || 0,
      cluster: feature.properties?.cluster,
      count: feature.properties?.count || 0,
      properties: feature.properties || {},
    }));

    this.labels = allLabels.sort((a: Label, b: Label) => (b.count || 0) - (a.count || 0));
  }

  /**
   * ホバーとクリック操作用のイベントリスナーを設定する
   */
  private setupEventListeners(): void {
    const parent = this.labelCanvas.parentElement;
    if (!parent) return;

    parent.addEventListener('mousemove', (e: MouseEvent) => {
      const rect = this.labelCanvas.getBoundingClientRect();
      const scaleX = this.labelCanvas.width / rect.width;
      const scaleY = this.labelCanvas.height / rect.height;
      const x = (e.clientX - rect.left) * scaleX;
      const y = (e.clientY - rect.top) * scaleY;

      const labelAtPosition = this.getLabelAtPosition(x, y);

      // 点の hit-test は spatial index だけで rowid を引く（DuckDB クエリは発行しない）。
      let nearestRowid: number | null = null;
      if (!labelAtPosition && this.dataLayer) {
        const aspectRatio = this.labelCanvas.width / this.labelCanvas.height;
        nearestRowid = this.dataLayer.findNearestPointId(
          x,
          y,
          this.labelCanvas.width,
          this.labelCanvas.height,
          this.zoom,
          this.panX,
          this.panY,
          aspectRatio,
          10
        );
      }

      if (labelAtPosition) {
        this.labelCanvas.style.pointerEvents = 'auto';
        this.labelCanvas.style.cursor = 'pointer';
      } else {
        this.labelCanvas.style.pointerEvents = 'none';
        this.labelCanvas.style.cursor = nearestRowid != null ? 'pointer' : 'default';
      }

      if (labelAtPosition !== this.hoveredLabel) {
        this.hoveredLabel = labelAtPosition;
        if (this.onLabelHover) {
          this.onLabelHover(this.hoveredLabel);
        }
        this.render();
      }

      // hover 中の点が変わらなければ何もしない（同じ点での再クエリ・再 render を防ぐ）。
      if (nearestRowid === this.hoveredRowid) {
        return;
      }

      // ズーム中（直近 wheel から 60ms 以内）は新しい点の DuckDB 取得を控える（ズーム描画と
      // 競合させない）。ただし点が変わった/外れたときの古い hover クリアは必ず行い、stale な
      // アウトライン・ツールチップを残さない（クリアは DuckDB を伴わない）。hoveredRowid は確定
      // させず null に戻し、ズーム解除後の次の mousemove でカーソル下の点を取得し直す。
      if (performance.now() - this.lastWheelTime < 60) {
        this.hoveredRowid = null;
        this.hoverQuerySeq++;
        this.hoverFetchQueued = null;
        if (this.hoveredPoint !== null) {
          this.hoveredPoint = null;
          if (this.onPointHover) {
            this.onPointHover(null);
          }
          this.render();
        }
        return;
      }

      this.hoveredRowid = nearestRowid;
      // 進行中の hover クエリを無効化（古い結果が新しい hover を上書きしないように）。
      this.hoverQuerySeq++;

      if (nearestRowid == null) {
        this.hoverFetchQueued = null;
        if (this.hoveredPoint !== null) {
          this.hoveredPoint = null;
          if (this.onPointHover) {
            this.onPointHover(null);
          }
          this.render();
        }
        return;
      }

      // latest-only: 既に findPointById 実行中なら、最新 rowid だけ控えて return する。密集域で
      // mousemove ごとに rowid が変わっても DuckDB クエリをキューに溜めず、完了時に「最新の点」を
      // 1つだけ取りに行く。これでホバー追従の遅延（クエリ詰まり）を防ぐ。
      if (this.hoverFetchInFlight) {
        this.hoverFetchQueued = nearestRowid;
        return;
      }
      this.fetchHoveredPoint(nearestRowid);
    });

    this.labelCanvas.addEventListener('click', (e: MouseEvent) => {
      const rect = this.labelCanvas.getBoundingClientRect();
      const scaleX = this.labelCanvas.width / rect.width;
      const scaleY = this.labelCanvas.height / rect.height;
      const x = (e.clientX - rect.left) * scaleX;
      const y = (e.clientY - rect.top) * scaleY;

      const labelAtPosition = this.getLabelAtPosition(x, y);

      if (labelAtPosition && this.onLabelClick) {
        // クリックの MouseEvent を渡す（Ctrl/Meta 等の修飾キー判定を呼び出し側で行えるように）
        this.onLabelClick(labelAtPosition, e);
        e.stopPropagation();
      }
    });

    this.labelCanvas.addEventListener(
      'wheel',
      (e: WheelEvent) => {
        const newEvent = new WheelEvent('wheel', e);
        this.canvas.dispatchEvent(newEvent);
      },
      { passive: false }
    );

    this.labelCanvas.addEventListener('mousedown', (e: MouseEvent) => {
      const newEvent = new MouseEvent('mousedown', e);
      this.canvas.dispatchEvent(newEvent);
    });

    this.labelCanvas.addEventListener('mousemove', (e: MouseEvent) => {
      const newEvent = new MouseEvent('mousemove', e);
      this.canvas.dispatchEvent(newEvent);
    });

    this.labelCanvas.addEventListener('mouseup', (e: MouseEvent) => {
      const newEvent = new MouseEvent('mouseup', e);
      this.canvas.dispatchEvent(newEvent);
    });

    this.labelCanvas.addEventListener('mouseleave', (e: MouseEvent) => {
      const newEvent = new MouseEvent('mouseleave', e);
      this.canvas.dispatchEvent(newEvent);
    });

    // ズーム（wheel）時刻を記録。wheel はバブリングするので canvas/labelCanvas どちらの上でも
    // parent で拾える。hover ハンドラがこれを見てズーム中は hover 処理を抑制する。
    parent.addEventListener(
      'wheel',
      () => {
        this.lastWheelTime = performance.now();
      },
      { passive: true }
    );

    parent.addEventListener('mouseleave', () => {
      const hadLabel = this.hoveredLabel !== null;
      const hadPoint = this.hoveredPoint !== null;

      this.hoveredLabel = null;
      this.hoveredPoint = null;
      this.hoveredRowid = null;
      this.hoverFetchQueued = null;
      this.hoverQuerySeq++;

      if (hadLabel && this.onLabelHover) {
        this.onLabelHover(null);
      }

      if (hadPoint && this.onPointHover) {
        this.onPointHover(null);
      }

      this.labelCanvas.style.pointerEvents = 'none';
      this.labelCanvas.style.cursor = 'default';
      this.render();
    });
  }

  /**
   * hover 中の点データ（SELECT *）を取得して反映する。latest-only: 実行中は新規クエリを発行せず、
   * 完了時に最新の hoveredRowid を1つだけ取りに行く（密集域で DuckDB クエリを詰まらせない）。
   */
  private fetchHoveredPoint(rowid: number): void {
    if (!this.dataLayer) {
      return;
    }
    this.hoverFetchInFlight = true;
    const seq = this.hoverQuerySeq;
    void this.dataLayer
      .findPointById(rowid)
      .then((data) => {
        // mouse が離れた／別点へ移った後の古い結果は破棄（seq と現在の hoveredRowid で検証）。
        if (seq === this.hoverQuerySeq && rowid === this.hoveredRowid) {
          this.hoveredPoint = data;
          if (this.onPointHover) {
            this.onPointHover(this.hoveredPoint);
          }
          this.render();
        }
      })
      .catch(() => {
        /* hover query failure: keep previous hovered point */
      })
      .finally(() => {
        this.hoverFetchInFlight = false;
        // 実行中に控えた最新 rowid があり、まだそれが現在の hover なら、それだけ取りに行く。
        const next = this.hoverFetchQueued;
        this.hoverFetchQueued = null;
        if (next != null && next === this.hoveredRowid) {
          this.fetchHoveredPoint(next);
        }
      });
  }

  /**
   * 指定された座標にあるラベルを検索する
   * @param x X座標（ピクセル）
   * @param y Y座標（ピクセル）
   * @returns 見つかったラベル、またはnull
   */
  private getLabelAtPosition(x: number, y: number): Label | null {
    for (const bound of this.renderedLabelBounds) {
      if (
        x >= bound.x - this.hitPadding &&
        x <= bound.x + bound.width + this.hitPadding &&
        y >= bound.y - this.hitPadding &&
        y <= bound.y + bound.height + this.hitPadding
      ) {
        return bound.label;
      }
    }
    return null;
  }

  /**
   * ラベルキャンバスのサイズを変更する
   * @param width 新しい幅
   * @param height 新しい高さ
   */
  resize(width: number, height: number): void {
    this.labelCanvas.width = width;
    this.labelCanvas.height = height;
    this.labelCanvas.style.width = this.canvas.style.width;
    this.labelCanvas.style.height = this.canvas.style.height;
    // width/height の代入でキャンバスはクリアされるので再描画する（dirty-check は cw/ch 変化で通る）。
    this.render();
  }

  /**
   * ラベルレイヤーのオプションを更新する
   * @param options 更新するオプション
   */
  updateOptions(options: Partial<LabelLayerOptions>): void {
    if (options.labelFontSize !== undefined) {
      this.labelFontSize = options.labelFontSize;
    }
    if (options.filterLambda !== undefined) {
      this.filterLambda = options.filterLambda ?? undefined;
    }
    if (options.unmatchedLabelOpacity !== undefined) {
      this.unmatchedLabelOpacity = options.unmatchedLabelOpacity;
    }
    if (options.maxRenderedLabels !== undefined) {
      this.maxRenderedLabels = options.maxRenderedLabels;
    }
    if (options.mutedLambda !== undefined) {
      this.mutedLambda = options.mutedLambda;
    }
    if (options.mutedLabelColor !== undefined) {
      this.mutedLabelColor = options.mutedLabelColor;
    }
    if (options.mutedLabelOpacity !== undefined) {
      this.mutedLabelOpacity = options.mutedLabelOpacity;
    }
    if (options.mutedLabelStyle !== undefined) {
      // null は「既定の flat に戻す」明示クリア。undefined はガードで素通し（据え置き）。
      this.mutedLabelStyle = options.mutedLabelStyle ?? undefined;
    }
    if (options.onLabelClick !== undefined) {
      this.onLabelClick = options.onLabelClick;
    }
    if (options.onPointHover !== undefined) {
      this.onPointHover = options.onPointHover;
    }
    if (options.onLabelHover !== undefined) {
      this.onLabelHover = options.onLabelHover;
    }
    if (options.hoverOutlineOptions !== undefined) {
      this.hoverOutlineOptions = {
        enabled: options.hoverOutlineOptions.enabled ?? this.hoverOutlineOptions.enabled,
        color: options.hoverOutlineOptions.color ?? this.hoverOutlineOptions.color,
        width: options.hoverOutlineOptions.width ?? this.hoverOutlineOptions.width,
        minimumHoverSize:
          options.hoverOutlineOptions.minimumHoverSize ?? this.hoverOutlineOptions.minimumHoverSize,
        outlinedPointAddition:
          options.hoverOutlineOptions.outlinedPointAddition ??
          this.hoverOutlineOptions.outlinedPointAddition,
      };
    }
  }

  /**
   * 現在のラベル配列を取得する
   * @returns ラベルの配列
   */
  getLabels(): Label[] {
    return this.labels;
  }

  /**
   * プログラム的にホバー中のポイントを設定する
   * @param data ホバーするポイントデータ、またはnullでクリア
   */
  setHoveredPoint(data: Record<string, any> | null): void {
    if (data === this.hoveredPoint) {
      return;
    }
    // 進行中の mousemove hover クエリを無効化し、その結果がこの明示設定を上書きしないようにする。
    // hoveredRowid もリセットする: これをしないと、cursor が同じ点上にあるまま null クリア
    // された場合、次の mousemove が `nearestRowid === this.hoveredRowid` 早期 return に当たり、
    // 点を再取得できず onPointHover も発火しなくなる（別の点/空白へ動くまで復帰しない）。
    this.hoverQuerySeq++;
    this.hoveredRowid = null;
    this.hoveredPoint = data;

    if (this.onPointHover) {
      this.onPointHover(this.hoveredPoint);
    }

    this.render();
  }

  /**
   * プログラム的にホバー中のラベルを設定する
   * @param label ホバーするラベル、またはnullでクリア
   */
  setHoveredLabel(label: Label | null): void {
    if (label === this.hoveredLabel) {
      return;
    }
    this.hoveredLabel = label;

    if (this.onLabelHover) {
      this.onLabelHover(this.hoveredLabel);
    }

    this.render();
  }

  /**
   * 識別子でラベルを検索する
   * @param identifier ラベル識別子（textまたはcluster）
   * @returns 見つかったラベル、またはnull
   */
  findLabel(identifier: LabelIdentifier): Label | null {
    for (const label of this.labels) {
      if (identifier.text !== undefined && label.text === identifier.text) {
        return label;
      }
      if (identifier.cluster !== undefined && label.cluster === identifier.cluster) {
        return label;
      }
    }
    return null;
  }

  /**
   * 現在ホバー中のポイントを取得する
   * @returns ホバー中のポイント、またはnull
   */
  getHoveredPoint(): Record<string, any> | null {
    return this.hoveredPoint;
  }

  /**
   * 現在ホバー中のラベルを取得する
   * @returns ホバー中のラベル、またはnull
   */
  getHoveredLabel(): Label | null {
    return this.hoveredLabel;
  }

  /**
   * ワールド座標をスクリーン座標に変換する
   * @param worldX ワールドX座標
   * @param worldY ワールドY座標
   * @returns スクリーン座標
   */
  private worldToScreenCoords(worldX: number, worldY: number): { x: number; y: number } {
    const aspectRatio = this.labelCanvas.width / this.labelCanvas.height;
    const clipX = worldX * (this.zoom / aspectRatio) + this.panX;
    const clipY = worldY * this.zoom + this.panY;
    const screenX = (clipX + 1) * 0.5 * this.labelCanvas.width;
    const screenY = (1 - clipY) * 0.5 * this.labelCanvas.height;
    return { x: screenX, y: screenY };
  }

  /**
   * リソースを解放してレイヤーを破棄する
   */
  destroy(): void {
    if (this.labelCanvas.parentElement) {
      this.labelCanvas.parentElement.removeChild(this.labelCanvas);
    }
  }
}
