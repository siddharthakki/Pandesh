import { TaskStore } from './TaskStore';
import { AgentPhase, TransitionReason } from './AgentEngineTypes';
import { Logger } from '../services/Logger';

export class InvalidPhaseTransitionError extends Error {
  constructor(readonly from: AgentPhase, readonly to: AgentPhase) {
    super(`Invalid agent phase transition: ${from} -> ${to}`);
    this.name = 'InvalidPhaseTransitionError';
  }
}

const TRANSITIONS: Readonly<Record<AgentPhase, readonly AgentPhase[]>> = {
  created: ['understanding', 'cancelled'],
  understanding: ['planning', 'blocked', 'paused', 'failed', 'cancelled'],
  planning: ['ready', 'blocked', 'paused', 'failed', 'cancelled'],
  ready: ['executing', 'blocked', 'paused', 'cancelled'],
  executing: ['waiting_for_approval', 'validating', 'blocked', 'paused', 'failed', 'cancelled'],
  // Approval persistence is asynchronous. Once the approved tool has returned,
  // validation may legitimately begin before the durable approval callback has
  // finished changing this phase back to executing.
  waiting_for_approval: ['executing', 'validating', 'blocked', 'paused', 'cancelled'],
  validating: ['completed', 'repairing', 'blocked', 'paused', 'failed', 'cancelled'],
  repairing: ['executing', 'blocked', 'paused', 'failed', 'cancelled'],
  paused: [
    'understanding',
    'planning',
    'ready',
    'executing',
    'waiting_for_approval',
    'validating',
    'repairing',
    'blocked',
    'cancelled',
  ],
  blocked: [
    'understanding',
    'planning',
    'ready',
    'executing',
    'validating',
    'paused',
    'failed',
    'cancelled',
  ],
  recovering: ['paused', 'blocked', 'completed', 'failed', 'cancelled'],
  // The implementation engine can reach completed before the optional Phase 12
  // Reviewer and Validator finish. They may retract completion exactly once by
  // moving the durable task to blocked with an explicit completion-gate reason.
  completed: ['blocked'],
  failed: [],
  cancelled: [],
};

export interface TransitionOptions {
  reason: TransitionReason;
  detail?: string;
  resumePhase?: AgentPhase;
  blockedReason?: string;
}

export function canTransition(from: AgentPhase, to: AgentPhase): boolean {
  return from === to || TRANSITIONS[from].includes(to);
}

export function phaseToTaskStatus(phase: AgentPhase):
  | 'created'
  | 'running'
  | 'waiting_for_approval'
  | 'paused'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'recovering' {
  switch (phase) {
    case 'created': return 'created';
    case 'waiting_for_approval': return 'waiting_for_approval';
    case 'paused': return 'paused';
    case 'blocked': return 'blocked';
    case 'completed': return 'completed';
    case 'failed': return 'failed';
    case 'cancelled': return 'cancelled';
    case 'recovering': return 'recovering';
    default: return 'running';
  }
}

export function statusToDefaultPhase(status: string): AgentPhase {
  switch (status) {
    case 'created': return 'created';
    case 'waiting_for_approval': return 'waiting_for_approval';
    case 'paused': return 'paused';
    case 'blocked': return 'blocked';
    case 'completed': return 'completed';
    case 'failed': return 'failed';
    case 'cancelled': return 'cancelled';
    case 'recovering': return 'recovering';
    default: return 'executing';
  }
}

export class AgentStateMachine {
  constructor(private readonly store: TaskStore) {}

  async transition(
    taskId: string,
    to: AgentPhase,
    options: TransitionOptions,
  ): Promise<void> {
    const task = await this.store.getTask(taskId);
    if (!task) { throw new Error(`Task not found: ${taskId}`); }

    const from = task.phase ?? statusToDefaultPhase(task.status);
    if (!canTransition(from, to)) {
      throw new InvalidPhaseTransitionError(from, to);
    }
    if (from === to) { return; }

    const now = new Date().toISOString();
    await this.store.updateTask(taskId, {
      phase: to,
      status: phaseToTaskStatus(to),
      resumePhase: options.resumePhase,
      blockedReason: options.blockedReason,
      ...(to === 'completed' ? { completedAt: now } : {}),
      ...(to === 'cancelled' ? { cancelledAt: now } : {}),
    });

    try {
      await this.store.appendEvent(taskId, 'phase_transition', {
        from,
        to,
        reason: options.reason,
        detail: options.detail,
        resumePhase: options.resumePhase,
        blockedReason: options.blockedReason,
      });
    } catch (error) {
      await this.store.updateTask(taskId, {
        phase: task.phase,
        status: task.status,
        resumePhase: task.resumePhase,
        blockedReason: task.blockedReason,
        completedAt: task.completedAt,
        cancelledAt: task.cancelledAt,
      }).catch(restoreError => {
        Logger.error('[AgentStateMachine] Failed to restore transition state:', restoreError);
      });
      throw error;
    }

    try {
      await this.store.writeSnapshot(taskId);
    } catch (error) {
      Logger.warn('[AgentStateMachine] Snapshot write failed after committed transition:', error);
    }
  }
}
