import { useScatterPlot } from '../context/ScatterPlotContext';

/** 描画点数とは独立した、HTML の詳細表示の上限を変更する。 */
export function PointCardLimitInput() {
  const { state, updatePointCardLimit } = useScatterPlot();
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor="point-card-limit" className="text-sm font-medium text-zinc-700">
        点カードの上限
      </label>
      <input
        id="point-card-limit"
        type="number"
        min={0}
        step={1}
        value={state.pointCardLimit}
        aria-describedby="point-card-limit-description"
        className="w-full rounded border border-zinc-300 bg-white px-2 py-1 text-sm text-zinc-800"
        onChange={(event) => updatePointCardLimit(Number(event.target.value))}
      />
      <p id="point-card-limit-description" className="text-xs text-zinc-500">
        画面内の一致点が上限以下なら見出し・日付を表示。0 で無効。
      </p>
    </div>
  );
}
