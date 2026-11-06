import type { AsyncDuckDBConnection } from '@duckdb/duckdb-wasm';
import type { ParquetData, ParquetReader } from './repository.js';
import { createParquetReader } from './repository.js';
import type {
  WhereCondition,
  ScatterPlotError,
  BrushBounds,
  PointPosition,
  PointAttributes,
} from '../types.js';
import { createError } from '../errors.js';
import type { AllPointsData } from '../renderer/gpu-layer.js';
import { SpatialPointIndex } from './spatial-index.js';
import { PointPacker, type PointCoordinates } from './point-packing.js';
import { createLodSizeDistribution, type LodSizeDistribution } from './lod.js';
import { GPU_FILTER_COLUMN_COMPONENTS, MAX_GPU_FILTER_COLUMNS } from '../constants.js';

/**
 * DataLayerの設定オプション
 */
export interface DataLayerOptions {
  /** ポイントサイズを計算するSQL式 */
  sizeSql?: string;
  /** ポイント色を計算するSQL式（ARGB形式） */
  colorSql?: string;
  /** 同じ SQL 式が参照する値の変更後に、全点の描画属性を再取得する */
  reloadPoints?: boolean;
  /** データフィルタリング用のWHERE条件 */
  whereConditions?: WhereCondition[];
  /** GPUでフィルタリングするカラム名（最大4つ。超過分は無視される） */
  gpuFilterColumns?: string[];
  /** エラーをScatterPlotに通知するためのコールバック */
  onError?: (error: ScatterPlotError) => void;
  /** データ変更時に呼び出されるコールバック */
  onDataChanged?: () => void | Promise<void>;
  /** WHERE条件変更時にビジビリティフラグ更新が必要な場合のコールバック */
  onVisibilityChanged?: () => void | Promise<void>;
}

/**
 * DataLayer.updateOptions が発生させた DuckDB/GPU データ境界の更新内容。
 * 実際の GPU upload は ScatterPlot 側で行う。
 */
export interface DataLayerUpdateResult {
  /** SQL 式の変更または明示的な再取得により、全点の描画属性を再生成する */
  allPointsChanged: boolean;
  /** whereConditions 変更により visibility bitmap の再生成が必要になった */
  visibilityChanged: boolean;
  /** gpuFilterColumns 変更により GPU filter column buffer の再アップロードが必要になった */
  gpuFilterColumnsChanged: boolean;
}

/**
 * データ取得とクエリ管理を担当するレイヤー
 * 責務:
 * - ParquetReaderを介したParquetデータの読み込みと管理
 * - 全データをGPU用フォーマットに変換
 * - データ変更の検知と通知
 */
export class DataLayer {
  /** Parquetデータへのアクセスを提供するリポジトリ */
  private repository: ParquetReader | null = null;
  /** ポイントサイズのSQL式 */
  private sizeSql: string = '3';
  /** ポイント色のSQL式（ARGB形式: a=0.3, r=0.3, g=0.3, b=0.8） */
  private colorSql: string = '0x4D4D4DCC';
  /** フィルタリング用のWHERE条件 */
  private whereConditions: WhereCondition[] = [];
  /** GPUでフィルタリングするカラム名 */
  private gpuFilterColumns: string[] = [];
  /** エラー通知用コールバック */
  private onError?: (error: ScatterPlotError) => void;
  /** データ変更通知用コールバック */
  private onDataChanged?: () => void | Promise<void>;
  /** WHERE条件変更時のビジビリティ更新コールバック */
  private onVisibilityChanged?: () => void | Promise<void>;
  /**
   * 構築時に検出したが、まだ発火していない設定警告（gpuFilterColumns 超過など）。
   * ScatterPlot のコンストラクタ内では consumer がまだ on('error') を登録できないため、
   * リスナーが attach 済みになる initialize() まで発火を遅延させる。
   */
  private pendingConfigWarning: ScatterPlotError | null = null;

