import * as vscode from 'vscode';
import { LocalAgentEngine } from './LocalAgentEngine';
import {
  AgentTaskSnapshot,
  ApprovalDecision,
  RollbackTarget,
  TaskBudgets,
  ValidationCommandRequest,
} from './AgentEngineTypes';
import { AgentStateMachine } from './AgentStateMachine';
import { CheckpointManager } from './CheckpointManager';
import { ApprovalRequest } from '../policy/ApprovalFlow';
import { AgentMode } from '../config/ConfigSchema';
import { Config } from '../config/Config';
import { AgentLoopEvents } from '../tools/ToolTypes';

const APPROVAL_PERSIST_TIMEOUT_MS = 5000;
const APPROVAL_POLL_INTERVAL_MS = 10;

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

export class ValidatedAgentRuntime extends LocalAgentEngine {
  private readonly workspaceRootForControls: string;

  constructor(workspaceRoot: string, secrets: vscode.SecretStorage) {
    super(workspaceRoot, secrets);
    this.workspaceRootForControls = workspaceRoot;
  }

  async getTask(taskId: string): Promise<AgentTaskSnapshot> {
    const snapshot = await super.getTask(taskId);
    if (
      snapshot.phase === 'waiting_for_approval' ||
      snapshot.phase === 'paused' ||
      snapshot.phase === 'blocked' ||
      snapshot.phase === 'completed' ||
      snapshot.phase === 'failed' ||
      snapshot.phase === 'cancelled' ||
      snapshot.phase === 'recovering'
    ) {
      snapshot.usage = { ...snapshot.usage, activeSince: undefined };
    }
    return snapshot;
  }

  setApprovalRequestCallback(callback: (request: ApprovalRequest) => void): void {
    super.setApprovalRequestCallback(request => {
      const taskId = this.getTaskId();
      if (taskId) {
        void this.freezeActiveUsage(taskId, true);
      }
      callback(request);
    });
  }

  async respondToApproval(taskId: string, approvalId: string, decision: ApprovalDecision): Promise<AgentTaskSnapshot>;
  async respondToApproval(approvalId: string, decision: ApprovalDecision): Promise<AgentTaskSnapshot>;
  async respondToApproval(first: string, second: string, third?: ApprovalDecision): Promise<AgentTaskSnapshot> {
    const taskId = third !== undefined ? first : this.getTaskId();
    const approvalId = third !== undefined ? second : first;
    const decision = third ?? (second as ApprovalDecision);
    if (!taskId) {
      throw new Error('No active task is available for this approval.');
    }

    const pending = await this.waitForPendingApproval(taskId, approvalId);
    await super.respondToApproval(taskId, approvalId, decision);
    await this.waitForApprovalResolution(taskId, approvalId, decision);
    await this.recordApprovalWait(taskId, pending.requestedAt, decision === 'approved');

    if (decision === 'rejected') {
      await this.freezeActiveUsage(taskId, true);
      const snapshot = await super.getTask(taskId);
      if (snapshot.phase !== 'blocked' && snapshot.phase !== 'failed' && snapshot.phase !== 'cancelled') {
        const machine = new AgentStateMachine(this.taskStore);
        await machine.transition(taskId, 'blocked', {
          reason: 'approval_rejected',
          detail: 'User rejected the requested operation.',
          blockedReason: 'User rejected the requested operation.',
        });
      }
      await this.taskStore.appendEvent(taskId, 'task_blocked', {
        reason: 'approval_rejected',
        approvalId,
      });
      await this.taskStore.writeSnapshot(taskId);
    }
    return this.getTask(taskId);
  }

  async pauseTask(taskId: string): Promise<AgentTaskSnapshot> {
    const before = await super.getTask(taskId);
    await super.pauseTask(taskId);
    await this.freezeActiveUsage(taskId, true);
    if (before.pendingApproval) {
      await this.taskStore.updateApproval(taskId, before.pendingApproval.approvalId, {
        status: 'cancelled',
        resolvedAt: new Date().toISOString(),
      });
      await this.taskStore.updateTask(taskId, { pendingApprovalId: undefined });
      await this.taskStore.writeSnapshot(taskId);
    }
    return this.getTask(taskId);
  }

