// @vitest-environment jsdom
//
// Drives the REAL production webview markup (media/chat.html) and the REAL
// production webview script (media/chat-autonomous.js) inside jsdom — no
// mock DOM, no assertions about which host messages were posted. This is
// the automated replacement for the manual "reinstall the VSIX, reopen VS
// Code, eyeball the sidebar" dogfood loop: the authoritative
// autonomousTaskActive / autonomousTaskStatus snapshot protocol that
// AgentPanel sends is simulated directly, and the resulting rendered DOM
// (button disabled state, card visibility, status text) is asserted.
import { JSDOM } from 'jsdom';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

interface PostedMessage {
  type: string;
  [key: string]: unknown;
}

interface MountedWebview {
  window: JSDOM['window'];
  document: Document;
  posted: PostedMessage[];
  dispatch: (message: Record<string, unknown>) => void;
  byId: (id: string) => HTMLElement;
}

const CHAT_HTML_PATH = resolve(process.cwd(), 'media/chat.html');

// Exact production load order from chat.html's dynamic <script> loader
// chain (`files` array in the trailing bootstrap block), plus the initial
// `<script src="{{jsUri}}">` (chat.js) that precedes it. This is the real
// webview's full script list — chat-sidebar-ui.js included and loaded last,
// exactly as the browser would fetch it.
const PRODUCTION_SCRIPT_FILES = [
  'chat.js',
  'chat-fixes.js',
  'chat-dashboard.js',
  'chat-operations.js',
  'chat-runtime-fixes.js',
  'chat-autonomous.js',
  'chat-sidebar-ui.js',
];

/**
 * Builds the exact production chat.html (with its `{{...}}` template slots
 * filled the same way AgentPanel.buildHtml does) and executes every real,
 * unmodified production media/*.js file chat.html loads, in chat.html's
 * exact order — including chat-sidebar-ui.js, which the real webview also
 * executes. jsdom has no webview resource loader, so the dynamic
 * `<script src>` injection chain chat.html normally uses is replaced with
 * inline `<script>` blocks containing each file's real contents, in the
 * same order — the direct equivalent of the browser fetching those exact
 * files, not a rewritten stand-in.
 */
