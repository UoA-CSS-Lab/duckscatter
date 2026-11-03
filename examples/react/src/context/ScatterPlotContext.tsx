import {
  createContext,
  useContext,
  useState,
  useCallback,
  useRef,
  useEffect,
  type ReactNode,
} from 'react';
import type {
  ScatterPlot,
  WhereCondition,
  Label,
  LabelIdentifier,
  GpuWhereCondition,
} from '@uoa-css-lab/duckscatter';
import {
  DEFAULT_POINT_COLOR,
  CLUSTER_COLOR_SQL,
  buildSingleColorSql,
  readClusterColors,
  replaceClusterColorTable,
  type ClusterColor,
  type PointColorMode,
} from '../utils/clusterColors';

// 公開日（YYYYMMDD）を UNIX 秒へ変換し、範囲の取得と GPU フィルターで同じ式を使う。
const PUBLISH_TIME_SQL = "epoch(strptime(CAST(publish_date AS VARCHAR), '%Y%m%d'))";

export const DEFAULT_LABEL_FONT_SIZE = 12;

interface ScatterPlotState {
  isInitialized: boolean;
  isLoading: boolean;
  error: string | null;
  hoveredPoint: Record<string, unknown> | null;
  hoveredLabel: Label | null;
  pointCount: number | null;
  hasHeadlineText: boolean;
  hasClusterId: boolean;
  hasClusterColors: boolean;
  colorMode: PointColorMode;
  pointColor: string;
  /** 読み込み済みラベルの表示用スナップショット */
  labels: Label[];
  /** 公開日の範囲（UNIX 秒の min/max） */
  timeRange: { min: number; max: number } | null;
}

export interface PointListItem {
  id: number;
  x: number;
  y: number;
  headlineText: string | null;
  publishDate: number | null;
}

type DataSummary = Pick<
  ScatterPlotState,
  'pointCount' | 'timeRange' | 'hasHeadlineText' | 'hasClusterId'
>;

/** 読み込んだ列を確認し、公開日を持つデータだけに日付フィルターを登録する。 */
async function readDataSummary(plot: ScatterPlot): Promise<DataSummary> {
  const schema = await plot.runQuery('DESCRIBE parquet_data');
  const columnNames = schema?.columnData.get('column_name');
  if (!schema || !columnNames) {
    throw new Error('Failed to read the Parquet schema.');
  }
  const columns = new Set<string>();
  for (let i = 0; i < schema.rowCount; i++) {
    columns.add(String(columnNames.get(i)));
  }

  const hasPublishDate = columns.has('publish_date');
  const timeColumns = hasPublishDate
    ? `MIN(${PUBLISH_TIME_SQL}) AS min_time, MAX(${PUBLISH_TIME_SQL}) AS max_time`
    : 'NULL AS min_time, NULL AS max_time';
  const result = await plot.runQuery(`SELECT COUNT(*) AS count, ${timeColumns} FROM parquet_data`);
  if (!result || result.rowCount === 0) {
    throw new Error('Failed to read the Parquet summary.');
  }

  // Arrow の列は配列添字ではなく get() で読む。NULL を epoch の 0 秒に変換しない。
  const pointCount = Number(result?.columnData.get('count')?.get(0) ?? 0);
  const min = result?.columnData.get('min_time')?.get(0);
  const max = result?.columnData.get('max_time')?.get(0);
  const timeRange =
    min != null && max != null && Number.isFinite(Number(min)) && Number.isFinite(Number(max))
      ? { min: Number(min), max: Number(max) }
      : null;

  await plot.update({
    data: { gpuFilterColumns: timeRange ? [PUBLISH_TIME_SQL] : [] },
  });

  return {
    pointCount,
    timeRange,
    hasHeadlineText: columns.has('headline_text'),
    hasClusterId: columns.has('cluster_id'),
  };
}

/** 未対応のデータでは単色に戻し、存在しないクラスタ列を SQL に含めない。 */
function getPointColorSettings(
  requestedMode: PointColorMode,
  pointColor: string,
  hasClusterId: boolean,
  colors: readonly ClusterColor[]
): { colorMode: PointColorMode; colorSql: string; hasClusterColors: boolean } {
  const hasClusterColors = hasClusterId && colors.length > 0;
  const colorMode = requestedMode === 'cluster' && hasClusterColors ? 'cluster' : 'single';
  const colorSql = colorMode === 'cluster' ? CLUSTER_COLOR_SQL : buildSingleColorSql(pointColor);
  return { colorMode, colorSql, hasClusterColors };
}

