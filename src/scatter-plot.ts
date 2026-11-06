import type { AsyncDuckDBConnection } from '@duckdb/duckdb-wasm';
import type {
  Label,
  ScatterPlotOptions,
  ScatterPlotEventMap,
  ScatterPlotError,
  LabelIdentifier,
  GpuWhereCondition,
  FilteredPointDisplayMode,
  SelectionStyle,
  BrushBounds,
  ScreenBrushRect,
  BrushOptions,
  ScatterPlotUpdatePath,
  ScatterPlotUpdatePlan,
  FrameStats,
  ScatterPlotView,
  ViewportPointQueryResult,
  PointAttributes,
} from './types.js';
import { DataLayer, type ParquetData } from './data/index.js';
import { GpuLayer } from './renderer/index.js';
import { LabelLayer } from './ui/index.js';
import { EventEmitter } from './event-emitter.js';
import { createError } from './errors.js';
import { WebGPUInitializationError } from './renderer/gpu-errors.js';

/**
 * WebGPUを使用して散布図を描画するメインクラス
 *
 * このクラスは3つの異なるレイヤーのファサード/コーディネーターとして機能する:
 * - DataLayer: データ取得とクエリ管理を担当
 * - GpuLayer: WebGPUレンダリングと変換を管理（LODと境界計算もGPU側で実行）
 * - LabelLayer: ラベル用の2Dキャンバスオーバーレイを担当
 */
export class ScatterPlot extends EventEmitter<ScatterPlotEventMap> {
  private readonly dataLayer: DataLayer;
  private gpuLayer: GpuLayer;
  private labelLayer: LabelLayer;
  private readonly canvas: HTMLCanvasElement;
  /** 初期化と更新の途中に、古いフィルターで候補を公開しないための状態。 */
  private pointDataReady = false;
  private pointDataPending = 0;
  private destroyed = false;
  private lastView: ScatterPlotView | null = null;

  private readonly dataSource: string | File | ArrayBuffer;
  private readonly labelSource?: string | File | ArrayBuffer;
  private readonly onDatabaseReady?: (conn: AsyncDuckDBConnection) => Promise<void>;
  /** 直近に指定された gpuWhereConditions（gpuFilterColumns 変更時に新 mapping で再解決するため保持） */
  private currentGpuWhereConditions: GpuWhereCondition[] = [];
  /** 直近に CONFIG_WARNING を出した「未登録 column 集合」のキー（hot path での重複 emit 抑制） */
  private lastIgnoredGpuWhereColumnsKey = '';
  /** 直近の update() が通った更新経路（getLastUpdatePlan 用） */
  private lastUpdatePlan: ScatterPlotUpdatePlan | null = null;
  private readonly initialFilteredPointDisplayMode?: FilteredPointDisplayMode;

  /** GPUフィルターカラム名→インデックスのマッピング */
  private gpuFilterColumnMapping: Map<string, number> = new Map();

  /**
   * ScatterPlotインスタンスを作成する
   * @param options 散布図の設定オプション
   */
  constructor(options: ScatterPlotOptions) {
    super();
    this.canvas = options.canvas;

    this.dataLayer = new DataLayer({
      sizeSql: options.data.sizeSql,
      colorSql: options.data.colorSql,
      whereConditions: options.data.whereConditions,
      gpuFilterColumns: options.data.gpuFilterColumns,
      onError: (error) => this.emitError(error),
      onDataChanged: () => this.handleDataChanged(),
      onVisibilityChanged: () => this.handleVisibilityChanged(),
    });

    this.gpuLayer = new GpuLayer({
      canvas: options.canvas,
      backgroundColor: options.gpu?.backgroundColor,
      targetRenderTimeMs: options.gpu?.targetRenderTimeMs,
      pointAlpha: options.gpu?.pointAlpha,
      pointSizeScale: options.gpu?.pointSizeScale,
      selectionStyle: options.gpu?.selection,
      recededClamp: options.gpu?.recededClamp,
      onError: (error) => this.emitError(error),
    });

    this.labelLayer = new LabelLayer({
      canvas: options.canvas,
      labelFontSize: options.labels?.fontSize,
      filterLambda: options.labels?.filterLambda,
      unmatchedLabelOpacity: options.labels?.unmatchedLabelOpacity,
      maxRenderedLabels: options.labels?.maxRendered,
      onLabelClick: options.labels?.onClick,
      onPointHover: options.interaction?.onPointHover,
      onLabelHover: options.interaction?.onLabelHover,
      hoverOutlineOptions: options.labels?.hoverOutlineOptions,
      pointSizeScale: this.gpuLayer.getPointSizeScale(),
      mutedLambda: options.labels?.mutedLambda,
      mutedLabelColor: options.labels?.mutedLabelColor,
      mutedLabelOpacity: options.labels?.mutedLabelOpacity,
      mutedLabelStyle: options.labels?.mutedLabelStyle,
      dataLayer: this.dataLayer,
    });

    const dataSource = options.dataFile ?? options.dataUrl;
    if (!dataSource) {
      throw new Error('Either dataUrl or dataFile must be provided.');
    }
    this.dataSource = dataSource;
    this.labelSource = options.labels?.file ?? options.labels?.url;
    this.onDatabaseReady = options.onDatabaseReady;
    this.currentGpuWhereConditions = options.data.gpuWhereConditions ?? [];
    this.initialFilteredPointDisplayMode = options.data.filteredPointDisplayMode;
  }

