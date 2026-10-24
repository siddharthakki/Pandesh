// @vitest-environment jsdom
import { JSDOM } from 'jsdom';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { ExecutionProjection } from '../../ui/executionProjection';

/**
 * One live execution surface: for a live Karke task Kaam ka Dhaaga is the primary surface and the legacy objective
 * card / stage rail / progress list / task line / status header must not render beside it. Approval cards are actions
 * and stay. History stays inert (never marks a live surface).
 */
const SCRIPTS = [
  'chat.js', 'chat-fixes.js', 'chat-dashboard.js', 'chat-operations.js', 'chat-runtime-fixes.js', 'chat-autonomous.js',
  'chat-sidebar-ui.js', 'everyday-presentation.js', 'chat-everyday.js', 'chat-dhaaga.js',
];
const LEGACY_EXECUTION_NODES = ['#task-request-entry', '#autonomous-stage-tracker', '#autonomous-conversational-progress', '#kd-task-line', '#autonomous-status > .autonomous-status-header'];
const GOAL = 'Create note.txt containing Hello';
const open: JSDOM[] = [];
afterEach(() => { for (const dom of open.splice(0)) dom.window.close(); });

function mount() {
  const raw = readFileSync(resolve(process.cwd(), 'media/chat.html'), 'utf8')
    .replace(/{{cspSource}}/g, "'self'").replace(/{{nonce}}/g, 'n').replace(/{{cssUri}}/g, 'chat.css').replace(/{{jsUri}}/g, 'chat.js')
    .replace(/{{pandaBaseUri}}/g, '').replace(/{{modelName}}/g, 'm');
  const head = raw.slice(0, raw.indexOf('<script nonce="n">'));
  // The real Dhaaga stylesheet carries the rule under test; an unparsable unrelated rule must not hide a regression.
  const css = `<style>${readFileSync(resolve(process.cwd(), 'media/chat-dhaaga.css'), 'utf8')}</style>`;
  const inline = SCRIPTS.map(file => `<script nonce="n">${readFileSync(resolve(process.cwd(), 'media', file), 'utf8')}</script>`).join('\n');
  const html = `${head}${css}<script nonce="n">(() => { const api = window.acquireVsCodeApi(); Object.defineProperty(window, '__ollamaAgentVsCodeApi', { value: api }); Object.defineProperty(window, '__pandaBaseUri', { value: '' }); })();</script>${inline}</body></html>`;
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
  const rendered = (selector: string) => {
    const node = dom.window.document.querySelector(selector) as HTMLElement | null;
    return Boolean(node) && dom.window.getComputedStyle(node!).display !== 'none';
  };
  return { document: dom.window.document, dispatch, rendered };
}

const dhaagaSnapshot = () => ({
  type: 'dhaaga', op: 'snapshot',
  state: new ExecutionProjection({ runId: 'task-live', mode: 'karke_dikha', request: GOAL }).snapshot(),
});

describe('a live Karke task renders on exactly one execution surface', () => {
  it('Dhaaga is the primary surface and no legacy objective/stage rail/progress/task line/status header renders beside it', () => {
    const { document, dispatch, rendered } = mount();
    dispatch({ type: 'autonomousTaskStarted', taskId: 'task-live', attemptId: 'a-live', goal: GOAL });
    dispatch({ type: 'autonomousTaskStatus', taskId: 'task-live', attemptId: 'a-live', state: 'running', goal: GOAL, events: [] });
    dispatch(dhaagaSnapshot());

    expect(document.body.dataset.kdExecutionSurface).toBe('dhaaga');
    expect(document.querySelectorAll('.kd-dhaaga')).toHaveLength(1);
    expect(rendered('.kd-dhaaga')).toBe(true);
    for (const selector of LEGACY_EXECUTION_NODES) expect(rendered(selector), `${selector} must not render beside the Dhaaga`).toBe(false);
    // Actions are not a second execution view: the pinned approval slot is not suppressed by this rule.
    expect(rendered('#kd-pinned-approval-slot')).toBe(true);
  });

  it('the surface stays single after the task turns terminal, and is released on a host-confirmed New Chat', () => {
    const { document, dispatch, rendered } = mount();
    dispatch({ type: 'autonomousTaskStarted', taskId: 'task-live', attemptId: 'a-live', goal: GOAL });
    dispatch({ type: 'autonomousTaskStatus', taskId: 'task-live', attemptId: 'a-live', state: 'blocked', goal: GOAL, events: [] });
    dispatch(dhaagaSnapshot());
    expect(document.body.dataset.kdExecutionSurface).toBe('dhaaga');
    for (const selector of LEGACY_EXECUTION_NODES) expect(rendered(selector)).toBe(false);

    dispatch({ type: 'newConversation', reset: true });
    expect(document.body.dataset.kdExecutionSurface).toBeUndefined();
  });

  it('history replay stays inert: it never claims a live surface and never mounts the legacy renderer', () => {
    const { document, dispatch } = mount();
    dispatch({ type: 'autonomousTaskActive', taskId: 't-old', attemptId: 'a-old', state: 'completed', goal: GOAL });
    dispatch({ type: 'autonomousTaskStatus', taskId: 't-old', attemptId: 'a-old', state: 'completed', goal: GOAL, events: [] });
    expect(document.body.dataset.kdExecutionSurface).toBeUndefined();
    expect((document.getElementById('autonomous-status') as HTMLElement).hidden).toBe(true);
  });
});
