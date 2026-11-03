import { useScatterPlot } from '../context/ScatterPlotContext';
import { Slider } from './Slider';

export function TargetRenderTimeSlider() {
  const { state, updateTargetRenderTime } = useScatterPlot();

  return (
    <Slider
      label="目標描画時間"
      min={1}
      max={50}
      step={1}
      defaultValue={8}
      disabled={state.isLoading}
      onChange={updateTargetRenderTime}
      formatValue={(v) => `${v} ms`}
      minLabel="1 ms"
      maxLabel="50 ms"
    />
  );
}
