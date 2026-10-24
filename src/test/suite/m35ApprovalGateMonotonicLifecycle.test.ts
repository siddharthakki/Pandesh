// @vitest-environment jsdom
//
// M35 approval-card ownership correction regression suite.
//
// Two production bugs are covered here:
//
// 1. Dual DOM ownership: media/chat-sidebar-ui.js used to independently move,
//    hide, and disable the same proposal/mutation/delivery approval cards
//    that media/chat-autonomous.js already owned (including a MutationObserver
//    that fought chat-autonomous.js over the `hidden` attribute). Ownership
//    is now exclusively chat-autonomous.js's; chat-sidebar-ui.js may only
//    react to approval message *types* to flip its own top-level banner.
//
// 2. Non-monotonic gate reconciliation: chat-autonomous.js used to derive
//    gate actionability directly from the latest autonomousTaskStatus
//    `state` string on every snapshot, with no ordering guard. A stale/
//    earlier snapshot (e.g. `running`) arriving after a later-stage
//    approval request (e.g. mutation) would collapse the pending gate —
//    this is the packaged-acceptance failure this file is written against.
//
// Every scenario below drives the real, unmodified media/chat.html +
// media/*.js production files inside jsdom, exactly as the packaged webview
// would load them (chat-sidebar-ui.js included, loaded last).
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

