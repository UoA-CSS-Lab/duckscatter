import { WebGPUContext } from './webgpu-context.js';
import {
  gpuErrorMessage,
  shaderCompilationError,
  WebGPUInitializationError,
} from './gpu-errors.js';
import { createError } from '../errors.js';
import {
  scatterVertexShader,
  filterComputeShader,
  updateIndirectShader,
  brushSelectionShader,
  countSelectionShader,
  compositeShader,
} from './shaders.js';
import type {
  Color4f,
  FilteredPointDisplayMode,
  RecededClampOptions,
  SelectionStyle,
  SelectionBrushMode,
  BrushBounds,
  ScreenBrushRect,
  BrushOptions,
  FrameStats,
  ScatterPlotError,
} from '../types.js';
import { AdaptiveLodController, LodViewMotion } from './adaptive-lod.js';
import { GpuFrameTimer, type GpuFrameSample } from './gpu-frame-timer.js';
import { getLodSizeCutoff, type LodSizeDistribution } from '../data/lod.js';

/** render uniform buffer サイズ（selection style + 受動クランプフィールドを含む, byte） */
const RENDER_UNIFORM_SIZE = 192;
/** composite uniform buffer サイズ（maxAlpha, byte） */
const COMPOSITE_UNIFORM_SIZE = 16;
/** brush compute uniform buffer サイズ（byte） */
const BRUSH_UNIFORM_SIZE = 80;
/** count compute uniform buffer サイズ（byte） */
const COUNT_UNIFORM_SIZE = 16;
/** 校正が不安定な環境でも、操作後の自動再描画を有限回で止める。 */
const MAX_REFINEMENT_FRAMES = 96;
/** SelectionBrushMode → shader 内合成コード */
const BRUSH_MODE_CODE: Record<SelectionBrushMode, number> = {
  replace: 0,
  add: 1,
  subtract: 2,
  toggle: 3,
};
/** 既定の selection 描画スタイル（黄系の強調色） */
const DEFAULT_SELECTION_STYLE: Required<SelectionStyle> = {
  selectedColor: { r: 1.0, g: 0.85, b: 0.2, a: 1.0 },
  unselectedAlpha: 0.25,
  selectedSizeScale: 1.35,
  highlightSelected: true,
};

/**
 * GPU用に処理されたポイントデータ
 */
export interface AllPointsData {
  /**
   * 点順の (x, y, color, size)。color の領域は u32 のビット列として保持する。
   * 元の Arrow バッファの一部を使う場合があるため、転送には byteOffset と byteLength を使う。
   */
  instanceData: Float32Array;
  /** 全ポイント数 */
  totalCount: number;
  /** 俯瞰で大きい点を優先するためのサイズ別累積件数。CPU だけで保持し、GPU へは境界値を渡す。 */
  lodSizeDistribution?: LodSizeDistribution;
}

/**
 * GpuLayerの設定オプション
 */
export interface GpuLayerOptions {
  /** 描画対象のHTMLCanvasElement */
  canvas: HTMLCanvasElement;
  /** 背景色（デフォルト: 透明な黒） */
  backgroundColor?: Color4f;
  /** 自動 LOD の目標 GPU 処理時間 (ms、既定 1000 / 60)。 */
  targetRenderTimeMs?: number;
  /** グローバル透明度 (0.0-1.0, デフォルト: 1.0) */
  pointAlpha?: number;
  /** グローバルサイズスケール (デフォルト: 1.0) */
  pointSizeScale?: number;
  /** selection mask の描画スタイル */
  selectionStyle?: SelectionStyle;
  /** 受動層（dim/gray）のオーバードロークランプ */
  recededClamp?: RecededClampOptions;
  /** 非同期の GPU エラーも利用側へ伝える。 */
  onError?: (error: ScatterPlotError) => void;
}

// ビューポート境界のマージン（クリップ空間）
const VIEWPORT_MARGIN = 0.1;

/**
 * WebGPUレンダリングを担当するレイヤー
 * 責務:
 * - WebGPUコンテキストとパイプラインの管理
 * - GPUバッファの作成と管理
 * - コンピュートシェーダーによるLODフィルタリング
 * - Indirect Drawingによるレンダリング
 */
export class GpuLayer {
  /** WebGPUコンテキスト */
  private context: WebGPUContext;
  /** 描画対象のキャンバス */
  private readonly canvas: HTMLCanvasElement;

  /** レンダーパイプライン */
  private renderPipeline: GPURenderPipeline | null = null;
  /** フィルタリング用コンピュートパイプライン */
  private filterPipeline: GPUComputePipeline | null = null;
  /** Indirect Buffer更新用コンピュートパイプライン */
  private updateIndirectPipeline: GPUComputePipeline | null = null;
  /** brush selection 用コンピュートパイプライン */
  private brushSelectionPipeline: GPUComputePipeline | null = null;
  /** selection 集計用コンピュートパイプライン */
  private countSelectionPipeline: GPUComputePipeline | null = null;

  /** クワッド頂点バッファ（stepMode: 'vertex'） */
  private quadVertexBuffer: GPUBuffer | null = null;
  /** 全ポイントデータバッファ (Storage) */
  private allPointsBuffer: GPUBuffer | null = null;
  /** 可視ポイントインデックスバッファ (Storage) */
  private visibleIndicesBuffer: GPUBuffer | null = null;
  /** アトミックカウンターバッファ (Storage) */
  private atomicCounterBuffer: GPUBuffer | null = null;
  /** Indirect Drawingパラメータバッファ */
  private indirectBuffer: GPUBuffer | null = null;
  /** インデックスバッファ */
  private indexBuffer: GPUBuffer | null = null;
  /** レンダリング用ユニフォームバッファ */
  private renderUniformBuffer: GPUBuffer | null = null;
  /** コンピュート用ユニフォームバッファ */
  private computeUniformBuffer: GPUBuffer | null = null;
  /** GPUフィルターカラムデータバッファ */
  private filterColumnsBuffer: GPUBuffer | null = null;
  /** WHERE条件による可視/非可視ビットマップバッファ */
  private visibilityFlagsBuffer: GPUBuffer | null = null;
  /** サイズ境界の二分探索に使う累積件数。点数に比例する LOD 用 GPU バッファは作らない。 */
  private lodSizeDistribution: LodSizeDistribution | undefined;
  /** GPU 常駐 selection bitset（1bit/point, brush で atomic 更新） */
  private selectionFlagsBuffer: GPUBuffer | null = null;
  /** selection bit 数（render の強調/減衰ゲート用, u32×1） */
  private selectionCountBuffer: GPUBuffer | null = null;
  /** GPU 常駐 hover bitset（1bit/point）。ホバー中クラスタのノードを selection dim から除外して強調。selection とは独立 */
  private hoverFlagsBuffer: GPUBuffer | null = null;
  /** brush compute 用 uniform バッファ */
  private brushUniformBuffer: GPUBuffer | null = null;
  /** count compute 用 uniform バッファ */
  private countUniformBuffer: GPUBuffer | null = null;
  /** 非同期の読み戻し中だけ保持する一時バッファ。終了・破棄時には計測対象から外す。 */
  private readonly readbackBuffers = new Set<GPUBuffer>();

  /** フィルター済みポイントインデックスバッファ (Storage) */
  private filteredIndicesBuffer: GPUBuffer | null = null;
  /** フィルター済みポイント用アトミックカウンターバッファ (Storage) */
  private filteredCounterBuffer: GPUBuffer | null = null;
  /** フィルター済みポイント用Indirect Drawingパラメータバッファ */
  private filteredIndirectBuffer: GPUBuffer | null = null;
  /** フィルター済みポイント用レンダリングユニフォームバッファ */
  private filteredRenderUniformBuffer: GPUBuffer | null = null;

  // --- 受動層オーバードロークランプ（dim/gray をオフスクリーン累積→合成時に alpha 頭打ち）---
  /** 受動層描画用 uniform（renderMode=1）。renderBindGroup と同構成で binding0 のみ差し替え */
  private recededRenderUniformBuffer: GPUBuffer | null = null;
  /** 受動層描画用バインドグループ（renderMode=1） */
  private recededRenderBindGroup: GPUBindGroup | null = null;
  /** 受動層を累積するオフスクリーンRT（canvas サイズ・format 一致） */
  private offscreenTexture: GPUTexture | null = null;
  /** オフスクリーンを clamp 合成するパイプライン */
  private compositePipeline: GPURenderPipeline | null = null;
  /** composite 用 sampler */
  private compositeSampler: GPUSampler | null = null;
  /** composite 用 uniform（maxAlpha） */
  private compositeUniformBuffer: GPUBuffer | null = null;
  /** composite 用バインドグループ（offscreen 再生成時に作り直す） */
  private compositeBindGroup: GPUBindGroup | null = null;
  /** オフスクリーンの現サイズ（canvas と不一致なら再生成） */
  private offscreenWidth = 0;
  private offscreenHeight = 0;
  /** 受動クランプ有効か（無効なら従来の単一パス＝後方互換） */
  private recededClampEnabled = false;
  /** 受動層の累積 alpha 上限 */
  private recededMaxAlpha = 0.5;
  /** 受動とみなす予約色 [r,g,b]（0-255）。null=色ベース判定なし（dim のみ受動） */
  private recededColor: [number, number, number] | null = null;

  /** GPUフィルター条件（range + optional soft-edge fade） */
  private gpuFilterConditions: {
    columnIndex: number;
    min: number;
    max: number;
    fade?: { width: number; edges: 'both' | 'min' | 'max' };
  }[] = [];
  /** WHERE条件フィルタが有効かどうか */
  private whereFilterEnabled: boolean = false;

  /** レンダリング用バインドグループ */
  private renderBindGroup: GPUBindGroup | null = null;
  /** フィルタリング用バインドグループ */
  private filterBindGroup: GPUBindGroup | null = null;
  /** Indirect更新用バインドグループ */
  private updateIndirectBindGroup: GPUBindGroup | null = null;
  /** フィルター済みポイント用レンダリングバインドグループ */
  private filteredRenderBindGroup: GPUBindGroup | null = null;
  /** フィルター済みポイント用Indirect更新バインドグループ */
  private filteredUpdateIndirectBindGroup: GPUBindGroup | null = null;
  /** brush selection 用バインドグループ */
  private brushSelectionBindGroup: GPUBindGroup | null = null;
  /** selection 集計用バインドグループ */
  private countSelectionBindGroup: GPUBindGroup | null = null;

