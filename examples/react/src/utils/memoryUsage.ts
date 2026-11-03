import type { ScatterPlot } from '@uoa-css-lab/duckscatter';

/**
 * DuckDB の管理対象メモリを取得する。WASM のヒープ全体や JS の Arrow 配列は含まない。
 * SUM の HUGEINT を Arrow で直接扱わずに済むよう、合計だけを BIGINT に揃える。
 */
export async function readDuckdbMemory(runQuery: ScatterPlot['runQuery']): Promise<number> {
  const result = await runQuery(
    'SELECT CAST(COALESCE(SUM(memory_usage_bytes), 0) AS BIGINT) AS memory_bytes FROM duckdb_memory()'
  );
  const rawBytes: unknown = result?.columnData.get('memory_bytes')?.get(0);
  const bytes =
    typeof rawBytes === 'bigint' || typeof rawBytes === 'number' ? Number(rawBytes) : NaN;
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    throw new Error('DuckDB memory statistics are unavailable');
  }
  return bytes;
}
