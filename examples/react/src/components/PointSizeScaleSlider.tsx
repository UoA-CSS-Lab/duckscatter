import { useScatterPlot } from '../context/ScatterPlotContext';
import { Slider } from './Slider';

export function PointSizeScaleSlider() {
  const { updatePointSizeScale } = useScatterPlot();

  return (
    <Slider
      label="Size Scale"
      min={0.1}
      max={3}
      step={0.05}
      defaultValue={1.0}
      onChange={updatePointSizeScale}
      formatValue={(v) => `${v.toFixed(2)}x`}
      minLabel="0.1x"
      maxLabel="3x"
    />
  );
}
