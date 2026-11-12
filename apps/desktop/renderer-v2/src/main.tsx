import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { api } from './bridge';

/** One failing surface must never blank the whole window: show what failed and offer a reload. */
class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error, info: React.ErrorInfo) { console.error('Pandesh UI v2 render error:', error, info.componentStack); }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div role="alert" style={{ maxWidth: 560, margin: '80px auto', padding: 24, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <h1 style={{ margin: 0, fontSize: 20 }}>This screen hit an error</h1>
        <p style={{ margin: 0, color: 'var(--muted)' }}>Pandesh Core and your work are not affected. Try the screen again, or reload the window.</p>
        <pre style={{ margin: 0, padding: 12, borderRadius: 8, background: 'var(--surface)', border: '1px solid var(--line)', whiteSpace: 'pre-wrap', fontSize: 12.5 }}>{String(this.state.error.message)}</pre>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" className="btn primary" onClick={() => location.reload()}>Reload</button>
          <button type="button" className="btn" onClick={() => this.setState({ error: null })}>Try again</button>
        </div>
      </div>
    );
  }
}

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');
if (!api) {
  root.textContent = 'Pandesh could not reach its desktop host. Restart the app.';
} else {
  try {
    const saved = localStorage.getItem('pandesh.v2.theme');
    if (saved === 'light' || saved === 'dark') document.documentElement.dataset.theme = saved;
  } catch { /* storage unavailable: follow the OS */ }
  createRoot(root).render(<ErrorBoundary><App /></ErrorBoundary>);
}
