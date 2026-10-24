// Pure, dependency-free lifecycle logic for the external CDP/Extension Host
// acceptance harnesses (scripts/live-m17-ui-dogfood.mjs and friends).
//
// Kept out of the harness scripts themselves so it can be unit-tested with
// vitest without spinning up a real VS Code process. None of this touches
// vscode.window.* APIs, the filesystem, or a child process directly — callers
// (the .mjs scripts) own all I/O and pass in observed state.

export const TERMINAL_TASK_STATES = new Set([
  'waiting_for_delivery_approval',
  'cancelled',
  'blocked',
  'completed',
  'failed',
]);

export function isTerminalTaskState(state: string | undefined): boolean {
  return typeof state === 'string' && TERMINAL_TASK_STATES.has(state);
}

export interface CleanupDecisionInput {
  /** A human-gated approval surface (QuickPick or modal) is currently believed to be open/pending. */
  awaitingHumanApproval: boolean;
  taskState: string | undefined;
  /** The human/operator explicitly asked to stop (e.g. SIGINT), overriding any pending-approval hold. */
  explicitCancel: boolean;
}

/**
 * Decides whether it is safe to terminate the isolated VS Code process and
 * clean up harness scratch directories right now. Cleanup must never happen
 * merely because a QuickPick/modal is waiting for a human, and must never be
 * driven by a short fixed timer — only by an explicit cancel or a genuine
 * task-level terminal state.
 */
export function canAutoCleanup(input: CleanupDecisionInput): boolean {
  if (input.explicitCancel) return true;
  if (input.awaitingHumanApproval) return false;
  return isTerminalTaskState(input.taskState);
}

export type CdpClosureKind = 'vscode_process_exited' | 'cdp_transport_closed';

export interface CdpClosureClassification {
  kind: CdpClosureKind;
  detail: string;
  /** Whether the caller should attempt to reconnect rather than declare the run failed. */
  recoverable: boolean;
}

export interface ChildProcessObservation {
  childExited: boolean;
  childExitCode: number | null;
  childSignal: string | null;
}

/**
 * Classifies an unexpected CDP transport closure using the *actual observed*
 * state of the VS Code child process (never inferred from the CDP error
 * alone), so the caller can tell "VS Code itself exited" apart from "only
 * the CDP transport dropped while VS Code is still running" and react
 * accordingly (fail vs. reconnect).
 */
export function classifyCdpClosure(observation: ChildProcessObservation): CdpClosureClassification {
  if (observation.childExited) {
    return {
      kind: 'vscode_process_exited',
      detail: `VS Code process exited (code=${observation.childExitCode ?? 'null'}, signal=${observation.childSignal ?? 'none'})`,
      recoverable: false,
    };
  }
  return {
    kind: 'cdp_transport_closed',
    detail: 'CDP WebSocket closed but the VS Code process is still running; reconnect is expected to succeed.',
    recoverable: true,
  };
}

export interface StallDecisionInput {
  awaitingHumanApproval: boolean;
  lastProgressAtMs: number;
  nowMs: number;
  inactivityTimeoutMs: number;
}

/**
 * A stage is only ever declared "stalled" from bounded per-stage inactivity
 * (no new task/status-file event observed for inactivityTimeoutMs) — never
 * from a fixed overall wall-clock budget, and never at all while a human
 * approval gate is open (that wait is unbounded by design).
 */
export function hasStalled(input: StallDecisionInput): boolean {
  if (input.awaitingHumanApproval) return false;
  return input.nowMs - input.lastProgressAtMs > input.inactivityTimeoutMs;
}

export interface SourceCheckoutSnapshot {
  branch: string;
  head: string;
  status: string;
}

export interface SourceCheckoutComparison {
  unchanged: boolean;
  branchChanged: boolean;
  headChanged: boolean;
  statusChanged: boolean;
}

/** Pure comparison of two before/after git snapshots of the original checkout — no git calls here. */
export function compareSourceCheckout(
  before: SourceCheckoutSnapshot,
  after: SourceCheckoutSnapshot,
): SourceCheckoutComparison {
  const branchChanged = before.branch !== after.branch;
  const headChanged = before.head !== after.head;
  const statusChanged = before.status !== after.status;
  return {
    unchanged: !branchChanged && !headChanged && !statusChanged,
    branchChanged,
    headChanged,
    statusChanged,
  };
}

export interface CleanupPlanInput {
  isolatedUserDataDir: string;
  isolatedExtensionsDir: string;
  worktreeLocation: string | undefined;
}

/**
 * Builds the list of paths a controlled shutdown is allowed to delete.
 * The isolated VS Code scratch dirs are always eligible; the task worktree
 * is never included, regardless of task outcome — retained worktrees
 * (successful or failed) are evidence and must survive harness cleanup.
 */
export function buildCleanupPlan(input: CleanupPlanInput): string[] {
  return [input.isolatedUserDataDir, input.isolatedExtensionsDir];
}
