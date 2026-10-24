import type { AttemptStatus } from '../shared/wireTypes';

/**
 * Execution-attempt lifecycle transition graph. Modeled directly on
 * src/agent/AgentStateMachine.ts's PersistedTaskStatus graph (docs/m32-decisions.md D1),
 * translated to Core ownership. `recovery_required` is the terminal-but-not-final state
 * a Core restart lands an attempt in in when its last known stage cannot be safely
 * assumed to have completed (see docs/m32-recovery.md).
 */
const ALLOWED_TRANSITIONS: Record<AttemptStatus, AttemptStatus[]> = {
  created: ['queued', 'running', 'cancelled', 'failed'],
  queued: ['running', 'cancelling', 'cancelled'],
  running: ['waiting_for_approval', 'validating', 'paused', 'blocked', 'completed', 'failed', 'cancelling'],
  waiting_for_approval: ['running', 'cancelling', 'blocked', 'cancelled', 'failed'],
  validating: ['running', 'waiting_for_approval', 'completed', 'failed', 'cancelling'],
  paused: ['running', 'cancelling', 'cancelled'],
  blocked: ['running', 'cancelling', 'cancelled', 'failed'],
  cancelling: ['cancelled', 'recovery_required'],
  completed: [],
  failed: [],
  cancelled: [],
  recovery_required: ['running', 'blocked', 'cancelled', 'failed'],
};

export const TERMINAL_ATTEMPT_STATUSES: ReadonlySet<AttemptStatus> = new Set(['completed', 'failed', 'cancelled']);

export function validateAttemptTransition(from: AttemptStatus, to: AttemptStatus): { ok: true } | { ok: false; reason: string } {
  if (from === to) {
    return { ok: false, reason: `attempt is already in status '${from}'` };
  }
  const allowed = ALLOWED_TRANSITIONS[from] ?? [];
  if (!allowed.includes(to)) {
    return { ok: false, reason: `transition from '${from}' to '${to}' is not permitted` };
  }
  return { ok: true };
}

export function isTerminalAttemptStatus(status: AttemptStatus): boolean {
  return TERMINAL_ATTEMPT_STATUSES.has(status);
}
