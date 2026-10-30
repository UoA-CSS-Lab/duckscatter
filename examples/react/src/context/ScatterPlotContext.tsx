import {
  createContext,
  useContext,
  useState,
  useCallback,
  useRef,
  useEffect,
  type ReactNode,
} from 'react';
import type { ScatterPlot, WhereCondition, Label, LabelIdentifier, GpuWhereCondition } from '@uoa-css-lab/duckscatter';

interface ScatterPlotState {
  isInitialized: boolean;
  isLoading: boolean;
  error: string | null;
  hoveredPoint: Record<string, unknown> | null;
  hoveredLabel: Label | null;
  pointCount: number | null;
  /** created_atカラムの範囲（min/max） */
  timeRange: { min: number; max: number } | null;
}

export interface PointListItem {
  id: number;
  x: number;
  y: number;
}

interface ScatterPlotContextValue {
  plot: ScatterPlot | null;
  state: ScatterPlotState;
  initializePlot: (canvas: HTMLCanvasElement) => Promise<void>;
  /** ローカルのParquetファイルを読み込んでプロットを再初期化する */
  loadDataFile: (file: File) => Promise<void>;
  updateSize: (sizeSql: string) => Promise<void>;
  updateColor: (colorSql: string) => Promise<void>;
  updateSearch: (searchText: string) => Promise<void>;
  updatePointLimit: (limit: number) => Promise<void>;
  updateLabelFilter: (searchText: string) => void;
  /** GPU側で時間範囲フィルターを適用 */
  updateTimeFilter: (min: number | null, max: number | null) => Promise<void>;
  /** グローバル透明度を設定 */
  updatePointAlpha: (alpha: number) => void;
  /** グローバルサイズスケールを設定 */
  updatePointSizeScale: (scale: number) => void;
  /** フィルター除外ポイントの表示モードを設定 */
  updateFilteredPointDisplayMode: (mode: 'hidden' | 'grayed') => void;
  // Hover control
  setPointHover: (pointId: number) => Promise<boolean>;
  setLabelHover: (identifier: LabelIdentifier) => boolean;
  clearAllHover: () => void;
  // List data
  fetchPoints: (page: number, pageSize: number) => Promise<PointListItem[]>;
  getLabels: () => Label[];
}

const ScatterPlotContext = createContext<ScatterPlotContextValue | null>(null);