  /**
   * WebGPUを初期化し、レンダリングリソースを作成する
   */
  async initialize(): Promise<void> {
    try {
      const allPointsData = await this.dataLayer.initialize(this.dataSource, this.onDatabaseReady);
      await this.gpuLayer.initialize(allPointsData);

      const gpuFilterData = await this.dataLayer.loadGpuFilterColumns();
      if (gpuFilterData) {
        this.gpuLayer.uploadFilterColumns(gpuFilterData.data);
        this.gpuFilterColumnMapping = gpuFilterData.columnMapping;
      }

      if (this.currentGpuWhereConditions.length > 0) {
        const conditions = this.convertGpuWhereConditions(this.currentGpuWhereConditions);
        this.gpuLayer.setGpuFilterConditions(conditions);
        this.dataLayer.setGpuFilterRanges(conditions);
      }

      if (this.initialFilteredPointDisplayMode !== undefined) {
        this.gpuLayer.setFilteredPointDisplayMode(this.initialFilteredPointDisplayMode);
      }

      // 初期WHERE条件がある場合はビットフラグを設定
      const visibilityData = await this.dataLayer.loadVisibilityFlags();
      if (visibilityData) {
        const hasWhereConditions = visibilityData.flags.some((word) => word !== 0xffffffff);
        if (hasWhereConditions) {
          this.gpuLayer.uploadVisibilityFlags(visibilityData.flags, true);
        }
      }
      this.pointDataReady = !this.destroyed;
      this.emit('pointdatachange', { pending: false, attributesChanged: true });
    } catch (e) {
      const error = this.categorizeInitError(e);
      this.emitError(error);
      return;
    }

    if (this.labelSource) {
      await this.loadLabelSource(this.labelSource);
    }
  }

  /**
   * データ変更時のハンドラ（sizeSql, colorSql変更時）
   */
  private async handleDataChanged(): Promise<void> {
    try {
      const allPointsData = await this.dataLayer.loadAllPoints();
      this.gpuLayer.uploadAllPoints(allPointsData);
      // WHERE条件があればビットフラグを再設定、なければクリア
      const visibilityData = await this.dataLayer.loadVisibilityFlags();
      if (visibilityData) {
        const hasWhereConditions = visibilityData.flags.some((word) => word !== 0xffffffff);
        if (hasWhereConditions) {
          this.gpuLayer.uploadVisibilityFlags(visibilityData.flags, true);
        } else {
          this.gpuLayer.clearVisibilityFlags();
        }
      } else {
        this.gpuLayer.clearVisibilityFlags();
      }
      this.render();
    } catch (e) {
      this.emitError(
        createError('QUERY_FAILED', 'Failed to reload data after options change', {
          cause: e instanceof Error ? e : undefined,
        })
      );
    }
  }

  /**
   * WHERE条件変更時のハンドラ（ビジビリティフラグのみ更新）
   */
  private async handleVisibilityChanged(): Promise<void> {
    try {
      const visibilityData = await this.dataLayer.loadVisibilityFlags();
      if (visibilityData) {
        this.gpuLayer.uploadVisibilityFlags(visibilityData.flags, true);
      } else {
        this.gpuLayer.clearVisibilityFlags();
      }
      this.render();
    } catch (e) {
      this.emitError(
        createError('QUERY_FAILED', 'Failed to update visibility flags', {
          cause: e instanceof Error ? e : undefined,
        })
      );
    }
  }

  /**
   * ラベルデータをURL、File、またはArrayBufferから読み込む
   * @param source ラベルデータのソース
   */
  private async loadLabelSource(source: string | File | ArrayBuffer): Promise<void> {
    if (typeof source === 'string') {
      await this.loadLabelsFromUrl(source);
    } else {
      await this.loadLabelsFromBuffer(source);
    }
  }

