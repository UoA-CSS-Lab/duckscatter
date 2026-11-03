import type { ParquetData } from './repository.js';

/** GPU と同じ f32 サイズの降順と、各サイズまでの累積件数。CPU 側だけで保持する。 */
export interface LodSizeDistribution {
  readonly sizes: Float32Array;
  readonly cumulativeCounts: Uint32Array;
}

/** 境界より大きい点は全て残し、同サイズの点だけ固定ハッシュで間引く。 */
export interface LodSizeCutoff {
  readonly size: number;
  readonly tieHashThreshold: number;
}

interface ValueColumn {
  readonly length: number;
  get(index: number): unknown;
}

const MAX_HASH = 0xffffffff;

/**
 * SQL でサイズごとに集計した降順の結果を、境界検索用の小さな表にする。
 * DOUBLE 等の値も GPU では f32 になるため、丸めた結果が同じ隣接グループは合算する。
 * NULL・非有限値などでサイズ順を安全に扱えない場合は、一様なハッシュ間引きへ戻す。
 */
export function createLodSizeDistribution(
  data: ParquetData,
  totalCount: number
): LodSizeDistribution | undefined {
  const sizeColumn = data.columnData.get('__size__') as ValueColumn | undefined;
  const countColumn = data.columnData.get('__count__') as ValueColumn | undefined;
  if (
    !Number.isInteger(totalCount) ||
    totalCount <= 0 ||
    totalCount > MAX_HASH ||
    !sizeColumn ||
    !countColumn ||
    sizeColumn.length !== data.rowCount ||
    countColumn.length !== data.rowCount
  ) {
    return undefined;
  }

  const sizes = new Float32Array(data.rowCount);
  const cumulativeCounts = new Uint32Array(data.rowCount);
  let bucketCount = 0;
  let cumulativeCount = 0;
  let previousSize = Infinity;
  for (let index = 0; index < data.rowCount; index++) {
    const rawSize = sizeColumn.get(index);
    const count = Number(countColumn.get(index));
    if (typeof rawSize !== 'number' || !Number.isSafeInteger(count) || count <= 0) {
      return undefined;
    }
    const size = Math.fround(rawSize);
    cumulativeCount += count;
    if (!Number.isFinite(size) || size > previousSize || cumulativeCount > totalCount) {
      return undefined;
    }

    if (bucketCount > 0 && sizes[bucketCount - 1] === size) {
      cumulativeCounts[bucketCount - 1] = cumulativeCount;
    } else {
      sizes[bucketCount] = size;
      cumulativeCounts[bucketCount++] = cumulativeCount;
    }
    previousSize = size;
  }
  if (cumulativeCount !== totalCount) return undefined;

  return {
    sizes: bucketCount === sizes.length ? sizes : sizes.slice(0, bucketCount),
    cumulativeCounts:
      bucketCount === cumulativeCounts.length
        ? cumulativeCounts
        : cumulativeCounts.slice(0, bucketCount),
  };
}

/**
 * 指定した保持率に対応するサイズを累積件数から二分探索する。ズームやパンで SQL は実行しない。
 * 均一サイズ・全点表示・ズームインでは既存のハッシュ経路をそのまま使う。
 * 同サイズの点は期待件数を予算に合わせるため、厳密な件数上限ではない。
 */
export function getLodSizeCutoff(
  distribution: LodSizeDistribution | undefined,
  totalCount: number,
  hashThreshold: number,
  zoom: number
): LodSizeCutoff | undefined {
  if (
    !distribution ||
    distribution.sizes.length <= 1 ||
    distribution.sizes.length !== distribution.cumulativeCounts.length ||
    distribution.cumulativeCounts[distribution.cumulativeCounts.length - 1] !== totalCount ||
    zoom > 1 ||
    hashThreshold <= 0 ||
    hashThreshold >= MAX_HASH
  ) {
    return undefined;
  }

  const targetCount = totalCount * (hashThreshold / MAX_HASH);
  let low = 0;
  let high = distribution.sizes.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (distribution.cumulativeCounts[middle] < targetCount) low = middle + 1;
    else high = middle;
  }

  const largerCount = low === 0 ? 0 : distribution.cumulativeCounts[low - 1];
  const equalCount = distribution.cumulativeCounts[low] - largerCount;
  const keepFraction = Math.max(0, Math.min(1, (targetCount - largerCount) / equalCount));
  return {
    size: distribution.sizes[low],
    tieHashThreshold: Math.floor(keepFraction * MAX_HASH),
  };
}