interface ScatterPlotContextValue {
  plot: ScatterPlot | null;
  state: ScatterPlotState;
  initializePlot: (canvas: HTMLCanvasElement) => Promise<void>;
  updateSize: (sizeSql: string) => Promise<void>;
  updateColorMode: (mode: PointColorMode) => Promise<void>;
  updatePointColor: (color: string) => Promise<void>;
  updateSearch: (searchText: string) => Promise<void>;
  updatePointLimit: (limit: number) => Promise<void>;
  updateLabelFilter: (searchText: string) => void;
  /** GPU側で時間範囲フィルターを適用 */
  updateTimeFilter: (min: number | null, max: number | null) => Promise<void>;
  /** グローバル透明度を設定 */
  updatePointAlpha: (alpha: number) => void;
  /** グローバルサイズスケールを設定 */
  updatePointSizeScale: (scale: number) => void;
  /** ラベルのフォントサイズをピクセル単位で設定 */
  updateLabelFontSize: (fontSize: number) => Promise<void>;
  /** フィルター除外ポイントの表示モードを設定 */
  updateFilteredPointDisplayMode: (mode: 'hidden' | 'grayed') => void;
  // ホバーの操作
  setPointHover: (pointId: number) => Promise<boolean>;
  setLabelHover: (identifier: LabelIdentifier) => boolean;
  clearAllHover: () => void;
  // 一覧のデータ
  fetchPoints: (page: number, pageSize: number) => Promise<PointListItem[]>;
  getLabels: () => Label[];
}

const ScatterPlotContext = createContext<ScatterPlotContextValue | null>(null);

