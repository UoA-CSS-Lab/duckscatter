import { PointAlphaSlider } from './PointAlphaSlider';
import { PointSizeScaleSlider } from './PointSizeScaleSlider';
import { LabelFontSizeSlider } from './LabelFontSizeSlider';
import { ColorExpressionInput } from './ColorExpressionInput';
import { SearchBox } from './SearchBox';
import { FilteredPointModeSelector } from './FilteredPointModeSelector';
import { LabelFilterInput } from './LabelFilterInput';
import { TargetRenderTimeSlider } from './TargetRenderTimeSlider';
import { StatsDisplay } from './StatsDisplay';
import { HoverControlPanel } from './HoverControlPanel';
import { TimeFilterSlider } from './TimeFilterSlider';
import { PointCardLimitInput } from './PointCardLimitInput';

export function ControlPanel() {
  return (
    <div className="w-80 bg-zinc-100 border-r border-zinc-300 p-4 flex flex-col gap-4 overflow-y-auto">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-zinc-800">Controls</h2>
        <StatsDisplay />
      </div>
      <TargetRenderTimeSlider />
      <PointAlphaSlider />
      <PointSizeScaleSlider />
      <LabelFontSizeSlider />
      <PointCardLimitInput />
      <TimeFilterSlider />
      <ColorExpressionInput />
      <SearchBox />
      <FilteredPointModeSelector />
      <LabelFilterInput />
      <HoverControlPanel />
    </div>
  );
}
