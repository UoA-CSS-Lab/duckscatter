import { useScatterPlot } from '../context/ScatterPlotContext';

export function StatsDisplay() {
  const { state } = useScatterPlot();

  if (state.pointCount === null) return null;

  return (
    <span className="text-sm text-zinc-500">
      {state.pointCount.toLocaleString()} points
    </span>
  );
}