  async cancelTask(taskId: string): Promise<AgentTaskSnapshot> {
    const before = await super.getTask(taskId);
    await super.cancelTask(taskId);
    await this.freezeActiveUsage(taskId, false);
    if (before.pendingApproval) {
      await this.taskStore.updateApproval(taskId, before.pendingApproval.approvalId, {
        status: 'cancelled',
        resolvedAt: new Date().toISOString(),
      });
      await this.taskStore.updateTask(taskId, { pendingApprovalId: undefined });
      await this.taskStore.writeSnapshot(taskId);
    }
    return this.getTask(taskId);
  }

  async rollbackTask(taskId: string, target: RollbackTarget): Promise<AgentTaskSnapshot> {
    const manager = new CheckpointManager(this.workspaceRootForControls);
    const references = await this.taskStore.getCheckpointRefs(taskId);

    if (target.kind === 'checkpoint') {
      const result = await manager.rewindCheckpoint(target.checkpointId);
      if (!result) {
        throw new Error(`Checkpoint ${target.checkpointId} is missing or unreadable.`);
      }
      const status = result.skipped.length === 0 ? 'restored' : 'failed';
      await this.taskStore.updateCheckpointRef(taskId, target.checkpointId, {
        restorationStatus: status,
      });
      if (result.skipped.length > 0) {
        throw new Error(`Checkpoint restored partially; skipped: ${result.skipped.join(', ')}`);
      }
    } else if (target.kind === 'iteration') {
      const result = await manager.rewindIteration(target.iterationId);
      if (result.count === 0) {
        throw new Error(`No checkpoints exist for iteration ${target.iterationId}.`);
      }
      for (const reference of references.filter(item => item.iterationId === target.iterationId)) {
        await this.taskStore.updateCheckpointRef(taskId, reference.checkpointId, {
          restorationStatus: result.skipped.length === 0 ? 'restored' : 'failed',
        });
      }
      if (result.skipped.length > 0) {
        throw new Error(`Iteration rollback restored partially; skipped: ${result.skipped.join(', ')}`);
      }
    } else if (target.kind === 'last_action') {
      const result = await manager.rewindLastCheckpoint();
      if (!result) { throw new Error('No checkpoint is available to roll back.'); }
      await this.taskStore.updateCheckpointRef(taskId, result.id, {
        restorationStatus: result.skipped.length === 0 ? 'restored' : 'failed',
      });
      if (result.skipped.length > 0) {
        throw new Error(`Last action rollback restored partially; skipped: ${result.skipped.join(', ')}`);
      }
    } else {
      if (!target.confirm) { throw new Error('Task-start rollback requires explicit confirmation.'); }
      const result = await manager.rewindAll({ confirm: true });
      for (const reference of references) {
        await this.taskStore.updateCheckpointRef(taskId, reference.checkpointId, {
          restorationStatus: result.skipped.length === 0 ? 'restored' : 'failed',
        });
      }
      if (result.skipped.length > 0) {
        throw new Error(`Task rollback restored partially; skipped: ${result.skipped.join(', ')}`);
      }
    }

    await this.taskStore.writeSnapshot(taskId);
    return this.getTask(taskId);
  }

