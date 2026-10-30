import { useScatterPlot } from '../context/ScatterPlotContext';
import { Slider } from './Slider';

export function PointAlphaSlider() {
  const { updatePointAlpha } = useScatterPlot();

  return (
    <Slider
      label="Point Alpha"
      min={0}
      max={1}
      step={0.01}
      defaultValue={1.0}
      onChange={updatePointAlpha}
      minLabel="0"
      maxLabel="1"
    />
  );
}
