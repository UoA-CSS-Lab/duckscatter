import { useState, useMemo } from 'react';
import type { Label } from '@uoa-css-lab/duckscatter';
import { useScatterPlot } from '../context/ScatterPlotContext';

const PAGE_SIZE = 20;

export function LabelList() {
  const { state, getLabels, setLabelHover } = useScatterPlot();
  const [page, setPage] = useState(0);

  // Load and sort labels by count (descending)
  const labels = useMemo(() => {
    if (!state.isInitialized) return [];
    const allLabels = getLabels();
    return [...allLabels].sort((a, b) => (b.count ?? 0) - (a.count ?? 0));
  }, [state.isInitialized, getLabels]);

  // Paginate labels
  const pagedLabels = useMemo(() => {
    const start = page * PAGE_SIZE;
    return labels.slice(start, start + PAGE_SIZE);
  }, [labels, page]);

  const totalPages = Math.ceil(labels.length / PAGE_SIZE);

  const handlePrev = () => {
    if (page > 0) setPage(page - 1);
  };

  const handleNext = () => {
    if (page < totalPages - 1) setPage(page + 1);
  };

  const handleLabelClick = (label: Label) => {
    setLabelHover({ text: label.text });
  };

  // Check if a label is currently hovered
  const isHovered = (label: Label) => {
    return state.hoveredLabel?.text === label.text;
  };

  if (!state.isInitialized) {
    return <div className="text-xs text-zinc-400">Not initialized</div>;
  }

  if (labels.length === 0) {
    return <div className="text-xs text-zinc-400">No labels</div>;
  }

  return (
    <div className="flex flex-col gap-2">
      {/* List */}
      <div className="max-h-48 overflow-y-auto border border-zinc-200 rounded bg-white">
        {pagedLabels.map((label, idx) => (
          <div
            key={`${label.text}-${idx}`}
            onClick={() => handleLabelClick(label)}
            className={`px-2 py-1 text-xs cursor-pointer border-b border-zinc-100 last:border-b-0 hover:bg-blue-50 ${
              isHovered(label) ? 'bg-blue-100 font-medium' : ''
            }`}
          >
            <div className="flex justify-between items-center">
              <span className="text-zinc-700 truncate flex-1">{label.text}</span>
              {label.count !== undefined && (
                <span className="text-zinc-400 ml-2">({label.count})</span>
              )}
            </div>
            {label.cluster !== undefined && (
              <span className="text-zinc-400 text-[10px]">cluster: {label.cluster}</span>
            )}
          </div>
        ))}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between text-xs">
          <button
            onClick={handlePrev}
            disabled={page === 0}
            className="px-2 py-1 bg-zinc-100 rounded hover:bg-zinc-200 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Prev
          </button>
          <span className="text-zinc-500">
            {page + 1} / {totalPages}
          </span>
          <button
            onClick={handleNext}
            disabled={page >= totalPages - 1}
            className="px-2 py-1 bg-zinc-100 rounded hover:bg-zinc-200 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Next
          </button>
        </div>
      )}

      <div className="text-[10px] text-zinc-400">
        Total: {labels.length} labels
      </div>
    </div>
  );
}