  /** 全ポイントデータのキャッシュ（ポイント検索用、SoA形式） */
  private pointsCache: PointCoordinates = {
    xArr: new Float64Array(0),
    yArr: new Float64Array(0),
    length: 0,
  };
  /** GPU に渡したサイズを点 ID 順に保持し、ホバーも同じ半径で判定する。 */
  private pointSizes = new Float32Array(0);
  /** 大きな点の外周を探索範囲から落とさないための最大半径。 */
  private maxPointSize = 0;

  /** WhereConditionから生成されたビジビリティフラグのキャッシュ（WHERE条件なし時は空） */
  private visibilityFlags: Uint32Array = new Uint32Array(0);
  /** GPUフィルターカラムデータのキャッシュ（最大4値/ポイント） */
  private filterColumnData = new Float32Array(0);
  /** 現在のGPUフィルターレンジ（スライダーで高頻度更新） */
  private gpuFilterRanges: { columnIndex: number; min: number; max: number }[] = [];
  /** 空間ポイントインデックス（四分木ベース） */
  private spatialIndex = new SpatialPointIndex();
  /** GPU 用の巡回置換と、チャンクサイズごとの順序表 */
  private readonly pointPacker = new PointPacker();
  /** 色だけの変更では再集計しない、サイズ別の累積件数。無効な分布も再取得まで保持する。 */
  private sizeDistributionCache: {
    totalCount: number;
    distribution: LodSizeDistribution | undefined;
  } | null = null;
  /** 読み込み中の設定変更で、古い分布をキャッシュへ戻さないための世代。 */
  private sizeDistributionRevision = 0;

  /**
   * DataLayerインスタンスを作成する
   * @param options 設定オプション
   */
  constructor(options: DataLayerOptions) {
    this.onError = options.onError;
    this.sizeSql = options.sizeSql ?? this.sizeSql;
    this.colorSql = options.colorSql ?? this.colorSql;
    this.whereConditions = options.whereConditions ?? [];
    const capped = this.capGpuFilterColumns(options.gpuFilterColumns);
    this.gpuFilterColumns = capped.columns;
    // 構築時点では consumer がまだ on('error') を登録できない（コンストラクタ内）ため、
    // 警告の発火は initialize() まで遅延する。リスナー登録後の updateOptions は即時発火。
    this.pendingConfigWarning = capped.warning;
    this.onDataChanged = options.onDataChanged;
    this.onVisibilityChanged = options.onVisibilityChanged;
  }

  /**
   * GPU filter columns は shader/buffer の fast path として vec4 に packing するため
   * 最大 MAX_GPU_FILTER_COLUMNS 列に制限する。capping した列と、超過時に発火すべき
   * CONFIG_WARNING を返す。副作用は持たず、警告の発火タイミングは呼び出し側に委ねる
   * （構築時は遅延、updateOptions では即時）。
   */
  private capGpuFilterColumns(columns: string[] | undefined): {
    columns: string[];
    warning: ScatterPlotError | null;
  } {
    const requestedColumns = columns ?? [];
    if (requestedColumns.length <= MAX_GPU_FILTER_COLUMNS) {
      return { columns: [...requestedColumns], warning: null };
    }

    const usedColumns = requestedColumns.slice(0, MAX_GPU_FILTER_COLUMNS);
    const ignoredColumns = requestedColumns.slice(MAX_GPU_FILTER_COLUMNS);
    const warning = createError(
      'CONFIG_WARNING',
      `gpuFilterColumns accepts at most ${MAX_GPU_FILTER_COLUMNS} columns; extra columns were ignored.`,
      {
        context: { maxGpuFilterColumns: MAX_GPU_FILTER_COLUMNS, usedColumns, ignoredColumns },
      }
    );
    return { columns: usedColumns, warning };
  }

  /**
   * 構築時に保留した設定警告を発行する。ScatterPlot のコンストラクタ内ではリスナーを
   * 登録できないため、リスナーが attach 済みになる initialize() の時点まで遅延させている。
   * 一度発火したらクリアし、二重発火しない。
   */
  private flushPendingConfigWarning(): void {
    const warning = this.pendingConfigWarning;
    this.pendingConfigWarning = null;
    if (warning && this.onError) {
      this.onError(warning);
    }
  }

