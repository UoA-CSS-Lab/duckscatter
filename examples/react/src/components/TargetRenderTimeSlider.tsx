import {
  useScatterPlot,
  DEFAULT_EXAMPLE_TARGET_RENDER_TIME_MS,
} from '../context/ScatterPlotContext';
import { Slider } from './Slider';

export function TargetRenderTimeSlider() {
  const { state, updateTargetRenderTime } = useScatterPlot();

  return (
    <Slider
      label="目標描画時間"
      min={1}
      max={100}
      step={1}
      defaultValue={DEFAULT_EXAMPLE_TARGET_RENDER_TIME_MS}
      disabled={state.isLoading}
      onChange={updateTargetRenderTime}
      formatValue={(v) => `${v} ms`}
      minLabel="1 ms"
      maxLabel="100 ms"
    />
  );
}