  async run(
    text: string,
    mode: AgentMode,
    events: AgentLoopEvents,
    images?: string[],
    modelOverride?: string,
    taskId?: string,
    settings: { validationCommands?: ValidationCommandRequest[]; allowedPaths?: string[] } = {},
    budgetOverrides?: Partial<TaskBudgets>,
  ): Promise<void> {
    let pendingDone: string | undefined;
    let errorDelivered = false;
    let stoppedDelivered = false;

    const gatedEvents: AgentLoopEvents = {
      ...events,
      onDone: content => { pendingDone = content; },
      onError: message => {
        errorDelivered = true;
        events.onError?.(message);
      },
      onStopped: () => {
        stoppedDelivered = true;
        events.onStopped?.();
      },
    };

    const configuredBudgets: Partial<TaskBudgets> = {
      maxWallClockMs: Config.getMaxTaskWallClockMs(),
      maxModelCalls: Config.getMaxTaskModelCalls(),
      maxToolCalls: Config.getMaxTaskToolCalls(),
      maxRepairAttempts: Config.getMaxTaskRepairAttempts(),
      maxIterations: Config.getMaxIterations(),
      maxCommandDurationMs: Config.getCommandTimeoutMs(),
      maxOutputBytes: Config.getMaxTaskOutputBytes(),
      maxNoProgressSteps: Config.getMaxTaskNoProgressSteps(),
      ...budgetOverrides,
    };

    await super.run(text, mode, gatedEvents, images, modelOverride, taskId, settings, configuredBudgets);

    const effectiveTaskId = taskId ?? this.getTaskId();
    if (!effectiveTaskId) { return; }
    const snapshot = await this.getTask(effectiveTaskId);

    if (snapshot.phase === 'completed') {
      events.onDone?.(pendingDone ?? '(No response content)');
    } else if (snapshot.phase === 'cancelled' || snapshot.phase === 'paused') {
      if (!stoppedDelivered) { events.onStopped?.(); }
    } else if ((snapshot.phase === 'blocked' || snapshot.phase === 'failed') && !errorDelivered) {
      events.onError?.(
        snapshot.blockedReason ?? snapshot.task.failure?.message ?? `Task stopped in ${snapshot.phase} state.`,
      );
    }
  }

  private async waitForPendingApproval(taskId: string, approvalId: string) {
    const deadline = Date.now() + APPROVAL_PERSIST_TIMEOUT_MS;
    while (Date.now() <= deadline) {
      const approvals = await this.taskStore.getCurrentApprovals(taskId);
      const approval = approvals.find(item => item.approvalId === approvalId);
      if (approval?.status === 'pending') { return approval; }
      if (approval) {
        throw new Error(`Approval ${approvalId} has already been resolved as ${approval.status}.`);
      }
      await delay(APPROVAL_POLL_INTERVAL_MS);
    }
    throw new Error(`Approval ${approvalId} was not persisted for task ${taskId}.`);
  }

  private async waitForApprovalResolution(
    taskId: string,
    approvalId: string,
    decision: ApprovalDecision,
  ): Promise<void> {
    const deadline = Date.now() + APPROVAL_PERSIST_TIMEOUT_MS;
    while (Date.now() <= deadline) {
      const approvals = await this.taskStore.getCurrentApprovals(taskId);
      const approval = approvals.find(item => item.approvalId === approvalId);
      const task = await this.taskStore.getTask(taskId);
      if (approval?.status === decision && task?.pendingApprovalId !== approvalId) { return; }
      await delay(APPROVAL_POLL_INTERVAL_MS);
    }
    throw new Error(`Approval ${approvalId} did not reach durable ${decision} state.`);
  }

  private async freezeActiveUsage(taskId: string, paused: boolean): Promise<void> {
    const snapshot = await super.getTask(taskId);
    const now = Date.now();
    const activeSince = snapshot.usage.activeSince
      ? new Date(snapshot.usage.activeSince).getTime()
      : undefined;
    const elapsedActiveMs = snapshot.usage.elapsedActiveMs + (
      activeSince === undefined ? 0 : Math.max(0, now - activeSince)
    );
    await this.taskStore.updateTask(taskId, {
      engineUsage: {
        ...snapshot.usage,
        elapsedActiveMs,
        activeSince: undefined,
        pausedAt: paused ? new Date(now).toISOString() : undefined,
      },
    });
  }

  private async recordApprovalWait(
    taskId: string,
    requestedAt: string | undefined,
    resumeActive: boolean,
  ): Promise<void> {
    const snapshot = await super.getTask(taskId);
    const now = Date.now();
    const waitingDelta = requestedAt
      ? Math.max(0, now - new Date(requestedAt).getTime())
      : 0;
    await this.taskStore.updateTask(taskId, {
      engineUsage: {
        ...snapshot.usage,
        waitingApprovalMs: snapshot.usage.waitingApprovalMs + waitingDelta,
        activeSince: resumeActive ? new Date(now).toISOString() : undefined,
        pausedAt: resumeActive ? undefined : new Date(now).toISOString(),
      },
    });
  }
}
