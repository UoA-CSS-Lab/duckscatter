/**
 * duckscatter - WebGPUを使用して散布図を描画するTypeScriptライブラリ
 */

export { ScatterPlot } from './scatter-plot.js';
export type {
  Color4f,
  ScatterPlotOptions,
  Label,
  WhereCondition,
  NumericFilter,
  StringFilter,
  RawSqlFilter,
  NumericOperator,
  StringOperator,
  // GPU filter types
  GpuWhereCondition,
  FilteredPointDisplayMode,
  // Selection / brushing types
  SelectionBrushMode,
  SelectionBrushTarget,
  BrushBounds,
  ScreenBrushRect,
  PointPosition,
  PointAttributes,
  ViewportPointQueryResult,
  ScatterPlotView,
  PointDataChangeEvent,
  BrushOptions,
  SelectionStyle,
  RecededClampOptions,
  // Label muted style
  MutedLabelStyle,
  // Update introspection types
  ScatterPlotUpdatePath,
  ScatterPlotUpdatePlan,
  // Error handling types
  ErrorSeverity,
  ErrorCategory,
  ErrorCode,
  ScatterPlotError,
  ScatterPlotEventMap,
  // Hover control types
  LabelIdentifier,
  LabelHoverCallback,
  // Instrumentation (dev/debug)
  FrameStats,
  GpuTimingSource,
} from './types.js';

export {
  MAX_GPU_FILTER_COLUMNS,
  GPU_FILTER_COLUMN_COMPONENTS,
  DEFAULT_TARGET_RENDER_TIME_MS,
} from './constants.js';
export { diagnoseWebGPU } from './diagnostics.js';
export type { WebGPUDiagnostics } from './diagnostics.js';

/**
 * 現在の環境でWebGPUがサポートされているかを確認する
 * @returns WebGPUがサポートされている場合はtrue、そうでない場合はfalse
 */
export function isWebGPUSupported(): boolean {
  // navigatorオブジェクトにgpuプロパティが存在するかをチェック
  return 'gpu' in navigator;
}
