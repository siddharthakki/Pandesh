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
  const posted: Array<Record<string, unknown>> = [];
  const vscodeApi = {
    postMessage(msg: Record<string, unknown>) { posted.push(msg); },
    getState: () => ({}),
    setState() {},
  };
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
  window.eval(read('media/chat-fixes.js'));
  send(window, { type: 'workspaceRestorationResolved', workspaceIdentity: 'test-workspace' });
  return { dom, window, posted };
}

describe('Autonomous UX Truthfulness & Progress Presentation', () => {
  describe('1. Progress Presentation', () => {
    it('projects runtime events into concise visible conversational progress messages', async () => {
      const { dom, window } = setupWebview();
      try {
        const taskId = 'task-conv-prog-1';
        send(window, { type: 'autonomousTaskStarted', taskId, attemptId: taskId, autonomyMode: 'supervised' });
        send(window, {
          type: 'autonomousTaskStatus',
          taskId,
          attemptId: taskId,
          state: 'running',
          goal: 'Test pricing discount',
          autonomyMode: 'supervised',
          events: [
            { seq: 1, rawProgress: 'lightweight_proposal_execution tier=local model=qwen' },
            { seq: 2, rawProgress: 'graph_stage_completed stage=repository-analyst index=1/5 durationMs=1200' },
            { seq: 3, rawProgress: 'graph_stage_started stage=planner index=2/5 model=qwen provider=ollama' },
            { seq: 4, rawProgress: 'proposal_ready' },
          ],
        });
        await settle();

        const convProgress = window.document.getElementById('autonomous-conversational-progress');
        expect(convProgress).toBeTruthy();
        const text = convProgress?.textContent || '';
        expect(text).toContain('Reviewing the relevant files…');
        expect(text).toContain('✓ Found the relevant implementation and tests');
        expect(text).toContain('Preparing the change…');
        expect(text).toContain('✓ Proposal ready');
      } finally {
        dom.window.close();
      }
    });

    it('keeps important progress visible while Details is collapsed', async () => {
      const { dom, window } = setupWebview();
      try {
        const taskId = 'task-details-collapsed';
        send(window, { type: 'autonomousTaskStarted', taskId, attemptId: taskId, autonomyMode: 'supervised' });
        send(window, {
          type: 'autonomousTaskStatus',
          taskId,
          attemptId: taskId,
          state: 'running',
          goal: 'Test pricing discount',
          autonomyMode: 'supervised',
          events: [{ seq: 1, rawProgress: 'proposal_ready' }],
        });
        await settle();

        const details = window.document.getElementById('kd-task-details') as HTMLDetailsElement;
        expect(details).toBeTruthy();
        expect(details?.open).toBe(false);

        // Conversational progress container is NOT inside kd-task-details
        const convProgress = window.document.getElementById('autonomous-conversational-progress');
        expect(details?.contains(convProgress)).toBe(false);
        expect(convProgress?.textContent).toContain('✓ Proposal ready');
      } finally {
        dom.window.close();
      }
    });

    it('does not render raw diagnostic fields in main conversational progress', async () => {
      const { dom, window } = setupWebview();
      try {
        const taskId = 'task-no-diag';
        send(window, { type: 'autonomousTaskStarted', taskId, attemptId: taskId, autonomyMode: 'supervised' });
        send(window, {
          type: 'autonomousTaskStatus',
          taskId,
          attemptId: taskId,
          state: 'running',
          goal: 'Test pricing discount',
          autonomyMode: 'supervised',
          events: [
            {
              seq: 1,
              eventId: 'evt-12345-abcdef',
              kind: 'lightweight_proposal_execution',
              rawProgress: 'approval_requested gate=proposal actor=user proposalId=sha256:abcd1234ef5678 version=1',
              timestamp: 1710000000000,
            },
          ],
        });
        await settle();

        const convProgress = window.document.getElementById('autonomous-conversational-progress');
        const text = convProgress?.textContent || '';
        expect(text).not.toContain('sha256:abcd1234ef5678');
        expect(text).not.toContain('evt-12345-abcdef');
        expect(text).not.toContain('1710000000000');
        expect(text).not.toContain('proposalId');
      } finally {
        dom.window.close();
      }
    });

    it('renders repair cycle failure → repair in progress → rerun clearly', async () => {
      const { dom, window } = setupWebview();
      try {
        const taskId = 'task-repair-cycle';
        send(window, { type: 'autonomousTaskStarted', taskId, attemptId: taskId, autonomyMode: 'supervised' });
        send(window, {
          type: 'autonomousTaskStatus',
          taskId,
          attemptId: taskId,
          state: 'running',
          goal: 'Test pricing discount',
          autonomyMode: 'supervised',
          events: [
            { seq: 1, rawProgress: 'validation_command_started index=1/1 command=pytest tests/test_pricing.py' },
            { seq: 2, rawProgress: 'validation_completed commands=1 failed=1' },
            { seq: 3, rawProgress: 'validation_repair_started cycle=1/2' },
            { seq: 4, rawProgress: 'proposal_regenerated operations=1' },
            { seq: 5, rawProgress: 'validation_repair_completed cycle=1/2 failed=0' },
          ],
        });
        await settle();

        const convProgress = window.document.getElementById('autonomous-conversational-progress');
        const text = convProgress?.textContent || '';
        expect(text).toContain('Running pytest tests/test_pricing.py…');
        expect(text).toContain('✗ Validation failed');
        expect(text).toContain('Repairing the failing validation — attempt 1 of 2…');
        expect(text).toContain('✓ Repair prepared');
        expect(text).toContain('Running validation again…');
        expect(text).toContain('✓ Validation passed');
      } finally {
        dom.window.close();
      }
    });
  });

  describe('2. Completion Semantics & Delivery', () => {
    it('validated task-branch commit before Apply displays "Ready to apply", NOT "Completed" or "Ho gaya boss."', async () => {
      const { dom, window } = setupWebview();
      try {
        const taskId = 'task-ready-apply';
        send(window, { type: 'autonomousTaskStarted', taskId, attemptId: taskId, autonomyMode: 'supervised' });
        send(window, {
          type: 'autonomousTaskStatus',
          taskId,
          attemptId: taskId,
          state: 'waiting_for_delivery_approval',
          goal: 'Test pricing discount',
          autonomyMode: 'supervised',
          branchName: 'main',
          deliveryEvidence: {
            taskBranchName: 'karkedikha/task-ready-apply',
            deliveryCommitSha: 'abc12345',
            changedFileCount: 1,
            validationPassCount: 2,
          },
          diffReview: { verdict: 'pass' },
        });
        await settle();

        const taskLine = window.document.getElementById('kd-task-line')?.textContent || '';
        expect(taskLine).toBe('Ready to apply');
        expect(taskLine).not.toContain('Completed');
        expect(taskLine).not.toContain('Ho gaya boss');

        const deliveryCard = window.document.getElementById('delivery-approval-card');
        expect(deliveryCard).toBeTruthy();
        expect(deliveryCard?.hidden).toBe(false);
        const applyBtn = window.document.getElementById('delivery-approve-btn') as HTMLButtonElement;
        expect(applyBtn).toBeTruthy();
        expect(applyBtn?.disabled).toBe(false);
        expect(applyBtn?.textContent).toContain('Apply');

        const evidence = window.document.getElementById('delivery-evidence')?.textContent || '';
        expect(evidence).toContain('✓ Change prepared');
        expect(evidence).toContain('✓ 2 checks passed');
        expect(evidence).toContain('✓ Diff review passed');
        expect(evidence).toContain('Ready to apply to your working files');
      } finally {
        dom.window.close();
      }
    });

    it('successful Apply transitions to "Completed" with applied evidence', async () => {
      const { dom, window } = setupWebview();
      try {
        const taskId = 'task-completed-apply';
        send(window, { type: 'autonomousTaskStarted', taskId, attemptId: taskId, autonomyMode: 'supervised' });
        send(window, {
          type: 'autonomousTaskStatus',
          taskId,
          attemptId: taskId,
          state: 'completed',
          goal: 'Test pricing discount',
          autonomyMode: 'supervised',
          branchName: 'main',
          approvedScopePaths: ['tests/test_pricing.py'],
          deliveryCommitSha: 'fedcba987654',
          validationTotals: { commands: 2, passed: 2, failed: 0 },
          deliveryEvidence: {
            taskBranchName: 'karkedikha/task-completed-apply',
            deliveryCommitSha: 'fedcba987654',
            changedFileCount: 1,
            validationPassCount: 2,
          },
          diffReview: { verdict: 'pass' },
        });
        await settle();

        const taskLine = window.document.getElementById('kd-task-line')?.textContent || '';
        expect(taskLine).toBe('Completed');

        const convProgress = window.document.getElementById('autonomous-conversational-progress');
        expect(convProgress?.textContent).toContain('✓ Applied to main');

        const outcomeCard = window.document.getElementById('everyday-outcome-card');
        expect(outcomeCard).toBeTruthy();
        const outcomeText = outcomeCard?.textContent || '';
        expect(outcomeText).toContain('Completed');
        expect(outcomeText).toContain('✓ Changed 1 file');
        expect(outcomeText).toContain('✓ 2 checks passed');
        expect(outcomeText).toContain('✓ Applied to main');
      } finally {
        dom.window.close();
      }
    });

    it('Apply failure with workspace conflict stays blocked and is NOT Completed', async () => {
      const { dom, window } = setupWebview();
      try {
        const taskId = 'task-apply-failure';
        send(window, { type: 'autonomousTaskStarted', taskId, attemptId: taskId, autonomyMode: 'supervised' });
        send(window, {
          type: 'autonomousTaskStatus',
          taskId,
          attemptId: taskId,
          state: 'blocked',
          goal: 'Test pricing discount',
          autonomyMode: 'supervised',
          branchName: 'main',
          failure: {
            classification: 'workspace_delivery_conflict',
            message: 'workspace_delivery_conflict: working repository contains unrelated changes',
          },
          deliveryEvidence: {
            taskBranchName: 'karkedikha/task-apply-failure',
            deliveryCommitSha: '11223344',
            changedFileCount: 1,
            validationPassCount: 2,
          },
          diffReview: { verdict: 'pass' },
        });
        await settle();

        const taskLine = window.document.getElementById('kd-task-line')?.textContent || '';
        expect(taskLine).not.toBe('Completed');

        const outcomeCard = window.document.getElementById('everyday-outcome-card');
        expect(outcomeCard?.classList.contains('is-blocked')).toBe(true);
        const text = outcomeCard?.textContent || '';
        expect(text).toContain('Task blocked: the verified change could not be safely applied because the working repository contains unrelated changes.');
        expect(text).toContain('✓ Change prepared');
        expect(text).toContain('✓ Validation passed');
        expect(text).toContain('✓ Diff review passed');
        expect(text).toContain('Untouched');
        expect(text).toContain('Review or clean the conflicting workspace changes, then retry delivery.');
      } finally {
        dom.window.close();
      }
    });

    it('blocked before any proposal or delivery never looks delivery-ready', async () => {
      const { dom, window } = setupWebview();
      try {
        const taskId = 'task-blocked-before-proposal';
        send(window, { type: 'autonomousTaskStarted', taskId, attemptId: taskId, autonomyMode: 'supervised' });
        send(window, {
          type: 'autonomousTaskStatus',
          taskId,
          attemptId: taskId,
          state: 'blocked',
          goal: 'Build a small web application',
          autonomyMode: 'supervised',
          branchName: 'main',
          destinationBranch: 'main',
          failure: { classification: 'runtime_error', message: 'The model did not return a usable proposal.' },
          deliveryEvidence: { changedFileCount: 0, destinationBranch: 'main', deliveryReached: false },
        });
        await settle();

        const taskLine = window.document.getElementById('kd-task-line')?.textContent || '';
        expect(taskLine).not.toBe('Ready to apply');
        expect(taskLine).not.toBe('Completed');
        const evidence = window.document.getElementById('delivery-evidence')?.textContent || '';
        expect(evidence).not.toContain('Ready to apply');
        expect(evidence).not.toContain('Change prepared');
        expect(evidence).not.toContain('Applied to');
        const outcome = window.document.getElementById('everyday-outcome-card')?.textContent || '';
        expect(outcome).not.toContain('Ready to apply');
        expect(outcome).not.toContain('Change prepared');
        expect(outcome).not.toContain('Applied to');
        const applyBtn = window.document.getElementById('delivery-approve-btn') as HTMLButtonElement | null;
        const deliveryCard = window.document.getElementById('delivery-approval-card');
        expect(Boolean(deliveryCard?.hidden) || Boolean(applyBtn?.disabled)).toBe(true);
      } finally {
        dom.window.close();
      }
    });

    it('D4 pre-delivery validation failure after Ready to apply ends blocked with destination untouched, not delivered', async () => {
      const { dom, window } = setupWebview();
      try {
        const taskId = 'task-pre-delivery-failure';
        send(window, { type: 'autonomousTaskStarted', taskId, attemptId: taskId, autonomyMode: 'supervised' });
        send(window, {
          type: 'autonomousTaskStatus',
          taskId,
          attemptId: taskId,
          state: 'waiting_for_delivery_approval',
          goal: 'Create exact fixture',
          autonomyMode: 'supervised',
          branchName: 'main',
          deliveryEvidence: { changedFileCount: 1, validationPassCount: 1, taskBranchName: 'forge/task-pre-delivery-failure' },
          diffReview: { verdict: 'pass' },
        });
        await settle();
        send(window, {
          type: 'autonomousTaskStatus',
          taskId,
          attemptId: taskId,
          state: 'blocked',
          goal: 'Create exact fixture',
          autonomyMode: 'supervised',
          branchName: 'main',
          failure: {
            classification: 'pre_delivery_validation_failed',
            message: 'Candidate delivered-state validation failed: npm run exact',
          },
          validationFailure: { commandLabel: 'npm run exact', exitCode: 9 },
          deliveryEvidence: {
            changedFileCount: 1,
            taskBranchName: 'forge/task-pre-delivery-failure',
            deliveryReached: false,
            postDeliveryValidationStatus: 'failed',
          },
          diffReview: { verdict: 'pass' },
        });
        await settle();

        expect(window.document.getElementById('kd-task-line')?.textContent || '').not.toBe('Completed');
        const evidence = window.document.getElementById('delivery-evidence')?.textContent || '';
        expect(evidence).toContain('Delivery not reached');
        expect(evidence).not.toContain('Ready to apply');
        expect(evidence).not.toContain('Applied to');
        const outcome = window.document.getElementById('everyday-outcome-card')?.textContent || '';
        expect(outcome).toContain('the destination was not changed');
        expect(outcome).toContain('npm run exact (exit code 9)');
        expect(outcome).not.toContain('Applied to');
      } finally {
        dom.window.close();
      }
    });
  });

  describe('3. Validation Truthfulness', () => {
    it('renders "Validation passed" only when all checks pass', async () => {
      const { dom, window } = setupWebview();
      try {
        const taskId = 'task-val-all-pass';
        send(window, { type: 'autonomousTaskStarted', taskId, attemptId: taskId, autonomyMode: 'supervised' });
        send(window, {
          type: 'autonomousTaskStatus',
          taskId,
          attemptId: taskId,
          state: 'running',
          goal: 'Run tests',
          autonomyMode: 'supervised',
          events: [
            { seq: 1, rawProgress: 'validation_command_started index=1/2 command=pytest tests/test_pricing.py' },
            { seq: 2, rawProgress: 'validation_command_started index=2/2 command=pytest' },
            { seq: 3, rawProgress: 'validation_completed commands=2 failed=0' },
          ],
        });
        await settle();

        const convProgress = window.document.getElementById('autonomous-conversational-progress');
        const text = convProgress?.textContent || '';
        expect(text).toContain('Running pytest tests/test_pricing.py…');
        expect(text).toContain('Running pytest…');
        expect(text).toContain('✓ Passed');
      } finally {
        dom.window.close();
      }
    });

    it('initial validation failure followed by successful repair shows final success only after rerun', async () => {
      const { dom, window } = setupWebview();
      try {
        const taskId = 'task-val-repair-success';
        send(window, { type: 'autonomousTaskStarted', taskId, attemptId: taskId, autonomyMode: 'supervised' });
        send(window, {
          type: 'autonomousTaskStatus',
          taskId,
          attemptId: taskId,
          state: 'running',
          goal: 'Run tests',
          autonomyMode: 'supervised',
          events: [
            { seq: 1, rawProgress: 'validation_command_started index=1/1 command=pytest tests/test_pricing.py' },
            { seq: 2, rawProgress: 'validation_completed commands=1 failed=1' },
            { seq: 3, rawProgress: 'validation_repair_started cycle=1/2' },
            { seq: 4, rawProgress: 'proposal_regenerated operations=1' },
            { seq: 5, rawProgress: 'validation_repair_completed cycle=1/2 failed=0' },
          ],
        });
        await settle();

        const convProgress = window.document.getElementById('autonomous-conversational-progress');
        const text = convProgress?.textContent || '';
        const failIdx = text.indexOf('✗ Validation failed');
        const rerunIdx = text.indexOf('Running validation again…');
        const passIdx = text.indexOf('✓ Validation passed');
        expect(failIdx).toBeGreaterThanOrEqual(0);
        expect(rerunIdx).toBeGreaterThan(failIdx);
        expect(passIdx).toBeGreaterThan(rerunIdx);
      } finally {
        dom.window.close();
      }
    });

    it('final validation failure blocker never claims validation passed', async () => {
      const { dom, window } = setupWebview();
      try {
        const taskId = 'task-val-failed-blocker';
        send(window, { type: 'autonomousTaskStarted', taskId, attemptId: taskId, autonomyMode: 'supervised' });
        send(window, {
          type: 'autonomousTaskStatus',
          taskId,
          attemptId: taskId,
          state: 'blocked',
          goal: 'Assert percentage_discount(100, 15) == 85.00',
          autonomyMode: 'supervised',
          failure: {
            classification: 'validation_failed',
            message: 'Command failed with exit code 1: pytest tests/test_pricing.py',
          },
          validationFailure: {
            commandLabel: 'pytest tests/test_pricing.py',
            exitCode: 1,
          },
          validationTotals: { commands: 1, passed: 0, failed: 1 },
          resolvedGates: { proposal: true, mutation: true },
          events: [
            { seq: 1, rawProgress: 'validation_command_started index=1/1 command=pytest tests/test_pricing.py' },
            { seq: 2, rawProgress: 'validation_completed commands=1 failed=1' },
          ],
        });
        await settle();

        const outcomeCard = window.document.getElementById('everyday-outcome-card');
        const text = outcomeCard?.textContent || '';
        expect(text).toContain('Task blocked: validation failed.');
        expect(text).toContain('What completed');
        expect(text).not.toContain('validation passed');
        expect(text).not.toContain('Validation passed');
        expect(text).toContain('What failed');
        expect(text).toContain('✗ pytest tests/test_pricing.py (exit code 1)');
        expect(text).toContain('Your repository');
        expect(text).toContain('Untouched');
        expect(text).toContain('Next step');
        expect(text).toContain('Review the validation failure or provide guidance.');
      } finally {
        dom.window.close();
      }
    });

    it('a stopped validation repair after an applied change never says the change failed to apply and states where the changed files live', async () => {
      const { dom, window } = setupWebview();
      try {
        const taskId = 'task-val-repair-unavailable';
        send(window, { type: 'autonomousTaskStarted', taskId, attemptId: taskId, autonomyMode: 'supervised' });
        send(window, {
          type: 'autonomousTaskStatus',
          taskId,
          attemptId: taskId,
          state: 'blocked',
          goal: 'Fix the failing discount calculation',
          autonomyMode: 'supervised',
          failure: {
            classification: 'validation_failed',
            message: 'Validation repair cycles exhausted (2 of 2) (Validation or quality gate blocked delivery progression.)',
            recovery: { terminalState: 'BLOCKED_RESUMABLE', cause: 'format_failure', subcode: 'validation_repair_unavailable', decisionSeq: 4 },
          },
          validationFailure: { commandLabel: 'npm test', exitCode: 1 },
          validationTotals: { commands: 1, passed: 0, failed: 1 },
          resolvedGates: { proposal: true, mutation: true },
          events: [],
        });
        await settle();

        const text = window.document.getElementById('everyday-outcome-card')?.textContent || '';
        expect(text).not.toContain('Applying the approved change failed');
        expect(text).not.toContain('so no changes were made');
        expect(text).toContain('Approved changes applied in isolated worktree');
        expect(text).toContain('✗ npm test (exit code 1)');
        expect(text).toContain('The approved change was applied, but validation still fails');
        expect(text).toContain('remain only in the isolated worktree');
      } finally {
        dom.window.close();
      }
    });
  });

  describe('4. Approval Projection & Actor Attribution', () => {
    it('supervised proposal approval displays exactly one user-visible resolution', async () => {
      const { dom, window } = setupWebview();
      try {
        const taskId = 'task-supervised-prop';
        send(window, { type: 'autonomousTaskStarted', taskId, attemptId: taskId, autonomyMode: 'supervised' });
        send(window, {
          type: 'autonomousTaskStatus',
          taskId,
          attemptId: taskId,
          state: 'waiting_for_proposal_approval',
          goal: 'Supervised task',
          autonomyMode: 'supervised',
          events: [
            { seq: 1, rawProgress: 'approval_waiting gate=proposal actor=user' },
          ],
        });
        await settle();

        // Simulate resolution arriving via status and event
        send(window, {
          type: 'autonomousTaskStatus',
          taskId,
          attemptId: taskId,
          state: 'running',
          goal: 'Supervised task',
          autonomyMode: 'supervised',
          resolvedGates: { proposal: true },
          events: [
            { seq: 2, rawProgress: 'approval_approved gate=proposal actor=user' },
          ],
        });
        // Simulate extension posting proposalApprovalResolved
        send(window, {
          type: 'proposalApprovalResolved',
          taskId,
          proposalId: 'p-1',
          decision: 'approved',
          actor: 'user',
        });
        await settle();

        const convProgress = window.document.getElementById('autonomous-conversational-progress');
        const matches = (convProgress?.textContent || '').match(/Proposal approved/g);
        expect(matches?.length).toBe(1);
      } finally {
        dom.window.close();
      }
    });

    it('supervised mutation approval displays exactly one user-visible resolution', async () => {
      const { dom, window } = setupWebview();
      try {
        const taskId = 'task-supervised-mut';
        send(window, { type: 'autonomousTaskStarted', taskId, attemptId: taskId, autonomyMode: 'supervised' });
        send(window, {
          type: 'autonomousTaskStatus',
          taskId,
          attemptId: taskId,
          state: 'waiting_for_mutation_approval',
          goal: 'Supervised mutation',
          autonomyMode: 'supervised',
          events: [
            { seq: 1, rawProgress: 'approval_waiting gate=mutation actor=user' },
          ],
        });
        await settle();

        send(window, {
          type: 'autonomousTaskStatus',
          taskId,
          attemptId: taskId,
          state: 'running',
          goal: 'Supervised mutation',
          autonomyMode: 'supervised',
          resolvedGates: { mutation: true },
          events: [
            { seq: 2, rawProgress: 'approval_approved gate=mutation actor=user' },
          ],
        });
        send(window, {
          type: 'mutationApprovalResolved',
          taskId,
          requestId: 'req-1',
          decision: 'approved',
          actor: 'user',
        });
        await settle();

        const convProgress = window.document.getElementById('autonomous-conversational-progress');
        const matches = (convProgress?.textContent || '').match(/Mutation approved/g);
        expect(matches?.length).toBe(1);
      } finally {
        dom.window.close();
      }
    });

    it('Hands-off proposal and mutation auto-authorization attributes actor to hands_off_policy and has no duplicate Actor: user', async () => {
      const { dom, window } = setupWebview();
      try {
        const taskId = 'task-hands-off-actor';
        send(window, { type: 'autonomousTaskStarted', taskId, attemptId: taskId, autonomyMode: 'hands_off' });
        send(window, {
          type: 'autonomousTaskStatus',
          taskId,
          attemptId: taskId,
          state: 'running',
          goal: 'Hands-off task',
          autonomyMode: 'hands_off',
          resolvedGates: { proposal: true, mutation: true },
          events: [
            { seq: 1, rawProgress: 'approval_auto_authorized gate=proposal policy=hands_off' },
            { seq: 2, rawProgress: 'approval_approved gate=proposal actor=hands_off_policy' },
            { seq: 3, rawProgress: 'approval_auto_authorized gate=mutation policy=hands_off' },
            { seq: 4, rawProgress: 'approval_approved gate=mutation actor=hands_off_policy' },
          ],
        });
        await settle();

        const convProgress = window.document.getElementById('autonomous-conversational-progress');
        const text = convProgress?.textContent || '';
        expect(text).toContain('✓ Proposal automatically authorized');
        expect(text).toContain('✓ Mutation automatically authorized');
        expect(text).not.toContain('Proposal approved');
        expect(text).not.toContain('Mutation approved');

        // Timeline in Details contains hands_off_policy and no Actor: user
        const timeline = window.document.getElementById('autonomous-timeline');
        const timelineText = timeline?.textContent || '';
        expect(timelineText).not.toContain('Actor: user');
      } finally {
        dom.window.close();
      }
    });
  });

  describe('5. Delivery Authorization vs Apply State Flow', () => {
    it('delivery authorization leads to verified task-branch commit state and remains "Ready to apply"', async () => {
      const { dom, window } = setupWebview();
      try {
        const taskId = 'task-delivery-flow';
        send(window, { type: 'autonomousTaskStarted', taskId, attemptId: taskId, autonomyMode: 'supervised' });
        send(window, {
          type: 'autonomousTaskStatus',
          taskId,
          attemptId: taskId,
          state: 'waiting_for_delivery_approval',
          goal: 'Delivery state flow',
          autonomyMode: 'supervised',
          branchName: 'main',
          deliveryEvidence: {
            taskBranchName: 'karkedikha/task-delivery-flow',
            deliveryCommitSha: '99887766',
            changedFileCount: 1,
            validationPassCount: 1,
          },
          diffReview: { verdict: 'pass' },
        });
        await settle();

        expect(window.document.getElementById('kd-task-line')?.textContent).toBe('Ready to apply');
        const convProgress = window.document.getElementById('autonomous-conversational-progress');
        expect(convProgress?.textContent).toContain('Ready to apply');
        expect(convProgress?.textContent).not.toContain('✓ Applied to main');
      } finally {
        dom.window.close();
      }
    });

    it('clicking Apply and completing transitions to Completed with applied evidence', async () => {
      const { dom, window, posted } = setupWebview();
      try {
        const taskId = 'task-delivery-click-apply';
        send(window, { type: 'autonomousTaskStarted', taskId, attemptId: taskId, autonomyMode: 'supervised' });
        send(window, {
          type: 'autonomousTaskStatus',
          taskId,
          attemptId: taskId,
          state: 'waiting_for_delivery_approval',
          goal: 'Delivery state flow',
          autonomyMode: 'supervised',
          branchName: 'main',
          deliveryEvidence: {
            taskBranchName: 'karkedikha/task-delivery-click-apply',
            deliveryCommitSha: '99887766',
            changedFileCount: 1,
            validationPassCount: 1,
          },
          diffReview: { verdict: 'pass' },
        });
        await settle();

        const applyBtn = window.document.getElementById('delivery-approve-btn') as HTMLButtonElement;
        applyBtn.click();
        expect(posted.some(p => p.type === 'approveAutonomousDelivery' && p.taskId === taskId)).toBe(true);

        send(window, {
          type: 'autonomousTaskStatus',
          taskId,
          attemptId: taskId,
          state: 'completed',
          goal: 'Delivery state flow',
          autonomyMode: 'supervised',
          branchName: 'main',
          approvedScopePaths: ['tests/test_pricing.py'],
          deliveryCommitSha: '99887766',
          validationTotals: { commands: 1, passed: 1, failed: 0 },
        });
        await settle();

        expect(window.document.getElementById('kd-task-line')?.textContent).toBe('Completed');
        const convProgress = window.document.getElementById('autonomous-conversational-progress');
        expect(convProgress?.textContent).toContain('✓ Applied to main');
      } finally {
        dom.window.close();
      }
    });

    it('distinguishes task branch from destination branch and never reports Applied to forge task branch', async () => {
      const { dom, window } = setupWebview();
      try {
        const taskId = 'task-destination-branch-truthfulness';
        const taskBranch = 'forge/att_110ebebc-4d6b-41bd-b89c-cc646a687d52';
        const destinationBranch = 'main';
        const deliverySha = 'a1e3f5399887766';

        send(window, { type: 'autonomousTaskStarted', taskId, attemptId: taskId, autonomyMode: 'supervised' });

        // Phase 1: Verified commit created on task branch -> Ready to apply to main
        send(window, {
          type: 'autonomousTaskStatus',
          taskId,
          attemptId: taskId,
          state: 'waiting_for_delivery_approval',
          goal: 'Add regression test in tests/test_pricing.py',
          autonomyMode: 'supervised',
          destinationBranch,
          taskBranchName: taskBranch,
          branchName: taskBranch, // even if legacy branchName was task branch
          deliveryEvidence: {
            destinationBranch,
            taskBranchName: taskBranch,
            deliveryCommitSha: deliverySha,
            changedFileCount: 1,
            validationPassCount: 1,
          },
          diffReview: { verdict: 'pass' },
        });
        await settle();

        // Must show "Ready to apply to your working files" and distinguish task branch
        const evidenceEl = window.document.getElementById('delivery-evidence');
        expect(evidenceEl?.textContent).toContain('Ready to apply to your working files');
        expect(evidenceEl?.textContent).toContain(`Task branch: ${taskBranch}`);
        expect(evidenceEl?.textContent).toContain('Verified commit: a1e3f53');
        expect(evidenceEl?.textContent).not.toContain(`Applied to ${taskBranch}`);
        expect(evidenceEl?.textContent).not.toContain(`Applied to ${destinationBranch}`);

        // Phase 2: Apply succeeds -> ✓ Applied to main, completed
        send(window, {
          type: 'autonomousTaskStatus',
          taskId,
          attemptId: taskId,
          state: 'completed',
          goal: 'Add regression test in tests/test_pricing.py',
          autonomyMode: 'supervised',
          destinationBranch,
          taskBranchName: taskBranch,
          branchName: taskBranch,
          approvedScopePaths: ['tests/test_pricing.py'],
          deliveryCommitSha: deliverySha,
          deliveryEvidence: {
            destinationBranch,
            taskBranchName: taskBranch,
            deliveryCommitSha: deliverySha,
            changedFileCount: 1,
            validationPassCount: 1,
          },
          validationTotals: { commands: 1, passed: 1, failed: 0 },
        });
        await settle();

        expect(window.document.getElementById('kd-task-line')?.textContent).toBe('Completed');

        const updatedEvidenceEl = window.document.getElementById('delivery-evidence');
        // User-visible evidence must say "✓ Applied to main", never "Applied to forge/..."
        expect(updatedEvidenceEl?.textContent).toContain('✓ Applied to main');
        expect(updatedEvidenceEl?.textContent).toContain(`Task branch: ${taskBranch}`);
        expect(updatedEvidenceEl?.textContent).toContain('Verified commit: a1e3f53');
        expect(updatedEvidenceEl?.textContent).not.toContain(`Applied to ${taskBranch}`);

        // Conversational progress must report "✓ Applied to main", not task branch
        const convProgress = window.document.getElementById('autonomous-conversational-progress');
        expect(convProgress?.textContent).toContain('✓ Applied to main');
        expect(convProgress?.textContent).not.toContain(`Applied to ${taskBranch}`);
      } finally {
        dom.window.close();
      }
    });

    it('displays a non-main destination branch truthfully and never invents main', async () => {
      const { dom, window } = setupWebview();
      try {
        const taskId = 'task-non-main-destination-truth';
        const taskBranch = 'forge/att_99887766-5544-3322-1100-aabbccddeeff';
        const destinationBranch = 'dev/current';
        const deliverySha = 'e7f8a9b0c1d2e3f';

        send(window, { type: 'autonomousTaskStarted', taskId, attemptId: taskId, autonomyMode: 'supervised' });

        send(window, {
          type: 'autonomousTaskStatus',
          taskId,
          attemptId: taskId,
          state: 'completed',
          goal: 'Add targeted non-main branch test',
          autonomyMode: 'supervised',
          destinationBranch,
          taskBranchName: taskBranch,
          branchName: destinationBranch,
          approvedScopePaths: ['src/feature.ts'],
          deliveryCommitSha: deliverySha,
          deliveryEvidence: {
            destinationBranch,
            taskBranchName: taskBranch,
            deliveryCommitSha: deliverySha,
            changedFileCount: 1,
            validationPassCount: 1,
          },
          validationTotals: { commands: 1, passed: 1, failed: 0 },
        });
        await settle();

        expect(window.document.getElementById('kd-task-line')?.textContent).toBe('Completed');

        const updatedEvidenceEl = window.document.getElementById('delivery-evidence');
        // User-visible evidence must say "✓ Applied to dev/current", never "Applied to main" or "Applied to forge/..."
        expect(updatedEvidenceEl?.textContent).toContain('✓ Applied to dev/current');
        expect(updatedEvidenceEl?.textContent).toContain(`Task branch: ${taskBranch}`);
        expect(updatedEvidenceEl?.textContent).toContain('Verified commit: e7f8a9b');
        expect(updatedEvidenceEl?.textContent).not.toContain('Applied to main');
        expect(updatedEvidenceEl?.textContent).not.toContain(`Applied to ${taskBranch}`);

        // Conversational progress must report "✓ Applied to dev/current", never "Applied to main" or task branch
        const convProgress = window.document.getElementById('autonomous-conversational-progress');
        expect(convProgress?.textContent).toContain('✓ Applied to dev/current');
        expect(convProgress?.textContent).not.toContain('Applied to main');
        expect(convProgress?.textContent).not.toContain(`Applied to ${taskBranch}`);
      } finally {
        dom.window.close();
      }
    });
  });
});

