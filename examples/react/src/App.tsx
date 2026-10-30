import { ScatterPlotCanvas } from './components/ScatterPlotCanvas';
import { ControlPanel } from './components/ControlPanel';
import { PerfOverlay } from './components/PerfOverlay';

export default function App() {
  return (
    <div className="h-screen w-screen flex overflow-hidden">
      <ControlPanel />
      <main className="flex-1 relative">
        <ScatterPlotCanvas />
        <PerfOverlay />
      </main>
    </div>
  );
}
