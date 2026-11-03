import type { ScatterPlotError, ErrorCode, ErrorCategory, ErrorSeverity } from './types.js';

/**
 * エラーコードからカテゴリへのマッピング
 */
const categoryMap: Record<ErrorCode, ErrorCategory> = {
  WEBGPU_NOT_SUPPORTED: 'webgpu',
  GPU_ADAPTER_NOT_AVAILABLE: 'webgpu',
  GPU_DEVICE_FAILED: 'webgpu',
  GPU_DEVICE_LOST: 'webgpu',
  GPU_UNCAPTURED_ERROR: 'webgpu',
  GPU_SHADER_FAILED: 'webgpu',
  GPU_PIPELINE_FAILED: 'webgpu',
  GPU_READBACK_FAILED: 'webgpu',
  GPU_QUEUE_FAILED: 'webgpu',
  WEBGPU_CONTEXT_FAILED: 'webgpu',
  DATA_LAYER_NOT_INITIALIZED: 'data',
  PARQUET_LOAD_FAILED: 'data',
  QUERY_FAILED: 'query',
  LABEL_FETCH_FAILED: 'label',
  CONFIG_WARNING: 'data',
};

/**
 * エラーコードから重大度レベルへのマッピング
 */
const severityMap: Record<ErrorCode, ErrorSeverity> = {
  WEBGPU_NOT_SUPPORTED: 'fatal',
  GPU_ADAPTER_NOT_AVAILABLE: 'fatal',
  GPU_DEVICE_FAILED: 'fatal',
  GPU_DEVICE_LOST: 'fatal',
  GPU_UNCAPTURED_ERROR: 'error',
  GPU_SHADER_FAILED: 'fatal',
  GPU_PIPELINE_FAILED: 'fatal',
  GPU_READBACK_FAILED: 'warning',
  GPU_QUEUE_FAILED: 'error',
  WEBGPU_CONTEXT_FAILED: 'fatal',
  DATA_LAYER_NOT_INITIALIZED: 'fatal',
  PARQUET_LOAD_FAILED: 'fatal',
  QUERY_FAILED: 'error',
  LABEL_FETCH_FAILED: 'warning',
  CONFIG_WARNING: 'warning',
};

/**
 * 指定されたコードとメッセージでScatterPlotErrorオブジェクトを作成する
 *
 * @param code エラーコード
 * @param message 人間が読めるエラーメッセージ
 * @param options 追加オプション
 * @returns ScatterPlotErrorオブジェクト
 *
 * @example
 * ```typescript
 * const error = createError(
 *   'WEBGPU_NOT_SUPPORTED',
 *   'WebGPU is not supported in this browser',
 *   { context: { userAgent: navigator.userAgent } }
 * );
 * ```
 */
export function createError(
  code: ErrorCode,
  message: string,
  options?: {
    cause?: Error;
    context?: Record<string, unknown>;
  }
): ScatterPlotError {
  return {
    code,
    category: categoryMap[code],
    severity: severityMap[code],
    message,
    cause: options?.cause,
    context: options?.context,
    timestamp: Date.now(),
  };
}
