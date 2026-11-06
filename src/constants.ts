/**
 * Internal/public constants that define duckscatter's current fast GPU path.
 */

/** Number of numeric columns packed into the GPU filter vec4 buffer. */
export const MAX_GPU_FILTER_COLUMNS = 4;

/** Number of f32 components stored per point in the GPU filter column buffer. */
export const GPU_FILTER_COLUMN_COMPONENTS = 4;

/** 60 fps の 1 フレーム分を基準にした、点の絞り込みと GPU 描画の目標処理時間。 */
export const DEFAULT_TARGET_RENDER_TIME_MS = 1000 / 60;
