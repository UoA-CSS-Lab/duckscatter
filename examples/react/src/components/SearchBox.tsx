import { useState, useRef, useEffect } from 'react';
import { useScatterPlot } from '../context/ScatterPlotContext';

export function SearchBox() {
  const [value, setValue] = useState('');
  const { updateSearch } = useScatterPlot();
  const debounceRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }
    debounceRef.current = setTimeout(() => {
      updateSearch(value);
    }, 300);

    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, [value, updateSearch]);

  return (
    <div className="flex flex-col gap-2">
      <label className="text-sm font-medium text-zinc-700">Search Words</label>
      <input
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Filter by word..."
        className="px-3 py-2 bg-white border border-zinc-300 rounded text-zinc-800 text-sm"
      />
      {value && (
        <button
          onClick={() => setValue('')}
          className="text-xs text-zinc-500 hover:text-zinc-800 self-start"
        >
          Clear filter
        </button>
      )}
    </div>
  );
}