  /**
   * File/ArrayBufferからラベルデータを読み込む
   * @param source GeoJSONファイルのバイナリデータ
   */
  private async loadLabelsFromBuffer(source: File | ArrayBuffer): Promise<void> {
    try {
      const buffer = source instanceof File ? await source.arrayBuffer() : source;
      const text = new TextDecoder().decode(buffer);
      const labelData = JSON.parse(text);
      this.loadLabels(labelData);
      await this.dataLayer.loadLabelData(labelData);
    } catch (e) {
      this.emitError(
        createError('LABEL_FETCH_FAILED', 'Failed to parse label file', {
          cause: e instanceof Error ? e : undefined,
        })
      );
    }
  }

  /**
   * URLからラベルデータを読み込み、エラーハンドリングを行う
   * @param url ラベルデータのURL
   */
  private async loadLabelsFromUrl(url: string): Promise<void> {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        this.emitError(
          createError(
            'LABEL_FETCH_FAILED',
            `Failed to fetch labels: ${response.status} ${response.statusText}`,
            {
              context: { url, status: response.status },
            }
          )
        );
        return;
      }
      const labelData = await response.json();
      this.loadLabels(labelData);
      await this.dataLayer.loadLabelData(labelData);
    } catch (e) {
      this.emitError(
        createError('LABEL_FETCH_FAILED', 'Network error while fetching labels', {
          cause: e instanceof Error ? e : undefined,
          context: { url },
        })
      );
    }
  }

  /**
   * 初期化エラーをScatterPlotError型に分類する
   * @param e 発生した例外
   * @returns 分類されたScatterPlotErrorオブジェクト
   */
  private categorizeInitError(e: unknown): ScatterPlotError {
    // シェーダーや pipeline の診断を、WebGPU 非対応という一般エラーへ置き換えない。
    if (e instanceof WebGPUInitializationError) return e.diagnostic;
    const message = e instanceof Error ? e.message : String(e);
    const cause = e instanceof Error ? e : undefined;

    if (message.includes('WebGPU is not supported')) {
      return createError('WEBGPU_NOT_SUPPORTED', message, { cause });
    }
    if (message.includes('GPU adapter') || message.includes('Failed to get GPU adapter')) {
      return createError('GPU_ADAPTER_NOT_AVAILABLE', message, { cause });
    }
    if (message.includes('GPU device') || message.includes('Failed to get GPU device')) {
      return createError('GPU_DEVICE_FAILED', message, { cause });
    }
    if (message.includes('WebGPU context') || message.includes('Failed to get WebGPU context')) {
      return createError('WEBGPU_CONTEXT_FAILED', message, { cause });
    }
    if (message.includes('Database not initialized') || message.includes('not initialized')) {
      return createError('DATA_LAYER_NOT_INITIALIZED', message, { cause });
    }
    if (message.includes('Parquet') || message.includes('parquet') || message.includes('load')) {
      return createError('PARQUET_LOAD_FAILED', message, { cause });
    }

    return createError('WEBGPU_NOT_SUPPORTED', message, { cause });
  }

  /**
   * エラーイベントを発行する。リスナーが登録されていない場合はconsole.warnに出力する
   * @param error 発行するエラーオブジェクト
   */
  private emitError(error: ScatterPlotError): void {
    const hasListeners = this.emit('error', error);
    if (!hasListeners) {
      // eslint-disable-next-line no-console
      console.warn('[duckscatter]', `${error.code}: ${error.message}`);
    }
  }

  /**
   * 散布図をレンダリングする（GPUレイヤーとラベルの両方）
   */
  render(): void {
    this.gpuLayer.render();
    this.labelLayer.render();
    const view = this.getViewState();
    const previous = this.lastView;
    if (
      !previous ||
      view.width !== previous.width ||
      view.height !== previous.height ||
      view.zoom !== previous.zoom ||
      view.panX !== previous.panX ||
      view.panY !== previous.panY
    ) {
      this.lastView = { ...view };
      this.emit('viewchange', view);
    }
  }

  /**
   * GeoJSONデータからラベルを読み込む
   * @param geojsonData ラベルポイントを含むGeoJSON FeatureCollection
   */
  loadLabels(geojsonData: any): void {
    this.labelLayer.loadLabels(geojsonData);
    this.render();
  }

  /**
   * プロットデータを更新して再レンダリングする
   * @param options 更新する設定オプション
   */
  async update(options: Partial<ScatterPlotOptions>): Promise<void> {
    const data = options.data;
    const affectsPoints =
      data !== undefined &&
      (data.sizeSql !== undefined ||
        data.colorSql !== undefined ||
        data.reloadPoints === true ||
        data.whereConditions !== undefined ||
        data.gpuFilterColumns !== undefined ||
        data.gpuWhereConditions !== undefined);
    const attributesChanged =
      data?.sizeSql !== undefined || data?.colorSql !== undefined || data?.reloadPoints === true;
    if (affectsPoints) {
      this.pointDataPending++;
      this.emit('pointdatachange', { pending: true, attributesChanged });
    }
    try {
      await this.applyUpdate(options);
    } finally {
      if (affectsPoints) {
        this.pointDataPending--;
        this.emit('pointdatachange', {
          pending: this.pointDataPending > 0,
          attributesChanged,
        });
      }
    }
  }

  /** 更新開始から完了までを通知したうえで、既存の各レイヤー更新を実行する。 */
  private async applyUpdate(options: Partial<ScatterPlotOptions>): Promise<void> {
    const updatePaths = new Set<ScatterPlotUpdatePath>();
    if (options.data !== undefined) {
      const gpuWhereConditionsChanged = options.data.gpuWhereConditions !== undefined;
      if (gpuWhereConditionsChanged) {
        this.currentGpuWhereConditions = options.data.gpuWhereConditions ?? [];
      }

      const result = await this.dataLayer.updateOptions({
        sizeSql: options.data.sizeSql,
        colorSql: options.data.colorSql,
        reloadPoints: options.data.reloadPoints,
        whereConditions: options.data.whereConditions,
        gpuFilterColumns: options.data.gpuFilterColumns,
      });

      if (result.allPointsChanged) {
        updatePaths.add('duckdb-all-points');
        updatePaths.add('duckdb-visibility-flags');
      } else if (result.visibilityChanged) {
        updatePaths.add('duckdb-visibility-flags');
      }

      if (result.gpuFilterColumnsChanged) {
        updatePaths.add('gpu-filter-columns-buffer');
        const gpuFilterData = await this.dataLayer.loadGpuFilterColumns();
        if (gpuFilterData) {
          this.gpuLayer.uploadFilterColumns(gpuFilterData.data);
          this.gpuFilterColumnMapping = gpuFilterData.columnMapping;
        } else {
          this.gpuFilterColumnMapping.clear();
        }
      }

      // gpuFilterColumns が変わったときも、保持中の gpuWhereConditions を新しい mapping で
      // 再解決する。古い columnIndex が残ったまま別カラムを誤フィルタするのを防ぐ。
      if (result.gpuFilterColumnsChanged || gpuWhereConditionsChanged) {
        const conditions = this.convertGpuWhereConditions(this.currentGpuWhereConditions);
        this.gpuLayer.setGpuFilterConditions(conditions);
        this.dataLayer.setGpuFilterRanges(conditions);
        updatePaths.add('gpu-filter-uniforms');
      }

      if (options.data.filteredPointDisplayMode !== undefined) {
        this.gpuLayer.setFilteredPointDisplayMode(options.data.filteredPointDisplayMode);
        updatePaths.add('gpu-filter-uniforms');
      }
    }

    if (options.gpu !== undefined) {
      this.gpuLayer.updateOptions({
        backgroundColor: options.gpu?.backgroundColor,
        targetRenderTimeMs: options.gpu.targetRenderTimeMs,
        pointAlpha: options.gpu?.pointAlpha,
        pointSizeScale: options.gpu?.pointSizeScale,
        selectionStyle: options.gpu?.selection,
        recededClamp: options.gpu?.recededClamp,
      });
      if (options.gpu.pointSizeScale !== undefined) {
        // 直接の setter と update() の両方で、GPU とホバーの倍率を揃える。
        this.labelLayer.updateOptions({ pointSizeScale: this.gpuLayer.getPointSizeScale() });
        updatePaths.add('label-layer');
      }
      updatePaths.add('gpu-render-uniforms');
    }

    if (options.labels !== undefined) {
      this.labelLayer.updateOptions({
        labelFontSize: options.labels.fontSize,
        filterLambda: options.labels.filterLambda,
        unmatchedLabelOpacity: options.labels.unmatchedLabelOpacity,
        maxRenderedLabels: options.labels.maxRendered,
        onLabelClick: options.labels.onClick,
        hoverOutlineOptions: options.labels.hoverOutlineOptions,
        mutedLambda: options.labels.mutedLambda,
        mutedLabelColor: options.labels.mutedLabelColor,
        mutedLabelOpacity: options.labels.mutedLabelOpacity,
        mutedLabelStyle: options.labels.mutedLabelStyle,
      });

      const labelSource = options.labels.file ?? options.labels.url;
      if (labelSource !== undefined) {
        await this.loadLabelSource(labelSource);
      }
      updatePaths.add('label-layer');
    }

    if (options.interaction !== undefined) {
      this.labelLayer.updateOptions({
        onPointHover: options.interaction?.onPointHover,
        onLabelHover: options.interaction.onLabelHover,
      });
      updatePaths.add('interaction-callbacks');
    }

    this.lastUpdatePlan = this.buildUpdatePlan(updatePaths);
    this.render();
  }

  /**
   * 直近の update() が通った DuckDB/GPU/label 更新経路を取得する。
   * 性能調査や UI 側のデバッグ用。update() 未実行の場合は null。
   */
  getLastUpdatePlan(): ScatterPlotUpdatePlan | null {
    if (!this.lastUpdatePlan) {
      return null;
    }
    return { ...this.lastUpdatePlan, paths: [...this.lastUpdatePlan.paths] };
  }

  private buildUpdatePlan(pathsSet: Set<ScatterPlotUpdatePath>): ScatterPlotUpdatePlan {
    const orderedPaths: ScatterPlotUpdatePath[] = [
      'duckdb-all-points',
      'duckdb-visibility-flags',
      'gpu-filter-columns-buffer',
      'gpu-filter-uniforms',
      'gpu-render-uniforms',
      'label-layer',
      'interaction-callbacks',
    ];
    const paths = orderedPaths.filter((path) => pathsSet.has(path));
    return {
      paths,
      duckdbAllPointsReload: pathsSet.has('duckdb-all-points'),
      duckdbVisibilityReload: pathsSet.has('duckdb-visibility-flags'),
      gpuFilterColumnUpload: pathsSet.has('gpu-filter-columns-buffer'),
      gpuFilterUniformUpdate: pathsSet.has('gpu-filter-uniforms'),
      gpuRenderUniformUpdate: pathsSet.has('gpu-render-uniforms'),
      labelLayerUpdate: pathsSet.has('label-layer'),
      interactionUpdate: pathsSet.has('interaction-callbacks'),
    };
  }

  /**
   * キャンバスをリサイズして再レンダリングする
   * @param width 新しい幅（ピクセル）
   * @param height 新しい高さ（ピクセル）
   */
  resize(width: number, height: number): void {
    this.gpuLayer.resize(width, height);
    this.labelLayer.resize(width, height);
    this.render();
  }

  /**
   * ズームレベルを設定する
   * @param zoom ズームレベル（1.0 = 通常、>1.0 = ズームイン、<1.0 = ズームアウト）
   */
  setZoom(zoom: number): void {
    this.gpuLayer.setZoom(zoom);
    this.syncLabelViewTransform();
    this.render();
  }

  /**
   * 現在のズームレベルを取得する
   * @returns 現在のズームレベル
   */
  getZoom(): number {
    return this.gpuLayer.getZoom();
  }

  /**
   * 指定した倍率でズームインする
   * @param factor ズーム倍率（デフォルト: 1.2）
   */
  zoomIn(factor: number = 1.2): void {
    this.setZoom(this.gpuLayer.getZoom() * factor);
  }

  /**
   * 指定した倍率でズームアウトする
   * @param factor ズーム倍率（デフォルト: 1.2）
   */
  zoomOut(factor: number = 1.2): void {
    this.setZoom(this.gpuLayer.getZoom() / factor);
  }

  /**
   * 指定した画面座標を中心にズームする
   * @param newZoom 新しいズームレベル
   * @param screenX 画面X座標（キャンバスピクセル単位）
   * @param screenY 画面Y座標（キャンバスピクセル単位）
   */
  zoomToPoint(newZoom: number, screenX: number, screenY: number): void {
    this.gpuLayer.zoomToPoint(newZoom, screenX, screenY);
    this.syncLabelViewTransform();
    this.render();
  }

  /**
   * ズームとパンをデフォルト値にリセットする
   */
  resetView(): void {
    this.gpuLayer.setZoom(1.0);
    this.gpuLayer.setPan(0.0, 0.0);
    this.syncLabelViewTransform();
    this.render();
  }

  /**
   * パンオフセットを設定する
   * @param x 正規化座標でのX方向パンオフセット（-1から1）
   * @param y 正規化座標でのY方向パンオフセット（-1から1）
   */
  setPan(x: number, y: number): void {
    this.gpuLayer.setPan(x, y);
    this.syncLabelViewTransform();
    this.render();
  }

  /**
   * 現在のパンオフセットを取得する
   * @returns x, y座標を含むオブジェクト
   */
  getPan(): { x: number; y: number } {
    return this.gpuLayer.getPan();
  }

  /** DOM 側で点の固定座標を投影するための表示状態を取得する。 */
  getViewState(): ScatterPlotView {
    const pan = this.gpuLayer.getPan();
    return {
      width: this.canvas.width,
      height: this.canvas.height,
      zoom: this.gpuLayer.getZoom(),
      panX: pan.x,
      panY: pan.y,
    };
  }

  /**
   * 中心座標が画面内にあるフィルター一致点を、LOD 前の集合から同期的に取得する。
   * 上限 + 1 件で探索を打ち切る。上限超過時は候補を返さず、正確な全件数も数えない。
   * GPU の余白や点の半径、alpha、選択状態は判定に含めない。
   */
  getPointsInViewport(limit: number = 10): ViewportPointQueryResult {
    if (!Number.isSafeInteger(limit) || limit < 0) {
      throw new RangeError('The viewport point limit must be a non-negative safe integer.');
    }
    const view = this.getViewState();
    if (
      !this.pointDataReady ||
      this.pointDataPending > 0 ||
      view.width <= 0 ||
      view.height <= 0 ||
      !Number.isFinite(view.zoom) ||
      view.zoom <= 0 ||
      !Number.isFinite(view.panX) ||
      !Number.isFinite(view.panY)
    ) {
      return { points: [], limitExceeded: false, ready: false };
    }
    const aspect = view.width / view.height;
    const points = this.dataLayer.findPointsInBounds(
      {
        minX: ((-1 - view.panX) * aspect) / view.zoom,
        maxX: ((1 - view.panX) * aspect) / view.zoom,
        minY: (-1 - view.panY) / view.zoom,
        maxY: (1 - view.panY) / view.zoom,
      },
      limit + 1
    );
    const limitExceeded = points.length > limit;
    return { points: limitExceeded ? [] : points, limitExceeded, ready: true };
  }

  /**
   * 指定した差分だけパンする
   * @param dx 正規化座標でのX方向の差分
   * @param dy 正規化座標でのY方向の差分
   */
  pan(dx: number, dy: number): void {
    const currentPan = this.gpuLayer.getPan();
    this.setPan(currentPan.x + dx, currentPan.y + dy);
  }

  /**
   * ラベルレイヤーのビュー変換をGPUレイヤーと同期する
   */
  private syncLabelViewTransform(): void {
    const pan = this.gpuLayer.getPan();
    this.labelLayer.updateViewTransform(this.gpuLayer.getZoom(), pan.x, pan.y);
  }

  /**
   * GpuWhereConditionをGpuLayer用の形式に変換する
   * @param conditions ユーザー指定のGPUフィルター条件
   * @returns GpuLayer用のフィルター条件配列
   */
  private convertGpuWhereConditions(conditions: GpuWhereCondition[]): {
    columnIndex: number;
    min: number;
    max: number;
    fade?: { width: number; edges: 'both' | 'min' | 'max' };
  }[] {
    const ignoredColumns = Array.from(
      new Set(
        conditions.filter((c) => !this.gpuFilterColumnMapping.has(c.column)).map((c) => c.column)
      )
    );
    this.warnIgnoredGpuWhereColumns(ignoredColumns);

    return conditions
      .filter((c) => this.gpuFilterColumnMapping.has(c.column))
      .map((c) => {
        const converted: {
          columnIndex: number;
          min: number;
          max: number;
          fade?: { width: number; edges: 'both' | 'min' | 'max' };
        } = {
          columnIndex: this.gpuFilterColumnMapping.get(c.column)!,
          min: c.min ?? -Infinity,
          max: c.max ?? Infinity,
        };
        if (c.fade && c.fade.width > 0) {
          converted.fade = { width: c.fade.width, edges: c.fade.edges ?? 'both' };
        }
        return converted;
      });
  }

  /**
   * gpuFilterColumns に未登録の gpuWhereConditions.column を CONFIG_WARNING で通知する。
   * 時間窓スライダ等が毎フレーム update() を呼ぶ hot path のため、未登録 column 集合が
   * 前回と変わったときだけ emit する（同一警告の氾濫を防ぐ）。正常化したらキーをクリアし、
   * 次に異常が起きたときに再度 emit できるようにする。
   */
  private warnIgnoredGpuWhereColumns(ignoredColumns: string[]): void {
    const key = JSON.stringify(ignoredColumns.slice().sort());
    if (key === this.lastIgnoredGpuWhereColumnsKey) {
      return;
    }
    this.lastIgnoredGpuWhereColumnsKey = key;
    if (ignoredColumns.length === 0) {
      return;
    }
    this.emitError(
      createError(
        'CONFIG_WARNING',
        'Some gpuWhereConditions were ignored because their columns are not registered in gpuFilterColumns.',
        {
          context: {
            ignoredColumns,
            availableGpuFilterColumns: [...this.gpuFilterColumnMapping.keys()],
          },
        }
      )
    );
  }

  /**
   * カスタムSQLクエリを実行する
   * @param query 実行するSQLクエリ文字列またはtoStringメソッドを持つオブジェクト
   * @returns クエリ結果のParquetData
   */
  async runQuery(query: string | { toString: () => string }): Promise<ParquetData | undefined> {
    return await this.dataLayer.executeQuery(query);
  }

  /** 指定した内部 ID の属性と、現在の式で計算したサイズ・色をまとめて取得する。 */
  async getPointsByIds(pointIds: readonly number[]): Promise<PointAttributes[]> {
    return this.dataLayer.findPointsByIds(pointIds);
  }

  /**
   * 読み込まれたすべてのラベルを取得する
   * @returns ラベルの配列
   */
  getLabels(): Label[] {
    return this.labelLayer.getLabels();
  }

  /**
   * IDを指定してプログラム的にポイントをホバー状態にする
   * @param pointId ホバーするポイントのrowid
   * @returns ポイントが見つかりホバーされた場合はtrue、そうでない場合はfalse
   */
  async setPointHover(pointId: number): Promise<boolean> {
    if (!this.dataLayer.isInitialized()) {
      return false;
    }

    const pointData = await this.dataLayer.findPointById(pointId);
    if (!pointData) {
      return false;
    }

    this.labelLayer.setHoveredPoint(pointData);
    return true;
  }

  /**
   * ポイントのホバー状態をクリアする
   */
  clearPointHover(): void {
    this.labelLayer.setHoveredPoint(null);
  }

  /**
   * 現在ホバー中のポイントデータを取得する
   * @returns ホバー中の場合はポイントデータ、そうでない場合はnull
   */
  getHoveredPoint(): Record<string, any> | null {
    return this.labelLayer.getHoveredPoint();
  }

  /**
   * プログラム的にラベルをホバー状態にする
   * @param identifier ラベル識別子（テキストまたはクラスターで識別）
   * @returns ラベルが見つかりホバーされた場合はtrue、そうでない場合はfalse
   */
  setLabelHover(identifier: LabelIdentifier): boolean {
    const label = this.labelLayer.findLabel(identifier);
    if (!label) {
      return false;
    }

    this.labelLayer.setHoveredLabel(label);
    return true;
  }

  /**
   * ラベルのホバー状態をクリアする
   */
  clearLabelHover(): void {
    this.labelLayer.setHoveredLabel(null);
  }

  /**
   * 現在ホバー中のラベルを取得する
   * @returns ホバー中の場合はラベル、そうでない場合はnull
   */
  getHoveredLabel(): Label | null {
    return this.labelLayer.getHoveredLabel();
  }

  /**
   * すべてのホバー状態をクリアする（ポイント・ラベル・GPU hover-mask）
   */
  clearAllHover(): void {
    this.labelLayer.setHoveredPoint(null);
    this.labelLayer.setHoveredLabel(null);
    // GPU hover-mask も解除する。さもないと setHoveredPointIds で立てた bit が残り、
    // 選択 dim 下で当該 rowid が undim のまま居残る／次に選択が有効化されたとき undim で再出現する。
    // LabelLayer の同期 render はラベルキャンバスのみ再描画するため、点の再描画に this.render() が要る。
    this.gpuLayer.clearHover();
    this.render();
  }

  /**
   * グローバル透明度を設定する
   * @param alpha 透明度 (0.0-1.0)
   */
  setPointAlpha(alpha: number): void {
    this.gpuLayer.setPointAlpha(alpha);
    this.render();
  }

  /**
   * 現在のグローバル透明度を取得する
   * @returns 現在の透明度値 (0.0-1.0)
   */
  getPointAlpha(): number {
    return this.gpuLayer.getPointAlpha();
  }

  /**
   * グローバルサイズスケールを設定する
   * @param scale サイズスケール (0.01以上)
   */
  setPointSizeScale(scale: number): void {
    this.gpuLayer.setPointSizeScale(scale);
    this.labelLayer.updateOptions({ pointSizeScale: this.gpuLayer.getPointSizeScale() });
    this.render();
  }

  /**
   * 現在のグローバルサイズスケールを取得する
   * @returns 現在のサイズスケール値
   */
  getPointSizeScale(): number {
    return this.gpuLayer.getPointSizeScale();
  }

  /**
   * フィルターされたポイントの表示モードを設定する
   * @param mode 'hidden'（非表示）または 'grayed'（灰色表示）
   */
  setFilteredPointDisplayMode(mode: FilteredPointDisplayMode): void {
    this.gpuLayer.setFilteredPointDisplayMode(mode);
    this.render();
  }

  /**
   * 現在のフィルター表示モードを取得する
   * @returns 現在のフィルター表示モード
   */
  getFilteredPointDisplayMode(): FilteredPointDisplayMode {
    return this.gpuLayer.getFilteredPointDisplayMode();
  }

  /**
   * データ空間矩形で selection を更新する（GPU 常駐 mask, CPU 読み戻しなし）。
   * @param bounds データ空間の矩形（順不同で可）
   * @param options 合成モード（既定 'replace'）/ 対象集合（既定 'filtered-data'）
   */
  brushSelect(bounds: BrushBounds, options?: BrushOptions): void {
    this.gpuLayer.brushSelect(bounds, options);
    this.render();
  }

  /**
   * キャンバス画面座標（物理ピクセル）の矩形で selection を更新する。
   * @param rect 画面座標の矩形（順不同で可）
   * @param options 合成モード / 対象集合
   */
  brushSelectScreenRect(rect: ScreenBrushRect, options?: BrushOptions): void {
    this.gpuLayer.brushSelectScreenRect(rect, options);
    this.render();
  }

  /**
   * ポイント ID（rowid）集合で selection を直接設定する。
   * @param ids 選択するポイント ID（= rowid）
   */
  setSelectedPointIds(ids: Iterable<number>): void {
    this.gpuLayer.setSelectedPointIds(ids);
    this.render();
  }

  /**
   * selection を全クリアする。
   */
  clearSelection(): void {
    this.gpuLayer.clearSelection();
    this.render();
  }

  /**
   * ポイント ID（rowid）集合で hover-mask を設定する（selection とは独立）。
   * ホバー中クラスタのノードを selection dim から除外して強調する。空集合 / clearHover で解除。
   * selection（getSelectionCount / brush 等）には一切影響しない。
   * @param ids 強調するポイント ID（= rowid）
   */
  setHoveredPointIds(ids: Iterable<number>): void {
    this.gpuLayer.setHoveredPointIds(ids);
    this.render();
  }

  /**
   * hover-mask を全クリアする（selection には影響しない）。
   */
  clearHover(): void {
    this.gpuLayer.clearHover();
    this.render();
  }

  /**
   * selection の描画スタイルを更新する（部分指定可）。
   * @param style selectedColor / unselectedAlpha / selectedSizeScale
   */
  setSelectionStyle(style: SelectionStyle): void {
    this.gpuLayer.setSelectionStyle(style);
    this.render();
  }

  /**
   * 選択 dim を強制的に有効/無効にする。選択点が0でも true なら全点を dim 表示にする。
   * ブラシ選択の開始時（右ドラッグ開始など、まだ点が捕捉されていない瞬間）に背景を即 dim
   * したいとき用。ジェスチャ終了時に false へ戻すこと。選択が1点以上あるときは無関係。
   * @param active true で選択 dim を強制
   */
  setBrushActive(active: boolean): void {
    this.gpuLayer.setBrushActive(active);
    this.render();
  }

  /**
   * 現在の selection 数を取得する（GPU からの非同期読み戻し）。
   */
  async getSelectionCount(): Promise<number> {
    return this.gpuLayer.getSelectionCount();
  }

  /**
   * 診断用の CPU・FPS・描画件数計測を切り替える。自動 LOD の時間計測は継続する。
   */
  setInstrumentation(on: boolean): void {
    this.gpuLayer.setInstrumentation(on);
  }

  /**
   * 直近フレームの計測値（fps・処理点数・GPU/CPU 時間など）を返す（dev/デバッグ用）。
   */
  getFrameStats(): FrameStats {
    return this.gpuLayer.getFrameStats();
  }

  /**
   * リソースを破棄する
   */
  async destroy(): Promise<void> {
    this.destroyed = true;
    this.pointDataReady = false;
    this.emit('destroy', undefined);
    this.removeAllListeners();
    // 非同期の DB 切断を待つ前に、自動描画と画面上のイベント処理を止める。
    this.gpuLayer.destroy();
    this.labelLayer.destroy();
    await this.dataLayer.destroy();
  }
}