  /**
   * データレイヤーを初期化し、データを読み込む
   * @param source ParquetファイルのURL、またはArrayBuffer/File
   * @returns 処理済みの全データ
   */
  async initialize(
    source: string | ArrayBuffer | File,
    onDatabaseReady?: (conn: AsyncDuckDBConnection) => Promise<void>
  ): Promise<AllPointsData> {
    // 構築時に保留した設定警告を、リスナーが登録済みのこの時点で発行する
    this.flushPendingConfigWarning();
    // 別の入力で初期化し直す場合は、同じ件数でも以前の座標と四分木を再利用しない。
    this.spatialIndex.destroy();
    this.pointPacker.clear();
    this.sizeDistributionCache = null;
    this.sizeDistributionRevision++;
    this.pointsCache = { xArr: new Float64Array(0), yArr: new Float64Array(0), length: 0 };
    this.pointSizes = new Float32Array(0);
    this.maxPointSize = 0;
    this.repository = await createParquetReader();
    if (typeof source === 'string') {
      await this.repository.loadParquetFromUrl(source);
    } else {
      const buffer = source instanceof File ? await source.arrayBuffer() : source;
      await this.repository.loadParquetFromBuffer(buffer);
    }
    if (onDatabaseReady) {
      await onDatabaseReady(this.repository.getConnection());
    }
    return await this.loadAllPoints();
  }

  /**
   * GeoJSONラベルデータをDuckDBテーブルに読み込む
   * @param geojson GeoJSON FeatureCollectionオブジェクト
   */
  async loadLabelData(geojson: any): Promise<void> {
    await this.repository!.loadGeoJson(geojson);
  }