export function ScatterPlotProvider({ children }: { children: ReactNode }) {
  const plotRef = useRef<ScatterPlot | null>(null);
  const dataSummaryRef = useRef<DataSummary | null>(null);
  const clusterColorsRef = useRef<ClusterColor[]>([]);
  const [state, setState] = useState<ScatterPlotState>({
    isInitialized: false,
    isLoading: false,
    error: null,
    hoveredPoint: null,
    hoveredLabel: null,
    pointCount: null,
    hasHeadlineText: false,
    hasClusterId: false,
    hasClusterColors: false,
    colorMode: 'cluster',
    pointColor: DEFAULT_POINT_COLOR,
    labels: [],
    timeRange: null,
  });

  const filtersRef = useRef<{
    searchText: string;
    sizeSql: string;
    colorSql: string;
    colorMode: PointColorMode;
    pointColor: string;
    visiblePointLimit: number;
    labelFontSize: number;
    timeRangeFilter: { min: number | null; max: number | null };
  }>({
    searchText: '',
    sizeSql: '5',
    colorSql: buildSingleColorSql(DEFAULT_POINT_COLOR),
    colorMode: 'cluster',
    pointColor: DEFAULT_POINT_COLOR,
    visiblePointLimit: 100000,
    labelFontSize: DEFAULT_LABEL_FONT_SIZE,
    timeRangeFilter: { min: null, max: null },
  });

  const buildWhereConditions = useCallback((): WhereCondition[] => {
    const conditions: WhereCondition[] = [];
    if (dataSummaryRef.current?.hasHeadlineText && filtersRef.current.searchText) {
      conditions.push({
        type: 'string',
        column: 'headline_text',
        operator: 'contains',
        value: filtersRef.current.searchText,
      });
    }
    return conditions;
  }, []);

  const initializePlot = useCallback(async (canvas: HTMLCanvasElement) => {
    const { ScatterPlot } = await import('@uoa-css-lab/duckscatter');

    setState((s) => ({ ...s, isLoading: true, error: null }));

    const plot = new ScatterPlot({
      canvas,
      dataUrl: `${import.meta.env.BASE_URL}abcnews-embeddinggemma2-umap.parquet`,
      data: {
        sizeSql: filtersRef.current.sizeSql,
        colorSql: filtersRef.current.colorSql,
        visiblePointLimit: filtersRef.current.visiblePointLimit,
      },
      gpu: {
        backgroundColor: { r: 0.85, g: 0.85, b: 0.85, a: 1.0 },
      },
      labels: {
        url: `${import.meta.env.BASE_URL}abcnews-clusters.geojson`,
        fontSize: filtersRef.current.labelFontSize,
        onClick: (label) => {
          console.log('Label clicked:', label);
        },
        hoverOutlineOptions: {
          enabled: true,
          color: '#ffffff',
          width: 2,
        },
      },
      interaction: {
        onPointHover: (data) => {
          setState((s) => ({ ...s, hoveredPoint: data }));
        },
        onLabelHover: (label) => {
          setState((s) => ({ ...s, hoveredLabel: label }));
        },
      },
    });

    plot.on('error', (error) => {
      setState((s) => ({ ...s, error: error.message }));
    });

    try {
      await plot.initialize();
      const summary = await readDataSummary(plot);
      const colors = readClusterColors(plot.getLabels());
      await replaceClusterColorTable((sql) => plot.runQuery(sql), colors);
      const colorSettings = getPointColorSettings(
        filtersRef.current.colorMode,
        filtersRef.current.pointColor,
        summary.hasClusterId,
        colors
      );
      // スキーマとラベルを確認してから、既存の色更新経路でクラスタ色を適用する。
      await plot.update({ data: { colorSql: colorSettings.colorSql } });
      clusterColorsRef.current = colors;
      filtersRef.current.colorMode = colorSettings.colorMode;
      filtersRef.current.colorSql = colorSettings.colorSql;
      dataSummaryRef.current = summary;
      plotRef.current = plot;
      plot.render();

      setState((s) => ({
        ...s,
        ...summary,
        colorMode: colorSettings.colorMode,
        hasClusterColors: colorSettings.hasClusterColors,
        labels: plot.getLabels(),
        isInitialized: true,
        isLoading: false,
      }));
    } catch (e) {
      let message = e instanceof Error ? e.message : 'Failed to initialize';
      // 初期化に失敗して参照を保持しない場合も、GPU の監視とリソースを残さない。
      await plot.destroy().catch((cleanupError: unknown) => {
        message += `\nPlot cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`;
      });
      setState((s) => ({
        ...s,
        isLoading: false,
        error: message,
      }));
    }
  }, []);

  const updateSize = useCallback(
    async (sizeSql: string) => {
      if (!plotRef.current) return;
      filtersRef.current.sizeSql = sizeSql;
      await plotRef.current.update({
        data: {
          sizeSql,
          colorSql: filtersRef.current.colorSql,
          whereConditions: buildWhereConditions(),
        },
      });
      plotRef.current.render();
    },
    [buildWhereConditions]
  );

  const applyPointColor = useCallback(async (mode: PointColorMode, pointColor: string) => {
    const plot = plotRef.current;
    const summary = dataSummaryRef.current;
    if (!plot || !summary) return;
    if (mode === 'cluster' && (!summary.hasClusterId || clusterColorsRef.current.length === 0)) {
      throw new Error('Cluster coloring requires cluster IDs and RGB label colors.');
    }
    const settings = getPointColorSettings(
      mode,
      pointColor,
      summary.hasClusterId,
      clusterColorsRef.current
    );
    filtersRef.current.colorSql = settings.colorSql;
    filtersRef.current.colorMode = settings.colorMode;
    filtersRef.current.pointColor = pointColor;
    await plot.update({ data: { colorSql: settings.colorSql } });
    if (plot !== plotRef.current) return;
    plot.clearPointHover();
    setState((s) => ({ ...s, colorMode: settings.colorMode, pointColor }));
  }, []);

  const updateColorMode = useCallback(
    (mode: PointColorMode) => applyPointColor(mode, filtersRef.current.pointColor),
    [applyPointColor]
  );

  const updatePointColor = useCallback(
    (color: string) => applyPointColor('single', color),
    [applyPointColor]
  );

  const updateSearch = useCallback(
    async (searchText: string) => {
      if (!plotRef.current) return;
      if (searchText && !dataSummaryRef.current?.hasHeadlineText) {
        throw new Error('Headline search requires the headline_text column.');
      }
      filtersRef.current.searchText = searchText;
      await plotRef.current.update({
        data: {
          sizeSql: filtersRef.current.sizeSql,
          colorSql: filtersRef.current.colorSql,
          whereConditions: buildWhereConditions(),
        },
      });
      plotRef.current.render();
    },
    [buildWhereConditions]
  );

  const updatePointLimit = useCallback(
    async (limit: number) => {
      if (!plotRef.current) return;
      filtersRef.current.visiblePointLimit = limit;
      await plotRef.current.update({
        data: {
          sizeSql: filtersRef.current.sizeSql,
          colorSql: filtersRef.current.colorSql,
          visiblePointLimit: limit,
          whereConditions: buildWhereConditions(),
        },
      });
      plotRef.current.render();
    },
    [buildWhereConditions]
  );

  // ホバーの操作
  const setPointHover = useCallback(async (pointId: number): Promise<boolean> => {
    if (!plotRef.current) return false;
    return await plotRef.current.setPointHover(pointId);
  }, []);

  const setLabelHover = useCallback((identifier: LabelIdentifier): boolean => {
    if (!plotRef.current) return false;
    return plotRef.current.setLabelHover(identifier);
  }, []);

  const clearAllHover = useCallback(() => {
    if (!plotRef.current) return;
    plotRef.current.clearAllHover();
  }, []);

  const updateLabelFilter = useCallback((searchText: string) => {
    if (!plotRef.current) return;
    if (searchText.trim() === '') {
      plotRef.current.update({
        labels: {
          filterLambda: null,
        },
      });
    } else {
      const lowerSearch = searchText.toLowerCase();
      plotRef.current.update({
        labels: {
          filterLambda: (properties) => {
            // 新データのラベル名と説明文を同じ検索対象にする。
            return [
              properties.cluster_label,
              properties.cluster_label_50,
              properties.title,
              properties.cluster_description,
              properties.summary,
            ].some(
              (value) => typeof value === 'string' && value.toLowerCase().includes(lowerSearch)
            );
          },
        },
      });
    }
    plotRef.current.render();
  }, []);

  const updateTimeFilter = useCallback(async (min: number | null, max: number | null) => {
    if (!plotRef.current) return;
    if ((min !== null || max !== null) && !dataSummaryRef.current?.timeRange) {
      throw new Error('Publish date filtering requires a valid publish_date column.');
    }
    filtersRef.current.timeRangeFilter = { min, max };

    // GPU 側のフィルター条件を構築する。
    const gpuConditions: GpuWhereCondition[] = [];
    if (min !== null || max !== null) {
      gpuConditions.push({
        column: PUBLISH_TIME_SQL,
        min: min ?? undefined,
        max: max ?? undefined,
      });
    }

    await plotRef.current.update({
      data: {
        sizeSql: filtersRef.current.sizeSql,
        colorSql: filtersRef.current.colorSql,
        gpuWhereConditions: gpuConditions,
      },
    });
    plotRef.current.render();
  }, []);

  const updatePointAlpha = useCallback((alpha: number) => {
    if (!plotRef.current) return;
    plotRef.current.setPointAlpha(alpha);
  }, []);

  const updatePointSizeScale = useCallback((scale: number) => {
    if (!plotRef.current) return;
    plotRef.current.setPointSizeScale(scale);
  }, []);

  const updateLabelFontSize = useCallback(async (fontSize: number) => {
    // 表示の更新と再読み込み時の初期値を同じ設定に保つ。
    filtersRef.current.labelFontSize = fontSize;
    const plot = plotRef.current;
    if (!plot) return;
    await plot.update({ labels: { fontSize } });
    plot.render();
  }, []);

  const updateFilteredPointDisplayMode = useCallback((mode: 'hidden' | 'grayed') => {
    if (!plotRef.current) return;
    plotRef.current.setFilteredPointDisplayMode(mode);
  }, []);

  // 一覧のデータ取得
  const fetchPoints = useCallback(
    async (page: number, pageSize: number): Promise<PointListItem[]> => {
      if (!plotRef.current) return [];
      const offset = page * pageSize;
      const result = await plotRef.current.runQuery(
        `SELECT rowid AS __point_id__, * FROM parquet_data ORDER BY rowid LIMIT ${pageSize} OFFSET ${offset}`
      );
      if (!result || result.rowCount === 0) return [];

      const idCol = result.columnData.get('__point_id__');
      const xCol = result.columnData.get('x');
      const yCol = result.columnData.get('y');
      const headlineCol = result.columnData.get('headline_text');
      const dateCol = result.columnData.get('publish_date');

      const points: PointListItem[] = [];
      for (let i = 0; i < result.rowCount; i++) {
        points.push({
          id: Number(idCol?.get(i)),
          x: Number(xCol?.get(i)),
          y: Number(yCol?.get(i)),
          // 存在しない属性列は、一覧で空欄として扱う。
          headlineText: headlineCol?.get(i) ?? null,
          publishDate: dateCol?.get(i) ?? null,
        });
      }
      return points;
    },
    []
  );

  const getLabels = useCallback((): Label[] => {
    if (!plotRef.current) return [];
    return plotRef.current.getLabels();
  }, []);

  useEffect(() => {
    return () => {
      if (plotRef.current) {
        plotRef.current.destroy();
        plotRef.current = null;
      }
    };
  }, []);

  return (
    <ScatterPlotContext.Provider
      value={{
        plot: plotRef.current,
        state,
        initializePlot,
        updateSize,
        updateColorMode,
        updatePointColor,
        updateSearch,
        updatePointLimit,
        updateLabelFilter,
        updateTimeFilter,
        updatePointAlpha,
        updatePointSizeScale,
        updateLabelFontSize,
        updateFilteredPointDisplayMode,
        setPointHover,
        setLabelHover,
        clearAllHover,
        fetchPoints,
        getLabels,
      }}
    >
      {children}
    </ScatterPlotContext.Provider>
  );
}

export function useScatterPlot() {
  const context = useContext(ScatterPlotContext);
  if (!context) {
    throw new Error('useScatterPlot must be used within ScatterPlotProvider');
  }
  return context;
}
