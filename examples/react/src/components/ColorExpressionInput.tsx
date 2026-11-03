import { useState, useEffect } from 'react';
import { useScatterPlot } from '../context/ScatterPlotContext';
import type { PointColorMode } from '../utils/clusterColors';

export function ColorExpressionInput() {
  const { state, updateColorMode, updatePointColor } = useScatterPlot();
  const [color, setColor] = useState(state.pointColor);
  const [error, setError] = useState<string | null>(null);
  const [isUpdating, setIsUpdating] = useState(false);
  const disabled = !state.isInitialized || state.isLoading || isUpdating;

  useEffect(() => {
    // クラスタ色を選択している間は、色ピッカーの初期値で上書きしない。
    if (
      !state.isInitialized ||
      state.isLoading ||
      isUpdating ||
      state.colorMode !== 'single' ||
      color === state.pointColor
    )
      return;
    const timer = setTimeout(async () => {
      setIsUpdating(true);
      try {
        setError(null);
        await updatePointColor(color);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Invalid color');
        setColor(state.pointColor);
      } finally {
        setIsUpdating(false);
      }
    }, 100);
    return () => clearTimeout(timer);
  }, [
    color,
    updatePointColor,
    state.isInitialized,
    state.isLoading,
    state.colorMode,
    state.pointColor,
    isUpdating,
  ]);

  const handleModeChange = async (mode: PointColorMode) => {
    setIsUpdating(true);
    setError(null);
    try {
      if (mode === 'single') {
        await updatePointColor(color);
      } else {
        await updateColorMode(mode);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update point colors');
      setColor(state.pointColor);
    } finally {
      setIsUpdating(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <label className="text-sm font-medium text-zinc-700">Point Color</label>
      <select
        aria-label="Point color mode"
        value={state.colorMode}
        disabled={disabled}
        onChange={(e) => handleModeChange(e.target.value as PointColorMode)}
        className="w-full px-3 py-2 bg-white border border-zinc-300 rounded text-zinc-800 text-sm disabled:opacity-50"
      >
        <option value="cluster" disabled={!state.hasClusterColors}>
          Cluster Colors
        </option>
        <option value="single">Single Color</option>
      </select>
      {state.colorMode === 'single' && (
        <input
          type="color"
          aria-label="Single point color"
          value={color}
          disabled={disabled}
          onChange={(e) => setColor(e.target.value)}
          className="w-full h-10 cursor-pointer rounded border border-zinc-300 disabled:opacity-50"
        />
      )}
      {state.isInitialized && !state.hasClusterColors && (
        <p className="text-zinc-500 text-xs">
          Cluster colors require cluster IDs and label colors.
        </p>
      )}
      {error && <p className="text-red-500 text-xs">{error}</p>}
    </div>
  );
}
