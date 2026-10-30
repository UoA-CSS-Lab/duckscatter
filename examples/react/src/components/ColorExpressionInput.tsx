import { useState, useEffect } from 'react';
import { useScatterPlot } from '../context/ScatterPlotContext';

export function ColorExpressionInput() {
  const [color, setColor] = useState('#3b82f6');
  const [error, setError] = useState<string | null>(null);
  const { updateColor } = useScatterPlot();

  useEffect(() => {
    const timer = setTimeout(async () => {
      try {
        setError(null);
        const r = parseInt(color.slice(1, 3), 16);
        const g = parseInt(color.slice(3, 5), 16);
        const b = parseInt(color.slice(5, 7), 16);
        const a = 255;
        const calc = `(CAST(${a} AS BIGINT) * 16777216 + ${r} * 65536 + ${g} * 256 + ${b})`;
        const colorSql = `(${calc} - CASE WHEN ${calc} > 2147483647 THEN 4294967296 ELSE 0 END)::INTEGER`;
        await updateColor(colorSql);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Invalid color');
      }
    }, 100);
    return () => clearTimeout(timer);
  }, [color, updateColor]);

  return (
    <div className="flex flex-col gap-2">
      <label className="text-sm font-medium text-zinc-700">Point Color</label>
      <input
        type="color"
        value={color}
        onChange={(e) => setColor(e.target.value)}
        className="w-full h-10 cursor-pointer rounded border border-zinc-300"
      />
      {error && <p className="text-red-500 text-xs">{error}</p>}
    </div>
  );
}