function mount(scriptFiles: string[]): MountedWebview {
  const html = buildTemplatedHtml(scriptFiles);
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

/** Full production stack — chat-autonomous.js + chat-sidebar-ui.js, exactly as packaged. */
function mountWebview(): MountedWebview {
  return mount(PRODUCTION_SCRIPT_FILES);
}

/** chat-sidebar-ui.js only, without chat-autonomous.js — proves it cannot
 * independently drive approval-card DOM on its own. */
function mountSidebarOnly(): MountedWebview {
  return mount(['chat.js', 'chat-sidebar-ui.js']);
}

function proposalRequest(w: MountedWebview, taskId: string, attemptId: string, proposalId: string) {
  w.dispatch({
    type: 'proposalApprovalRequest',
    taskId, attemptId, proposalId, version: 1,
    taskSummary: 'Update one file safely.', operations: [], validationCommands: [], warnings: [],
  });
}

function mutationRequest(w: MountedWebview, taskId: string, attemptId: string, requestId: string) {
  w.dispatch({
    type: 'mutationApprovalRequest',
    taskId, attemptId, requestId, operationCount: 1, targets: ['src/a.ts'],
    elevatedConfirmationRequired: false,
  });
}

function deliveryRequest(w: MountedWebview, taskId: string, attemptId: string) {
  w.dispatch({ type: 'deliveryApprovalRequest', taskId, attemptId });
}

function status(w: MountedWebview, taskId: string, attemptId: string, state: string) {
  w.dispatch({ type: 'autonomousTaskStatus', taskId, attemptId, state, events: [] });
}

function isEnabled(w: MountedWebview, id: string): boolean {
  return !(w.byId(id) as HTMLButtonElement).disabled;
}

/** Counts how many of the three gate cards are currently both visible and
 * have at least one enabled control — the "at most one actionable gate"
 * invariant (rule 7). */
function actionableGateCount(w: MountedWebview): number {
  const gates: Array<{ card: string; controls: string[] }> = [
    { card: 'proposal-approval-card', controls: ['proposal-approve-btn', 'proposal-reject-btn'] },
    { card: 'mutation-approval-card', controls: ['mutation-approve-btn', 'mutation-deny-btn'] },
    { card: 'delivery-approval-card', controls: ['delivery-approve-btn', 'delivery-reject-btn'] },
  ];
  return gates.filter(g => !w.byId(g.card).hidden && g.controls.some(c => isEnabled(w, c))).length;
}

describe('M35 approval-card single ownership + monotonic gate lifecycle', () => {
  const TASK = 'task-m35';
  const ATTEMPT = 'attempt-1';

  it('1. proposal request -> status -> approval -> resolution', () => {
    const w = mountWebview();
    w.dispatch({ type: 'autonomousTaskStarted', taskId: TASK, attemptId: ATTEMPT });
    proposalRequest(w, TASK, ATTEMPT, 'p1');
    expect(isEnabled(w, 'proposal-approve-btn')).toBe(true);
    // The compact panda label for a pending approval gate is "waiting".
    expect(w.byId('autonomous-panda-label').textContent).toMatch(/^waiting/);

    status(w, TASK, ATTEMPT, 'waiting_for_proposal_approval');
    expect(isEnabled(w, 'proposal-approve-btn')).toBe(true);
    expect(actionableGateCount(w)).toBe(1);

    w.dispatch({ type: 'proposalApprovalResolved', taskId: TASK, proposalId: 'p1', decision: 'approved' });
    expect(isEnabled(w, 'proposal-approve-btn')).toBe(false);
    expect(w.byId('proposal-approval-card').hidden).toBe(false);
    expect(w.byId('proposal-card-status').textContent).toBe('Approved');
    expect(actionableGateCount(w)).toBe(0);
  });

  it('2. [KEY REGRESSION] mutation request followed by a stale running snapshot must not disable the pending mutation gate', () => {
    const w = mountWebview();
    w.dispatch({ type: 'autonomousTaskStarted', taskId: TASK, attemptId: ATTEMPT });
    proposalRequest(w, TASK, ATTEMPT, 'p1');
    w.dispatch({ type: 'proposalApprovalResolved', taskId: TASK, proposalId: 'p1', decision: 'approved' });
    mutationRequest(w, TASK, ATTEMPT, 'm1');

    // The exact failing CI order: a stale/earlier `running` snapshot arrives
    // after the mutation gate is already pending.
    status(w, TASK, ATTEMPT, 'running');

    expect(w.byId('mutation-approval-card').hidden).toBe(false);
    expect(isEnabled(w, 'mutation-approve-btn')).toBe(true);
    expect(isEnabled(w, 'mutation-deny-btn')).toBe(true);

    expect(w.byId('proposal-approval-card').hidden).toBe(false);
    expect(isEnabled(w, 'proposal-approve-btn')).toBe(false);

    expect(w.byId('delivery-approval-card').hidden).toBe(true);

    expect(actionableGateCount(w)).toBe(1);
  });

  it('3. stale snapshot followed by waiting_for_mutation_approval', () => {
    const w = mountWebview();
    w.dispatch({ type: 'autonomousTaskStarted', taskId: TASK, attemptId: ATTEMPT });
    proposalRequest(w, TASK, ATTEMPT, 'p1');
    w.dispatch({ type: 'proposalApprovalResolved', taskId: TASK, proposalId: 'p1', decision: 'approved' });

    // Stale/earlier snapshot for the already-resolved proposal gate must not
    // reactivate it.
    status(w, TASK, ATTEMPT, 'waiting_for_proposal_approval');
    expect(isEnabled(w, 'proposal-approve-btn')).toBe(false);
    expect(actionableGateCount(w)).toBe(0);

    // The legitimate next-stage snapshot (no explicit mutation request has
    // arrived yet) may still advance the gate.
    status(w, TASK, ATTEMPT, 'waiting_for_mutation_approval');
    expect(w.byId('mutation-approval-card').hidden).toBe(false);
    expect(isEnabled(w, 'mutation-approve-btn')).toBe(true);
    expect(actionableGateCount(w)).toBe(1);
  });

  it('4. duplicate mutation request is idempotent', () => {
    const w = mountWebview();
    w.dispatch({ type: 'autonomousTaskStarted', taskId: TASK, attemptId: ATTEMPT });
    proposalRequest(w, TASK, ATTEMPT, 'p1');
    w.dispatch({ type: 'proposalApprovalResolved', taskId: TASK, proposalId: 'p1', decision: 'approved' });
    mutationRequest(w, TASK, ATTEMPT, 'm1');
    mutationRequest(w, TASK, ATTEMPT, 'm1');

    expect(w.document.querySelectorAll('#mutation-approval-card').length).toBe(1);
    expect(isEnabled(w, 'mutation-approve-btn')).toBe(true);
    expect(actionableGateCount(w)).toBe(1);

    (w.byId('mutation-approve-btn') as HTMLButtonElement).click();
    expect(w.posted.filter(m => m.type === 'approveMutation').length).toBe(1);
  });

  it('5. mutation resolution followed by delivery request', () => {
    const w = mountWebview();
    w.dispatch({ type: 'autonomousTaskStarted', taskId: TASK, attemptId: ATTEMPT });
    proposalRequest(w, TASK, ATTEMPT, 'p1');
    w.dispatch({ type: 'proposalApprovalResolved', taskId: TASK, proposalId: 'p1', decision: 'approved' });
    mutationRequest(w, TASK, ATTEMPT, 'm1');
    w.dispatch({ type: 'mutationApprovalResolved', taskId: TASK, requestId: 'm1', decision: 'approved' });
    expect(isEnabled(w, 'mutation-approve-btn')).toBe(false);
    expect(w.byId('mutation-approval-card').hidden).toBe(false);

    deliveryRequest(w, TASK, ATTEMPT);
    expect(isEnabled(w, 'delivery-approve-btn')).toBe(true);
    expect(w.byId('mutation-approval-card').hidden).toBe(false);
    expect(isEnabled(w, 'mutation-approve-btn')).toBe(false);
    expect(actionableGateCount(w)).toBe(1);
  });

  it('6. host rehydration replays resolved proposal/mutation plus a pending delivery into a fresh webview', () => {
    const w = mountWebview();
    // No autonomousTaskStarted here — this simulates AgentPanel replaying
    // the durable per-task event log into a brand-new webview session.
    proposalRequest(w, TASK, ATTEMPT, 'p1');
    w.dispatch({ type: 'proposalApprovalResolved', taskId: TASK, proposalId: 'p1', decision: 'approved' });
    mutationRequest(w, TASK, ATTEMPT, 'm1');
    w.dispatch({ type: 'mutationApprovalResolved', taskId: TASK, requestId: 'm1', decision: 'approved' });
    deliveryRequest(w, TASK, ATTEMPT);

    expect(w.byId('proposal-approval-card').hidden).toBe(false);
    expect(isEnabled(w, 'proposal-approve-btn')).toBe(false);
    expect(w.byId('mutation-approval-card').hidden).toBe(false);
    expect(isEnabled(w, 'mutation-approve-btn')).toBe(false);
    expect(w.byId('delivery-approval-card').hidden).toBe(false);
    expect(isEnabled(w, 'delivery-approve-btn')).toBe(true);
    expect(actionableGateCount(w)).toBe(1);
  });

  it('7. a new attempt resets old card ownership', () => {
    const w = mountWebview();
    w.dispatch({ type: 'autonomousTaskStarted', taskId: TASK, attemptId: 'attempt-a' });
    proposalRequest(w, TASK, 'attempt-a', 'p1');
    expect(w.byId('proposal-approval-card').hidden).toBe(false);
    expect(isEnabled(w, 'proposal-approve-btn')).toBe(true);

    w.dispatch({
      type: 'autonomousRetryStarted',
      taskId: TASK, attemptId: 'attempt-b', predecessorAttemptId: 'attempt-a',
      message: 'Retrying with a stronger coding model',
    });

    // The previous attempt's proposal ownership must not leak into the new
    // attempt: card hidden, no gate actionable, until re-requested.
    expect(w.byId('proposal-approval-card').hidden).toBe(true);
    expect(actionableGateCount(w)).toBe(0);

    proposalRequest(w, TASK, 'attempt-b', 'p2');
    expect(w.byId('proposal-approval-card').dataset.attemptId).toBe('attempt-b');
    expect(isEnabled(w, 'proposal-approve-btn')).toBe(true);

    (w.byId('proposal-approve-btn') as HTMLButtonElement).click();
    expect(w.posted).toContainEqual({ type: 'approveProposal', taskId: TASK, proposalId: 'p2' });
    expect(w.posted.some(m => m.type === 'approveProposal' && m.proposalId === 'p1')).toBe(false);
  });

  it('8. a different task cannot inherit or activate stale cards', () => {
    const w = mountWebview();
    // Captured once: chat-autonomous.js's own card references are cached at
    // script load (not re-queried by id), and `autonomousTaskStarted` clears
    // #autonomous-timeline's innerHTML (detaching any inline-moved card from
    // the live tree) — so a *fresh* getElementById lookup after that point
    // can spuriously miss a node the production code still tracks correctly.
    const mutationCard = w.byId('mutation-approval-card') as HTMLElement;
    const mutationApproveBtn = w.byId('mutation-approve-btn') as HTMLButtonElement;

    w.dispatch({ type: 'autonomousTaskStarted', taskId: 'task-A', attemptId: 'attempt-1' });
    mutationRequest(w, 'task-A', 'attempt-1', 'm1');
    expect(mutationApproveBtn.disabled).toBe(false);

    w.dispatch({ type: 'autonomousTaskStarted', taskId: 'task-B', attemptId: 'attempt-1' });
    expect(mutationCard.hidden).toBe(true);
    expect(mutationApproveBtn.disabled).toBe(true);

    // A status snapshot for the old task must never resurrect its gate now
    // that a different task is active.
    status(w, 'task-A', 'attempt-1', 'waiting_for_mutation_approval');
    expect(mutationCard.hidden).toBe(true);
    expect(mutationApproveBtn.disabled).toBe(true);
  });

  it('9. exactly one approval action is posted for one real click', () => {
    const w = mountWebview();
    w.dispatch({ type: 'autonomousTaskStarted', taskId: TASK, attemptId: ATTEMPT });
    mutationRequest(w, TASK, ATTEMPT, 'm1');
    const btn = w.byId('mutation-approve-btn') as HTMLButtonElement;
    btn.click();
    btn.click();
    btn.click();
    expect(w.posted.filter(m => m.type === 'approveMutation').length).toBe(1);
  });

  it('10. terminal completion cannot regress to delivery-working state', async () => {
    const w = mountWebview();
    w.dispatch({ type: 'autonomousTaskStarted', taskId: TASK, attemptId: ATTEMPT });
    deliveryRequest(w, TASK, ATTEMPT);
    status(w, TASK, ATTEMPT, 'completed');
    proposalRequest(w, TASK, ATTEMPT, 'historical-p1');
    w.dispatch({ type: 'proposalApprovalResolved', taskId: TASK, proposalId: 'historical-p1', decision: 'approved' });
    mutationRequest(w, TASK, ATTEMPT, 'historical-m1');
    w.dispatch({ type: 'mutationApprovalResolved', taskId: TASK, requestId: 'historical-m1', decision: 'approved' });
    deliveryRequest(w, TASK, ATTEMPT);
    w.dispatch({ type: 'deliveryApprovalResolved', taskId: TASK, decision: 'approved' });
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(w.byId('kd-task-line').textContent).toBe('Completed');
    expect(w.byId('stop-btn').hidden).toBe(true);
    expect(w.byId('send-btn').textContent).toBe('Send');
    expect(w.byId('unified-task-stop-btn').hidden).toBe(true);
    const stages = [...w.document.querySelectorAll('#autonomous-stage-tracker li')];
    expect(stages.filter(stage => stage.classList.contains('is-current'))).toHaveLength(0);
    expect(stages.every(stage => stage.classList.contains('is-complete'))).toBe(true);
  });

  it('11. chat-sidebar-ui.js cannot independently mutate approval-card DOM state', () => {
    const w = mountSidebarOnly();
    const initialHidden = {
      proposal: w.byId('proposal-approval-card').hidden,
      mutation: w.byId('mutation-approval-card').hidden,
      delivery: w.byId('delivery-approval-card').hidden,
    };
    const initialEnabled = {
      proposal: isEnabled(w, 'proposal-approve-btn'),
      mutation: isEnabled(w, 'mutation-approve-btn'),
      delivery: isEnabled(w, 'delivery-approve-btn'),
    };

    proposalRequest(w, TASK, ATTEMPT, 'p1');
    mutationRequest(w, TASK, ATTEMPT, 'm1');
    deliveryRequest(w, TASK, ATTEMPT);
    w.dispatch({ type: 'proposalApprovalResolved', taskId: TASK, proposalId: 'p1', decision: 'approved' });
    w.dispatch({ type: 'mutationApprovalResolved', taskId: TASK, requestId: 'm1', decision: 'approved' });
    w.dispatch({ type: 'deliveryApprovalResolved', taskId: TASK, decision: 'approved' });

    expect(w.byId('proposal-approval-card').hidden).toBe(initialHidden.proposal);
    expect(w.byId('mutation-approval-card').hidden).toBe(initialHidden.mutation);
    expect(w.byId('delivery-approval-card').hidden).toBe(initialHidden.delivery);
    expect(isEnabled(w, 'proposal-approve-btn')).toBe(initialEnabled.proposal);
    expect(isEnabled(w, 'mutation-approve-btn')).toBe(initialEnabled.mutation);
    expect(isEnabled(w, 'delivery-approve-btn')).toBe(initialEnabled.delivery);
    expect(w.byId('proposal-approval-card').dataset.inlineApprovalState).toBeUndefined();
    expect(w.posted.some(m => String(m.type).startsWith('approve'))).toBe(false);
  });
});
