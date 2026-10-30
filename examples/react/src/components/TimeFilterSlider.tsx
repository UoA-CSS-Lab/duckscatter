import { useState, useCallback } from 'react';
import { useScatterPlot } from '../context/ScatterPlotContext';

export function TimeFilterSlider() {
  const { state, updateTimeFilter } = useScatterPlot();
  const { timeRange } = state;

  const [minValue, setMinValue] = useState<number>(0);
  const [maxValue, setMaxValue] = useState<number>(0);
  const [prevTimeRange, setPrevTimeRange] = useState(timeRange);

  // timeRangeが変更されたら値を更新（レンダー中のステート更新パターン）
  if (timeRange !== prevTimeRange) {
    setPrevTimeRange(timeRange);
    if (timeRange) {
      setMinValue(timeRange.min);
      setMaxValue(timeRange.max);
    }
  }

  const handleMinChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const newMin = parseFloat(e.target.value);
      // maxValueを超えないように制限
      const clampedMin = Math.min(newMin, maxValue);
      setMinValue(clampedMin);
      updateTimeFilter(clampedMin, maxValue);
    },
    [maxValue, updateTimeFilter]
  );

  const handleMaxChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const newMax = parseFloat(e.target.value);
      // minValueを下回らないように制限
      const clampedMax = Math.max(newMax, minValue);
      setMaxValue(clampedMax);
      updateTimeFilter(minValue, clampedMax);
    },
    [minValue, updateTimeFilter]
  );

  const handleReset = useCallback(() => {
    if (timeRange) {
      setMinValue(timeRange.min);
      setMaxValue(timeRange.max);
      updateTimeFilter(null, null);
    }
  }, [timeRange, updateTimeFilter]);

  // 日時フォーマット関数（UNIXタイムスタンプ秒 → 日付文字列）
  const formatTime = (timestamp: number) => {
    // タイムスタンプが大きい場合はミリ秒として扱う
    const ts = timestamp > 1e12 ? timestamp : timestamp * 1000;
    return new Date(ts).toLocaleDateString('ja-JP', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  };

  // 範囲が未取得の場合は非表示
  if (!timeRange) {
    return null;
  }

  // 選択範囲の割合を計算（トラックのハイライト用）
  const range = timeRange.max - timeRange.min;
  const minPercent = range > 0 ? ((minValue - timeRange.min) / range) * 100 : 0;
  const maxPercent = range > 0 ? ((maxValue - timeRange.min) / range) * 100 : 100;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex justify-between items-center">
        <label className="text-sm font-medium text-zinc-700">Time Filter</label>
        <button
          onClick={handleReset}
          className="text-xs text-zinc-500 hover:text-zinc-800 underline"
        >
          Reset
        </button>
      </div>

      <div className="relative h-6">
        {/* トラック背景 */}
        <div className="absolute top-1/2 -translate-y-1/2 w-full h-2 bg-zinc-200 rounded-lg" />

        {/* 選択範囲ハイライト */}
        <div
          className="absolute top-1/2 -translate-y-1/2 h-2 bg-blue-500 rounded-lg"
          style={{
            left: `${minPercent}%`,
            width: `${maxPercent - minPercent}%`,
          }}
        />

        {/* 最小値スライダー */}
        <input
          type="range"
          min={timeRange.min}
          max={timeRange.max}
          step={(timeRange.max - timeRange.min) / 1000}
          value={minValue}
          onChange={handleMinChange}
          className="absolute w-full h-2 top-1/2 -translate-y-1/2 appearance-none bg-transparent pointer-events-none
            [&::-webkit-slider-thumb]:pointer-events-auto
            [&::-webkit-slider-thumb]:w-4
            [&::-webkit-slider-thumb]:h-4
            [&::-webkit-slider-thumb]:appearance-none
            [&::-webkit-slider-thumb]:bg-blue-500
            [&::-webkit-slider-thumb]:rounded-full
            [&::-webkit-slider-thumb]:cursor-pointer
            [&::-webkit-slider-thumb]:shadow-md
            [&::-webkit-slider-thumb]:border-2
            [&::-webkit-slider-thumb]:border-white
            [&::-moz-range-thumb]:pointer-events-auto
            [&::-moz-range-thumb]:w-4
            [&::-moz-range-thumb]:h-4
            [&::-moz-range-thumb]:appearance-none
            [&::-moz-range-thumb]:bg-blue-500
            [&::-moz-range-thumb]:rounded-full
            [&::-moz-range-thumb]:cursor-pointer
            [&::-moz-range-thumb]:shadow-md
            [&::-moz-range-thumb]:border-2
            [&::-moz-range-thumb]:border-white"
        />

        {/* 最大値スライダー */}
        <input
          type="range"
          min={timeRange.min}
          max={timeRange.max}
          step={(timeRange.max - timeRange.min) / 1000}
          value={maxValue}
          onChange={handleMaxChange}
          className="absolute w-full h-2 top-1/2 -translate-y-1/2 appearance-none bg-transparent pointer-events-none
            [&::-webkit-slider-thumb]:pointer-events-auto
            [&::-webkit-slider-thumb]:w-4
            [&::-webkit-slider-thumb]:h-4
            [&::-webkit-slider-thumb]:appearance-none
            [&::-webkit-slider-thumb]:bg-blue-500
            [&::-webkit-slider-thumb]:rounded-full
            [&::-webkit-slider-thumb]:cursor-pointer
            [&::-webkit-slider-thumb]:shadow-md
            [&::-webkit-slider-thumb]:border-2
            [&::-webkit-slider-thumb]:border-white
            [&::-moz-range-thumb]:pointer-events-auto
            [&::-moz-range-thumb]:w-4
            [&::-moz-range-thumb]:h-4
            [&::-moz-range-thumb]:appearance-none
            [&::-moz-range-thumb]:bg-blue-500
            [&::-moz-range-thumb]:rounded-full
            [&::-moz-range-thumb]:cursor-pointer
            [&::-moz-range-thumb]:shadow-md
            [&::-moz-range-thumb]:border-2
            [&::-moz-range-thumb]:border-white"
        />
      </div>

      {/* 日時表示 */}
      <div className="flex justify-between text-xs text-zinc-500">
        <span>{formatTime(minValue)}</span>
        <span>{formatTime(maxValue)}</span>
      </div>
    </div>
  );
}
