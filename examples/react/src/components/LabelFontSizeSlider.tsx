import { DEFAULT_LABEL_FONT_SIZE, useScatterPlot } from '../context/ScatterPlotContext';
import { Slider } from './Slider';

/** ラベルの文字サイズを既存のコントロールと同じ操作で変更する。 */
export function LabelFontSizeSlider() {
  const { state, updateLabelFontSize } = useScatterPlot();

  return (
    <Slider
      label="Label Size"
      min={8}
      max={32}
      step={1}
      defaultValue={DEFAULT_LABEL_FONT_SIZE}
      disabled={!state.isInitialized || state.isLoading}
      onChange={updateLabelFontSize}
      formatValue={(value) => `${value} px`}
      minLabel="8 px"
      maxLabel="32 px"
    />
  );
}
