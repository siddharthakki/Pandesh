// @vitest-environment jsdom
import { JSDOM } from 'jsdom';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * History is inert (Golden P1/P5 invariants C/D/E): hydrating a TERMINAL task this webview never started or saw
 * running must not mount the legacy execution renderer, must not dispatch anything, and must not change composer mode.
 * A task that is started/observed live in this session still renders (live execution is not history).
 */

interface Posted { type: string; [key: string]: unknown }
const SCRIPTS = [
  'chat.js', 'chat-fixes.js', 'chat-dashboard.js', 'chat-operations.js', 'chat-runtime-fixes.js', 'chat-autonomous.js',
  'chat-sidebar-ui.js', 'everyday-presentation.js', 'chat-everyday.js', 'chat-dhaaga.js',
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
  const posted: Posted[] = [];
  const dom = new JSDOM(html, {
    runScripts: 'dangerously', url: 'https://example-webview.invalid/',
    beforeParse(window) {
      (window as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({ postMessage: (m: Posted) => { posted.push(m); }, getState: () => ({}), setState: () => undefined });
      (window as unknown as { alert: () => void }).alert = () => undefined;
    },
  });
  open.push(dom);
  (dom.window as unknown as { __kdWorkspaceRestored?: boolean }).__kdWorkspaceRestored = true;
  const dispatch = (data: Record<string, unknown>) => dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data }));
  return { document: dom.window.document, posted, dispatch };
}

const PROMPT = 'Verify your previous run instructions. Read the actual launcher/entrypoint files needed to prove the exact startup command, including start.bat if it exists. Correct anything you previously inferred. Cite the exact files/functions that establish the startup path.';
const DISPATCHING = new Set(['sendMessage', 'retryBlockedAttempt', 'approveProposal', 'approveMutation', 'approveAutonomousDelivery', 'startAutonomousTask', 'resumeTask']);
const legacyMounted = (document: Document) => (document.getElementById('autonomous-status') as HTMLElement | null)?.hidden === false;
const dispatched = (posted: Posted[]) => posted.filter(m => DISPATCHING.has(m.type));

describe('history hydration never mounts the legacy execution renderer or dispatches', () => {
  for (const state of ['completed', 'failed', 'blocked', 'cancelled']) {
    it(`terminal ${state} task replayed from history stays unmounted (exact objective prompt)`, () => {
      const { document, posted, dispatch } = mount();
      dispatch({ type: 'autonomousTaskActive', taskId: 't-old', attemptId: 'a-old', state, goal: PROMPT });
      dispatch({ type: 'autonomousTaskStatus', taskId: 't-old', attemptId: 'a-old', state, goal: PROMPT, events: [] });
      dispatch({ type: 'autonomousTaskStatus', taskId: 't-old', attemptId: 'a-old', state, goal: PROMPT, events: [] });
      expect(legacyMounted(document)).toBe(false);
      expect(document.body.dataset.autonomousTaskActive).not.toBe('true');
      expect(dispatched(posted)).toEqual([]);
    });
  }

  it('a task started live in this session still renders when it turns terminal', () => {
    const { document, dispatch } = mount();
    dispatch({ type: 'autonomousTaskStarted', taskId: 't-live', attemptId: 'a-live', goal: PROMPT });
    dispatch({ type: 'autonomousTaskStatus', taskId: 't-live', attemptId: 'a-live', state: 'blocked', goal: PROMPT, events: [] });
    expect(legacyMounted(document)).toBe(true);
  });

  it('opening, expanding and re-opening history causes zero dispatch', () => {
    const { document, posted, dispatch } = mount();
    dispatch({ type: 'everydayHistory', available: true, tasks: [{ taskId: 't-old', attemptId: 'a-old', state: 'completed', request: PROMPT, updatedAt: new Date().toISOString() }] });
    (document.getElementById('everyday-history-toggle') as HTMLElement | null)?.click();
    document.querySelectorAll<HTMLElement>('.everyday-history-item').forEach(item => item.click());
    expect(dispatched(posted)).toEqual([]);
  });
});
