import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { AgentMode } from '../config/ConfigSchema';
import { Config } from '../config/Config';
import { AgentLoopEvents } from '../tools/ToolTypes';
import { TaskBudgets, ValidationCommandRequest } from '../agent/AgentEngineTypes';
import { resolveExecutionMode, resolveExecutionModelOverride } from '../agent/TaskIntent';
import { PolicySafeAgentRuntime } from './PolicySafeAgentRuntime';

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export class MeasuredAgentRuntime extends PolicySafeAgentRuntime {
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
    const startedAt = new Date();
    const hasExplicitValidationCommands = Boolean(settings.validationCommands?.length);
    const effectiveMode = resolveExecutionMode(text, mode, hasExplicitValidationCommands);
    const effectiveModelOverride = resolveExecutionModelOverride(
      text,
      mode,
      modelOverride,
      Config.getAgentModel(),
      hasExplicitValidationCommands,
    );
    await super.run(
      text,
      effectiveMode,
      events,
      images,
      effectiveModelOverride,
      taskId,
      settings,
      budgetOverrides,
    );

    if (effectiveMode !== 'agent') { return; }
    const activeTaskId = this.getTaskId() ?? taskId;
    if (!activeTaskId) { return; }
    const taskDir = this.taskStore.getTaskDir(activeTaskId);
    const destination = path.join(taskDir, 'role-workflow.json');

    let existingWorkflow: Record<string, unknown> | undefined;
    try {
      existingWorkflow = asObject(JSON.parse(await fs.readFile(destination, 'utf8')));
    } catch {
      existingWorkflow = undefined;
    }

    if (existingWorkflow) {
      await this.ensureCompletionGateAudit(activeTaskId, existingWorkflow);
      return;
    }

    let snapshot;
    try { snapshot = await this.getTask(activeTaskId); } catch { return; }
    const finalStatus = snapshot.phase === 'completed'
      ? 'completed'
      : snapshot.phase === 'blocked' || snapshot.phase === 'paused'
        ? 'blocked'
        : 'failed';
    const payload = {
      schemaVersion: 1,
      workflowId: `baseline_${activeTaskId}`,
      taskId: activeTaskId,
      startedAt: startedAt.toISOString(),
      completedAt: new Date().toISOString(),
      repairPasses: snapshot.usage.repairAttempts,
      baselineMode: 'single-role',
      finalStatus,
      artifacts: ['task.json', 'result.json'],
      elapsedMs: Math.max(0, Date.now() - startedAt.getTime()),
      roleModelCalls: 0,
      engineModelCalls: snapshot.usage.modelCalls,
      approvalsRequested: 0,
      validationPassed: snapshot.validationPassed,
    };
    await fs.mkdir(taskDir, { recursive: true });
    const temporary = `${destination}.${process.pid}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(payload, null, 2), 'utf8');
    await fs.rename(temporary, destination);
  }

  private async ensureCompletionGateAudit(
    taskId: string,
    workflow: Record<string, unknown>,
  ): Promise<void> {
    if (workflow['baselineMode'] !== 'sequential-specialists' || workflow['finalStatus'] === 'completed') {
      return;
    }
    const task = await this.taskStore.getTask(taskId);
    if (!task || task.phase !== 'blocked') { return; }

    const eventState = await this.taskStore.getEvents(taskId);
    const hasGateTransition = eventState.events.some(event =>
      event.type === 'phase_transition'
      && event.payload['from'] === 'completed'
      && event.payload['to'] === 'blocked'
      && (event.payload['reason'] === 'reviewer_rejected' || event.payload['reason'] === 'validator_rejected'),
    );
    if (hasGateTransition) { return; }

    const reviewerBlocking = workflow['reviewerBlocking'] === true;
    const reason = reviewerBlocking ? 'reviewer_rejected' : 'validator_rejected';
    await this.taskStore.appendEvent(taskId, 'phase_transition', {
      from: 'completed',
      to: 'blocked',
      reason,
      detail: task.blockedReason,
      blockedReason: task.blockedReason,
      completionGate: true,
    });
    await this.taskStore.writeSnapshot(taskId);
  }
}
