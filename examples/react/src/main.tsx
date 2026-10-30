import { createRoot } from 'react-dom/client';
import App from './App';
import { ScatterPlotProvider } from './context/ScatterPlotContext';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <ScatterPlotProvider>
    <App />
  </ScatterPlotProvider>
);
