import { useRef, useState } from 'react';
import { useScatterPlot } from '../context/ScatterPlotContext';

export function FileUploadButton() {
  const { loadDataFile, state } = useScatterPlot();
  const parquetInputRef = useRef<HTMLInputElement>(null);
  const geojsonInputRef = useRef<HTMLInputElement>(null);
  const [parquetName, setParquetName] = useState<string | null>(null);
  const [geojsonName, setGeojsonName] = useState<string | null>(null);

  const handleParquetChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setParquetName(file.name);
    await loadDataFile(file);
    if (parquetInputRef.current) {
      parquetInputRef.current.value = '';
    }
  };

  const handleGeojsonChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setGeojsonName(file.name);
    const text = await file.text();
    const geojson = JSON.parse(text);
    if (state.isInitialized && plot) {
      plot.loadLabels(geojson as Record<string, unknown>);
    }
    if (geojsonInputRef.current) {
      geojsonInputRef.current.value = '';
    }
  };

  const { plot } = useScatterPlot();

  return (
    <div className="flex flex-col gap-2">
      <label className="text-sm font-medium text-zinc-700">File Upload</label>
      <div className="flex flex-col gap-1">
        <button
          onClick={() => parquetInputRef.current?.click()}
          disabled={state.isLoading}
          className="w-full px-3 py-2 bg-white border border-zinc-300 rounded text-sm hover:bg-zinc-50 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer text-left"
        >
          <span className="text-zinc-500">.parquet: </span>
          <span className="text-zinc-800">{state.isLoading ? 'Loading...' : parquetName ?? 'output.parquet'}</span>
        </button>
        <button
          onClick={() => geojsonInputRef.current?.click()}
          disabled={state.isLoading || !state.isInitialized}
          className="w-full px-3 py-2 bg-white border border-zinc-300 rounded text-sm hover:bg-zinc-50 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer text-left"
        >
          <span className="text-zinc-500">.geojson: </span>
          <span className="text-zinc-800">{geojsonName ?? 'label.geojson'}</span>
        </button>
      </div>
      <input
        ref={parquetInputRef}
        type="file"
        accept=".parquet"
        onChange={handleParquetChange}
        className="hidden"
      />
      <input
        ref={geojsonInputRef}
        type="file"
        accept=".geojson,.json"
        onChange={handleGeojsonChange}
        className="hidden"
      />
    </div>
  );
}
