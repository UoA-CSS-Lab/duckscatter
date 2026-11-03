import { useEffect, useRef, useState } from 'react';
import { useScatterPlot } from '../context/ScatterPlotContext';
import type { FrameStats, ScatterPlot } from '@uoa-css-lab/duckscatter';
import { readDuckdbMemory } from '../utils/memoryUsage';

/** 1 行（ラベル + 値）。render 中に再生成しないようコンポーネント外で定義する（react-hooks/static-components）。 */
function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-4">
      <span className="text-gray-400">{k}</span>
      <span className="font-mono tabular-nums text-gray-100">{v}</span>
    </div>
  );
}

/**
 * フレーム計測とメモリの表示。GPU の確保量はフレーム統計と一緒に 250ms ごとに取得する。
 * DuckDB は別の低頻度ポーリングにし、描画のたびに診断用 SQL が走らないようにする。
 */
export function PerfOverlay() {
  const { plot, state } = useScatterPlot();
  const [frameReading, setFrameReading] = useState<{
    plot: ScatterPlot;
    stats: FrameStats;
  } | null>(null);
  const [duckdbMemory, setDuckdbMemory] = useState<{
    plot: ScatterPlot;
    bytes: number | null;
  } | null>(null);
  const enabledRef = useRef(false);

  useEffect(() => {
    if (!plot || !state.isInitialized) return;
    // 旧 duckscatter（計測 API なし）では何もしない
    if (
      typeof (plot as { setInstrumentation?: unknown }).setInstrumentation !== 'function' ||
      typeof (plot as { getFrameStats?: unknown }).getFrameStats !== 'function'
    ) {
      return;
    }
    plot.setInstrumentation(true);
    enabledRef.current = true;
    const id = setInterval(() => setFrameReading({ plot, stats: plot.getFrameStats() }), 250);
    return () => {
      clearInterval(id);
      if (enabledRef.current) {
        plot.setInstrumentation(false);
        enabledRef.current = false;
      }
    };
  }, [plot, state.isInitialized]);

  useEffect(() => {
    if (!plot || !state.isInitialized) return;
    let cancelled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const runQuery = plot.runQuery.bind(plot);
    const updateMemory = async () => {
      try {
        const bytes = await readDuckdbMemory(runQuery);
        if (!cancelled) setDuckdbMemory({ plot, bytes });
      } catch {
        // 取得失敗を実測 0 として表示しない。描画自体は継続する。
        if (!cancelled) setDuckdbMemory({ plot, bytes: null });
      } finally {
        // 完了から 1 秒後に次を取得し、遅いクエリでも診断要求を重ねない。
        if (!cancelled) timeout = setTimeout(() => void updateMemory(), 1000);
      }
    };
    void updateMemory();
    return () => {
      cancelled = true;
      clearTimeout(timeout);
    };
  }, [plot, state.isInitialized]);

  const stats = frameReading?.plot === plot ? frameReading.stats : null;
  if (!stats || !plot || !state.isInitialized) return null;

  const pct =
    stats.totalPointCount > 0
      ? Math.round((stats.drawnCount / stats.totalPointCount) * 1000) / 10
      : 0;

  const deltaCompute = Math.max(0, stats.gpuComputeMs - stats.gpuIdleMs);
  // プロットを差し替えた直後は、前の DB の結果を新しいファイルの数値として表示しない。
  const currentMemory = duckdbMemory?.plot === plot ? duckdbMemory : null;
  const duckdbMemoryText = currentMemory
    ? currentMemory.bytes === null
      ? '取得失敗'
      : `${(currentMemory.bytes / (1024 * 1024)).toFixed(2)} MiB`
    : '未取得';
  const gpuMemoryText =
    typeof stats.gpuAllocatedBytes === 'number'
      ? `${(stats.gpuAllocatedBytes / (1024 * 1024)).toFixed(2)} MiB`
      : '未取得';

  return (
    <div className="pointer-events-none absolute bottom-3 left-3 z-50 select-none rounded-lg bg-black/80 px-3 py-2 text-xs text-gray-100 shadow-lg backdrop-blur-sm">
      <div className="mb-1 font-semibold text-emerald-400">perf</div>
      <Row k="fps*" v={String(stats.fps)} />
      <Row k="compute" v={stats.computeRan ? 'ran' : 'idle'} />
      <Row k="processed" v={stats.processedCount.toLocaleString()} />
      <Row
        k="drawn"
        v={
          stats.drawnCountStatus === 'ready'
            ? `${stats.drawnCount.toLocaleString()} (${pct}%)`
            : stats.drawnCountStatus === 'error'
              ? 'readback failed'
              : 'not measured'
        }
      />
      <Row k="total" v={stats.totalPointCount.toLocaleString()} />
      <Row k="budget" v={stats.pointBudget.toLocaleString()} />
      <Row k="DuckDB 管理メモリ" v={duckdbMemoryText} />
      <Row k="GPU 確保量" v={gpuMemoryText} />
      <Row k="cpu enc" v={`${stats.cpuEncodeMs.toFixed(2)} ms`} />
      <Row k="gpu cmp" v={`${stats.gpuComputeMs.toFixed(2)} ms`} />
      <Row k="gpu idle" v={`${stats.gpuIdleMs.toFixed(2)} ms`} />
      <Row k="Δ compute" v={`${deltaCompute.toFixed(2)} ms`} />
      <Row k="zoom" v={stats.zoom.toFixed(2)} />
      <div className="mt-1 text-[10px] text-gray-500">
        *fps = render 呼び出し/秒（表示 fps ではない）。processed/drawn は直近 compute
        フレーム（sticky）
      </div>
      <div className="mt-1 text-[10px] text-gray-500">
        メモリは管理対象分。WASM 全体・ブラウザや GPU ドライバ内部の領域は含みません。
      </div>
    </div>
  );
}