  /**
   * 単一の条件からWHERE句文字列を構築する
   * @param condition WHERE条件
   * @returns SQL WHERE句の文字列
   */
  private buildWhereClauseString(condition: WhereCondition): string {
    switch (condition.type) {
      case 'numeric':
        return `${condition.column} ${condition.operator} ${condition.value}`;
      case 'raw':
        return condition.sql;
      case 'string': {
        const escapedValue = condition.value.replace(/'/g, "''");
        switch (condition.operator) {
          case 'equals':
            return `${condition.column} = '${escapedValue}'`;
          case 'contains':
            return `${condition.column} LIKE '%${escapedValue}%'`;
          case 'startsWith':
            return `${condition.column} LIKE '${escapedValue}%'`;
          case 'endsWith':
            return `${condition.column} LIKE '%${escapedValue}'`;
        }
      }
    }
  }

  /**
   * 全データを読み込んでGPU用フォーマットに変換する
   * WHERE条件によるフィルタリングはビットフラグで行うため、ここでは適用しない
   * @returns 処理済みの全データ
   */
  async loadAllPoints(): Promise<AllPointsData> {
    try {
      // 非同期のクエリ待ちの間に設定が変わっても、点本体と分布には同じサイズ式を使う。
      const sizeSql = this.sizeSql;
      const sizeDistributionRevision = this.sizeDistributionRevision;
      let sizeDistributionCache = this.sizeDistributionCache;
      const data = await this.repository!.query({
        toString: () =>
          `SELECT x, y, (${sizeSql}) AS __size__, (${this.colorSql}) AS __color__ ` +
          `FROM parquet_data ORDER BY rowid`,
      });
      if (!data) {
        return {
          instanceData: new Float32Array(0),
          totalCount: 0,
        };
      }

      if (!sizeDistributionCache || sizeDistributionCache.totalCount !== data.rowCount) {
        // 点ごとの順位は作らず、異なるサイズの件数だけを集計する。
        // 分布は描画と同じ全点集合に対するもので、SQL・GPU フィルターでは変更しない。
        const distributionData = await this.repository!.query({
          toString: () =>
            `WITH __sizes AS (SELECT (${sizeSql}) AS __size__ FROM parquet_data) ` +
            `SELECT __size__, COUNT(*) AS __count__ FROM __sizes ` +
            `GROUP BY __size__ ORDER BY __size__ DESC`,
        });
        sizeDistributionCache = {
          totalCount: data.rowCount,
          distribution: createLodSizeDistribution(distributionData, data.rowCount),
        };
        if (sizeDistributionRevision === this.sizeDistributionRevision) {
          this.sizeDistributionCache = sizeDistributionCache;
        }
      }

      // 初期化後の座標と点 ID は固定なので、色・サイズの再取得では検索用データを再構築しない。
      const needsSpatialIndex = !this.spatialIndex.isBuilt();
      const packed = this.pointPacker.pack(data, needsSpatialIndex ? undefined : this.pointsCache);
      if (this.pointSizes.length !== data.rowCount) {
        this.pointSizes = new Float32Array(data.rowCount);
      }
      this.maxPointSize = 0;
      for (let index = 0; index < data.rowCount; index++) {
        // 詰め替え後の f32 を使い、元の SQL 列と GPU の丸めの違いを持ち込まない。
        const size = Math.abs(packed.instanceData[index * 4 + 3]);
        this.pointSizes[index] = Number.isFinite(size) ? size : 0;
        this.maxPointSize = Math.max(this.maxPointSize, this.pointSizes[index]);
      }
      if (needsSpatialIndex) {
        this.pointsCache = packed.coordinates;
        const { xArr, yArr, length } = packed.coordinates;
        this.spatialIndex.build(xArr, yArr, length);
      }

      return {
        instanceData: packed.instanceData,
        totalCount: data.rowCount,
        lodSizeDistribution: sizeDistributionCache.distribution,
      };
    } catch (e) {
      if (this.onError) {
        this.onError(
          createError('QUERY_FAILED', 'Failed to load all points', {
            cause: e instanceof Error ? e : undefined,
          })
        );
      }
      return {
        instanceData: new Float32Array(0),
        totalCount: 0,
      };
    }
  }

  /**
   * GPUフィルターカラムデータを読み込む
   * @returns フィルターカラムデータとカラム数、カラムが指定されていない場合はnull
   */
  async loadGpuFilterColumns(): Promise<{
    data: Float32Array;
    columnMapping: Map<string, number>;
  } | null> {
    if (this.gpuFilterColumns.length === 0) {
      return null;
    }

    const columns = this.gpuFilterColumns.slice(0, MAX_GPU_FILTER_COLUMNS);

    try {
      const columnSelects = columns
        .map((col, i) => `CAST(${col} AS DOUBLE) AS __filter_col_${i}__`)
        .join(', ');

      const data = await this.repository!.query({
        // ORDER BY rowid: GPU filter column buffer の行順を loadAllPoints/loadVisibilityFlags
        //（いずれも ORDER BY rowid）と揃える。これが無いと per-point の filter 値が point
        // buffer と別順序になり、GPU range フィルタや fade（filterColumns[pointIdx] 参照）が
        // 誤った行の値を読む潜在バグになる。
        toString: () => `SELECT ${columnSelects} FROM parquet_data ORDER BY rowid`,
      });
      if (!data || data.rowCount === 0) {
        return null;
      }

      const filterData = new Float32Array(data.rowCount * GPU_FILTER_COLUMN_COMPONENTS);

      for (let i = 0; i < data.rowCount; i++) {
        const baseIndex = i * GPU_FILTER_COLUMN_COMPONENTS;
        for (let j = 0; j < GPU_FILTER_COLUMN_COMPONENTS; j++) {
          if (j < columns.length) {
            const colData = data.columnData.get(`__filter_col_${j}__`)!;
            filterData[baseIndex + j] = colData.get(i);
          } else {
            filterData[baseIndex + j] = 0;
          }
        }
      }

      const columnMapping = new Map<string, number>();
      columns.forEach((col, i) => columnMapping.set(col, i));

      this.filterColumnData = filterData;

      return {
        data: filterData,
        columnMapping,
      };
    } catch (e) {
      if (this.onError) {
        this.onError(
          createError('QUERY_FAILED', 'Failed to load GPU filter columns', {
            cause: e instanceof Error ? e : undefined,
          })
        );
      }
      return null;
    }
  }

  /**
   * WHERE条件に基づいてビットフラグ配列を生成する
   * @returns 可視ポイントのビットマップと総ポイント数、エラー時はnull
   */
  async loadVisibilityFlags(): Promise<{
    flags: Uint32Array;
    totalCount: number;
  } | null> {
    try {
      const totalCount = this.pointsCache.length;

      if (totalCount === 0) {
        return null;
      }

      // WHERE条件がない場合は全ポイント可視
      if (this.whereConditions.length === 0) {
        this.visibilityFlags = new Uint32Array(0);
        const wordCount = Math.ceil(totalCount / 32);
        const flags = new Uint32Array(wordCount);
        flags.fill(0xffffffff);
        return { flags, totalCount };
      }

      // WHERE句を構築
      const whereConditions: string[] = [];
      for (const condition of this.whereConditions) {
        whereConditions.push(this.buildWhereClauseString(condition));
      }
      const whereClause = `WHERE ${whereConditions.join(' AND ')}`;

      // 一致する行だけを 32 点単位で集約する。欠けたワードも 0 で埋め、GPU と同じ順番で返す。
      const wordCount = Math.ceil(totalCount / 32);
      const data = await this.repository!.query({
        toString: () =>
          `WITH __matching_words AS (` +
          `SELECT rowid // 32 AS __word_index__, ` +
          `bit_or(1::UINTEGER << ((rowid % 32)::UINTEGER)) AS __flags__ ` +
          `FROM parquet_data ${whereClause} GROUP BY rowid // 32) ` +
          `SELECT COALESCE(__matching_words.__flags__, 0::UINTEGER) AS __flags__ ` +
          `FROM range(${wordCount}) AS __words(__word_index__) ` +
          `LEFT JOIN __matching_words USING (__word_index__) ORDER BY __words.__word_index__`,
      });
      if (!data) {
        return null;
      }

      // 行ごとの JS 変換はせず、Arrow の u32 列を使う。複数チャンクの場合だけ連結する。
      // CPU ホバーにも同じ連続配列を渡し、GPU 転送では byteOffset と byteLength を保持する。
      const flags = data.columnData.get('__flags__')!.toArray();
      if (!(flags instanceof Uint32Array) || flags.length !== wordCount) {
        throw new Error('Visibility query must return one u32 value per 32 points');
      }

      this.visibilityFlags = this.whereConditions.length === 0 ? new Uint32Array(0) : flags;

      return { flags, totalCount };
    } catch (e) {
      if (this.onError) {
        this.onError(
          createError('QUERY_FAILED', 'Failed to load visibility flags', {
            cause: e instanceof Error ? e : undefined,
          })
        );
      }
      return null;
    }
  }

  /**
   * カスタムSQLクエリを実行する
   * @param query SQLクエリ
   * @returns クエリ結果のParquetData
   */
  async executeQuery(query: string | { toString: () => string }): Promise<ParquetData | undefined> {
    return this.repository!.query(typeof query === 'string' ? { toString: () => query } : query);
  }

  /**
   * 設定オプションを更新する
   * @param options 更新する設定オプション
   * @returns 変更の種類を示すオブジェクト
   */
  async updateOptions(options: Partial<DataLayerOptions>): Promise<DataLayerUpdateResult> {
    let needsFullReload = options.reloadPoints === true;
    let needsVisibilityUpdate = false;
    let gpuFilterColumnsChanged = false;

    // 同じ SQL 式がサイズの参照テーブルを使う場合も、明示的な再取得では分布を更新する。
    if (options.reloadPoints === true) {
      this.sizeDistributionCache = null;
      this.sizeDistributionRevision++;
    }

    if (options.sizeSql !== undefined && options.sizeSql !== this.sizeSql) {
      this.sizeSql = options.sizeSql;
      this.sizeDistributionCache = null;
      this.sizeDistributionRevision++;
      needsFullReload = true;
    }
    if (options.colorSql !== undefined && options.colorSql !== this.colorSql) {
      this.colorSql = options.colorSql;
      needsFullReload = true;
    }
    if (options.whereConditions !== undefined) {
      const oldConditions = JSON.stringify(this.whereConditions);
      const newConditions = JSON.stringify(options.whereConditions);
      if (oldConditions !== newConditions) {
        this.whereConditions = options.whereConditions;
        // WHERE条件変更時はフルリロードではなくビジビリティ更新のみ
        needsVisibilityUpdate = true;
      }
    }
    if (options.gpuFilterColumns !== undefined) {
      const capped = this.capGpuFilterColumns(options.gpuFilterColumns);
      // この更新が gpuFilterColumns を上書きするため、構築時に保留した警告は破棄する。
      // （未 initialize の状態でこれが呼ばれても、後続の flush で古い設定の警告が
      //   二重発火しないようにする。現在の設定に対する警告は下で即時発火する。）
      this.pendingConfigWarning = null;
      // 構築後の更新では consumer が on('error') を登録済みなので即時発火してよい
      if (capped.warning && this.onError) {
        this.onError(capped.warning);
      }
      const oldColumns = this.gpuFilterColumns.join(',');
      const newColumns = capped.columns.join(',');
      if (oldColumns !== newColumns) {
        this.gpuFilterColumns = capped.columns;
        gpuFilterColumnsChanged = true;
      }
    }
    if (options.onDataChanged !== undefined) {
      this.onDataChanged = options.onDataChanged;
    }
    if (options.onVisibilityChanged !== undefined) {
      this.onVisibilityChanged = options.onVisibilityChanged;
    }

    if (needsFullReload && this.onDataChanged) {
      await this.onDataChanged();
    } else if (needsVisibilityUpdate && this.onVisibilityChanged) {
      await this.onVisibilityChanged();
    }

    return {
      allPointsChanged: needsFullReload,
      visibilityChanged: needsVisibilityUpdate,
      gpuFilterColumnsChanged,
    };
  }

  /**
   * GPUフィルターレンジを更新する（findNearestPointで使用）
   * スライダー変更時にO(1)で呼び出される
   */
  setGpuFilterRanges(ranges: { columnIndex: number; min: number; max: number }[]): void {
    this.gpuFilterRanges = ranges;
  }

  /** 固定座標と四分木を再利用し、LOD 前の矩形内一致点を取得する。 */
  findPointsInBounds(bounds: BrushBounds, limit: number): PointPosition[] {
    return this.spatialIndex
      .findInBounds(
        bounds,
        limit,
        this.visibilityFlags,
        this.filterColumnData,
        this.gpuFilterRanges
      )
      .map((id) => ({ id, x: this.pointsCache.xArr[id], y: this.pointsCache.yArr[id] }));
  }

  /**
   * 画面座標に最も近いポイントを検索する
   * @param screenX マウスのスクリーンX座標
   * @param screenY マウスのスクリーンY座標
   * @param canvasWidth キャンバスの幅（ピクセル）
   * @param canvasHeight キャンバスの高さ（ピクセル）
   * @param zoom 現在のズームレベル
   * @param panX 現在のパンX
   * @param panY 現在のパンY
   * @param aspectRatio キャンバスのアスペクト比
   * @param thresholdPixels 小さい点にも確保する最小の判定半径（ピクセル、デフォルト: 10）
   * @param pointSizeScale GPU 描画と同じポイントサイズ倍率（デフォルト: 1）
   * @returns 見つかった場合はポイントデータ、そうでない場合はnull
   */
  /**
   * 画面座標に最も近いポイントの rowid を返す（spatial index のみ。DuckDB クエリは発行しない）。
   * hover のたびに点データ（SELECT *）を取得するのを避け、rowid が前回と変わったときだけ
   * findPointById を呼べるようにするための軽量版。
   * @returns 見つかった場合は rowid、なければ null
   */
  findNearestPointId(
    screenX: number,
    screenY: number,
    canvasWidth: number,
    canvasHeight: number,
    zoom: number,
    panX: number,
    panY: number,
    aspectRatio: number,
    thresholdPixels: number = 10,
    pointSizeScale: number = 1
  ): number | null {
    if (!this.spatialIndex.isBuilt()) {
      return null;
    }

    const clipX = (screenX / canvasWidth) * 2 - 1;
    const clipY = -((screenY / canvasHeight) * 2 - 1);

    const worldX = ((clipX - panX) * aspectRatio) / zoom;
    const worldY = (clipY - panY) / zoom;

    const pixelToWorld = (2 * aspectRatio) / (canvasWidth * zoom);
    const minimumRadius = thresholdPixels * pixelToWorld;
    // GPU の点半径と同じサイズ倍率・ズーム補正を使う。小さい点には従来の余白を残す。
    const sizeToWorld = pointSizeScale * Math.pow(zoom, 0.3) * pixelToWorld;
    const thresholdWorld = Math.max(minimumRadius, this.maxPointSize * sizeToWorld);
    const thresholdWorldSq = thresholdWorld * thresholdWorld;

    return (
      this.spatialIndex.findNearest(
        worldX,
        worldY,
        thresholdWorldSq,
        this.visibilityFlags,
        this.filterColumnData,
        this.gpuFilterRanges,
        (index, distanceSq) => {
          // 最大サイズは枝の探索範囲にだけ使い、各候補は自分の半径で判定する。
          const radius = Math.max(minimumRadius, this.pointSizes[index] * sizeToWorld);
          return distanceSq < radius * radius;
        }
      ) ?? null
    );
  }

  async findNearestPoint(
    screenX: number,
    screenY: number,
    canvasWidth: number,
    canvasHeight: number,
    zoom: number,
    panX: number,
    panY: number,
    aspectRatio: number,
    thresholdPixels: number = 10,
    pointSizeScale: number = 1
  ): Promise<Record<string, any> | null> {
    const nearestRowid = this.findNearestPointId(
      screenX,
      screenY,
      canvasWidth,
      canvasHeight,
      zoom,
      panX,
      panY,
      aspectRatio,
      thresholdPixels,
      pointSizeScale
    );
    if (nearestRowid == null) {
      return null;
    }

    return this.findPointById(nearestRowid);
  }

  /**
   * データレイヤーが初期化されているかチェックする
   * @returns 初期化されていればtrue
   */
  isInitialized(): boolean {
    return this.repository !== null;
  }

  /**
   * rowidでポイントを検索する
   * @param pointId 検索するポイントのrowid
   * @returns 見つかった場合はポイントデータ、そうでない場合はnull
   */
  async findPointById(pointId: number): Promise<PointAttributes | null> {
    return (await this.findPointsByIds([pointId]))[0] ?? null;
  }

  /** 現在の色・サイズの式を使い、少数点の属性をひとつのクエリで取得する。 */
  async findPointsByIds(pointIds: readonly number[]): Promise<PointAttributes[]> {
    const ids = [...new Set(pointIds)];
    if (ids.some((id) => !Number.isSafeInteger(id) || id < 0)) {
      throw new RangeError('Point IDs must be non-negative safe integers.');
    }
    if (ids.length === 0) return [];
    if (!this.repository) throw new Error('Point data has not been initialized.');
    const data = await this.repository.query({
      toString: () =>
        `SELECT *, (${this.sizeSql}) AS __size__, (${this.colorSql}) AS __color__, rowid AS __point_id__
         FROM parquet_data WHERE rowid IN (${ids.join(',')})`,
    });
    const rows: PointAttributes[] = [];
    for (let i = 0; i < data.rowCount; i++) {
      const row: PointAttributes = {
        __point_id__: Number(data.columnData.get('__point_id__')!.get(i)),
        __size__: data.columnData.get('__size__')!.get(i),
        __color__: data.columnData.get('__color__')!.get(i),
      };
      for (const column of data.columns) {
        // 元データに同名の列があっても、描画用メタデータを上書きしない。
        if (column !== '__point_id__' && column !== '__size__' && column !== '__color__') {
          row[column] = data.columnData.get(column)!.get(i);
        }
      }
      rows.push(row);
    }
    return rows;
  }

  /**
   * リソースをクリーンアップする
   */
  async destroy(): Promise<void> {
    this.spatialIndex.destroy();
    this.pointPacker.clear();
    this.sizeDistributionCache = null;
    this.sizeDistributionRevision++;
    this.pointsCache = { xArr: new Float64Array(0), yArr: new Float64Array(0), length: 0 };
    this.pointSizes = new Float32Array(0);
    this.maxPointSize = 0;
    if (this.repository) {
      await this.repository.close();
      this.repository = null;
    }
  }
}
