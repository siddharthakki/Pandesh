import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  canAutoCleanup,
  classifyCdpClosure,
  hasStalled,
  compareSourceCheckout,
  buildCleanupPlan,
  isTerminalTaskState,
} from '../../acceptance/HarnessLifecycle';

describe('HarnessLifecycle', () => {
  it('does not allow cleanup while a QuickPick/modal is waiting for a human', () => {
    expect(
      canAutoCleanup({ awaitingHumanApproval: true, taskState: undefined, explicitCancel: false }),
    ).toBe(false);
    expect(
      canAutoCleanup({ awaitingHumanApproval: true, taskState: 'waiting_for_delivery_approval', explicitCancel: false }),
    ).toBe(false);
  });

  it('never reports a stall while awaiting human approval, no matter how much time has passed', () => {
    expect(
      hasStalled({ awaitingHumanApproval: true, lastProgressAtMs: 0, nowMs: 1000 * 60 * 60 * 24, inactivityTimeoutMs: 1000 }),
    ).toBe(false);
  });

  it('reports a stall only once true per-stage inactivity is exceeded and no human gate is open', () => {
    expect(
      hasStalled({ awaitingHumanApproval: false, lastProgressAtMs: 0, nowMs: 500, inactivityTimeoutMs: 1000 }),
    ).toBe(false);
    expect(
      hasStalled({ awaitingHumanApproval: false, lastProgressAtMs: 0, nowMs: 1500, inactivityTimeoutMs: 1000 }),
    ).toBe(true);
  });

  it('classifies CDP closure as vscode_process_exited when the child process has exited, and records exit code/signal', () => {
    const result = classifyCdpClosure({ childExited: true, childExitCode: 0, childSignal: null });
    expect(result.kind).toBe('vscode_process_exited');
    expect(result.recoverable).toBe(false);
    expect(result.detail).toContain('code=0');
  });

  it('classifies CDP closure as a recoverable transport-only closure when the child process is still alive', () => {
    const result = classifyCdpClosure({ childExited: false, childExitCode: null, childSignal: null });
    expect(result.kind).toBe('cdp_transport_closed');
    expect(result.recoverable).toBe(true);
  });

  it('a successful terminal task state (with no pending human gate) permits controlled shutdown', () => {
    expect(isTerminalTaskState('waiting_for_delivery_approval')).toBe(true);
    expect(
      canAutoCleanup({ awaitingHumanApproval: false, taskState: 'waiting_for_delivery_approval', explicitCancel: false }),
    ).toBe(true);
  });

  it('a non-terminal task state does not permit cleanup even without a pending human gate', () => {
    expect(
      canAutoCleanup({ awaitingHumanApproval: false, taskState: 'queued', explicitCancel: false }),
    ).toBe(false);
  });

  it('an explicit cancel always permits cleanup, overriding a pending human gate', () => {
    expect(
      canAutoCleanup({ awaitingHumanApproval: true, taskState: undefined, explicitCancel: true }),
    ).toBe(true);
  });

  it('detects an unchanged source checkout as unchanged across all three dimensions', () => {
    const snapshot = { branch: 'main', head: 'abc123', status: ' M foo.py\n' };
    const comparison = compareSourceCheckout(snapshot, { ...snapshot });
    expect(comparison.unchanged).toBe(true);
    expect(comparison.branchChanged).toBe(false);
    expect(comparison.headChanged).toBe(false);
    expect(comparison.statusChanged).toBe(false);
  });

  it('detects a mutated source checkout (branch, head, or status) as changed', () => {
    const before = { branch: 'main', head: 'abc123', status: '' };
    expect(compareSourceCheckout(before, { ...before, head: 'def456' }).unchanged).toBe(false);
    expect(compareSourceCheckout(before, { ...before, branch: 'other' }).unchanged).toBe(false);
    expect(compareSourceCheckout(before, { ...before, status: ' M x.py\n' }).unchanged).toBe(false);
  });

  it('never includes the task worktree location in the cleanup plan, whether the run succeeded or failed', () => {
    const worktreeLocation = 'C:\\Users\\someone\\AppData\\Local\\Temp\\ollama-agent-worktrees\\repo\\task-attempt';
    const plan = buildCleanupPlan({
      isolatedUserDataDir: 'C:\\Temp\\harness\\user-data',
      isolatedExtensionsDir: 'C:\\Temp\\harness\\extensions',
      worktreeLocation,
    });
    expect(plan).not.toContain(worktreeLocation);
    expect(plan).toEqual(['C:\\Temp\\harness\\user-data', 'C:\\Temp\\harness\\extensions']);
  });

  it('the live UI dogfood harness never calls the auto-approval UI driver functions', () => {
    const scriptPath = path.resolve(__dirname, '../../../scripts/live-m17-ui-dogfood.mjs');
    const source = fs.readFileSync(scriptPath, 'utf8');
    expect(source).not.toMatch(/uiDriver\.acceptQuickPickFirstItem/);
    expect(source).not.toMatch(/uiDriver\.clickModalButton/);
    expect(source).not.toMatch(/uiDriver\.pressEscapeToRejectQuickPick/);
  });
});
