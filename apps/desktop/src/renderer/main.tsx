import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@ow/ui-kit/tokens.css';
import '@ow/ui-kit/base.css';
import '@ow/ui-kit/components.css';
import './app.css';
import './editor.css';
import { App } from './App.js';
import './table.css';

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

