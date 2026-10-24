import { Logger } from '../services/Logger';
import { TaskStore } from './TaskStore';
import {
  PersistedTask,
  PersistedEvent,
  PersistedApproval,
  PersistedCheckpointRef,
  RecoveryCandidate,
  InterruptionKind,
} from './TaskTypes';

export class TaskRecovery {
  constructor(private readonly store: TaskStore) {}

  async scan(): Promise<RecoveryCandidate[]> {
    let tasks: PersistedTask[];

    try {
      tasks = await this.store.listTasks();
    } catch (error) {
      Logger.error('[TaskRecovery] Failed to list tasks:', error);
      return [];
    }

    const candidates: RecoveryCandidate[] = [];

    for (const task of tasks) {
      try {
        const candidate = await this.analyzeTask(task);
        if (candidate) { candidates.push(candidate); }
      } catch (error) {
        Logger.error(`[TaskRecovery] Error analyzing task ${task.taskId}:`, error);
        candidates.push({
          taskId: task.taskId,
          task,
          mutationOutcomeUncertain: false,
          issues: [
            `Recovery analysis failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          ],
          snapshotEventSeq: 0,
          totalEventSeq: 0,
        });
      }
    }

    return candidates;
  }

  private async analyzeTask(task: PersistedTask): Promise<RecoveryCandidate | null> {
    const { taskId, status } = task;

    if (status === 'completed' || status === 'cancelled' || status === 'failed') {
      const snapshot = await this.store.readSnapshot(taskId);
      if (snapshot && snapshot.task.status === status) {
        return null;
      }
    }

    const eventState = await this.store.getEvents(taskId);
    const snapshotSequence = (await this.store.readSnapshot(taskId))?.snapshotSeq ?? 0;
    const totalEventSequence = eventState.events.length > 0
      ? eventState.events[eventState.events.length - 1].seq
      : 0;

    const issues: string[] = [...eventState.warnings];
    if (eventState.integrityFailed) {
      issues.push(
        'Event-log integrity is compromised. Manual repair is required before this task can be modified.',
      );
    }

    const checkpointReferences = await this.store.getCheckpointRefs(taskId);
    const approvals = await this.store.getCurrentApprovals(taskId);
    const pendingApproval = approvals.find(approval => approval.status === 'pending');

    const lock = await this.store.readLock(taskId);
    if (lock && await this.store.isLockStale(taskId)) {
      issues.push(
        `Stale lock from PID ${lock.pid} ` +
        `(locked at ${lock.lockedAt}, heartbeat at ${lock.heartbeatAt ?? 'none'})`,
      );
      await this.store.releaseLock(taskId);
    }

    const interruptionKind = this.classifyInterruption(
      task,
      eventState.events,
      approvals,
      checkpointReferences,
    );

    const needsRecovery =
      status === 'running' ||
      status === 'waiting_for_approval' ||
      status === 'recovering' ||
      status === 'blocked' ||
      interruptionKind !== undefined;

    if (!needsRecovery && issues.length === 0) {
      return null;
    }

    const mutationOutcomeUncertain =
      interruptionKind === 'tool_execution_unknown' ||
      interruptionKind === 'checkpoint_exists_result_missing';
    const blockerReason = mutationOutcomeUncertain
      ? 'mutation_outcome_uncertain'
      : eventState.integrityFailed
        ? 'event_log_integrity_failure'
        : 'interrupted_by_crash';

    if (mutationOutcomeUncertain) {
      issues.unshift(
        'DANGER: Mutation outcome uncertain. A mutating tool or checkpoint was recorded, ' +
        'but no reliable completion outcome exists. Do not re-run the task automatically. ' +
        'Inspect the workspace and rollback checkpoint, then explicitly restore, continue, or cancel.',
      );
    }

    let recoveredApproval = pendingApproval;

    if (needsRecovery && (status === 'running' || status === 'waiting_for_approval')) {
      try {
        await this.store.updateTaskStatus(taskId, 'blocked', {
          phase: 'blocked',
          blockedReason: blockerReason,
          resumePhase: mutationOutcomeUncertain ? undefined : task.phase ?? 'executing',
        });
      } catch (error) {
        issues.push(
          `Could not persist blocked task status: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }

      if (!eventState.integrityFailed) {
        try {
          await this.store.appendEvent(taskId, 'task_blocked', {
            reason: blockerReason,
            interruptionKind: interruptionKind ?? null,
            recoveredAt: new Date().toISOString(),
          });
        } catch (error) {
          Logger.warn(
            `[TaskRecovery] Could not append task_blocked event for ${taskId}: ` +
            `${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      try {
        await this.store.interruptPendingApprovals(taskId);
        if (pendingApproval) {
          recoveredApproval = {
            ...pendingApproval,
            status: 'interrupted',
            resolvedAt: new Date().toISOString(),
          };
        }
      } catch (error) {
        issues.push(
          `Could not interrupt pending approval: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    const lastCheckpointReference = checkpointReferences.length > 0
      ? checkpointReferences[checkpointReferences.length - 1]
      : undefined;

    return {
      taskId,
      task: {
        ...task,
        status: needsRecovery ? 'blocked' : task.status,
        phase: needsRecovery ? 'blocked' : task.phase,
        blockedReason: needsRecovery ? blockerReason : task.blockedReason,
      },
      interruptionKind,
      mutationOutcomeUncertain,
      pendingApproval: recoveredApproval,
      lastCheckpointRef: lastCheckpointReference,
      snapshotEventSeq: snapshotSequence,
      totalEventSeq: totalEventSequence,
      issues,
    };
  }

  private classifyInterruption(
    task: PersistedTask,
    events: PersistedEvent[],
    approvals: PersistedApproval[],
    checkpointReferences: PersistedCheckpointRef[],
  ): InterruptionKind | undefined {
    if (events.length > 0) {
      const lastToolLifecycleEvent = [...events].reverse().find(event =>
        event.type === 'tool_started' ||
        event.type === 'tool_completed' ||
        event.type === 'tool_failed',
      );

      if (lastToolLifecycleEvent?.type === 'tool_started') {
        return 'tool_execution_unknown';
      }

      if (checkpointReferences.length > 0) {
        const lastCheckpoint = checkpointReferences[checkpointReferences.length - 1];
        const matchingOutcome = events.some(event => {
          if (event.type !== 'tool_completed' && event.type !== 'tool_failed') {
            return false;
          }

          if (lastCheckpoint.toolCallId) {
            const eventToolCallId =
              event.correlationId ??
              (typeof event.payload['toolCallId'] === 'string'
                ? event.payload['toolCallId']
                : undefined);
            return eventToolCallId === lastCheckpoint.toolCallId;
          }

          return event.timestamp > lastCheckpoint.timestamp;
        });

        if (!matchingOutcome) {
          return 'checkpoint_exists_result_missing';
        }
      }
    }

    if (approvals.some(approval => approval.status === 'pending')) {
      return 'approval_interrupted';
    }

    const terminalTypes = new Set<string>([
      'task_completed',
      'task_cancelled',
      'task_failed',
      'task_paused',
      'task_blocked',
    ]);
    const hasTerminalEvent = events.some(event => terminalTypes.has(event.type));

    if (
      !hasTerminalEvent &&
      (task.status === 'running' || task.status === 'waiting_for_approval')
    ) {
      return 'inference_interrupted';
    }

    return undefined;
  }

  async reconstructTask(taskId: string): Promise<PersistedTask | null> {
    return this.store.reconstructFromEvents(taskId);
  }
}
