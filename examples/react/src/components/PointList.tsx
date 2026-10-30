import { useState, useEffect, useCallback } from 'react';
import { useScatterPlot, type PointListItem } from '../context/ScatterPlotContext';

const PAGE_SIZE = 20;

export function PointList() {
  const { state, fetchPoints, setPointHover } = useScatterPlot();
  const [points, setPoints] = useState<PointListItem[]>([]);
  const [page, setPage] = useState(0);
  const [isLoading, setIsLoading] = useState(false);

  const totalPages = state.pointCount ? Math.ceil(state.pointCount / PAGE_SIZE) : 0;

  const loadPage = useCallback(
    async (pageNum: number) => {
      setIsLoading(true);
      const data = await fetchPoints(pageNum, PAGE_SIZE);
      setPoints(data);
      setIsLoading(false);
    },
    [fetchPoints]
  );

  useEffect(() => {
    if (state.isInitialized) {
      loadPage(page);
    }
  }, [state.isInitialized, page, loadPage]);

  const handlePrev = () => {
    if (page > 0) setPage(page - 1);
  };

  const handleNext = () => {
    if (page < totalPages - 1) setPage(page + 1);
  };

  const handlePointClick = async (id: number) => {
    await setPointHover(id);
  };

  // Check if a point is currently hovered
  const isHovered = (id: number) => {
    if (!state.hoveredPoint) return false;
    return state.hoveredPoint['rowid'] === id;
  };

  if (!state.isInitialized) {
    return <div className="text-xs text-zinc-400">Not initialized</div>;
  }

  return (
    <div className="flex flex-col gap-2">
      {/* List */}
      <div className="max-h-48 overflow-y-auto border border-zinc-200 rounded bg-white">
        {isLoading ? (
          <div className="p-2 text-xs text-zinc-400">Loading...</div>
        ) : points.length === 0 ? (
          <div className="p-2 text-xs text-zinc-400">No points</div>
        ) : (
          points.map((point) => (
            <div
              key={String(point.id)}
              onClick={() => handlePointClick(point.id)}
              className={`px-2 py-1 text-xs cursor-pointer border-b border-zinc-100 last:border-b-0 hover:bg-blue-50 ${
                isHovered(point.id) ? 'bg-blue-100 font-medium' : ''
              }`}
            >
              <span className="text-zinc-500">rowid:{point.id}</span>{' '}
              <span className="text-zinc-700">
                ({point.x.toFixed(2)}, {point.y.toFixed(2)})
              </span>
            </div>
          ))
        )}
      </div>

      {/* Pagination */}
      <div className="flex items-center justify-between text-xs">
        <button
          onClick={handlePrev}
          disabled={page === 0}
          className="px-2 py-1 bg-zinc-100 rounded hover:bg-zinc-200 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Prev
        </button>
        <span className="text-zinc-500">
          {page + 1} / {totalPages || 1}
        </span>
        <button
          onClick={handleNext}
          disabled={page >= totalPages - 1}
          className="px-2 py-1 bg-zinc-100 rounded hover:bg-zinc-200 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Next
        </button>
      </div>
    </div>
  );
}
