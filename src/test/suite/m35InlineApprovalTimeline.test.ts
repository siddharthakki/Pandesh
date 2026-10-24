import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { TextDecoder, TextEncoder } from 'util';
import { JSDOM } from 'jsdom';

const root = path.join(__dirname, '..', '..', '..');
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), 'utf8');

function send(window: JSDOM['window'], data: Record<string, unknown>): void {
  window.dispatchEvent(new window.MessageEvent('message', { data }));
}

function setupWebview() {
  const dom = new JSDOM(read('media/chat.html'), {
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    url: 'https://karkedikha.test/',
  });
  const { window } = dom;
  const posted: Array<Record<string, unknown>> = [];
  const scrolled: string[] = [];
  let state: Record<string, unknown> = {};

  Object.defineProperty(window, '__ollamaAgentVsCodeApi', {
    value: {
      postMessage(message: Record<string, unknown>) { posted.push(message); },
      getState() { return state; },
      setState(next: Record<string, unknown>) { state = next; },
    },
  });
  Object.defineProperty(window, '__pandaBaseUri', { value: '' });
  Object.defineProperty(window, 'TextEncoder', { value: TextEncoder });
  Object.defineProperty(window, 'TextDecoder', { value: TextDecoder });
  Object.defineProperty(window, 'matchMedia', {
    value: () => ({ matches: true, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }),
  });
  Object.defineProperty(window, 'requestAnimationFrame', {
    value: (callback: FrameRequestCallback) => { callback(0); return 1; },
  });
  window.HTMLElement.prototype.scrollIntoView = function scrollIntoView() {
    scrolled.push(this.id);
  };

  window.eval(read('media/chat-autonomous.js'));
  window.eval(read('media/chat-sidebar-ui.js'));
  return { dom, window, posted, scrolled };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await new Promise(resolve => setTimeout(resolve, 0));
}

