// @vitest-environment jsdom
//
// Completed-task restoration projection regression suite.
//
// Reopening a workspace whose Karke Dikha task already finished replays that
// task's resolved approval cards. Those replayed messages reach
// activateGate/resolveGate -> ensureTaskAttempt, which sets `activeTaskId`.
//
// media/chat-autonomous.js's `autonomousTaskStatus` handler used to reveal and
// stamp the task message only under `if (!activeTaskId && statusTaskId)` — a
// "first projection" condition. When the approval replay won that race, the
// only branch that reveals a *completed* task's message was skipped, and there
// was no recovery: a terminal task is filtered out of `autonomousTaskActive`,
// `statusBox` is never re-hidden elsewhere, and every later status message
// re-hit the same guard. The durable task stayed permanently invisible in the
// reopened transcript (#autonomous-status hidden, no `data-kd-task-message`,
// `Task: —` while the attempt id was correctly labelled).
//
// The Guardian P0 lifecycle journey caught this intermittently as
// "completed task response must restore exactly once, 0 !== 1".
//
// Every scenario below drives the real, unmodified media/chat.html + media/*.js
// production files inside jsdom, exactly as the packaged webview loads them.
import { JSDOM } from 'jsdom';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

interface PostedMessage {
  type: string;
  [key: string]: unknown;
}

interface MountedWebview {
  document: Document;
  posted: PostedMessage[];
  dispatch: (message: Record<string, unknown>) => void;
  byId: (id: string) => HTMLElement;
}

const MEDIA_DIR = resolve(process.cwd(), 'media');
const CHAT_HTML_PATH = resolve(MEDIA_DIR, 'chat.html');

const PRODUCTION_SCRIPT_FILES = [
  'chat.js',
  'chat-fixes.js',
  'chat-dashboard.js',
  'chat-operations.js',
  'chat-runtime-fixes.js',
  'chat-autonomous.js',
  'chat-sidebar-ui.js',
];

function buildTemplatedHtml(scriptFiles: string[]): string {
  const rawHtml = readFileSync(CHAT_HTML_PATH, 'utf8');
  const scripts = scriptFiles.map(file => readFileSync(resolve(MEDIA_DIR, file), 'utf8'));

  const templated = rawHtml
    .replace(/{{cspSource}}/g, "'self'")
    .replace(/{{nonce}}/g, 'test-nonce')
    .replace(/{{cssUri}}/g, 'chat.css')
    .replace(/{{jsUri}}/g, 'chat.js')
    .replace(/{{modelName}}/g, 'test-model');

  const scriptsStart = templated.indexOf('<script nonce="test-nonce">');
  if (scriptsStart === -1) throw new Error('Could not locate chat.html bootstrap script block.');
  const head = templated.slice(0, scriptsStart);

  const inlineScripts = scripts.map(js => `<script nonce="test-nonce">${js}</script>`).join('\n    ');

  return `${head}
    <script nonce="test-nonce">
      (() => {
        const acquire = window.acquireVsCodeApi;
        if (typeof acquire !== 'function') {
          throw new Error('VS Code webview API is unavailable.');
        }
        const api = acquire();
        Object.defineProperty(window, '__ollamaAgentVsCodeApi', {
          value: api,
          configurable: false,
          enumerable: false,
          writable: false,
        });
      })();
    </script>
    ${inlineScripts}
  </body>
  </html>`;
}

function mountWebview(): MountedWebview {
  const html = buildTemplatedHtml(PRODUCTION_SCRIPT_FILES);
  const posted: PostedMessage[] = [];
  const state: { value: Record<string, unknown> } = { value: {} };

  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'https://example-webview.invalid/',
    beforeParse(window) {
      window.HTMLElement.prototype.scrollIntoView = () => undefined;
      (window as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({
        postMessage: (msg: PostedMessage) => { posted.push(msg); },
        getState: () => state.value,
        setState: (next: Record<string, unknown>) => { state.value = next; },
      });
    },
  });

  const { window } = dom;
  const document = window.document;

  return {
    document,
    posted,
    dispatch: message => {
      window.dispatchEvent(new window.MessageEvent('message', { data: message }));
    },
    byId: id => {
      const el = document.getElementById(id);
      if (!el) throw new Error(`Expected element #${id} to exist in chat.html`);
      return el as HTMLElement;
    },
  };
}

