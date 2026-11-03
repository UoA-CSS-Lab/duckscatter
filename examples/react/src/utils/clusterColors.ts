export type PointColorMode = 'cluster' | 'single';

export interface ClusterColor {
  clusterId: number;
  rgb: [number, number, number];
}

export const DEFAULT_POINT_COLOR = '#3b82f6';

/** 不透明な RGB を、既存の描画経路が受け取る符号付き ARGB 整数にする SQL 式。 */
function rgbColorSql(r: string, g: string, b: string): string {
  return `((${r}) * 65536 + (${g}) * 256 + (${b}) - 16777216)::INTEGER`;
}

export const NOISE_COLOR_SQL = rgbColorSql('128', '128', '128');

/** 色ピッカーの値を検証してから SQL に数値だけを埋め込む。 */
export function buildSingleColorSql(color: string): string {
  if (!/^#[0-9a-f]{6}$/i.test(color)) {
    throw new Error('Point color must be a six-digit hexadecimal color.');
  }
  return rgbColorSql(
    String(parseInt(color.slice(1, 3), 16)),
    String(parseInt(color.slice(3, 5), 16)),
    String(parseInt(color.slice(5, 7), 16))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** GeoJSON の Feature と読み込み済み Label の、共通の properties から色を取得する。 */
export function readClusterColors(labels: readonly unknown[]): ClusterColor[] {
  const colors = new Map<number, ClusterColor>();
  for (const label of labels) {
    if (!isRecord(label) || !isRecord(label.properties)) continue;
    const properties = label.properties;
    const clusterId = properties.cluster_id ?? properties.cluster;
    const rgb = properties.color;
    if (clusterId == null || rgb == null) continue;
    if (typeof clusterId !== 'number' || !Number.isSafeInteger(clusterId)) {
      throw new Error('Cluster IDs must be safe integers.');
    }
    // ノイズにはラベル側の色があっても、中立のグレーを使う。
    if (clusterId < 0) continue;
    if (
      !Array.isArray(rgb) ||
      rgb.length !== 3 ||
      !rgb.every(
        (value) =>
          typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 255
      )
    ) {
      throw new Error(`Cluster ${clusterId} must have three RGB values between 0 and 255.`);
    }
    const previous = colors.get(clusterId);
    if (previous && previous.rgb.some((value, index) => value !== rgb[index])) {
      throw new Error(`Cluster ${clusterId} has conflicting colors.`);
    }
    colors.set(clusterId, { clusterId, rgb: [rgb[0], rgb[1], rgb[2]] });
  }
  // 主キーになる ID の重複をまとめ、ラベルの並びに依存しない色表にする。
  return [...colors.values()].sort((a, b) => a.clusterId - b.clusterId);
}

/** 描画時は保存済みの色を読む。点の行集合・座標・rowid は変更しない。 */
export const CLUSTER_COLOR_SQL = `COALESCE((
  SELECT cluster_color.color
  FROM cluster_color
  WHERE cluster_color.cluster_id = parquet_data.cluster_id
), ${NOISE_COLOR_SQL})`;

type ExecuteSql = (sql: string) => Promise<unknown>;

/**
 * RGB の変換はラベルの読み込み時に行い、クラスタごとの ARGB 整数を DB に保存する。
 * 空の色表にも対応し、更新失敗時は以前のテーブルをトランザクションで保つ。
 */
export async function replaceClusterColorTable(
  executeSql: ExecuteSql,
  colors: readonly ClusterColor[]
): Promise<void> {
  await executeSql('BEGIN TRANSACTION');
  try {
    await executeSql(`CREATE OR REPLACE TEMP TABLE cluster_color (
      cluster_id BIGINT PRIMARY KEY,
      color INTEGER NOT NULL
    )`);
    if (colors.length > 0) {
      const values = colors
        .map(({ clusterId, rgb }) => `(${clusterId}, ${rgb.join(', ')})`)
        .join(', ');
      await executeSql(`INSERT INTO cluster_color
        SELECT palette.cluster_id, ${rgbColorSql('palette.r', 'palette.g', 'palette.b')}
        FROM (VALUES ${values}) AS palette(cluster_id, r, g, b)`);
    }
    await executeSql('COMMIT');
  } catch (error) {
    await executeSql('ROLLBACK');
    throw error;
  }
}