export function ScatterPlotProvider({ children }: { children: ReactNode }) {
  const plotRef = useRef<ScatterPlot | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [state, setState] = useState<ScatterPlotState>({
    isInitialized: false,
    isLoading: false,
    error: null,
    hoveredPoint: null,
    hoveredLabel: null,
    pointCount: null,
    timeRange: null,
  });

  const filtersRef = useRef<{
    searchText: string;
    sizeSql: string;
    colorSql: string;
    visiblePointLimit: number;
    timeRangeFilter: { min: number | null; max: number | null };
  }>({
    searchText: '',
    sizeSql: '5',
    colorSql: '(CAST(255 AS BIGINT) * 16777216 + 59 * 65536 + 130 * 256 + 246 - CASE WHEN (CAST(255 AS BIGINT) * 16777216 + 59 * 65536 + 130 * 256 + 246) > 2147483647 THEN 4294967296 ELSE 0 END)::INTEGER',
    visiblePointLimit: 100000,
    timeRangeFilter: { min: null, max: null },
  });

  const buildWhereConditions = useCallback((): WhereCondition[] => {
    const conditions: WhereCondition[] = [];
    if (filtersRef.current.searchText) {
      conditions.push({
        type: 'string',
        column: 'token',
        operator: 'contains',
        value: filtersRef.current.searchText,
      });
    }
    return conditions;
  }, []);

  const initializePlot = useCallback(
    async (canvas: HTMLCanvasElement) => {
      const { ScatterPlot } = await import('@uoa-css-lab/duckscatter');

      canvasRef.current = canvas;
      setState((s) => ({ ...s, isLoading: true, error: null }));

      const plot = new ScatterPlot({
        canvas,
        dataUrl: `${import.meta.env.BASE_URL}output.parquet`,
        data: {
          sizeSql: filtersRef.current.sizeSql,
          colorSql: filtersRef.current.colorSql,
          visiblePointLimit: filtersRef.current.visiblePointLimit,
          gpuFilterColumns: ['created_at'],
        },
        gpu: {
          backgroundColor: { r: 0.85, g: 0.85, b: 0.85, a: 1.0 },
        },
        labels: {
          url: `${import.meta.env.BASE_URL}label.geojson`,
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
        plotRef.current = plot;
        plot.render();

        // Get point count
        const result = await plot.runQuery('SELECT COUNT(*) as count FROM parquet_data');
        let pointCount = 0;
        if (result && result.rowCount > 0) {
          const countCol = result.columnData.get('count');
          if (countCol) {
            pointCount = Number(countCol[0]);
          }
        }

        // Get time range (created_at min/max)
        let timeRange: { min: number; max: number } | null = null;
        const timeResult = await plot.runQuery(
          'SELECT MIN(created_at) as min_time, MAX(created_at) as max_time FROM parquet_data'
        );
        if (timeResult && timeResult.rowCount > 0) {
          const minCol = timeResult.columnData.get('min_time');
          const maxCol = timeResult.columnData.get('max_time');
          if (minCol && maxCol) {
            const minVal = Number(minCol.get(0));
            const maxVal = Number(maxCol.get(0));
            if (!isNaN(minVal) && !isNaN(maxVal)) {
              timeRange = { min: minVal, max: maxVal };
            }
          }
        }

        setState((s) => ({ ...s, isInitialized: true, isLoading: false, pointCount, timeRange }));
      } catch (e) {
        setState((s) => ({
          ...s,
          isLoading: false,
          error: e instanceof Error ? e.message : 'Failed to initialize',
        }));
      }
    },
    []
  );

  const loadDataFile = useCallback(
    async (file: File) => {
      const canvas = canvasRef.current;
      if (!canvas) return;

      // 既存のプロットを破棄
      if (plotRef.current) {
        await plotRef.current.destroy();
        plotRef.current = null;
      }

      const { ScatterPlot } = await import('@uoa-css-lab/duckscatter');

      setState((s) => ({
        ...s,
        isInitialized: false,
        isLoading: true,
        error: null,
        pointCount: null,
        timeRange: null,
      }));

      const plot = new ScatterPlot({
        canvas,
        dataFile: file,
        data: {
          sizeSql: filtersRef.current.sizeSql,
          colorSql: filtersRef.current.colorSql,
          visiblePointLimit: filtersRef.current.visiblePointLimit,
        },
        gpu: {
          backgroundColor: { r: 0.85, g: 0.85, b: 0.85, a: 1.0 },
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
        plotRef.current = plot;
        plot.render();

        const result = await plot.runQuery('SELECT COUNT(*) as count FROM parquet_data');
        let pointCount = 0;
        if (result && result.rowCount > 0) {
          const countCol = result.columnData.get('count');
          if (countCol) {
            pointCount = Number(countCol[0]);
          }
        }

        setState((s) => ({
          ...s,
          isInitialized: true,
          isLoading: false,
          pointCount,
          timeRange: null,
        }));
      } catch (e) {
        setState((s) => ({
          ...s,
          isLoading: false,
          error: e instanceof Error ? e.message : 'Failed to load file',
        }));
      }
    },
    []
  );

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

  const updateColor = useCallback(
    async (colorSql: string) => {
      if (!plotRef.current) return;
      filtersRef.current.colorSql = colorSql;
      await plotRef.current.update({
        data: {
          sizeSql: filtersRef.current.sizeSql,
          colorSql,
          whereConditions: buildWhereConditions(),
        },
      });
      plotRef.current.render();
    },
    [buildWhereConditions]
  );

  const updateSearch = useCallback(
    async (searchText: string) => {
      if (!plotRef.current) return;
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

  // Hover control methods
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
          filterLambda: undefined,
        },
      });
    } else {
      const lowerSearch = searchText.toLowerCase();
      plotRef.current.update({
        labels: {
          filterLambda: (properties) => {
            const label = (properties.cluster_label as string) || '';
            return label.toLowerCase().includes(lowerSearch);
          },
        },
      });
    }
    plotRef.current.render();
  }, []);

  const updateTimeFilter = useCallback(
    async (min: number | null, max: number | null) => {
      if (!plotRef.current) return;
      filtersRef.current.timeRangeFilter = { min, max };

      // GPU側のフィルター条件を構築
      const gpuConditions: GpuWhereCondition[] = [];
      if (min !== null || max !== null) {
        gpuConditions.push({
          column: 'created_at',
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
    },
    []
  );

  const updatePointAlpha = useCallback((alpha: number) => {
    if (!plotRef.current) return;
    plotRef.current.setPointAlpha(alpha);
  }, []);

  const updatePointSizeScale = useCallback((scale: number) => {
    if (!plotRef.current) return;
    plotRef.current.setPointSizeScale(scale);
  }, []);

  const updateFilteredPointDisplayMode = useCallback((mode: 'hidden' | 'grayed') => {
    if (!plotRef.current) return;
    plotRef.current.setFilteredPointDisplayMode(mode);
  }, []);

  // List data methods
  const fetchPoints = useCallback(
    async (page: number, pageSize: number): Promise<PointListItem[]> => {
      if (!plotRef.current) return [];
      const offset = page * pageSize;
      const result = await plotRef.current.runQuery(
        `SELECT rowid as id, x, y FROM parquet_data ORDER BY rowid LIMIT ${pageSize} OFFSET ${offset}`
      );
      if (!result || result.rowCount === 0) return [];

      const idCol = result.columnData.get('id');
      const xCol = result.columnData.get('x');
      const yCol = result.columnData.get('y');

      const points: PointListItem[] = [];
      for (let i = 0; i < result.rowCount; i++) {
        points.push({
          id: idCol?.get(i),
          x: xCol?.get(i),
          y: yCol?.get(i),
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
        loadDataFile,
        updateSize,
        updateColor,
        updateSearch,
        updatePointLimit,
        updateLabelFilter,
        updateTimeFilter,
        updatePointAlpha,
        updatePointSizeScale,
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