const TASK = 'att_9c6ab098-2f45-4a7b-bb9d-70bc1e80ca35';
const ATTEMPT = 'att_9c6ab098-2f45-4a7b-bb9d-70bc1e80ca35';

/** Replays the resolved proposal + mutation approval cards exactly as reopening
 * a finished workspace does. Both reach ensureTaskAttempt, which sets
 * activeTaskId before any status snapshot arrives — the race condition. */
function replayResolvedApprovalCards(w: MountedWebview): void {
  w.dispatch({
    type: 'proposalApprovalRequest',
    taskId: TASK, attemptId: ATTEMPT, proposalId: 'p1', version: 1,
    taskSummary: 'Create note-auto.txt containing Hello.',
    operations: [], validationCommands: [], warnings: [],
  });
  w.dispatch({
    type: 'proposalApprovalResolved',
    taskId: TASK, attemptId: ATTEMPT, proposalId: 'p1', decision: 'approved',
  });
  w.dispatch({
    type: 'mutationApprovalRequest',
    taskId: TASK, attemptId: ATTEMPT, requestId: 'm1',
    operationCount: 1, targets: ['note-auto.txt'], elevatedConfirmationRequired: false,
  });
  w.dispatch({
    type: 'mutationApprovalResolved',
    taskId: TASK, attemptId: ATTEMPT, requestId: 'm1', decision: 'approved',
  });
}

function completedStatus(w: MountedWebview): void {
  w.dispatch({
    type: 'autonomousTaskStatus',
    taskId: TASK, attemptId: ATTEMPT, state: 'completed',
    goal: 'create note-auto.txt containing Hello', events: [],
  });
}

/** The Guardian page object's `responseCount`: rendered `.kd-task-message`
 * wrappers inside `#messages`. jsdom reports no layout boxes, so this counts
 * structural wrappers that are not hidden. */
function taskMessageWrappers(w: MountedWebview): HTMLElement[] {
  return Array.from(w.document.querySelectorAll<HTMLElement>('#messages .kd-task-message'))
    .filter(element => !element.hidden);
}

function exactId(value: string | null | undefined): string {
  return String(value ?? '').replace(/^[^:]+:\s*/, '').trim();
}

// A task this webview session started (or saw running) is LIVE and renders in the execution surface when it
// completes. A terminal task replayed from history never does (see historyInertness.test.ts): history is inert.
function markLive(w: MountedWebview): void {
  w.dispatch({ type: 'autonomousTaskStarted', taskId: TASK, attemptId: ATTEMPT, state: 'queued' });
}

