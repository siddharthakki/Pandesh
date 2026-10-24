import * as vscode from 'vscode';
import { AgentMode } from '../config/ConfigSchema';
import { AgentLoopEvents } from '../tools/ToolTypes';
import { TaskBudgets, ValidationCommandRequest } from '../agent/AgentEngineTypes';
import { AgentStateMachine, canTransition, statusToDefaultPhase } from '../agent/AgentStateMachine';
import { TrustedSequentialAgentRuntime } from './TrustedSequentialAgentRuntime';

const POLICY_PREFIX = 'Stopped on policy violation:';

export class PolicySafeAgentRuntime extends TrustedSequentialAgentRuntime {
  constructor(workspaceRoot: string, secrets: vscode.SecretStorage) {
    super(workspaceRoot, secrets);
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
    let terminalError: string | undefined;
    let abortPromise: Promise<unknown> | undefined;
    const wrapped: AgentLoopEvents = {
      ...events,
      onError: message => {
        terminalError ??= message;
        const activeTaskId = this.getTaskId() ?? taskId;
        if (!abortPromise && activeTaskId && this.isRunning()) {
          // Abort the active loop before it can enter validation/repair. The task
          // is converted to a durable blocked state after the lower runtime exits.
          abortPromise = super.pauseTask(activeTaskId).catch(() => undefined);
        }
        events.onError?.(message);
      },
    };

    await super.run(
      text,
      mode,
      wrapped,
      images,
      modelOverride,
      taskId,
      settings,
      budgetOverrides,
    );

    await abortPromise;
    if (!terminalError) { return; }

    const activeTaskId = this.getTaskId() ?? taskId;
    if (!activeTaskId) { return; }
    const task = await this.taskStore.getTask(activeTaskId);
    if (!task) { return; }

    const phase = task.phase ?? statusToDefaultPhase(task.status);
    if (phase === 'failed' || phase === 'cancelled') { return; }

    const reason = terminalError.startsWith(POLICY_PREFIX)
      ? 'policy_denial' as const
      : 'internal_error' as const;
    if (phase !== 'blocked') {
      if (!canTransition(phase, 'blocked')) { return; }
      const machine = new AgentStateMachine(this.taskStore);
      await machine.transition(activeTaskId, 'blocked', {
        reason,
        detail: terminalError,
        blockedReason: terminalError,
      });
    } else {
      await this.taskStore.updateTask(activeTaskId, {
        blockedReason: terminalError,
      });
    }

    await this.taskStore.updateTask(activeTaskId, { validationPassed: false });
    await this.taskStore.appendEvent(activeTaskId, 'task_blocked', {
      reason,
      detail: terminalError,
    });
    await this.taskStore.writeSnapshot(activeTaskId);
  }
}
