import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { api } from './bridge';

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');
if (!api) {
  root.textContent = 'Pandesh could not reach its desktop host. Restart the app.';
} else {
  try {
    const saved = localStorage.getItem('pandesh.v2.theme');
    if (saved === 'light' || saved === 'dark') document.documentElement.dataset.theme = saved;
  } catch { /* storage unavailable: follow the OS */ }
  createRoot(root).render(<App />);
}
