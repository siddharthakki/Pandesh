// @vitest-environment jsdom
import { JSDOM } from 'jsdom';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { ExecutionProjection } from '../../ui/executionProjection';

/**
 * The task footer (#everyday-phase) is a terminal status surface. The authoritative execution projection decides how a
 * run ended; a blocked / needs-input / failed / cancelled run must never render the generic "Completed" footer.
 */

const SCRIPTS = [
  'chat.js', 'chat-fixes.js', 'chat-dashboard.js', 'chat-operations.js', 'chat-runtime-fixes.js', 'chat-autonomous.js',
  'chat-operator-context.js', 'chat-sidebar-ui.js', 'everyday-presentation.js', 'chat-everyday.js', 'chat-dhaaga.js',
];
const open: JSDOM[] = [];
afterEach(() => { for (const dom of open.splice(0)) dom.window.close(); });

function mount() {
  const raw = readFileSync(resolve(process.cwd(), 'media/chat.html'), 'utf8')
    .replace(/{{cspSource}}/g, "'self'").replace(/{{nonce}}/g, 'n').replace(/{{cssUri}}/g, 'chat.css').replace(/{{jsUri}}/g, 'chat.js')
    .replace(/{{pandaBaseUri}}/g, '').replace(/{{modelName}}/g, 'm');
  const head = raw.slice(0, raw.indexOf('<script nonce="n">'));
  const inline = SCRIPTS.map(file => `<script nonce="n">${readFileSync(resolve(process.cwd(), 'media', file), 'utf8')}</script>`).join('\n');
  const html = `${head}<script nonce="n">(() => { const api = window.acquireVsCodeApi(); Object.defineProperty(window, '__ollamaAgentVsCodeApi', { value: api }); Object.defineProperty(window, '__pandaBaseUri', { value: '' }); })();</script>${inline}</body></html>`;
  const dom = new JSDOM(html, {
    runScripts: 'dangerously', url: 'https://example-webview.invalid/',
    beforeParse(window) {
      (window as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({ postMessage: () => undefined, getState: () => ({}), setState: () => undefined });
      (window as unknown as { alert: () => void }).alert = () => undefined;
    },
  });
  open.push(dom);
  (dom.window as unknown as { __kdWorkspaceRestored?: boolean }).__kdWorkspaceRestored = true;
  const dispatch = (data: Record<string, unknown>) => dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data }));
  const footer = () => {
    const strip = dom.window.document.getElementById('everyday-phase')!;
    return { hidden: strip.hidden, label: dom.window.document.getElementById('everyday-phase-label')!.textContent ?? '', sentence: dom.window.document.getElementById('everyday-phase-sentence')!.textContent ?? '' };
  };
  return { dispatch, footer, document: dom.window.document, state: () => (dom.window as unknown as { __kdExecutionState: { phase: string } }).__kdExecutionState };
}

function runTo(outcome: 'completed' | 'blocked' | 'needs_input' | 'failed' | 'cancelled') {
  const projection = new ExecutionProjection({ runId: 'r1', mode: 'baat_kar', request: 'How does governance work?' });
  projection.repositoryEvidence(['src/a.ts']);
  const snapshot = { type: 'dhaaga', op: 'snapshot', state: projection.snapshot() };
  const patch = projection.terminal(outcome, outcome === 'completed' ? undefined : 'Implementation evidence was incomplete');
  return { snapshot, patch };
}

describe('task footer follows the execution projection', () => {
  for (const outcome of ['blocked', 'needs_input', 'failed', 'cancelled'] as const) {
    it(`a ${outcome} run never renders a Completed footer when the turn's done arrives`, () => {
      const { dispatch, footer } = mount();
      const { snapshot, patch } = runTo(outcome);
      dispatch(snapshot);
      dispatch({ type: 'dhaaga', op: 'patch', runId: 'r1', patch });
      dispatch({ type: 'done' });
      const state = footer();
      expect(state.label).not.toBe('Completed');
      expect(state.sentence).not.toMatch(/task finished/i);
      expect(state.label).toBe(outcome === 'cancelled' ? 'Stopped' : 'Blocked');
    });
  }

  it('re-derives the footer when the projection settles after done (either arrival order)', () => {
    const { dispatch, footer, state } = mount();
    const { snapshot, patch } = runTo('blocked');
    dispatch(snapshot);
    dispatch({ type: 'done' });
    expect(footer().label).not.toBe('Completed');
    expect(state().phase).not.toBe('completed');
    dispatch({ type: 'dhaaga', op: 'patch', runId: 'r1', patch });
    expect(footer().label).toBe('Blocked');
  });

  it('a completed run still renders Completed', () => {
    const { dispatch, footer } = mount();
    const { snapshot, patch } = runTo('completed');
    dispatch(snapshot);
    dispatch({ type: 'dhaaga', op: 'patch', runId: 'r1', patch });
    dispatch({ type: 'done' });
    expect(footer().label).toBe('Completed');
  });
});

describe('transport done never renders semantic Completed before the projection settles', () => {
  function activeRun() {
    const projection = new ExecutionProjection({ runId: 'r9', mode: 'saath_kar', request: 'Update a.txt and b.txt' });
    projection.toolStarted('c1', 'read_file', { path: 'b.txt' });
    return { projection, snapshot: { type: 'dhaaga', op: 'snapshot', state: projection.snapshot() } };
  }
  const surfaces = (ui: ReturnType<typeof mount>) => ({
    footer: ui.footer().label,
    sentence: ui.footer().sentence,
    status: ui.document.getElementById('status-row-text')?.textContent ?? '',
    operator: ui.document.getElementById('oc-status')?.textContent ?? '',
    phase: ui.state().phase,
    visual: ui.document.body.dataset.kdTaskState ?? '',
  });

  it('keeps every status surface off Completed when done arrives while the run is still active', () => {
    const ui = mount();
    const { snapshot } = activeRun();
    ui.dispatch(snapshot);
    ui.dispatch({ type: 'done', content: 'Updated a.txt.' });
    const now = surfaces(ui);
    expect(now.footer).not.toBe('Completed');
    expect(now.sentence).not.toMatch(/task finished/i);
    expect(now.status).not.toBe('Completed');
    expect(now.operator).not.toBe('Completed');
    expect(now.phase).not.toBe('completed');
    expect(now.visual).not.toBe('completed');
  });

  it('renders Completed only once the authoritative terminal patch arrives, in either arrival order', () => {
    for (const doneFirst of [true, false]) {
      const ui = mount();
      const { projection, snapshot } = activeRun();
      ui.dispatch(snapshot);
      const patch = projection.terminal('completed');
      if (doneFirst) ui.dispatch({ type: 'done', content: 'ok' });
      expect(surfaces(ui).status).not.toBe('Completed');
      ui.dispatch({ type: 'dhaaga', op: 'patch', runId: 'r9', patch });
      if (!doneFirst) ui.dispatch({ type: 'done', content: 'ok' });
      const settled = surfaces(ui);
      expect(settled.phase).toBe('completed');
      expect(settled.status).toBe('Completed');
      expect(settled.footer).toBe('Completed');
    }
  });
});
