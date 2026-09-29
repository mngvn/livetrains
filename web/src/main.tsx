import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import 'maplibre-gl/dist/maplibre-gl.css';
import './styles.css';
import { App } from './App.tsx';
import { registerServiceWorker } from './lib/offline.ts';

const container = document.getElementById('root');
if (!container) throw new Error('Missing #root element');

registerServiceWorker();

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
