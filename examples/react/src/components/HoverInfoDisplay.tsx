import { useMemo } from 'react';
import { useScatterPlot } from '../context/ScatterPlotContext';

interface HoverInfoDisplayProps {
  mousePosition: { x: number; y: number };
}

export function HoverInfoDisplay({ mousePosition }: HoverInfoDisplayProps) {
  const { state } = useScatterPlot();

  const formattedData = useMemo(() => {
    if (!state.hoveredPoint) return null;

    const obj: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(state.hoveredPoint)) {
      obj[key] = typeof val === 'bigint' ? Number(val) : val;
    }
    return JSON.stringify(obj, null, 2);
  }, [state.hoveredPoint]);

  if (!formattedData) return null;

  return (
    <div
      className="fixed z-50 pointer-events-none"
      style={{
        left: mousePosition.x + 15,
        top: mousePosition.y - 10,
      }}
    >
      <pre className="p-2 bg-white border border-zinc-300 rounded shadow-lg text-zinc-700 text-xs max-w-xs">
        {formattedData}
      </pre>
    </div>
  );
}
