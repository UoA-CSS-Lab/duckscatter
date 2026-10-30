import { useState } from 'react';
import { useScatterPlot } from '../context/ScatterPlotContext';

export function FilteredPointModeSelector() {
  const { updateFilteredPointDisplayMode } = useScatterPlot();
  const [mode, setMode] = useState<'hidden' | 'grayed'>('hidden');

  const handleChange = (newMode: 'hidden' | 'grayed') => {
    setMode(newMode);
    updateFilteredPointDisplayMode(newMode);
  };

  return (
    <div>
      <label className="block text-sm font-medium text-zinc-700 mb-1">
        フィルター除外ポイント
      </label>
      <div className="flex gap-1">
        <button
          className={`flex-1 px-3 py-1.5 text-xs rounded-l border ${
            mode === 'hidden'
              ? 'bg-zinc-700 text-white border-zinc-700'
              : 'bg-white text-zinc-600 border-zinc-300 hover:bg-zinc-50'
          }`}
          onClick={() => handleChange('hidden')}
        >
          非表示
        </button>
        <button
          className={`flex-1 px-3 py-1.5 text-xs rounded-r border ${
            mode === 'grayed'
              ? 'bg-zinc-700 text-white border-zinc-700'
              : 'bg-white text-zinc-600 border-zinc-300 hover:bg-zinc-50'
          }`}
          onClick={() => handleChange('grayed')}
        >
          灰色表示
        </button>
      </div>
    </div>
  );
}