describe('M34 post-dogfood correction: approvals are inline conversation events', () => {
  it('moves every authoritative approval card into the active autonomous timeline, owned solely by chat-autonomous.js', () => {
    const source = read('media/chat-autonomous.js');
    expect(source).toContain("const timeline = document.getElementById('autonomous-timeline')");
    expect(source).toContain('timeline.appendChild(card)');
    expect(source).toContain("case 'proposalApprovalRequest':");
    expect(source).toContain("case 'mutationApprovalRequest':");
    expect(source).toContain("case 'deliveryApprovalRequest':");

    const sidebarSource = read('media/chat-sidebar-ui.js');
    expect(sidebarSource).not.toContain('autonomous-timeline');
    expect(sidebarSource).not.toContain('proposal-approval-card');
    expect(sidebarSource).not.toContain('mutation-approval-card');
    expect(sidebarSource).not.toContain('delivery-approval-card');
  });

  // M40 note: a PENDING approval card now mounts into the always-visible
  // pinned approval slot (`#kd-pinned-approval-slot`) inside the single
  // `.kd-task-message` wrapper, not directly into `#autonomous-timeline` —
  // the timeline (inside the closed-by-default `.kd-task-details`) is now
  // reserved for RESOLVED gates rendered as compact chronological history.
  // This test's parentElement assertions were updated to match: pending →
  // pinned slot, resolved → timeline. The scroll/dedupe/decision-persistence
  // coverage itself is unchanged.
  it('renders proposal, mutation, and delivery gates in the pinned slot while pending and the timeline once resolved, scrolls pending gates, and retains disabled decisions', async () => {
    const { dom, window, scrolled } = setupWebview();
    try {
      const timeline = window.document.getElementById('autonomous-timeline')!;
      const pinnedSlot = window.document.getElementById('kd-pinned-approval-slot')!;
      send(window, { type: 'autonomousTaskStarted', taskId: 'task-1', attemptId: 'attempt-1' });

      send(window, {
        type: 'proposalApprovalRequest',
        taskId: 'task-1',
        attemptId: 'attempt-1',
        proposalId: 'proposal-1',
        version: 1,
        taskSummary: 'Update one file safely.',
        operations: [{ type: 'replace', path: 'src/a.ts', reason: 'Fix the defect.' }],
        validationCommands: [{ kind: 'npm-script', script: 'verify' }],
        warnings: [],
      });
      const proposal = window.document.getElementById('proposal-approval-card')!;
      expect(proposal.parentElement).toBe(pinnedSlot);
      expect(proposal.hidden).toBe(false);
      expect(scrolled).not.toContain('autonomous-status');
      expect(window.document.getElementById('proposal-approve-btn')!.hasAttribute('disabled')).toBe(false);
      expect(window.document.getElementById('status-row-text')!.textContent!.toLowerCase()).toContain('waiting');

      send(window, { type: 'proposalApprovalResolved', taskId: 'task-1', proposalId: 'proposal-1', decision: 'approved' });
      await settle();
      expect(proposal.parentElement).toBe(timeline);
      expect(proposal.hidden).toBe(false);
      expect(proposal.dataset.inlineApprovalState).toBe('resolved');
      expect(window.document.getElementById('proposal-card-status')!.textContent).toBe('Approved');
      expect((window.document.getElementById('proposal-approve-btn') as HTMLButtonElement).disabled).toBe(true);

      send(window, {
        type: 'mutationApprovalRequest',
        taskId: 'task-1',
        attemptId: 'attempt-1',
        requestId: 'mutation-1',
        operationCount: 1,
        targets: ['src/a.ts'],
        elevatedConfirmationRequired: true,
      });
      const mutation = window.document.getElementById('mutation-approval-card')!;
      expect(mutation.parentElement).toBe(pinnedSlot);
      expect(mutation.hidden).toBe(false);
      expect(window.document.getElementById('mutation-card-title')!.textContent).toContain('Elevated');

      send(window, { type: 'mutationApprovalResolved', taskId: 'task-1', requestId: 'mutation-1', decision: 'denied' });
      await settle();
      expect(mutation.parentElement).toBe(timeline);
      expect(mutation.hidden).toBe(false);
      expect(window.document.getElementById('mutation-card-status')!.textContent).toBe('Denied');
      expect((window.document.getElementById('mutation-approve-btn') as HTMLButtonElement).disabled).toBe(true);

      send(window, { type: 'deliveryApprovalRequest', taskId: 'task-1', attemptId: 'attempt-1' });
      const delivery = window.document.getElementById('delivery-approval-card')!;
      expect(delivery.parentElement).toBe(pinnedSlot);
      expect(delivery.hidden).toBe(false);

      send(window, { type: 'deliveryApprovalResolved', taskId: 'task-1', decision: 'approved' });
      await settle();
      expect(delivery.parentElement).toBe(timeline);
      expect(delivery.hidden).toBe(false);
      expect(delivery.dataset.inlineApprovalState).toBe('resolved');
      expect(delivery.querySelector('.proposal-card-status')?.textContent).toBe('Approved');
      expect((window.document.getElementById('delivery-approve-btn') as HTMLButtonElement).disabled).toBe(true);

      send(window, { type: 'autonomousTaskStarted', taskId: 'task-2', attemptId: 'attempt-2' });
      await settle();
      expect(proposal.hidden).toBe(true);
      expect(mutation.hidden).toBe(true);
      expect(delivery.hidden).toBe(true);
    } finally {
      dom.window.close();
    }
  });

  it('does not create a second approval authority or enable controls', () => {
    const source = read('media/chat-sidebar-ui.js');
    expect(source).not.toContain('.disabled = false');
    expect(source).not.toContain('.disabled = true');
    expect(source).not.toContain("postMessage({ type: 'approve");
    expect(source).not.toContain('MutationObserver');
    expect(source).toMatch(/Approval-card DOM[\s\S]*owned exclusively by chat-autonomous\.js/);
  });

  it('ships the inline behavior in the packaged webview', () => {
    const html = read('media/chat.html');
    const ignore = read('.vscodeignore');
    expect(html).toContain("'chat-sidebar-ui.js'");
    expect(ignore).not.toMatch(/chat-sidebar-ui\.js/);
    expect(ignore).not.toMatch(/^media[\\/]\s*$/m);
  });

  // Regression for a packaged-acceptance failure: the restart scenario
  // asserted the panda label's display text verbatim, which is brittle as
  // the compact panda copy changes. The authoritative signal for "this gate
  // is actionable" is the card's own `data-inline-approval-state` attribute
  // (set by placeCardInline), not the panda label text — so it must read
  // "pending" regardless of what the label shows.
  it('keeps the proposal card\'s inline-approval-state "pending" across panda label updates', async () => {
    const { dom, window } = setupWebview();
    try {
      send(window, { type: 'autonomousTaskStarted', taskId: 'task-1', attemptId: 'attempt-1' });
      send(window, {
        type: 'proposalApprovalRequest',
        taskId: 'task-1',
        attemptId: 'attempt-1',
        proposalId: 'proposal-1',
        version: 1,
        taskSummary: 'Update one file safely.',
        operations: [{ type: 'replace', path: 'src/a.ts', reason: 'Fix the defect.' }],
        validationCommands: [{ kind: 'npm-script', script: 'verify' }],
        warnings: [],
      });

      const proposal = window.document.getElementById('proposal-approval-card')!;
      const pandaLabel = window.document.getElementById('autonomous-panda-label')!;

      // Compact panda copy (set as the last writer by placeCardInline).
      expect(pandaLabel.textContent).toBe('waiting');
      expect(proposal.dataset.inlineApprovalState).toBe('pending');

      // A later status snapshot carrying a pandaState (as happens in
      // production once the gate is already requested) rewrites the display
      // label, but must not change the authoritative gate state.
      send(window, {
        type: 'autonomousTaskStatus',
        taskId: 'task-1',
        attemptId: 'attempt-1',
        state: 'waiting_for_proposal_approval',
        pandaState: 'waiting_for_delivery_approval',
      });

      expect(pandaLabel.textContent).toBe('waiting');
      expect(proposal.dataset.inlineApprovalState).toBe('pending');
    } finally {
      dom.window.close();
    }
  });
});