  /** フィルターされたポイントの表示モード */
  private filteredPointDisplayMode: FilteredPointDisplayMode = 'hidden';

  /** 全ポイント数 */
  private totalPointCount: number = 0;
  /** 背景色 */
  private backgroundColor: Color4f = { r: 0, g: 0, b: 0, a: 0 };
  /** 目標時間に合わせて、点を残す割合を自動調整する。 */
  private readonly adaptiveLod: AdaptiveLodController;
  private frameTimer: GpuFrameTimer | null = null;
  /** データや目標時間が変わった後に、以前の計測を適用しないための世代。 */
  private timingGeneration = 0;
  private renderTimeMs: number | null = null;
  private renderTimeSource: FrameStats['renderTimeSource'] = null;
  private refinementFrame: number | null = null;
  private refinementTimeout: ReturnType<typeof setTimeout> | null = null;
  private readonly viewMotion = new LodViewMotion();
  private refinementFramesRemaining = 0;
  private needsTimingSample = false;
  private disposed = false;
  /** フィルタリング結果が有効かどうか */
  private filterResultValid: boolean = false;

  /** 現在のズームレベル */
  private zoom: number = 1.0;
  /** 現在のX方向パンオフセット */
  private panX: number = 0.0;
  /** 現在のY方向パンオフセット */
  private panY: number = 0.0;
  /** グローバル透明度 (0.0-1.0) */
  private pointAlpha: number = 1.0;
  /** グローバルサイズスケール */
  private pointSizeScale: number = 1.0;
  /** selection 描画スタイル */
  private selectionStyle: Required<SelectionStyle> = DEFAULT_SELECTION_STYLE;
  /** 選択点が0でも選択 dim を強制するか（ブラシ操作開始時に背景を即 dim する用） */
  private forceSelectionActive = false;

  // 診断用の CPU・FPS・描画件数。自動 LOD 用の時間計測は、この設定と独立して動作する。
  private instrument = false;
  private statPrevRenderTs = 0;
  private statFps = 0;
  private statComputeRan = false;
  private statProcessed = 0;
  private statDrawn = 0;
  private statCpuMs = 0;
  private statGpuComputeMs = 0;
  private statGpuIdleMs = 0;
  private statDrawnInFlight = false;
  private statDrawnStatus: FrameStats['drawnCountStatus'] = 'pending';

  /**
   * GpuLayerインスタンスを作成する
   * @param options 設定オプション
   */
  constructor(options: GpuLayerOptions) {
    this.canvas = options.canvas;
    this.context = new WebGPUContext(options.onError);
    this.backgroundColor = options.backgroundColor ?? { r: 0, g: 0, b: 0, a: 0 };
    this.adaptiveLod = new AdaptiveLodController(options.targetRenderTimeMs);
    this.pointAlpha = Math.max(0, Math.min(1, options.pointAlpha ?? 1.0));
    this.pointSizeScale = Math.max(0.01, options.pointSizeScale ?? 1.0);
    this.selectionStyle = this.resolveSelectionStyle(options.selectionStyle);
    this.applyRecededClamp(options.recededClamp);
  }

  /** 部分指定の SelectionStyle を既定値で埋める */
  private resolveSelectionStyle(style?: SelectionStyle): Required<SelectionStyle> {
    return {
      selectedColor: style?.selectedColor ?? DEFAULT_SELECTION_STYLE.selectedColor,
      unselectedAlpha: style?.unselectedAlpha ?? DEFAULT_SELECTION_STYLE.unselectedAlpha,
      selectedSizeScale: style?.selectedSizeScale ?? DEFAULT_SELECTION_STYLE.selectedSizeScale,
      highlightSelected: style?.highlightSelected ?? DEFAULT_SELECTION_STYLE.highlightSelected,
    };
  }

  /**
   * WebGPUを初期化し、レンダリングリソースを作成する
   * @param initialData 初期データ
   */
  async initialize(initialData: AllPointsData): Promise<void> {
    this.cancelRefinement();
    this.disposed = false;
    this.timingGeneration++;
    this.frameTimer?.destroy();
    this.adaptiveLod.reset();
    this.viewMotion.reset();
    await this.context.initialize(this.canvas);
    this.frameTimer = new GpuFrameTimer(this.context.device!);
    await this.createPipelines();
    await this.createBuffers(initialData);
    this.createBindGroups();
  }

  /**
   * パイプラインを作成する
   */
  private async createPipelines(): Promise<void> {
    const device = this.context.device;
    if (!device) {
      throw new Error('WebGPU device not initialized');
    }

    // 互いに独立したモジュールは並行して検査し、失敗したシェーダーの名前と行番号を残す。
    const [filterModule, indirectModule, renderModule, compositeModule, brushModule, countModule] =
      await Promise.all([
        this.createShaderModule('point-visibility-filter', filterComputeShader),
        this.createShaderModule('point-indirect-arguments', updateIndirectShader),
        this.createShaderModule('point-render', scatterVertexShader),
        this.createShaderModule('receded-composite', compositeShader),
        this.createShaderModule('brush-selection', brushSelectionShader),
        this.createShaderModule('selection-count', countSelectionShader),
      ]);

    const quadVertexBufferLayout: GPUVertexBufferLayout = {
      arrayStride: 8,
      stepMode: 'vertex',
      attributes: [
        {
          format: 'float32x2',
          offset: 0,
          shaderLocation: 0,
        },
      ],
    };

    const renderDescriptor: GPURenderPipelineDescriptor = {
      label: 'point-render',
      layout: 'auto',
      vertex: {
        module: renderModule,
        entryPoint: 'vertexMain',
        buffers: [quadVertexBufferLayout],
      },
      fragment: {
        module: renderModule,
        entryPoint: 'fragmentMain',
        targets: [
          {
            format: this.context.format,
            blend: {
              color: {
                srcFactor: 'src-alpha',
                dstFactor: 'one-minus-src-alpha',
                operation: 'add',
              },
              alpha: {
                srcFactor: 'one',
                dstFactor: 'one-minus-src-alpha',
                operation: 'add',
              },
            },
          },
        ],
      },
      primitive: {
        topology: 'triangle-list',
      },
    };

    // 受動層クランプ用 composite パイプライン（オフスクリーンをサンプルし alpha を頭打ちにして合成）。
    // composite の出力は premultiplied なので blend は premultiplied-over（src=one）。
    const compositeDescriptor: GPURenderPipelineDescriptor = {
      label: 'receded-composite',
      layout: 'auto',
      vertex: { module: compositeModule, entryPoint: 'vertexMain' },
      fragment: {
        module: compositeModule,
        entryPoint: 'fragmentMain',
        targets: [
          {
            format: this.context.format,
            blend: {
              color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
              alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            },
          },
        ],
      },
      primitive: { topology: 'triangle-list' },
    };

    // 非同期 API は、無効な pipeline を後段へ渡さず、作成失敗を Promise の拒否で通知する。
    [
      this.filterPipeline,
      this.updateIndirectPipeline,
      this.renderPipeline,
      this.compositePipeline,
      this.brushSelectionPipeline,
      this.countSelectionPipeline,
    ] = await Promise.all([
      this.createPipeline('point-visibility-filter', () =>
        device.createComputePipelineAsync({
          label: 'point-visibility-filter',
          layout: 'auto',
          compute: { module: filterModule, entryPoint: 'main' },
        })
      ),
      this.createPipeline('point-indirect-arguments', () =>
        device.createComputePipelineAsync({
          label: 'point-indirect-arguments',
          layout: 'auto',
          compute: { module: indirectModule, entryPoint: 'main' },
        })
      ),
      this.createPipeline('point-render', () => device.createRenderPipelineAsync(renderDescriptor)),
      this.createPipeline('receded-composite', () =>
        device.createRenderPipelineAsync(compositeDescriptor)
      ),
      this.createPipeline('brush-selection', () =>
        device.createComputePipelineAsync({
          label: 'brush-selection',
          layout: 'auto',
          compute: { module: brushModule, entryPoint: 'main' },
        })
      ),
      this.createPipeline('selection-count', () =>
        device.createComputePipelineAsync({
          label: 'selection-count',
          layout: 'auto',
          compute: { module: countModule, entryPoint: 'main' },
        })
      ),
    ]);
    this.compositeSampler = device.createSampler({
      magFilter: 'nearest',
      minFilter: 'nearest',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });
  }

  /** コンパイル結果を取得し、警告だけのモジュールはそのまま利用する。 */
  private async createShaderModule(label: string, code: string): Promise<GPUShaderModule> {
    const device = this.context.device;
    if (!device) throw new Error('WebGPU device not initialized');
    try {
      const module = device.createShaderModule({ label, code });
      const info = await module.getCompilationInfo();
      const error = shaderCompilationError(label, code, info.messages);
      if (error) throw new WebGPUInitializationError(error);
      return module;
    } catch (error) {
      if (error instanceof WebGPUInitializationError) throw error;
      throw new WebGPUInitializationError(
        createError(
          'GPU_SHADER_FAILED',
          `Shader creation failed [${label}]: ${gpuErrorMessage(error)}`,
          {
            cause: error instanceof Error ? error : undefined,
            context: { shader: label },
          }
        )
      );
    }
  }

  /** pipeline の検証・Metal 等へのコンパイル失敗を、名前と元のメッセージ付きで伝える。 */
  private async createPipeline<T>(label: string, create: () => Promise<T>): Promise<T> {
    try {
      return await create();
    } catch (error) {
      throw new WebGPUInitializationError(
        createError(
          'GPU_PIPELINE_FAILED',
          `Pipeline creation failed [${label}]: ${gpuErrorMessage(error)}`,
          {
            cause: error instanceof Error ? error : undefined,
            context: { pipeline: label },
          }
        )
      );
    }
  }