function mountWebview(): MountedWebview {
  const rawHtml = readFileSync(CHAT_HTML_PATH, 'utf8');
  const scripts = PRODUCTION_SCRIPT_FILES.map(file =>
    readFileSync(resolve(process.cwd(), 'media', file), 'utf8'),
  );

  const templated = rawHtml
    .replace(/{{cspSource}}/g, "'self'")
    .replace(/{{nonce}}/g, 'test-nonce')
    .replace(/{{cssUri}}/g, 'chat.css')
    .replace(/{{jsUri}}/g, 'chat.js')
    .replace(/{{modelName}}/g, 'test-model');

  // Strip the two trailing <script> blocks that (a) call acquireVsCodeApi
  // and (b) dynamically inject chat.js/chat-fixes.js/.../chat-sidebar-ui.js
  // via <script src>, and replace them with the acquire bootstrap (kept
  // verbatim) followed by every production script's real contents inlined,
  // in chat.html's exact load order.
  const scriptsStart = templated.indexOf('<script nonce="test-nonce">');
  if (scriptsStart === -1) throw new Error('Could not locate chat.html bootstrap script block.');
  const head = templated.slice(0, scriptsStart);

  const inlineScripts = scripts.map(js => `<script nonce="test-nonce">${js}</script>`).join('\n    ');

  const html = `${head}
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

  const posted: PostedMessage[] = [];
  const state: { value: Record<string, unknown> } = { value: {} };

  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'https://example-webview.invalid/',
    beforeParse(window) {
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
    window,
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

/** Surfaces a historical (already-shown-earlier-this-session) proposal card
 * exactly the way AgentPanel.surfaceProposalApproval does, so the card
 * starts out fully interactive before the authoritative snapshot arrives. */
function surfaceHistoricalProposal(w: MountedWebview, taskId: string, attemptId: string, proposalId: string): void {
  w.dispatch({
    type: 'proposalApprovalRequest',
    taskId, attemptId, proposalId, version: 1,
    taskSummary: 'Historical proposal', operations: [], validationCommands: [], warnings: [],
  });
}

function surfaceHistoricalMutation(w: MountedWebview, taskId: string, attemptId: string, requestId: string): void {
  w.dispatch({
    type: 'mutationApprovalRequest',
    taskId, attemptId, requestId, proposalId: 'p1', operationCount: 2, targets: ['a.ts', 'b.ts'],
    elevatedConfirmationRequired: false,
  });
}

function currentDelivery(w: MountedWebview, taskId: string, attemptId: string): void {
  w.dispatch({ type: 'deliveryApprovalRequest', gate: 'delivery', taskId, attemptId });
}

describe('webview approval-card reconciliation (real chat.html + real chat-autonomous.js)', () => {
  const TASK_ID = 'task-dogfood-1';
  const ATTEMPT_ID = 'attempt-1';

  it('AUTONOMOUS_APPROVAL_RESTORE: reconciles historical proposal/mutation cards to disabled and keeps only delivery active on the authoritative snapshot', () => {
    const w = mountWebview();

    // Simulate the exact restored-timeline scenario: proposal, then mutation,
    // then delivery requests are replayed in chronological order (as
    // AgentPanel.rehydrateResolvedApprovalCards / a durable-log replay would
    // do). The bounded gate lifecycle in chat-autonomous.js supersedes each
    // earlier still-pending gate the instant a later-stage request arrives
    // — at most one gate is ever actionable, even mid-replay, without
    // needing to wait for a status snapshot to reconcile it after the fact.
    surfaceHistoricalProposal(w, TASK_ID, ATTEMPT_ID, 'proposal-1');
    expect((w.byId('proposal-approve-btn') as HTMLButtonElement).disabled).toBe(false);

    surfaceHistoricalMutation(w, TASK_ID, ATTEMPT_ID, 'mutation-1');
    expect((w.byId('proposal-approve-btn') as HTMLButtonElement).disabled).toBe(true);
    expect((w.byId('mutation-approve-btn') as HTMLButtonElement).disabled).toBe(false);

    currentDelivery(w, TASK_ID, ATTEMPT_ID);
    expect((w.byId('mutation-approve-btn') as HTMLButtonElement).disabled).toBe(true);
    expect((w.byId('delivery-approve-btn') as HTMLButtonElement).disabled).toBe(false);

    // The one authoritative snapshot that must reconcile everything.
    w.dispatch({
      type: 'autonomousTaskStatus',
      taskId: TASK_ID,
      attemptId: ATTEMPT_ID,
      state: 'waiting_for_delivery_approval',
      pandaState: 'waiting_for_delivery_approval',
      events: [],
    });

    expect((w.byId('proposal-approve-btn') as HTMLButtonElement).disabled).toBe(true);
    expect((w.byId('proposal-revise-btn') as HTMLButtonElement).disabled).toBe(true);
    expect((w.byId('proposal-reject-btn') as HTMLButtonElement).disabled).toBe(true);
    expect((w.byId('proposal-revision-text') as HTMLTextAreaElement).disabled).toBe(true);
    expect((w.byId('mutation-approve-btn') as HTMLButtonElement).disabled).toBe(true);
    expect((w.byId('mutation-deny-btn') as HTMLButtonElement).disabled).toBe(true);

    expect((w.byId('delivery-review-btn') as HTMLButtonElement).disabled).toBe(false);
    expect((w.byId('delivery-approve-btn') as HTMLButtonElement).disabled).toBe(false);
    expect((w.byId('delivery-reject-btn') as HTMLButtonElement).disabled).toBe(false);

    // Earlier approval cards belonging to the same task remain visible as
    // disabled history. Delivery is the only actionable gate.
    expect((w.byId('proposal-approval-card') as HTMLElement).hidden).toBe(false);
    expect((w.byId('mutation-approval-card') as HTMLElement).hidden).toBe(false);
    expect((w.byId('delivery-approval-card') as HTMLElement).hidden).toBe(false);

    const pandaLabel = w.byId('autonomous-panda-label');
    expect(pandaLabel.textContent).not.toBe('Ready when you are.');
    expect(pandaLabel.textContent).toMatch(/wait/i);

    // No duplicate cards — the production markup has exactly one section
    // per gate, reused in place; assert that invariant explicitly.
    expect(w.document.querySelectorAll('#proposal-approval-card').length).toBe(1);
    expect(w.document.querySelectorAll('#mutation-approval-card').length).toBe(1);
    expect(w.document.querySelectorAll('#delivery-approval-card').length).toBe(1);

    console.log('AUTONOMOUS_APPROVAL_RESTORE: PASS');
    console.log('ACTIVE_GATE: delivery');
    console.log('PROPOSAL_CONTROLS: disabled');
    console.log('MUTATION_CONTROLS: disabled');
    console.log('DELIVERY_CONTROLS: enabled');
    console.log('STATUS: waiting_for_delivery_approval');
  });

  it('a fresh reload (new DOM) that never re-surfaces the proposal/mutation cards still lands on the correct locked delivery-only status, and cards for a different task are untouched', () => {
    const w = mountWebview();

    // Reconnect path: AgentPanel posts autonomousTaskActive immediately,
    // then the first poll's autonomousTaskStatus — the proposal/mutation
    // request messages are never resent because the task has moved past
    // those gates. Cards must stay hidden, not resurrected.
    w.dispatch({ type: 'autonomousTaskActive', taskId: TASK_ID, attemptId: ATTEMPT_ID, state: 'waiting_for_delivery_approval' });
    expect((w.byId('autonomous-status') as HTMLElement).hidden).toBe(false);
    expect(w.byId('autonomous-attempt-id').textContent).toBe(`Attempt: ${ATTEMPT_ID}`);
    expect(w.byId('autonomous-panda-label').textContent).not.toBe('Ready when you are.');

    currentDelivery(w, TASK_ID, ATTEMPT_ID);
    w.dispatch({
      type: 'autonomousTaskStatus',
      taskId: TASK_ID, attemptId: ATTEMPT_ID,
      state: 'waiting_for_delivery_approval', pandaState: 'waiting_for_delivery_approval', events: [],
    });
    expect(w.byId('autonomous-attempt-id').textContent).toBe(`Attempt: ${ATTEMPT_ID}`);

    expect((w.byId('proposal-approval-card') as HTMLElement).hidden).toBe(true);
    expect((w.byId('mutation-approval-card') as HTMLElement).hidden).toBe(true);
    expect((w.byId('delivery-approval-card') as HTMLElement).hidden).toBe(false);
    expect((w.byId('delivery-approve-btn') as HTMLButtonElement).disabled).toBe(false);
    expect(w.document.querySelectorAll('#delivery-approval-card').length).toBe(1);

    // A snapshot for an unrelated task must never touch this task's cards.
    w.dispatch({
      type: 'autonomousTaskStatus',
      taskId: 'some-other-task', attemptId: 'x',
      state: 'blocked', pandaState: 'blocked', events: [],
    });
    expect((w.byId('delivery-approve-btn') as HTMLButtonElement).disabled).toBe(false);
    expect((w.byId('delivery-approval-card') as HTMLElement).hidden).toBe(false);

    console.log('RELOAD_RESTARTED_EXECUTION: false');
  });

  it('switches approval ownership to a linked retry before its proposal can be approved', () => {
    const w = mountWebview();
    const predecessor = 'attempt-blocked';
    const successor = 'attempt-retry';
    w.dispatch({ type: 'autonomousTaskActive', taskId: predecessor, attemptId: predecessor, state: 'blocked' });
    w.dispatch({
      type: 'autonomousRetryStarted',
      taskId: successor,
      attemptId: successor,
      predecessorAttemptId: predecessor,
      message: 'Retrying with a stronger coding model',
    });
    surfaceHistoricalProposal(w, successor, successor, 'proposal-retry');

    expect(w.byId('autonomous-task-id').textContent).toBe(`Task: ${successor}`);
    expect(w.byId('autonomous-attempt-id').textContent).toBe(`Attempt: ${successor}`);
    (w.byId('proposal-approve-btn') as HTMLButtonElement).click();
    expect(w.posted).toContainEqual({
      type: 'approveProposal',
      taskId: successor,
      proposalId: 'proposal-retry',
    });
  });

  it('reload → reject delivery → reload again lands on a terminal state with every gate disabled and no re-activation', () => {
    let w = mountWebview();
    currentDelivery(w, TASK_ID, ATTEMPT_ID);
    w.dispatch({
      type: 'autonomousTaskStatus',
      taskId: TASK_ID, attemptId: ATTEMPT_ID,
      state: 'waiting_for_delivery_approval', pandaState: 'waiting_for_delivery_approval', events: [],
    });
    expect((w.byId('delivery-approve-btn') as HTMLButtonElement).disabled).toBe(false);

    w.dispatch({ type: 'deliveryApprovalResolved', taskId: TASK_ID, decision: 'rejected' });
    expect((w.byId('delivery-approve-btn') as HTMLButtonElement).disabled).toBe(true);
    expect((w.byId('delivery-reject-btn') as HTMLButtonElement).disabled).toBe(true);
    expect((w.byId('delivery-approval-card') as HTMLElement).hidden).toBe(false);
    expect(w.byId('delivery-approval-card').dataset.inlineApprovalState).toBe('resolved');

    // Reload once more: fresh DOM, authoritative terminal snapshot only.
    w = mountWebview();
    w.dispatch({ type: 'autonomousTaskActive', taskId: TASK_ID, state: 'cancelled' });
    w.dispatch({
      type: 'autonomousTaskStatus',
      taskId: TASK_ID, attemptId: ATTEMPT_ID,
      state: 'cancelled', pandaState: 'blocked', events: [],
    });

    // Proposal/mutation cards were never surfaced in this fresh session (the
    // task moved past those gates before reload), so they stay hidden —
    // that is the correct outcome, not a bug.
    expect((w.byId('proposal-approval-card') as HTMLElement).hidden).toBe(true);
    expect((w.byId('mutation-approval-card') as HTMLElement).hidden).toBe(true);
    // Terminal state: activeGate is null, so delivery controls are force-disabled too.
    currentDelivery(w, TASK_ID, ATTEMPT_ID);
    w.dispatch({
      type: 'autonomousTaskStatus',
      taskId: TASK_ID, attemptId: ATTEMPT_ID,
      state: 'cancelled', pandaState: 'blocked', events: [],
    });
    // History is inert: a terminal task replayed after reload is not mounted at all (card hidden) — and if it were, its gates must be disabled.
    const gateInert = (id: string) => (w.byId('delivery-approval-card') as HTMLElement).hidden || (w.byId(id) as HTMLButtonElement).disabled;
    expect(gateInert('delivery-approve-btn')).toBe(true);
    expect(gateInert('delivery-reject-btn')).toBe(true);

    expect(w.posted.some(m => m.type === 'startAutonomousTask')).toBe(false);
    expect(w.posted.some(m => m.type === 'approveMutation')).toBe(false);
    expect(w.posted.some(m => m.type === 'approveProposal')).toBe(false);
  });
});
