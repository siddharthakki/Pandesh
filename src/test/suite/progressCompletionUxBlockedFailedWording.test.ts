import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { TextDecoder, TextEncoder } from 'util';
import { JSDOM } from 'jsdom';

/**
 * Progress & Completion UX V1 — Step 9 closure pass (blocked/failed wording).
 *
 * `chat-everyday.js#humanizeClassification` previously mapped only a handful
 * of the classifications Core/M15 can actually produce
 * (`GovernedCodingExecutionStatus`, `classifyRuntimeError`, and the explicit
 * overrides in `M15AutonomousRuntime.ts`). Every unmapped classification fell
 * through to rendering the raw `failure.message` as the blocker card's
 * PRIMARY headline — exactly the "raw exception text as the primary message"
 * Step 9 forbids. This proves the previously-missing classifications
 * (including `diff_review_rejected`, the milestone's own governed-rejection
 * example, and the workspace/git "blocked safely" family) now resolve to a
 * plain, truthful headline instead.
 */

const root = path.join(__dirname, '..', '..', '..');
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), 'utf8');

function send(window: JSDOM['window'], data: Record<string, unknown>): void {
  window.dispatchEvent(new window.MessageEvent('message', { data }));
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await new Promise(resolve => setTimeout(resolve, 0));
}

function setupWebview() {
  const dom = new JSDOM(read('media/chat.html'), {
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    url: 'https://karkedikha.test/',
  });
  const { window } = dom;
  const vscodeApi = { postMessage() {}, getState: () => ({}), setState() {} };
  Object.defineProperty(window, '__ollamaAgentVsCodeApi', { value: vscodeApi });
  Object.defineProperty(window, 'acquireVsCodeApi', { value: () => vscodeApi });
  Object.defineProperty(window, '__pandaBaseUri', { value: '' });
  Object.defineProperty(window, 'TextEncoder', { value: TextEncoder });
  Object.defineProperty(window, 'TextDecoder', { value: TextDecoder });
  Object.defineProperty(window, 'matchMedia', {
    value: () => ({ matches: true, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }),
  });
  window.HTMLElement.prototype.scrollIntoView = function scrollIntoView() {};
  window.eval(read('media/chat-autonomous.js'));
  window.eval(read('media/chat-sidebar-ui.js'));
  window.eval(read('media/everyday-presentation.js'));
  window.eval(read('media/chat-everyday.js'));
  send(window, { type: 'workspaceRestorationResolved', workspaceIdentity: 'test-workspace' });
  return { dom, window };
}

async function blockerHeadline(
  window: JSDOM['window'],
  taskId: string,
  state: 'blocked' | 'failed',
  failure: { classification: string; message: string },
): Promise<string | null | undefined> {
  send(window, { type: 'autonomousTaskStarted', taskId, attemptId: taskId });
  send(window, { type: 'autonomousTaskStatus', taskId, attemptId: taskId, state, goal: 'Fix the registration bug', failure, events: [] });
  await settle();
  return window.document.getElementById('everyday-outcome-card')?.querySelector('.everyday-outcome-headline')?.textContent;
}

describe('Progress & Completion UX V1 — humanized blocked/failed classifications (Step 9)', () => {
  it('renders the milestone\'s own example: a deterministic host-review rejection reads as a governed outcome, not a crash', async () => {
    const { dom, window } = setupWebview();
    try {
      const headline = await blockerHeadline(window, 'task-review', 'blocked', {
        classification: 'diff_review_rejected',
        message: 'ReviewRejectedError: host review returned score 0.12 at commit abc123',
      });
      expect(headline).toContain('The implementation did not pass final review');
      // The raw diagnostic never appears as the primary message.
      expect(headline).not.toContain('ReviewRejectedError');
      expect(headline).not.toContain('abc123');
    } finally {
      dom.window.close();
    }
  });

  it('explains workspace_dirty-shaped blocks and states that the user\'s work was preserved', async () => {
    const { dom, window } = setupWebview();
    try {
      const headline = await blockerHeadline(window, 'task-dirty', 'blocked', {
        classification: 'workspace_delivery_conflict',
        message: 'workspace_delivery_conflict: workspace_dirty',
      });
      // Headline wording is pinned by autonomousUxTruthfulness.test.ts; the preserved-work statement now lives in the card's evidence rows.      expect(headline).toContain('working repository contains unrelated changes');      expect(window.document.getElementById('everyday-outcome-card')?.textContent).toContain('Untouched');
      expect(headline).not.toContain('workspace_delivery_conflict');
    } finally {
      dom.window.close();
    }
  });

  it('never falls back to raw exception text as the primary headline for any known classification', async () => {
    const { dom, window } = setupWebview();
    try {
      const classifications = [
        'proposal_unavailable', 'invalid_proposal', 'execution_rejected', 'graph_incomplete',
        'readiness_blocked', 'file_missing_at_binding', 'create_target_exists',
        'workspace_changed_after_review', 'dirty_document_blocked', 'workspace_lease_held',
        'validation_side_effect_detected', 'git_state_changed', 'approval_replay_rejected',
        'snapshot_read_failed', 'path_rejected', 'duplicate_proposal_target', 'mutation_failed',
        'execution_profile_missing', 'execution_profile_invalid', 'delivery_diff_changed',
        'delivery_superseded_after_commit', 'core_authority_missing', 'task_input_integrity_mismatch',
        'worktree_identity_mismatch', 'runtime_error',
      ];
      let index = 0;
      for (const classification of classifications) {
        index += 1;
        const rawMessage = `RAW_DIAGNOSTIC_MARKER_${classification}`;
        const headline = await blockerHeadline(window, `task-${index}`, 'blocked', { classification, message: rawMessage });
        expect(headline, `classification "${classification}" leaked raw text as its headline`).not.toContain(rawMessage);
        expect(headline, `classification "${classification}" has no humanized headline`).not.toBe('Task blocked: the task could not continue.');
      }
    } finally {
      dom.window.close();
    }
  });

  it('still surfaces the raw diagnostic, bounded, as a secondary "What failed" row once the headline is humanized', async () => {
    const { dom, window } = setupWebview();
    try {
      send(window, { type: 'autonomousTaskStarted', taskId: 'task-detail', attemptId: 'task-detail' });
      send(window, {
        type: 'autonomousTaskStatus',
        taskId: 'task-detail',
        attemptId: 'task-detail',
        state: 'blocked',
        goal: 'Fix the registration bug',
        failure: { classification: 'runtime_error', message: 'ENOENT: no such file or directory' },
        events: [],
      });
      await settle();
      const evidence = window.document.getElementById('everyday-outcome-card')?.textContent ?? '';
      expect(evidence).toContain('An unexpected internal error stopped the task');
      expect(evidence).toContain('ENOENT');
    } finally {
      dom.window.close();
    }
  });
});
