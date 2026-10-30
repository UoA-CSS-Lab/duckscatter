import { useState } from 'react';
import { useScatterPlot } from '../context/ScatterPlotContext';
import { PointList } from './PointList';
import { LabelList } from './LabelList';

type Tab = 'points' | 'labels';

export function HoverControlPanel() {
  const { state, clearAllHover } = useScatterPlot();
  const [activeTab, setActiveTab] = useState<Tab>('points');

  return (
    <div className="flex flex-col gap-3">
      <label className="text-sm font-medium text-zinc-700">Hover Control</label>

      {/* Tabs */}
      <div className="flex border-b border-zinc-200">
        <button
          onClick={() => setActiveTab('points')}
          className={`px-3 py-1.5 text-sm font-medium border-b-2 -mb-px transition-colors ${
            activeTab === 'points'
              ? 'border-blue-500 text-blue-600'
              : 'border-transparent text-zinc-500 hover:text-zinc-700'
          }`}
        >
          Points
        </button>
        <button
          onClick={() => setActiveTab('labels')}
          className={`px-3 py-1.5 text-sm font-medium border-b-2 -mb-px transition-colors ${
            activeTab === 'labels'
              ? 'border-blue-500 text-blue-600'
              : 'border-transparent text-zinc-500 hover:text-zinc-700'
          }`}
        >
          Labels
        </button>
      </div>

      {/* Tab content */}
      <div className="min-h-[200px]">
        {activeTab === 'points' && <PointList />}
        {activeTab === 'labels' && <LabelList />}
      </div>

      {/* Clear button */}
      <button
        onClick={() => clearAllHover()}
        className="px-3 py-1.5 bg-zinc-200 text-zinc-700 text-sm rounded hover:bg-zinc-300"
      >
        Clear All Hover
      </button>

      {/* Current hover state */}
      <div className="text-xs text-zinc-500 border-t border-zinc-200 pt-2">
        <div>
          <span className="font-medium">Point:</span>{' '}
          {state.hoveredPoint ? 'Hovered' : 'None'}
        </div>
        <div>
          <span className="font-medium">Label:</span>{' '}
          {state.hoveredLabel ? state.hoveredLabel.text : 'None'}
        </div>
      </div>
    </div>
  );
}