describe('completed-task restoration projects the durable task into the reopened transcript', () => {
  it('reveals and stamps the completed task when approval-card restore set activeTaskId first', () => {
    const w = mountWebview();

    // 1. Approval-card restore wins the race and sets activeTaskId.
    replayResolvedApprovalCards(w);
    const statusBox = w.byId('autonomous-status');
    expect(statusBox.dataset.kdTaskMessage).toBeUndefined();
    markLive(w);

    // 2. The completed task's status snapshot arrives afterwards.
    completedStatus(w);

    // 3. The durable completed task must be visibly projected.
    expect(statusBox.hidden).toBe(false);
    expect(statusBox.dataset.kdTaskMessage).toBe(`kd-task-message-${TASK}`);
    expect(exactId(w.byId('autonomous-task-id').textContent)).toBe(TASK);
    expect(exactId(w.byId('autonomous-attempt-id').textContent)).toBe(ATTEMPT);
    expect(taskMessageWrappers(w)).toHaveLength(1);
  });

  it('projects identically when the status snapshot wins the race instead', () => {
    const w = mountWebview();
    markLive(w);

    // The ordering that always worked — must keep working unchanged.
    completedStatus(w);
    replayResolvedApprovalCards(w);

    const statusBox = w.byId('autonomous-status');
    expect(statusBox.hidden).toBe(false);
    expect(statusBox.dataset.kdTaskMessage).toBe(`kd-task-message-${TASK}`);
    expect(exactId(w.byId('autonomous-task-id').textContent)).toBe(TASK);
    expect(exactId(w.byId('autonomous-attempt-id').textContent)).toBe(ATTEMPT);
    expect(taskMessageWrappers(w)).toHaveLength(1);
  });

  it('repeated status messages do not duplicate or reset the projection', () => {
    const w = mountWebview();
    markLive(w);
    replayResolvedApprovalCards(w);
    completedStatus(w);

    const statusBox = w.byId('autonomous-status');
    const details = statusBox.querySelector<HTMLDetailsElement>('details#kd-task-details');
    // Open the disclosure, then prove a re-stamp would have collapsed it.
    if (details) details.open = true;
    const stampedIdentity = statusBox.dataset.kdTaskMessage;

    completedStatus(w);
    completedStatus(w);
    completedStatus(w);

    expect(taskMessageWrappers(w)).toHaveLength(1);
    expect(statusBox.hidden).toBe(false);
    expect(statusBox.dataset.kdTaskMessage).toBe(stampedIdentity);
    expect(exactId(w.byId('autonomous-task-id').textContent)).toBe(TASK);
    expect(exactId(w.byId('autonomous-attempt-id').textContent)).toBe(ATTEMPT);
    // stampTaskMessage collapses the details disclosure, so an unguarded
    // re-stamp on every poll would have reset this to false.
    if (details) expect(details.open).toBe(true);
  });

  it('a status snapshot for an unrelated completed task does not steal the projection', () => {
    const w = mountWebview();
    markLive(w);
    replayResolvedApprovalCards(w);
    completedStatus(w);

    const statusBox = w.byId('autonomous-status');
    w.dispatch({
      type: 'autonomousTaskStatus',
      taskId: 'att_other-task', attemptId: 'att_other-task', state: 'completed', events: [],
    });

    expect(taskMessageWrappers(w)).toHaveLength(1);
    expect(exactId(w.byId('autonomous-task-id').textContent)).toBe(TASK);
  });

  // Sibling handlers must keep their existing behavior.
  it('autonomousTaskActive still reveals and stamps a restored non-terminal task', () => {
    const w = mountWebview();
    w.dispatch({
      type: 'autonomousTaskActive',
      taskId: TASK, attemptId: ATTEMPT, state: 'running',
      goal: 'create note-auto.txt containing Hello', restored: true,
    });

    const statusBox = w.byId('autonomous-status');
    expect(statusBox.hidden).toBe(false);
    expect(statusBox.dataset.kdTaskMessage).toBe(`kd-task-message-${TASK}`);
    expect(exactId(w.byId('autonomous-task-id').textContent)).toBe(TASK);
    expect(exactId(w.byId('autonomous-attempt-id').textContent)).toBe(ATTEMPT);
    expect(taskMessageWrappers(w)).toHaveLength(1);
  });

  it('autonomousTaskStarted still reveals and stamps a freshly acknowledged task', () => {
    const w = mountWebview();
    w.dispatch({ type: 'autonomousTaskStarted', taskId: TASK, attemptId: ATTEMPT, state: 'queued' });

    const statusBox = w.byId('autonomous-status');
    expect(statusBox.hidden).toBe(false);
    expect(statusBox.dataset.kdTaskMessage).toBe(`kd-task-message-${TASK}`);
    expect(exactId(w.byId('autonomous-task-id').textContent)).toBe(TASK);
    expect(exactId(w.byId('autonomous-attempt-id').textContent)).toBe(ATTEMPT);
    expect(taskMessageWrappers(w)).toHaveLength(1);
  });

  it('a started task followed by status keeps exactly one wrapper', () => {
    const w = mountWebview();
    w.dispatch({ type: 'autonomousTaskStarted', taskId: TASK, attemptId: ATTEMPT, state: 'queued' });
    completedStatus(w);

    expect(taskMessageWrappers(w)).toHaveLength(1);
    expect(w.byId('autonomous-status').dataset.kdTaskMessage).toBe(`kd-task-message-${TASK}`);
  });
});