  /**
   * バッファを作成する
   * @param data 初期データ
   */
  private async createBuffers(data: AllPointsData): Promise<void> {
    if (!this.context.device) return;

    this.totalPointCount = data.totalCount;

    const quadVertices = new Float32Array([-1.0, -1.0, 1.0, -1.0, -1.0, 1.0, 1.0, 1.0]);
    this.quadVertexBuffer = this.context.device.createBuffer({
      size: quadVertices.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.context.device.queue.writeBuffer(this.quadVertexBuffer, 0, quadVertices);

    const pointsBufferSize = data.totalCount * 16;
    this.allPointsBuffer = this.context.device.createBuffer({
      label: 'all-points',
      size: pointsBufferSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.context.device.queue.writeBuffer(
      this.allPointsBuffer,
      0,
      data.instanceData.buffer,
      data.instanceData.byteOffset,
      data.instanceData.byteLength
    );

    const indicesBufferSize = data.totalCount * 4;
    this.visibleIndicesBuffer = this.context.device.createBuffer({
      label: 'visible-point-indices',
      size: indicesBufferSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.VERTEX,
    });

    this.atomicCounterBuffer = this.context.device.createBuffer({
      label: 'visible-point-count',
      size: 4,
      // COPY_SRC: 計測（readDrawnCount）が描画点数を atomicCounter から読み戻すために必要。
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    });

    this.indirectBuffer = this.context.device.createBuffer({
      label: 'point-indirect-arguments',
      size: 20,
      usage: GPUBufferUsage.INDIRECT | GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    const indices = new Uint16Array([0, 1, 2, 2, 1, 3]);
    this.indexBuffer = this.context.device.createBuffer({
      size: indices.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    this.context.device.queue.writeBuffer(this.indexBuffer, 0, indices);

    this.renderUniformBuffer = this.context.device.createBuffer({
      size: RENDER_UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.computeUniformBuffer = this.context.device.createBuffer({
      size: 80,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // フィルター済みポイント用バッファ
    this.filteredIndicesBuffer = this.context.device.createBuffer({
      size: indicesBufferSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.VERTEX,
    });

    this.filteredCounterBuffer = this.context.device.createBuffer({
      size: 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    this.filteredIndirectBuffer = this.context.device.createBuffer({
      size: 20,
      usage: GPUBufferUsage.INDIRECT | GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    this.filteredRenderUniformBuffer = this.context.device.createBuffer({
      size: RENDER_UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // 受動層描画用 uniform（renderMode=1）と composite 用 uniform（maxAlpha）。
    this.recededRenderUniformBuffer = this.context.device.createBuffer({
      size: RENDER_UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.compositeUniformBuffer = this.context.device.createBuffer({
      size: COMPOSITE_UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const filterColumnsBufferSize = Math.max(16, data.totalCount * 16);
    this.filterColumnsBuffer = this.context.device.createBuffer({
      label: 'point-filter-columns',
      size: filterColumnsBufferSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    // Visibility flags buffer: ceil(totalCount / 32) * 4 bytes (1 bit per point)
    const visibilityFlagsSize = Math.max(4, Math.ceil(data.totalCount / 32) * 4);
    this.visibilityFlagsBuffer = this.context.device.createBuffer({
      label: 'where-visibility-flags',
      size: visibilityFlagsSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    // Initialize all bits to 1 (all visible)
    const initialFlags = new Uint32Array(Math.ceil(data.totalCount / 32));
    initialFlags.fill(0xffffffff);
    this.context.device.queue.writeBuffer(this.visibilityFlagsBuffer, 0, initialFlags);

    this.lodSizeDistribution = data.lodSizeDistribution;

    // selection 用バッファ（bitset + count + brush/count uniform）
    this.createSelectionBuffers(data.totalCount);

    this.updateUniforms();
  }

  /**
   * selection 用 GPU バッファ群を（再）生成し初期化する。
   * selectionFlags（bitset）はサイズが totalCount に依存するため毎回作り直す。
   * count/brush/count-uniform は固定サイズなので未生成時のみ作る。
   */
  private createSelectionBuffers(totalCount: number): void {
    if (!this.context.device) return;

    const wordCount = Math.max(1, Math.ceil(totalCount / 32));

    this.selectionFlagsBuffer?.destroy();
    this.selectionFlagsBuffer = this.context.device.createBuffer({
      size: wordCount * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    // 初期状態は全 bit 0（未選択）
    this.context.device.queue.writeBuffer(this.selectionFlagsBuffer, 0, new Uint32Array(wordCount));

    // hover-mask bitset（selection と同型・別バッファ）。点集合が変わるたびに作り直してクリアする。
    this.hoverFlagsBuffer?.destroy();
    this.hoverFlagsBuffer = this.context.device.createBuffer({
      size: wordCount * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.context.device.queue.writeBuffer(this.hoverFlagsBuffer, 0, new Uint32Array(wordCount));

    if (!this.selectionCountBuffer) {
      this.selectionCountBuffer = this.context.device.createBuffer({
        size: 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
      });
    }
    this.context.device.queue.writeBuffer(this.selectionCountBuffer, 0, new Uint32Array([0]));

    if (!this.brushUniformBuffer) {
      this.brushUniformBuffer = this.context.device.createBuffer({
        size: BRUSH_UNIFORM_SIZE,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
    }
    if (!this.countUniformBuffer) {
      this.countUniformBuffer = this.context.device.createBuffer({
        size: COUNT_UNIFORM_SIZE,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
    }
    // count uniform は wordCount のみ保持（N 変化時に更新）
    this.context.device.queue.writeBuffer(
      this.countUniformBuffer,
      0,
      new Uint32Array([wordCount, 0, 0, 0])
    );
  }

  /**
   * バインドグループを作成する
   */
  private createBindGroups(): void {
    if (
      !this.context.device ||
      !this.filterPipeline ||
      !this.updateIndirectPipeline ||
      !this.renderPipeline ||
      !this.allPointsBuffer ||
      !this.visibleIndicesBuffer ||
      !this.atomicCounterBuffer ||
      !this.indirectBuffer ||
      !this.computeUniformBuffer ||
      !this.renderUniformBuffer ||
      !this.filterColumnsBuffer ||
      !this.visibilityFlagsBuffer ||
      !this.filteredIndicesBuffer ||
      !this.filteredCounterBuffer ||
      !this.filteredIndirectBuffer ||
      !this.filteredRenderUniformBuffer ||
      !this.recededRenderUniformBuffer ||
      !this.brushSelectionPipeline ||
      !this.countSelectionPipeline ||
      !this.selectionFlagsBuffer ||
      !this.selectionCountBuffer ||
      !this.hoverFlagsBuffer ||
      !this.brushUniformBuffer ||
      !this.countUniformBuffer
    ) {
      return;
    }

    this.filterBindGroup = this.context.device.createBindGroup({
      layout: this.filterPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.allPointsBuffer } },
        { binding: 1, resource: { buffer: this.visibleIndicesBuffer } },
        { binding: 2, resource: { buffer: this.atomicCounterBuffer } },
        { binding: 3, resource: { buffer: this.computeUniformBuffer } },
        { binding: 4, resource: { buffer: this.filterColumnsBuffer } },
        { binding: 5, resource: { buffer: this.visibilityFlagsBuffer } },
        { binding: 6, resource: { buffer: this.filteredIndicesBuffer } },
        { binding: 7, resource: { buffer: this.filteredCounterBuffer } },
      ],
    });

    this.updateIndirectBindGroup = this.context.device.createBindGroup({
      layout: this.updateIndirectPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.atomicCounterBuffer } },
        { binding: 1, resource: { buffer: this.indirectBuffer } },
      ],
    });

    this.filteredUpdateIndirectBindGroup = this.context.device.createBindGroup({
      layout: this.updateIndirectPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.filteredCounterBuffer } },
        { binding: 1, resource: { buffer: this.filteredIndirectBuffer } },
      ],
    });

    this.renderBindGroup = this.context.device.createBindGroup({
      layout: this.renderPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.renderUniformBuffer } },
        { binding: 1, resource: { buffer: this.allPointsBuffer } },
        { binding: 2, resource: { buffer: this.visibleIndicesBuffer } },
        { binding: 3, resource: { buffer: this.filterColumnsBuffer } },
        { binding: 4, resource: { buffer: this.selectionFlagsBuffer } },
        { binding: 5, resource: { buffer: this.selectionCountBuffer } },
        { binding: 6, resource: { buffer: this.hoverFlagsBuffer } },
      ],
    });

    // 受動層描画用（renderMode=1）。renderBindGroup と同じ可視インデックスで uniform だけ差し替え。
    this.recededRenderBindGroup = this.context.device.createBindGroup({
      layout: this.renderPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.recededRenderUniformBuffer } },
        { binding: 1, resource: { buffer: this.allPointsBuffer } },
        { binding: 2, resource: { buffer: this.visibleIndicesBuffer } },
        { binding: 3, resource: { buffer: this.filterColumnsBuffer } },
        { binding: 4, resource: { buffer: this.selectionFlagsBuffer } },
        { binding: 5, resource: { buffer: this.selectionCountBuffer } },
        { binding: 6, resource: { buffer: this.hoverFlagsBuffer } },
      ],
    });

    this.filteredRenderBindGroup = this.context.device.createBindGroup({
      layout: this.renderPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.filteredRenderUniformBuffer } },
        { binding: 1, resource: { buffer: this.allPointsBuffer } },
        { binding: 2, resource: { buffer: this.filteredIndicesBuffer } },
        { binding: 3, resource: { buffer: this.filterColumnsBuffer } },
        { binding: 4, resource: { buffer: this.selectionFlagsBuffer } },
        { binding: 5, resource: { buffer: this.selectionCountBuffer } },
        { binding: 6, resource: { buffer: this.hoverFlagsBuffer } },
      ],
    });

    this.brushSelectionBindGroup = this.context.device.createBindGroup({
      layout: this.brushSelectionPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.allPointsBuffer } },
        { binding: 1, resource: { buffer: this.selectionFlagsBuffer } },
        { binding: 2, resource: { buffer: this.brushUniformBuffer } },
        { binding: 3, resource: { buffer: this.filterColumnsBuffer } },
        { binding: 4, resource: { buffer: this.visibilityFlagsBuffer } },
      ],
    });

    this.countSelectionBindGroup = this.context.device.createBindGroup({
      layout: this.countSelectionPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.selectionFlagsBuffer } },
        { binding: 1, resource: { buffer: this.selectionCountBuffer } },
        { binding: 2, resource: { buffer: this.countUniformBuffer } },
      ],
    });
  }

  /**
   * 全ポイントデータをアップロードする
   * @param data 新しいポイントデータ
   */
  uploadAllPoints(data: AllPointsData): void {
    if (!this.context.device) return;

    this.invalidateTiming();

    const newTotalCount = data.totalCount;
    const countChanged = newTotalCount !== this.totalPointCount;

    if (newTotalCount > this.totalPointCount) {
      this.allPointsBuffer?.destroy();
      this.visibleIndicesBuffer?.destroy();
      this.visibilityFlagsBuffer?.destroy();
      this.filteredIndicesBuffer?.destroy();

      const pointsBufferSize = newTotalCount * 16;
      this.allPointsBuffer = this.context.device.createBuffer({
        size: pointsBufferSize,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });

      const indicesBufferSize = newTotalCount * 4;
      this.visibleIndicesBuffer = this.context.device.createBuffer({
        size: indicesBufferSize,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.VERTEX,
      });

      this.filteredIndicesBuffer = this.context.device.createBuffer({
        size: indicesBufferSize,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.VERTEX,
      });

      // Recreate visibility flags buffer
      const visibilityFlagsSize = Math.max(4, Math.ceil(newTotalCount / 32) * 4);
      this.visibilityFlagsBuffer = this.context.device.createBuffer({
        size: visibilityFlagsSize,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      // Initialize all bits to 1 (all visible)
      const initialFlags = new Uint32Array(Math.ceil(newTotalCount / 32));
      initialFlags.fill(0xffffffff);
      this.context.device.queue.writeBuffer(this.visibilityFlagsBuffer, 0, initialFlags);
      this.whereFilterEnabled = false;
    }

    if (countChanged) {
      // ポイント集合が変わった（増減いずれも）。selection は index(rowid) ベースのため無効化し、
      // bitset / count / countUniform を新しい totalCount に合わせて作り直してクリアする。
      // 縮小時に作り直さないと、旧 bitset の範囲外 bit が count されて getSelectionCount() が
      // 過大になり、存在しない点の減衰が残ってしまう（同一カウントの再 materialize 時は
      // rowid が不変なので selection を保持する）。createBindGroups は拡大時に作り直した
      // 大バッファと新しい selection バッファの両方を rebind する。
      this.createSelectionBuffers(newTotalCount);
      this.createBindGroups();
    }

    this.totalPointCount = newTotalCount;
    this.filterResultValid = false;

    if (this.allPointsBuffer) {
      this.context.device.queue.writeBuffer(
        this.allPointsBuffer,
        0,
        data.instanceData.buffer,
        data.instanceData.byteOffset,
        data.instanceData.byteLength
      );
    }
    // 同じ点数のサイズ変更でも、新しい分布から境界を計算し直す。
    this.lodSizeDistribution = data.lodSizeDistribution;
    this.updateUniforms();
  }

  /**
   * ビュー行列を作成する
   */
  private createViewMatrix(): Float32Array {
    const aspectRatio = this.canvas.width / this.canvas.height;
    return new Float32Array([
      this.zoom / aspectRatio,
      0,
      0,
      0,
      0,
      this.zoom,
      0,
      0,
      0,
      0,
      1,
      0,
      this.panX,
      this.panY,
      0,
      1,
    ]);
  }

  /**
   * 計測から決めた保持率を、固定ハッシュと比較する u32 の閾値に変換する。
   */
  private calculateLodThreshold(): number {
    return Math.floor(0xffffffff * this.adaptiveLod.keepRatio);
  }

  /**
   * ユニフォームを更新する
   */
  updateUniforms(): void {
    if (!this.context.device || !this.renderUniformBuffer || !this.computeUniformBuffer) {
      return;
    }

    this.filterResultValid = false;

    const viewMatrix = this.createViewMatrix();

    // GPUフィルタ条件から、フィルタ範囲（compute/render 共用）と
    // per-column soft-edge フェード（render 専用）をまとめて構築する。
    let activeFilterMask = 0;
    const filterRangeMin = [-Infinity, -Infinity, -Infinity, -Infinity];
    const filterRangeMax = [Infinity, Infinity, Infinity, Infinity];
    const fadeWidth = [0, 0, 0, 0];
    // 2bit/列: bit(2c)=min端をフェード, bit(2c+1)=max端をフェード
    let fadeEdgeFlags = 0;
    for (const condition of this.gpuFilterConditions) {
      const c = condition.columnIndex;
      if (c >= 0 && c < 4) {
        activeFilterMask |= 1 << c;
        filterRangeMin[c] = condition.min;
        filterRangeMax[c] = condition.max;
        if (condition.fade && condition.fade.width > 0) {
          fadeWidth[c] = condition.fade.width;
          const edges = condition.fade.edges;
          if (edges !== 'max') fadeEdgeFlags |= 1 << (2 * c); // min端
          if (edges !== 'min') fadeEdgeFlags |= 1 << (2 * c + 1); // max端
        }
      }
    }

    // render uniform: f32 と u32 が混在するため ArrayBuffer に2つのビューを張る
    const renderUniformData = new ArrayBuffer(RENDER_UNIFORM_SIZE);
    const renderFloatView = new Float32Array(renderUniformData);
    const renderUint32View = new Uint32Array(renderUniformData);
    renderFloatView.set(viewMatrix, 0);
    // Vertex Shaderで pow(zoom, 0.3) を計算するコストを避けるため、CPUで事前に計算して渡す
    renderFloatView[16] = Math.pow(this.zoom, 0.3);
    renderFloatView[17] = this.canvas.width;
    renderFloatView[18] = this.canvas.height;
    renderFloatView[19] = this.pointAlpha;
    renderFloatView[20] = this.pointSizeScale;
    // grayedMode: 0.0 (通常ポイント用)
    renderFloatView[21] = 0.0;
    // per-column soft-edge フェード（gpuWhereConditions.fade）
    renderUint32View[22] = fadeEdgeFlags >>> 0;
    // [23] = padding(u32)
    renderFloatView[24] = filterRangeMin[0]; // filterRangeMin: vec4 @ byte 96
    renderFloatView[25] = filterRangeMin[1];
    renderFloatView[26] = filterRangeMin[2];
    renderFloatView[27] = filterRangeMin[3];
    renderFloatView[28] = filterRangeMax[0]; // filterRangeMax: vec4 @ byte 112
    renderFloatView[29] = filterRangeMax[1];
    renderFloatView[30] = filterRangeMax[2];
    renderFloatView[31] = filterRangeMax[3];
    renderFloatView[32] = fadeWidth[0]; // fadeWidth: vec4 @ byte 128
    renderFloatView[33] = fadeWidth[1];
    renderFloatView[34] = fadeWidth[2];
    renderFloatView[35] = fadeWidth[3];
    // selection style: selectionColor vec4 @ byte 144, unselectedAlpha @160, selectedSizeScale @164
    renderFloatView[36] = this.selectionStyle.selectedColor.r;
    renderFloatView[37] = this.selectionStyle.selectedColor.g;
    renderFloatView[38] = this.selectionStyle.selectedColor.b;
    renderFloatView[39] = this.selectionStyle.selectedColor.a;
    renderFloatView[40] = this.selectionStyle.unselectedAlpha;
    renderFloatView[41] = this.selectionStyle.selectedSizeScale;
    renderFloatView[42] = this.selectionStyle.highlightSelected ? 1.0 : 0.0; // selectionHighlight @168
    renderFloatView[43] = this.forceSelectionActive ? 1.0 : 0.0; // forceSelectionActive @172
    // 受動クランプ: main は renderMode=2(焦点のみ) / 無効時は 0(全描画)。受動予約色（gray）も渡す。
    renderUint32View[44] = this.recededClampEnabled ? 2 : 0; // renderMode @176
    const rc = this.recededColor;
    renderFloatView[45] = rc ? rc[0] / 255.0 : -1.0; // recededR @180（負=色ベース判定なし）
    renderFloatView[46] = rc ? rc[1] / 255.0 : -1.0; // recededG @184
    renderFloatView[47] = rc ? rc[2] / 255.0 : -1.0; // recededB @188
    this.context.device.queue.writeBuffer(this.renderUniformBuffer, 0, renderUniformData);

    // 受動層描画用ユニフォーム（renderMode = 1 = 受動のみ）。main と同内容で renderMode だけ差し替え。
    if (this.recededRenderUniformBuffer) {
      const recededData = renderUniformData.slice(0);
      new Uint32Array(recededData)[44] = 1; // renderMode = 受動のみ
      this.context.device.queue.writeBuffer(this.recededRenderUniformBuffer, 0, recededData);
    }

    // composite uniform（受動層の累積 alpha 上限）
    if (this.compositeUniformBuffer) {
      this.context.device.queue.writeBuffer(
        this.compositeUniformBuffer,
        0,
        new Float32Array([this.recededMaxAlpha])
      );
    }

    // フィルター済みポイント用ユニフォーム（grayedMode = 1.0、renderMode = 0 = discard しない）
    if (this.filteredRenderUniformBuffer) {
      const filteredRenderUniformData = renderUniformData.slice(0);
      new Float32Array(filteredRenderUniformData)[21] = 1.0; // grayedMode = 1.0
      new Uint32Array(filteredRenderUniformData)[44] = 0; // renderMode = 全（discard なし）
      // grayed パスはフィルタ範囲 [min,max] の外側の点を描画するため、フェードを
      // 適用すると computeFadeAlpha が 0 になり点が消えてしまう（gray 表示にならない）。
      // fadeEdgeFlags を 0 にしてフェードを無効化し、常に gray で表示する。
      new Uint32Array(filteredRenderUniformData)[22] = 0;
      this.context.device.queue.writeBuffer(
        this.filteredRenderUniformBuffer,
        0,
        filteredRenderUniformData
      );
    }

    // 逆変換を行ってワールド空間での境界を計算し、シェーダー内での行列演算を削除する
    const aspectRatio = this.canvas.width / this.canvas.height;
    const clipMinX = -1 - VIEWPORT_MARGIN;
    const clipMinY = -1 - VIEWPORT_MARGIN;
    const clipMaxX = 1 + VIEWPORT_MARGIN;
    const clipMaxY = 1 + VIEWPORT_MARGIN;

    const scaleX = this.zoom / aspectRatio;
    const scaleY = this.zoom;

    const worldMinX = (clipMinX - this.panX) / scaleX;
    const worldMaxX = (clipMaxX - this.panX) / scaleX;
    const worldMinY = (clipMinY - this.panY) / scaleY;
    const worldMaxY = (clipMaxY - this.panY) / scaleY;

    const computeUniformData = new ArrayBuffer(80);
    const computeFloatView = new Float32Array(computeUniformData);
    const computeUint32View = new Uint32Array(computeUniformData);

    computeFloatView[0] = worldMinX;
    computeFloatView[1] = worldMinY;
    computeFloatView[2] = worldMaxX;
    computeFloatView[3] = worldMaxY;
    const lodThreshold = this.calculateLodThreshold();
    computeUint32View[4] = lodThreshold;
    computeUint32View[5] = this.totalPointCount;

    // activeFilterMask / filterRangeMin / filterRangeMax は上で構築済み
    computeUint32View[6] = activeFilterMask;
    computeUint32View[7] = this.whereFilterEnabled ? 1 : 0;

    computeFloatView[8] = filterRangeMin[0];
    computeFloatView[9] = filterRangeMin[1];
    computeFloatView[10] = filterRangeMin[2];
    computeFloatView[11] = filterRangeMin[3];

    computeFloatView[12] = filterRangeMax[0];
    computeFloatView[13] = filterRangeMax[1];
    computeFloatView[14] = filterRangeMax[2];
    computeFloatView[15] = filterRangeMax[3];

    // filteredDisplayMode: 0=hidden, 1=grayed
    computeUint32View[16] = this.filteredPointDisplayMode === 'grayed' ? 1 : 0;
    // 俯瞰ではサイズ境界を使う。均一サイズ・分布なし・ズームインでは従来のハッシュ間引き。
    // 境界と同サイズの点に限って、残りの予算に応じたハッシュ閾値を適用する。
    const cutoff = getLodSizeCutoff(
      this.lodSizeDistribution,
      this.totalPointCount,
      lodThreshold,
      this.zoom
    );
    computeUint32View[17] = cutoff ? 1 : 0;
    computeFloatView[18] = cutoff?.size ?? 0;
    computeUint32View[19] = cutoff?.tieHashThreshold ?? 0;

    this.context.device.queue.writeBuffer(this.computeUniformBuffer, 0, computeUniformData);
  }

  /**
   * 散布図をレンダリングする
   */
  /**
   * 受動層オフスクリーンRT と composite bind group を canvas サイズに合わせて用意する。
   * サイズ変化時は作り直す。準備できれば true（受動クランプの3パスを実行可能）。
   */
  private ensureOffscreen(): boolean {
    const device = this.context.device;
    if (
      !device ||
      !this.compositePipeline ||
      !this.compositeSampler ||
      !this.compositeUniformBuffer ||
      !this.recededRenderBindGroup
    ) {
      return false;
    }
    const w = this.canvas.width;
    const h = this.canvas.height;
    if (w === 0 || h === 0) return false;
    if (!this.offscreenTexture || this.offscreenWidth !== w || this.offscreenHeight !== h) {
      this.offscreenTexture?.destroy();
      this.offscreenTexture = device.createTexture({
        size: { width: w, height: h },
        format: this.context.format,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      });
      this.offscreenWidth = w;
      this.offscreenHeight = h;
      this.compositeBindGroup = device.createBindGroup({
        layout: this.compositePipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.compositeUniformBuffer } },
          { binding: 1, resource: this.compositeSampler },
          { binding: 2, resource: this.offscreenTexture.createView() },
        ],
      });
    }
    return !!this.compositeBindGroup;
  }

  render(): void {
    if (this.disposed) return;
    // 外部から描画を要求されたら再調整を許す。静止後の自動描画は有限回で止める。
    this.refinementFramesRemaining = MAX_REFINEMENT_FRAMES;
    if (this.refinementFrame !== null) cancelAnimationFrame(this.refinementFrame);
    this.refinementFrame = null;
    this.renderFrame();
    if (this.viewMotion.delay(performance.now()) > 0) this.requestRefinementRender();
  }

  private renderFrame(): void {
    if (
      this.disposed ||
      !this.context.device ||
      !this.context.context ||
      !this.filterPipeline ||
      !this.updateIndirectPipeline ||
      !this.renderPipeline ||
      !this.quadVertexBuffer ||
      !this.filterBindGroup ||
      !this.updateIndirectBindGroup ||
      !this.renderBindGroup ||
      !this.atomicCounterBuffer ||
      !this.indirectBuffer ||
      !this.filteredCounterBuffer ||
      !this.filteredIndirectBuffer ||
      !this.filteredUpdateIndirectBindGroup ||
      !this.filteredRenderBindGroup
    ) {
      return;
    }

    // ── フレーム計測（dev-only）。OFF 時は何もしない。 ──
    let _computeRan = false;
    const _instrT0 = this.instrument ? performance.now() : 0;
    if (this.instrument) {
      if (this.statPrevRenderTs > 0) {
        const dt = _instrT0 - this.statPrevRenderTs;
        if (dt > 0) {
          const inst = 1000 / dt;
          this.statFps = this.statFps > 0 ? this.statFps * 0.85 + inst * 0.15 : inst;
        }
      }
      this.statPrevRenderTs = _instrT0;
    }

    const isGrayed = this.filteredPointDisplayMode === 'grayed';
    const commandEncoder = this.context.device.createCommandEncoder();
    const sample = this.frameTimer?.beginFrame();
    const sampledKeepRatio = this.adaptiveLod.keepRatio;
    const timingGeneration = this.timingGeneration;
    const allowLodAdjustment = this.viewMotion.delay(performance.now()) === 0;
    let submitted = false;

    try {
      if (!this.filterResultValid) {
        _computeRan = true;
        this.context.device.queue.writeBuffer(this.atomicCounterBuffer, 0, new Uint32Array([0]));
        this.context.device.queue.writeBuffer(this.filteredCounterBuffer, 0, new Uint32Array([0]));

        {
          const computePass = commandEncoder.beginComputePass({
            timestampWrites: sample?.querySet
              ? { querySet: sample.querySet, beginningOfPassWriteIndex: 0 }
              : undefined,
          });
          computePass.setPipeline(this.filterPipeline);
          computePass.setBindGroup(0, this.filterBindGroup);
          const workgroupCount = Math.ceil(this.totalPointCount / 256);
          computePass.dispatchWorkgroups(workgroupCount);
          computePass.end();
        }

        // 可視ポイント用Indirect Buffer更新
        {
          const computePass = commandEncoder.beginComputePass();
          computePass.setPipeline(this.updateIndirectPipeline);
          computePass.setBindGroup(0, this.updateIndirectBindGroup);
          computePass.dispatchWorkgroups(1);
          computePass.end();
        }

        // フィルター済みポイント用Indirect Buffer更新
        if (isGrayed) {
          const computePass = commandEncoder.beginComputePass();
          computePass.setPipeline(this.updateIndirectPipeline);
          computePass.setBindGroup(0, this.filteredUpdateIndirectBindGroup);
          computePass.dispatchWorkgroups(1);
          computePass.end();
        }

        this.filterResultValid = true;
      }

      if (this.recededClampEnabled && this.ensureOffscreen()) {
        // ── 受動層クランプ: 受動(dim/gray)をオフスクリーンに通常累積 → 合成時に alpha 頭打ち → 焦点を上に ──
        // 1) 受動層（renderMode=1）をオフスクリーン（透明クリア）に累積描画。
        {
          const offPass = commandEncoder.beginRenderPass({
            timestampWrites:
              sample?.querySet && !_computeRan
                ? { querySet: sample.querySet, beginningOfPassWriteIndex: 0 }
                : undefined,
            colorAttachments: [
              {
                view: this.offscreenTexture!.createView(),
                clearValue: { r: 0, g: 0, b: 0, a: 0 },
                loadOp: 'clear',
                storeOp: 'store',
              },
            ],
          });
          offPass.setPipeline(this.renderPipeline);
          offPass.setVertexBuffer(0, this.quadVertexBuffer);
          offPass.setIndexBuffer(this.indexBuffer!, 'uint16');
          // 時間フィルタの灰色層（grayedMode=1）も受動なので、ここで累積してクランプ対象にする
          // （main へ直接描くと composite を迂回し、密集で不透明化してしまう）。背面なので先に描く。
          if (isGrayed) {
            offPass.setBindGroup(0, this.filteredRenderBindGroup);
            offPass.drawIndexedIndirect(this.filteredIndirectBuffer, 0);
          }
          // 通常 visible のうち受動（renderMode=1 で焦点を discard）を累積。
          offPass.setBindGroup(0, this.recededRenderBindGroup!);
          offPass.drawIndexedIndirect(this.indirectBuffer, 0);
          offPass.end();
        }
        // 2) main: 背景クリア → 受動層(時間フィルタ灰色＋dim/gray を累積済み)を clamp 合成 → 焦点層(renderMode=2)。
        {
          const textureView = this.context.context.getCurrentTexture().createView();
          const mainPass = commandEncoder.beginRenderPass({
            timestampWrites: sample?.querySet
              ? { querySet: sample.querySet, endOfPassWriteIndex: 1 }
              : undefined,
            colorAttachments: [
              {
                view: textureView,
                clearValue: {
                  r: this.backgroundColor.r,
                  g: this.backgroundColor.g,
                  b: this.backgroundColor.b,
                  a: this.backgroundColor.a,
                },
                loadOp: 'clear',
                storeOp: 'store',
              },
            ],
          });
          // 受動層オフスクリーン（時間フィルタ灰色＋dim/gray を累積済み）を clamp 合成（フルスクリーン三角形）。
          mainPass.setPipeline(this.compositePipeline!);
          mainPass.setBindGroup(0, this.compositeBindGroup!);
          mainPass.draw(3);
          // 焦点層（renderMode=2 で受動を discard）。
          mainPass.setPipeline(this.renderPipeline);
          mainPass.setVertexBuffer(0, this.quadVertexBuffer);
          mainPass.setIndexBuffer(this.indexBuffer!, 'uint16');
          mainPass.setBindGroup(0, this.renderBindGroup);
          mainPass.drawIndexedIndirect(this.indirectBuffer, 0);
          mainPass.end();
        }
      } else {
        // ── 従来の単一パス（受動クランプ無効＝後方互換）──
        const textureView = this.context.context.getCurrentTexture().createView();
        const renderPass = commandEncoder.beginRenderPass({
          timestampWrites: sample?.querySet
            ? {
                querySet: sample.querySet,
                beginningOfPassWriteIndex: _computeRan ? undefined : 0,
                endOfPassWriteIndex: 1,
              }
            : undefined,
          colorAttachments: [
            {
              view: textureView,
              clearValue: {
                r: this.backgroundColor.r,
                g: this.backgroundColor.g,
                b: this.backgroundColor.b,
                a: this.backgroundColor.a,
              },
              loadOp: 'clear',
              storeOp: 'store',
            },
          ],
        });

        renderPass.setPipeline(this.renderPipeline);
        renderPass.setVertexBuffer(0, this.quadVertexBuffer);
        renderPass.setIndexBuffer(this.indexBuffer!, 'uint16');

        // フィルター済みポイント（灰色）を先に描画（背面）
        if (isGrayed) {
          renderPass.setBindGroup(0, this.filteredRenderBindGroup);
          renderPass.drawIndexedIndirect(this.filteredIndirectBuffer, 0);
        }

        // 通常ポイントを描画（前面）
        renderPass.setBindGroup(0, this.renderBindGroup);
        renderPass.drawIndexedIndirect(this.indirectBuffer, 0);
        renderPass.end();
      }

      sample?.resolve(commandEncoder);
      const submittedAt = performance.now();
      this.context.device.queue.submit([commandEncoder.finish()]);
      submitted = true;
      if (_computeRan) this.needsTimingSample = !sample;
      if (sample) {
        this.recordFrameTime(
          sample,
          submittedAt,
          _computeRan,
          sampledKeepRatio,
          timingGeneration,
          allowLodAdjustment
        );
      }

      if (this.instrument) {
        this.statCpuMs = performance.now() - _instrT0;
        this.statComputeRan = _computeRan;
        // processed は compute が走ったフレームの値だけ保持（idle で 0 に戻さない＝sticky）。
        // 静止状態でオーバーレイを読んでも直近の重いフレームの走査点数が見える。
        if (_computeRan) this.statProcessed = this.totalPointCount;
        // 描画点数の読み戻し（compute が走ったフレームのみ・throttle・sticky）
        if (_computeRan && !this.statDrawnInFlight) {
          void this.readDrawnCount();
        }
      }
    } finally {
      // エンコードや submit が同期的に失敗した場合も、計測スロットを占有したままにしない。
      if (!submitted) {
        sample?.cancel();
        this.filterResultValid = false;
      }
    }
  }

  private recordFrameTime(
    sample: GpuFrameSample,
    submittedAt: number,
    wasCompute: boolean,
    sampledKeepRatio: number,
    timingGeneration: number,
    allowLodAdjustment: boolean
  ): void {
    void sample
      .read(submittedAt)
      .then((ms) => {
        if (this.disposed || !this.context.device) return;
        if (
          timingGeneration !== this.timingGeneration ||
          sampledKeepRatio !== this.adaptiveLod.keepRatio
        ) {
          if (this.needsTimingSample) this.requestRefinementRender();
          return;
        }
        if (ms === undefined || !Number.isFinite(ms) || ms < 0) {
          if (wasCompute || this.needsTimingSample) this.requestRefinementRender();
          return;
        }
        if (!wasCompute) {
          this.statGpuIdleMs = ms;
          // 軽い描画がスロットを占有していた間に、重い更新の計測が省略された場合は再試行する。
          if (this.needsTimingSample) this.requestRefinementRender();
          return;
        }

        this.statGpuComputeMs = ms;
        this.renderTimeMs = ms;
        this.renderTimeSource = sample.source;
        // 最後の自動描画後に、画面へ反映できない次の保持率だけを設定しない。
        if (this.refinementFramesRemaining <= 0) return;
        // 移動中に始めた計測は、停止後に遅れて届いても保持率の調整に使わない。
        if (!allowLodAdjustment || this.viewMotion.delay(performance.now()) > 0) {
          this.needsTimingSample = true;
          this.requestRefinementRender();
          return;
        }
        // compute を省略したホバー等の軽い描画を根拠に、保持率を上げ続けない。
        const adjustment = this.adaptiveLod.observe(ms, sampledKeepRatio, performance.now());
        if (adjustment.changed) this.updateUniforms();
        if (adjustment.changed || adjustment.needsMoreSamples || this.needsTimingSample) {
          this.requestRefinementRender(adjustment.retryAfterMs);
        }
      })
      .catch((error: unknown) => {
        if (this.disposed || !this.context.device || timingGeneration !== this.timingGeneration)
          return;
        this.context.reportError(
          createError(
            sample.source === 'timestamp-query' ? 'GPU_READBACK_FAILED' : 'GPU_QUEUE_FAILED',
            `Frame timing failed: ${gpuErrorMessage(error)}`,
            {
              cause: error instanceof Error ? error : undefined,
              context: { operation: 'frame-timing', source: sample.source, computeRan: wasCompute },
            }
          )
        );
        // GPU 時刻の読み戻しに失敗した後は、タイマーが切り替えたキュー方式で再計測する。
        if (sample.source === 'timestamp-query') this.requestRefinementRender();
      });
  }

  private requestRefinementRender(delayMs = 0): void {
    if (
      this.disposed ||
      this.refinementFrame !== null ||
      this.refinementTimeout !== null ||
      this.refinementFramesRemaining <= 0
    )
      return;
    const delay = Math.max(delayMs, this.viewMotion.delay(performance.now()));
    if (delay > 0) {
      this.refinementTimeout = setTimeout(() => {
        this.refinementTimeout = null;
        this.requestRefinementRender();
      }, Math.ceil(delay));
      return;
    }
    this.refinementFrame = requestAnimationFrame(() => {
      this.refinementFrame = null;
      if (this.disposed) return;
      if (this.viewMotion.delay(performance.now()) > 0) {
        this.requestRefinementRender();
        return;
      }
      this.refinementFramesRemaining--;
      // 初期校正や保持率変更後も、絞り込みを含む同じ処理を計測する。
      this.filterResultValid = false;
      this.renderFrame();
    });
  }

  private invalidateTiming(): void {
    this.cancelRefinement();
    this.timingGeneration++;
    this.adaptiveLod.invalidateMeasurements();
    this.renderTimeMs = null;
    this.renderTimeSource = null;
    this.needsTimingSample = true;
  }

  private cancelRefinement(): void {
    if (this.refinementFrame !== null) cancelAnimationFrame(this.refinementFrame);
    if (this.refinementTimeout !== null) clearTimeout(this.refinementTimeout);
    this.refinementFrame = null;
    this.refinementTimeout = null;
  }

  private noteViewMotion(): void {
    this.cancelRefinement();
    this.viewMotion.moved(performance.now());
    this.timingGeneration++;
    // 移動だけでは、直前の保持率更新からの 500 ms の待機を解除しない。
    this.adaptiveLod.invalidateMeasurements(true);
    this.needsTimingSample = true;
  }

  /**
   * キャンバスをリサイズし、ビューポートを更新する
   */
  resize(width: number, height: number): void {
    this.invalidateTiming();
    this.canvas.width = width;
    this.canvas.height = height;
    this.updateUniforms();
  }

  /**
   * ズームレベルを設定する
   */
  setZoom(zoom: number): void {
    const clampedZoom = Math.max(0.01, Math.min(100, zoom));
    if (clampedZoom === this.zoom) return;
    this.noteViewMotion();
    this.zoom = clampedZoom;
    this.updateUniforms();
  }

  /**
   * 現在のズームレベルを取得する
   */
  getZoom(): number {
    return this.zoom;
  }

  /**
   * パンオフセットを設定する
   */
  setPan(x: number, y: number): void {
    if (x === this.panX && y === this.panY) return;
    this.noteViewMotion();
    this.panX = x;
    this.panY = y;
    this.updateUniforms();
  }

  /**
   * 現在のパンオフセットを取得する
   */
  getPan(): { x: number; y: number } {
    return { x: this.panX, y: this.panY };
  }

  /**
   * 指定した画面座標を中心にズームする
   */
  zoomToPoint(newZoom: number, screenX: number, screenY: number): void {
    const clampedZoom = Math.max(0.01, Math.min(100, newZoom));
    if (clampedZoom === this.zoom) return;
    this.noteViewMotion();
    const aspectRatio = this.canvas.width / this.canvas.height;

    const ndcX = (screenX / this.canvas.width) * 2 - 1;
    const ndcY = -((screenY / this.canvas.height) * 2 - 1);

    const worldXBefore = ((ndcX - this.panX) * aspectRatio) / this.zoom;
    const worldYBefore = (ndcY - this.panY) / this.zoom;

    this.zoom = clampedZoom;

    this.panX = ndcX - (worldXBefore * this.zoom) / aspectRatio;
    this.panY = ndcY - worldYBefore * this.zoom;

    this.updateUniforms();
  }

  /**
   * GPUレイヤーの設定オプションを更新する
   */
  updateOptions(options: Partial<GpuLayerOptions>): void {
    let needsUniformUpdate = false;

    if (options.backgroundColor !== undefined) {
      this.backgroundColor = options.backgroundColor;
    }
    if (
      options.targetRenderTimeMs !== undefined &&
      options.targetRenderTimeMs !== this.adaptiveLod.targetRenderTimeMs
    ) {
      this.adaptiveLod.setTargetRenderTimeMs(options.targetRenderTimeMs);
      this.invalidateTiming();
      needsUniformUpdate = true;
    }
    if (options.pointAlpha !== undefined) {
      this.pointAlpha = Math.max(0, Math.min(1, options.pointAlpha));
      needsUniformUpdate = true;
    }
    if (options.pointSizeScale !== undefined) {
      this.pointSizeScale = Math.max(0.01, options.pointSizeScale);
      needsUniformUpdate = true;
    }
    if (options.selectionStyle !== undefined) {
      // 部分指定をマージして既定値で埋める（render uniform 経由で反映）
      this.selectionStyle = this.resolveSelectionStyle({
        ...this.selectionStyle,
        ...options.selectionStyle,
      });
      needsUniformUpdate = true;
    }
    if (options.recededClamp !== undefined) {
      this.applyRecededClamp(options.recededClamp);
      needsUniformUpdate = true;
    }

    if (needsUniformUpdate) {
      this.updateUniforms();
    }
  }

  /**
   * GPUフィルターカラムデータをアップロードする
   * @param data フィルターカラムデータ（各ポイントに4カラム分のf32、totalPoints * 4 floats）
   * @param columnCount 有効なカラム数（0-4）
   */
  uploadFilterColumns(data: Float32Array): void {
    if (!this.context.device) return;

    const requiredSize = this.totalPointCount * 16;

    if (!this.filterColumnsBuffer || data.byteLength > requiredSize) {
      this.filterColumnsBuffer?.destroy();
      this.filterColumnsBuffer = this.context.device.createBuffer({
        size: Math.max(16, data.byteLength),
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      this.createBindGroups();
    }

    this.context.device.queue.writeBuffer(
      this.filterColumnsBuffer,
      0,
      data.buffer,
      data.byteOffset,
      data.byteLength
    );
    this.filterResultValid = false;
  }

  /**
   * GPUフィルター条件を設定する
   * @param conditions フィルター条件の配列
   */
  setGpuFilterConditions(
    conditions: {
      columnIndex: number;
      min: number;
      max: number;
      fade?: { width: number; edges: 'both' | 'min' | 'max' };
    }[]
  ): void {
    this.gpuFilterConditions = conditions;
    this.filterResultValid = false;
    this.updateUniforms();
  }

  /**
   * WHERE条件によるビットフラグ配列をアップロードする
   * @param flags ビットマップ配列（各u32に32ポイント分のフラグ）
   * @param enabled フラグフィルタを有効にするか
   */
  uploadVisibilityFlags(flags: Uint32Array, enabled: boolean): void {
    if (!this.context.device || !this.visibilityFlagsBuffer) return;

    const requiredSize = flags.byteLength;
    const currentSize = Math.max(4, Math.ceil(this.totalPointCount / 32) * 4);

    if (requiredSize > currentSize) {
      this.visibilityFlagsBuffer.destroy();
      this.visibilityFlagsBuffer = this.context.device.createBuffer({
        size: requiredSize,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      this.createBindGroups();
    }

    this.context.device.queue.writeBuffer(
      this.visibilityFlagsBuffer,
      0,
      flags.buffer,
      flags.byteOffset,
      flags.byteLength
    );
    this.whereFilterEnabled = enabled;
    this.filterResultValid = false;
    this.updateUniforms();
  }

  /**
   * WHERE条件フラグをクリア（全ポイント可視）
   */
  clearVisibilityFlags(): void {
    if (!this.context.device || !this.visibilityFlagsBuffer) return;

    const clearFlags = new Uint32Array(Math.ceil(this.totalPointCount / 32));
    clearFlags.fill(0xffffffff);
    this.context.device.queue.writeBuffer(this.visibilityFlagsBuffer, 0, clearFlags);
    this.whereFilterEnabled = false;
    this.filterResultValid = false;
    this.updateUniforms();
  }

  /**
   * グローバル透明度を設定する
   * @param alpha 透明度 (0.0-1.0)
   */
  setPointAlpha(alpha: number): void {
    this.pointAlpha = Math.max(0, Math.min(1, alpha));
    this.updateUniforms();
  }

  /**
   * 現在のグローバル透明度を取得する
   */
  getPointAlpha(): number {
    return this.pointAlpha;
  }

  /**
   * グローバルサイズスケールを設定する
   * @param scale サイズスケール (0.01以上)
   */
  setPointSizeScale(scale: number): void {
    this.pointSizeScale = Math.max(0.01, scale);
    this.updateUniforms();
  }

  /**
   * 現在のグローバルサイズスケールを取得する
   */
  getPointSizeScale(): number {
    return this.pointSizeScale;
  }

  /**
   * フィルターされたポイントの表示モードを設定する
   */
  setFilteredPointDisplayMode(mode: FilteredPointDisplayMode): void {
    this.filteredPointDisplayMode = mode;
    this.filterResultValid = false;
    this.updateUniforms();
  }

  /**
   * 現在のフィルター表示モードを取得する
   */
  getFilteredPointDisplayMode(): FilteredPointDisplayMode {
    return this.filteredPointDisplayMode;
  }

  /**
   * selection の描画スタイルを更新する（部分指定可）。次回 render() に反映される。
   */
  setSelectionStyle(style: SelectionStyle): void {
    this.selectionStyle = this.resolveSelectionStyle({ ...this.selectionStyle, ...style });
    this.updateUniforms();
  }

  /** recededClamp オプションをフィールドへ反映（updateUniforms は呼ばない＝呼び出し側で制御）。 */
  private applyRecededClamp(opts?: RecededClampOptions): void {
    if (!opts) return;
    this.recededClampEnabled = opts.enabled;
    if (opts.maxAlpha !== undefined) {
      this.recededMaxAlpha = Math.max(0, Math.min(1, opts.maxAlpha));
    }
    if (opts.recededColor !== undefined) {
      this.recededColor = opts.recededColor;
    }
  }

  /**
   * 受動層（dim/gray）のオーバードロークランプを設定する。enabled=true で受動点をオフスクリーンに
   * 累積し、合成時に累積 alpha を maxAlpha で頭打ちにする（密集しても不透明化しない）。
   * recededColor を指定すると、その色の点（例: 投稿フィルタ非該当の gray）も受動扱いにする。
   */
  setRecededClamp(opts: RecededClampOptions): void {
    this.applyRecededClamp(opts);
    this.updateUniforms();
  }

  /**
   * 選択 dim を強制的に有効/無効にする。選択点が0でも true なら全点を dim 表示にする。
   * ブラシ操作の開始時（まだ何も選択されていない瞬間）に背景を即 dim したいとき用。
   * 選択が1点以上あるときは selectionCount ゲートで常に有効なのでこのフラグは無関係。
   */
  setBrushActive(active: boolean): void {
    this.forceSelectionActive = active;
    this.updateUniforms();
  }

  /**
   * データ空間矩形で selection bitset を更新する（GPU 常駐, CPU 読み戻しなし）。
   * brush pass で bit を更新し、続く count pass で選択数を集計する。
   * @param bounds データ空間の矩形（順不同で可、内部で min/max 正規化）
   * @param options 合成モード（既定 'replace'）/ 対象集合（既定 'filtered-data'）
   */
  brushSelect(bounds: BrushBounds, options?: BrushOptions): void {
    if (
      !this.context.device ||
      !this.brushUniformBuffer ||
      !this.brushSelectionBindGroup ||
      this.totalPointCount === 0
    ) {
      return;
    }

    const mode = options?.mode ?? 'replace';
    const target = options?.target ?? 'filtered-data';
    const { minX, maxX, minY, maxY } = this.normalizeBrushBounds(bounds);

    // filterRange / activeFilterMask は updateUniforms と同じ規約で構築する。
    let activeFilterMask = 0;
    const filterRangeMin = [-Infinity, -Infinity, -Infinity, -Infinity];
    const filterRangeMax = [Infinity, Infinity, Infinity, Infinity];
    for (const condition of this.gpuFilterConditions) {
      const c = condition.columnIndex;
      if (c >= 0 && c < 4) {
        activeFilterMask |= 1 << c;
        filterRangeMin[c] = condition.min;
        filterRangeMax[c] = condition.max;
      }
    }

    const brushData = new ArrayBuffer(BRUSH_UNIFORM_SIZE);
    const f = new Float32Array(brushData);
    const u = new Uint32Array(brushData);
    f[0] = minX; // brushMin.x
    f[1] = minY; // brushMin.y
    f[2] = maxX; // brushMax.x
    f[3] = maxY; // brushMax.y
    f[4] = filterRangeMin[0]; // filterRangeMin: vec4 @ byte 16
    f[5] = filterRangeMin[1];
    f[6] = filterRangeMin[2];
    f[7] = filterRangeMin[3];
    f[8] = filterRangeMax[0]; // filterRangeMax: vec4 @ byte 32
    f[9] = filterRangeMax[1];
    f[10] = filterRangeMax[2];
    f[11] = filterRangeMax[3];
    u[12] = this.totalPointCount; // totalPoints @48
    u[13] = BRUSH_MODE_CODE[mode]; // mode @52
    u[14] = target === 'filtered-data' ? 1 : 0; // applyFilter @56
    u[15] = activeFilterMask; // @60
    u[16] = this.whereFilterEnabled ? 1 : 0; // whereFilterEnabled @64
    this.context.device.queue.writeBuffer(this.brushUniformBuffer, 0, brushData);

    this.dispatchBrushAndCount();
  }

  /**
   * キャンバス画面座標（物理ピクセル）の矩形で selection を更新する。
   * 現在の zoom / pan を使ってデータ空間へ変換してから brushSelect する。
   */
  brushSelectScreenRect(rect: ScreenBrushRect, options?: BrushOptions): void {
    const a = this.screenToWorld(rect.x0, rect.y0);
    const b = this.screenToWorld(rect.x1, rect.y1);
    this.brushSelect({ minX: a.x, maxX: b.x, minY: a.y, maxY: b.y }, options);
  }

  /**
   * ポイント ID（= rowid = バッファ index）集合で selection を直接設定する。
   * GPU で brush せず CPU 側で bitset を構築してアップロードする。
   */
  setSelectedPointIds(ids: Iterable<number>): void {
    if (!this.context.device || !this.selectionFlagsBuffer || !this.selectionCountBuffer) return;

    const wordCount = Math.max(1, Math.ceil(this.totalPointCount / 32));
    const bitset = new Uint32Array(wordCount);
    let count = 0;
    for (const id of ids) {
      if (id >= 0 && id < this.totalPointCount) {
        const w = id >>> 5;
        const mask = 1 << (id & 31);
        if ((bitset[w] & mask) === 0) {
          bitset[w] |= mask;
          count++;
        }
      }
    }
    this.context.device.queue.writeBuffer(this.selectionFlagsBuffer, 0, bitset);
    this.context.device.queue.writeBuffer(this.selectionCountBuffer, 0, new Uint32Array([count]));
  }

  /**
   * selection を全クリアする。
   */
  clearSelection(): void {
    if (!this.context.device || !this.selectionFlagsBuffer || !this.selectionCountBuffer) return;
    const wordCount = Math.max(1, Math.ceil(this.totalPointCount / 32));
    this.context.device.queue.writeBuffer(this.selectionFlagsBuffer, 0, new Uint32Array(wordCount));
    this.context.device.queue.writeBuffer(this.selectionCountBuffer, 0, new Uint32Array([0]));
  }

  /**
   * ポイント ID（= rowid = バッファ index）集合で hover-mask を設定する。
   * selection とは独立した別 bitset で、ホバー中クラスタのノードを selection dim から
   * 除外して元の明度に戻す（＝強調）。空集合（または clearHover）で解除。
   * GPU 常駐 selection を一切触らないため getSelectionCount / brush / 投稿リストを汚染しない。
   */
  setHoveredPointIds(ids: Iterable<number>): void {
    if (!this.context.device || !this.hoverFlagsBuffer) return;

    const wordCount = Math.max(1, Math.ceil(this.totalPointCount / 32));
    const bitset = new Uint32Array(wordCount);
    for (const id of ids) {
      if (id >= 0 && id < this.totalPointCount) {
        const w = id >>> 5;
        const mask = 1 << (id & 31);
        bitset[w] |= mask;
      }
    }
    this.context.device.queue.writeBuffer(this.hoverFlagsBuffer, 0, bitset);
  }

  /**
   * hover-mask を全クリアする（selection には影響しない）。
   */
  clearHover(): void {
    if (!this.context.device || !this.hoverFlagsBuffer) return;
    const wordCount = Math.max(1, Math.ceil(this.totalPointCount / 32));
    this.context.device.queue.writeBuffer(this.hoverFlagsBuffer, 0, new Uint32Array(wordCount));
  }

  /**
   * 診断用の CPU・FPS・描画件数計測の ON/OFF。自動 LOD の時間計測は停止しない。
   */
  setInstrumentation(on: boolean): void {
    this.instrument = on;
    if (!on) {
      this.statFps = 0;
      this.statPrevRenderTs = 0;
    }
  }

  /**
   * 診断値と自動 LOD の現在値を返す。時間と描画件数は非同期で取得するため、数フレーム遅れる。
   */
  getFrameStats(): FrameStats {
    return {
      enabled: this.instrument,
      fps: Math.round(this.statFps),
      computeRan: this.statComputeRan,
      processedCount: this.statProcessed,
      drawnCount: this.statDrawn,
      drawnCountStatus: this.statDrawnStatus,
      totalPointCount: this.totalPointCount,
      targetRenderTimeMs: this.adaptiveLod.targetRenderTimeMs,
      lodKeepRatio: this.adaptiveLod.keepRatio,
      renderTimeMs: this.renderTimeMs,
      renderTimeSource: this.renderTimeSource,
      cpuEncodeMs: Math.round(this.statCpuMs * 100) / 100,
      gpuComputeMs: Math.round(this.statGpuComputeMs * 100) / 100,
      gpuIdleMs: Math.round(this.statGpuIdleMs * 100) / 100,
      gpuAllocatedBytes: this.getAllocatedGpuBytes(),
      zoom: this.zoom,
    };
  }

  /**
   * 点数からの推定ではなく、現在の各バッファの実際の要求サイズを合計する。
   * 件数縮小後の余剰容量や、無効化後も保持しているオフスクリーンも含める。
   * 新しい常駐バッファを追加するときは、この一覧にも含める。
   */
  private getAllocatedGpuBytes(): number {
    if (!this.context.device) return 0;
    const buffers = [
      this.quadVertexBuffer,
      this.allPointsBuffer,
      this.visibleIndicesBuffer,
      this.atomicCounterBuffer,
      this.indirectBuffer,
      this.indexBuffer,
      this.renderUniformBuffer,
      this.computeUniformBuffer,
      this.filterColumnsBuffer,
      this.visibilityFlagsBuffer,
      this.selectionFlagsBuffer,
      this.selectionCountBuffer,
      this.hoverFlagsBuffer,
      this.brushUniformBuffer,
      this.countUniformBuffer,
      this.filteredIndicesBuffer,
      this.filteredCounterBuffer,
      this.filteredIndirectBuffer,
      this.filteredRenderUniformBuffer,
      this.recededRenderUniformBuffer,
      this.compositeUniformBuffer,
      ...this.readbackBuffers,
    ];
    const bufferBytes = buffers.reduce((sum, buffer) => sum + (buffer?.size ?? 0), 0);
    // 現在のオフスクリーンは、単一 mip・単一 sample の RGBA/BGRA 8 bit テクスチャ。
    const textureBytes = this.offscreenTexture
      ? this.offscreenTexture.width * this.offscreenTexture.height * 4
      : 0;
    return bufferBytes + textureBytes + (this.frameTimer?.allocatedBufferBytes ?? 0);
  }

  /** 描画点数（atomicCounter = visibleIndices 件数）を非同期読み戻し（計測用・throttle）。 */
  private async readDrawnCount(): Promise<void> {
    const device = this.context.device;
    if (!device || !this.atomicCounterBuffer) return;
    this.statDrawnInFlight = true;
    this.statDrawnStatus = 'pending';
    let staging: GPUBuffer | null = null;
    try {
      staging = device.createBuffer({
        label: 'visible-point-count-readback',
        size: 4,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
      this.readbackBuffers.add(staging);
      const enc = device.createCommandEncoder({ label: 'visible-point-count-readback' });
      enc.copyBufferToBuffer(this.atomicCounterBuffer, 0, staging, 0, 4);
      device.queue.submit([enc.finish()]);
      await staging.mapAsync(GPUMapMode.READ);
      if (this.context.device !== device) return;
      this.statDrawn = new Uint32Array(staging.getMappedRange().slice(0))[0];
      this.statDrawnStatus = 'ready';
      staging.unmap();
    } catch (error) {
      // 破棄した古いデバイスの読み戻し失敗を、新しい画面のエラーとして通知しない。
      if (this.context.device !== device) return;
      this.statDrawnStatus = 'error';
      this.context.reportError(
        createError(
          'GPU_READBACK_FAILED',
          `Point count readback failed: ${gpuErrorMessage(error)}`,
          {
            cause: error instanceof Error ? error : undefined,
            context: { operation: 'visible-point-count-readback' },
          }
        )
      );
    } finally {
      if (staging) {
        this.readbackBuffers.delete(staging);
        staging.destroy(); // 例外時もバッファをリークさせない
      }
      this.statDrawnInFlight = false;
    }
  }

  /**
   * 現在の selection 数を取得する（GPU からの非同期読み戻し）。
   */
  async getSelectionCount(): Promise<number> {
    if (!this.context.device || !this.selectionCountBuffer) return 0;
    const staging = this.context.device.createBuffer({
      size: 4,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    this.readbackBuffers.add(staging);
    try {
      const encoder = this.context.device.createCommandEncoder();
      encoder.copyBufferToBuffer(this.selectionCountBuffer, 0, staging, 0, 4);
      this.context.device.queue.submit([encoder.finish()]);
      await staging.mapAsync(GPUMapMode.READ);
      const count = new Uint32Array(staging.getMappedRange().slice(0))[0];
      staging.unmap();
      return count;
    } finally {
      this.readbackBuffers.delete(staging);
      staging.destroy();
    }
  }

  /** brush pass → count pass を1回の submit で実行する */
  private dispatchBrushAndCount(): void {
    if (
      !this.context.device ||
      !this.brushSelectionPipeline ||
      !this.brushSelectionBindGroup ||
      !this.countSelectionPipeline ||
      !this.countSelectionBindGroup ||
      !this.selectionCountBuffer
    ) {
      return;
    }
    // count を 0 にリセットしてから popcount で積算する（submit より前に queue 投入）
    this.context.device.queue.writeBuffer(this.selectionCountBuffer, 0, new Uint32Array([0]));

    const encoder = this.context.device.createCommandEncoder();
    {
      const pass = encoder.beginComputePass();
      pass.setPipeline(this.brushSelectionPipeline);
      pass.setBindGroup(0, this.brushSelectionBindGroup);
      pass.dispatchWorkgroups(Math.ceil(this.totalPointCount / 256));
      pass.end();
    }
    {
      const wordCount = Math.max(1, Math.ceil(this.totalPointCount / 32));
      const pass = encoder.beginComputePass();
      pass.setPipeline(this.countSelectionPipeline);
      pass.setBindGroup(0, this.countSelectionBindGroup);
      pass.dispatchWorkgroups(Math.ceil(wordCount / 256));
      pass.end();
    }
    this.context.device.queue.submit([encoder.finish()]);
  }

  /** 画面座標（物理ピクセル, y 下向き）→ データ空間座標 */
  private screenToWorld(screenX: number, screenY: number): { x: number; y: number } {
    const aspectRatio = this.canvas.width / this.canvas.height;
    const ndcX = (screenX / this.canvas.width) * 2 - 1;
    const ndcY = -((screenY / this.canvas.height) * 2 - 1);
    const scaleX = this.zoom / aspectRatio;
    const scaleY = this.zoom;
    return {
      x: (ndcX - this.panX) / scaleX,
      y: (ndcY - this.panY) / scaleY,
    };
  }

  /** BrushBounds を min <= max に正規化する */
  private normalizeBrushBounds(b: BrushBounds): BrushBounds {
    return {
      minX: Math.min(b.minX, b.maxX),
      maxX: Math.max(b.minX, b.maxX),
      minY: Math.min(b.minY, b.maxY),
      maxY: Math.max(b.minY, b.maxY),
    };
  }

  /**
   * リソースを破棄する
   */
  destroy(): void {
    this.disposed = true;
    this.timingGeneration++;
    this.cancelRefinement();
    this.viewMotion.reset();
    this.refinementFramesRemaining = 0;
    this.frameTimer?.destroy();
    this.frameTimer = null;
    for (const buffer of this.readbackBuffers) buffer.destroy();
    this.readbackBuffers.clear();
    this.quadVertexBuffer?.destroy();
    this.allPointsBuffer?.destroy();
    this.visibleIndicesBuffer?.destroy();
    this.atomicCounterBuffer?.destroy();
    this.indirectBuffer?.destroy();
    this.indexBuffer?.destroy();
    this.renderUniformBuffer?.destroy();
    this.computeUniformBuffer?.destroy();
    this.filterColumnsBuffer?.destroy();
    this.visibilityFlagsBuffer?.destroy();
    this.filteredIndicesBuffer?.destroy();
    this.filteredCounterBuffer?.destroy();
    this.filteredIndirectBuffer?.destroy();
    this.filteredRenderUniformBuffer?.destroy();
    this.recededRenderUniformBuffer?.destroy();
    this.compositeUniformBuffer?.destroy();
    this.offscreenTexture?.destroy();
    this.selectionFlagsBuffer?.destroy();
    this.selectionCountBuffer?.destroy();
    this.hoverFlagsBuffer?.destroy();
    this.brushUniformBuffer?.destroy();
    this.countUniformBuffer?.destroy();
    this.lodSizeDistribution = undefined;
    this.context.destroy();
  }
}
