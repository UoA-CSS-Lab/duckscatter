import { useScatterPlot } from '../context/ScatterPlotContext';
import { Slider } from './Slider';

export function PointLimitSlider() {
  const { updatePointLimit } = useScatterPlot();

  return (
    <Slider
      label="Visible Points"
      min={10000}
      max={5000000}
      step={1000}
      defaultValue={100000}
      onChange={updatePointLimit}
      parseValue={(v) => parseInt(v, 10)}
      formatValue={(v) => v.toLocaleString()}
      minLabel="1K"
      maxLabel="5M"
    />
  );
}
