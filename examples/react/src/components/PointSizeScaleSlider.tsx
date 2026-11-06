import { useScatterPlot } from '../context/ScatterPlotContext';
import { Slider } from './Slider';

export function PointSizeScaleSlider() {
  const { state, updatePointSizeScale } = useScatterPlot();

  return (
    <Slider
      label="Size Scale"
      min={0.1}
      max={10}
      step={0.05}
      defaultValue={1.0}
      disabled={!state.isInitialized || state.isLoading}
      onChange={updatePointSizeScale}
      formatValue={(v) => `${v.toFixed(2)}x`}
      minLabel="0.1x"
      maxLabel="10x"
    />
  );
}
