import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { ConversationAwareAgentRuntime } from '../agent/ConversationAwareAgentRuntime';
import {
  DEFAULT_TASK_BUDGETS,
  TaskBudgets,
  TransitionReason,
  ValidationCommandRequest,
} from '../agent/AgentEngineTypes';
import { AgentStateMachine, canTransition, statusToDefaultPhase } from '../agent/AgentStateMachine';
import { AgentMode } from '../config/ConfigSchema';
import { Config } from '../config/Config';
import { AgentLoopEvents } from '../tools/ToolTypes';
import { TaskContract, TaskContractInput } from '../autonomy/TaskContract';
import { TaskContractStore } from '../autonomy/TaskContractStore';
import { RoleRunner } from './RoleRunner';
import {
  ImplementationArtifact,
  PlannerArtifact,
  ReviewArtifact,
  RoleWorkflowSummary,
  SupervisorArtifact,
} from './RoleTypes';
import { Logger } from '../services/Logger';

const execFileAsync = promisify(execFile);

interface RunSettings {
  validationCommands?: ValidationCommandRequest[];
  allowedPaths?: string[];
}

class WorkflowBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowBudgetError';
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

export class TrustedSequentialAgentRuntime extends ConversationAwareAgentRuntime {
  private readonly contractStore: TaskContractStore;
  private readonly roleRunner: RoleRunner;
  private activeRoleController?: AbortController;

  constructor(
    private readonly roleWorkspaceRoot: string,
    secrets: vscode.SecretStorage,
  ) {
    super(roleWorkspaceRoot, secrets);
    this.contractStore = new TaskContractStore(this.taskStore);
    this.roleRunner = new RoleRunner(roleWorkspaceRoot, secrets);
  }

  async proposeTaskContract(taskId: string, input: TaskContractInput): Promise<TaskContract> {
    return this.contractStore.propose(taskId, input);
  }

  async approveTaskContract(taskId: string, contractId: string): Promise<TaskContract> {
    return this.contractStore.approve(taskId, contractId, 'user');
  }

  async revokeTaskContract(taskId: string, contractId: string): Promise<TaskContract> {
    return this.contractStore.revoke(taskId, contractId);
  }

  async getTaskContract(taskId: string): Promise<TaskContract | null> {
    return this.contractStore.get(taskId);
  }

  stop(): void {
    this.activeRoleController?.abort();
    super.stop();
  }

  async run(
    text: string,
    mode: AgentMode,
    events: AgentLoopEvents,
    images?: string[],
    modelOverride?: string,
    taskId?: string,
    settings: RunSettings = {},
    budgetOverrides?: Partial<TaskBudgets>,
  ): Promise<void> {
    const conversationRoot = taskId ?? this.getTaskId() ?? this.createWorkflowRoot();
    if (mode === 'agent' && Config.getTrustedAutonomyEnabled()) {
      await this.ensureTrustedContract(conversationRoot, text, settings, budgetOverrides);
    }

    await this.writeHeartbeat(conversationRoot, false, 'preparing').catch(() => undefined);
    const heartbeat = this.startHeartbeat(conversationRoot);
    try {
      if (mode !== 'agent' || !Config.getSequentialRolesEnabled()) {
        await super.run(
          text,
          mode,
          events,
          images,
          modelOverride,
          conversationRoot,
          settings,
          budgetOverrides,
        );
        return;
      }

      if (this.activeRoleController) {
        throw new Error('A specialist role workflow is already active.');
      }
      const controller = new AbortController();
      this.activeRoleController = controller;
      try {
        await this.runSequentialWorkflow(
          conversationRoot,
          text,
          events,
          images,
          modelOverride,
          settings,
          budgetOverrides,
          controller.signal,
        );
      } catch (error) {
        if (controller.signal.aborted) {
          events.onStopped?.();
          return;
        }
        if (error instanceof WorkflowBudgetError) {
          const message = `Sequential role workflow stopped: ${error.message}`;
          await this.blockCurrentTask(conversationRoot, message, 'budget_exhausted');
          events.onError?.(message);
          return;
        }
        throw error;
      } finally {
        if (this.activeRoleController === controller) {
          this.activeRoleController = undefined;
        }
      }
    } finally {
      clearInterval(heartbeat);
      await this.writeHeartbeat(conversationRoot, true, 'stopped').catch(() => undefined);
    }
  }

  private async runSequentialWorkflow(
    conversationRoot: string,
    goal: string,
    events: AgentLoopEvents,
    images: string[] | undefined,
    modelOverride: string | undefined,
    settings: RunSettings,
    budgetOverrides: Partial<TaskBudgets> | undefined,
    signal: AbortSignal,
  ): Promise<void> {
    const workflowStarted = Date.now();
    const workflowId = `roles_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const workflowBudgets: TaskBudgets = { ...DEFAULT_TASK_BUDGETS, ...budgetOverrides };
    let roleModelCalls = 0;
    let engineModelCalls = 0;
    const contract = await this.contractStore.get(conversationRoot);

    const assertActive = () => {
      if (signal.aborted) { throw new Error('Specialist role workflow cancelled.'); }
      const elapsed = Date.now() - workflowStarted;
      if (elapsed >= workflowBudgets.maxWallClockMs) {
        throw new WorkflowBudgetError(
          `wall-clock budget exhausted after ${elapsed} ms (limit ${workflowBudgets.maxWallClockMs} ms).`,
        );
      }
    };
    const consumeRoleCall = (role: string) => {
      assertActive();
      if (roleModelCalls + engineModelCalls + 1 > workflowBudgets.maxModelCalls) {
        throw new WorkflowBudgetError(
          `model-call budget exhausted before ${role} ` +
          `(${roleModelCalls + engineModelCalls}/${workflowBudgets.maxModelCalls} used).`,
        );
      }
      roleModelCalls += 1;
    };
    const engineBudgets = (futureRoleCalls: number): Partial<TaskBudgets> => {
      assertActive();
      const remainingCalls = workflowBudgets.maxModelCalls
        - roleModelCalls
        - engineModelCalls
        - futureRoleCalls;
      if (remainingCalls < 1) {
        throw new WorkflowBudgetError(
          `no model calls remain for implementation after reserving ${futureRoleCalls} specialist calls.`,
        );
      }
      return {
        ...budgetOverrides,
        maxModelCalls: remainingCalls,
        maxWallClockMs: Math.max(1, workflowBudgets.maxWallClockMs - (Date.now() - workflowStarted)),
      };
    };

    let supervisor: SupervisorArtifact;
    let planner: PlannerArtifact;
    try {
      events.onAssistantContent?.('Supervisor is defining the task contract and acceptance boundaries.');
      consumeRoleCall('Supervisor');
      supervisor = await this.roleRunner.runSupervisor(
        goal,
        contract ? asObject(contract) : {},
        signal,
      );
      events.onAssistantContent?.('Planner is creating a bounded implementation handoff.');
      consumeRoleCall('Planner');
      planner = await this.roleRunner.runPlanner(goal, supervisor, signal);
      await this.roleRunner.writeArtifact(
        this.taskStore.getTaskDir(conversationRoot),
        'supervisor.json',
        supervisor,
      );
      await this.roleRunner.writeArtifact(
        this.taskStore.getTaskDir(conversationRoot),
        'plan.json',
        planner,
      );
    } catch (error) {
      if (signal.aborted || error instanceof WorkflowBudgetError) { throw error; }
      Logger.warn('[TrustedSequentialAgentRuntime] Specialist preparation failed; using single-role fallback:', error);
      events.onAssistantContent?.(
        `Specialist preparation failed; continuing with the validated single-agent path: ${error instanceof Error ? error.message : String(error)}`,
      );
      await super.run(
        goal,
        'agent',
        events,
        images,
        modelOverride,
        conversationRoot,
        settings,
        budgetOverrides,
      );
      return;
    }

    let pendingDone = '';
    const gatedEvents: AgentLoopEvents = {
      ...events,
      onDone: content => { pendingDone = content; },
    };
    const implementerInput = [
      goal,
      '## Supervisor handoff',
      JSON.stringify(supervisor, null, 2),
      '## Planner handoff',
      JSON.stringify(planner, null, 2),
      'Act as the Implementer. Follow this handoff, remain inside the approved task contract, and finish only after required validation passes.',
    ].join('\n\n');

    await this.writeHeartbeat(conversationRoot, false, 'implementing');
    await super.run(
      implementerInput,
      'agent',
      gatedEvents,
      images,
      modelOverride,
      conversationRoot,
      settings,
      engineBudgets(2),
    );

    let activeTaskId = this.getTaskId() ?? conversationRoot;
    let snapshot = await this.getTask(activeTaskId);
    engineModelCalls += snapshot.usage.modelCalls;
    if (snapshot.phase !== 'completed') { return; }

    let repairPasses = 0;
    let implementation = await this.buildImplementation(activeTaskId, pendingDone);
    consumeRoleCall('Reviewer');
    let review = await this.reviewImplementation(
      activeTaskId,
      goal,
      planner,
      implementation,
      signal,
    );
    await this.persistRoleArtifacts(activeTaskId, supervisor, planner, implementation, review);

    const maxReviewerRepairs = Config.getMaxReviewerRepairPasses();
    while (review.blocking && repairPasses < maxReviewerRepairs) {
      assertActive();
      repairPasses += 1;
      events.onAssistantContent?.(
        `Reviewer found blocking issues. Starting bounded repair pass ${repairPasses}/${maxReviewerRepairs}.`,
      );
      const repairPrompt = [
        'Reviewer repair request. Fix only the concrete blocking findings below.',
        JSON.stringify(review.findings.filter(finding => finding.severity === 'blocking'), null, 2),
        'Re-read affected files, keep changes inside the approved contract, run required validation, and stop.',
      ].join('\n\n');
      pendingDone = '';
      await this.writeHeartbeat(conversationRoot, false, `repair-${repairPasses}`);
      await super.run(
        repairPrompt,
        'agent',
        gatedEvents,
        undefined,
        modelOverride,
        conversationRoot,
        settings,
        engineBudgets(2),
      );
      activeTaskId = this.getTaskId() ?? activeTaskId;
      snapshot = await this.getTask(activeTaskId);
      engineModelCalls += snapshot.usage.modelCalls;
      if (snapshot.phase !== 'completed') { return; }
      implementation = await this.buildImplementation(activeTaskId, pendingDone);
      consumeRoleCall('Reviewer');
      review = await this.reviewImplementation(
        activeTaskId,
        goal,
        planner,
        implementation,
        signal,
      );
      await this.persistRoleArtifacts(activeTaskId, supervisor, planner, implementation, review);
    }

    const mechanicalValidation = await this.readJson(path.join(
      this.taskStore.getTaskDir(activeTaskId),
      'result.json',
    ));
    events.onAssistantContent?.('Validator is checking mechanical evidence and Reviewer findings.');
    consumeRoleCall('Validator');
    const validation = await this.roleRunner.runValidator(
      activeTaskId,
      goal,
      asObject(implementation),
      review,
      mechanicalValidation,
      signal,
    );
    await this.roleRunner.writeArtifact(
      this.taskStore.getTaskDir(activeTaskId),
      'validation.json',
      validation,
    );

    const workflow: RoleWorkflowSummary & {
      elapsedMs: number;
      roleModelCalls: number;
      engineModelCalls: number;
      reviewerBlocking: boolean;
      validatorPassed: boolean;
    } = {
      schemaVersion: 1,
      workflowId,
      taskId: activeTaskId,
      startedAt: new Date(workflowStarted).toISOString(),
      completedAt: nowIso(),
      repairPasses,
      baselineMode: 'sequential-specialists',
      finalStatus: validation.passed ? 'completed' : review.blocking ? 'blocked' : 'failed',
      artifacts: ['task.json', 'plan.json', 'implementation.json', 'review.json', 'validation.json'],
      elapsedMs: Date.now() - workflowStarted,
      roleModelCalls,
      engineModelCalls,
      reviewerBlocking: review.blocking,
      validatorPassed: validation.passed,
    };
    await this.roleRunner.writeArtifact(
      this.taskStore.getTaskDir(activeTaskId),
      'role-workflow.json',
      workflow,
    );
    await this.taskStore.appendEvent(activeTaskId, 'assistant_message', {
      kind: 'sequential_role_workflow',
      workflowId,
      repairPasses,
      roleModelCalls,
      engineModelCalls,
      reviewerBlocking: review.blocking,
      validatorPassed: validation.passed,
      elapsedMs: workflow.elapsedMs,
    });

    if (!validation.passed) {
      const reason: TransitionReason = review.blocking ? 'reviewer_rejected' : 'validator_rejected';
      const detail = review.blocking
        ? 'Blocking Reviewer findings remain after the bounded repair budget.'
        : 'Validator rejected the available completion evidence.';
      await this.blockTask(activeTaskId, detail, reason);
      events.onError?.(`Task blocked: ${detail}`);
      return;
    }

    events.onDone?.(pendingDone || validation.summary);
  }

  private async ensureTrustedContract(
    taskId: string,
    goal: string,
    settings: RunSettings,
    budgetOverrides?: Partial<TaskBudgets>,
  ): Promise<void> {
    await this.contractStore.ensureTrustedContract(taskId, {
      goal,
      acceptanceCriteria: (settings.validationCommands ?? []).map(command =>
        `${command.required ? 'Required' : 'Optional'} ${command.category}: ${command.command}`,
      ),
      allowedPaths: settings.allowedPaths?.length ? settings.allowedPaths : ['**/*'],
      allowedCommands: (settings.validationCommands ?? []).map(command => command.command),
      allowSafeCommands: true,
      budgets: { ...DEFAULT_TASK_BUDGETS, ...budgetOverrides },
      approvalPolicy: 'in-contract-autonomous',
      checkpointPolicy: 'required',
    }, 'trusted-setting');
  }

  private async buildImplementation(
    taskId: string,
    summary: string,
  ): Promise<ImplementationArtifact> {
    const result = await this.readJson(path.join(this.taskStore.getTaskDir(taskId), 'result.json'));
    const validation = asObject(result['validation']);
    const checkpoints = await this.taskStore.getCheckpointRefs(taskId);
    return {
      schemaVersion: 1,
      role: 'implementer',
      taskId,
      summary: summary || 'Implementation pass completed.',
      filesChanged: asStrings(result['filesChanged']),
      commandsRun: asStrings(result['commandsRun']),
      checkpointIds: checkpoints.map(checkpoint => checkpoint.checkpointId),
      validationPassed: typeof validation['passed'] === 'boolean'
        ? validation['passed']
        : typeof result['success'] === 'boolean'
          ? result['success']
          : undefined,
      completedAt: nowIso(),
    };
  }

  private async reviewImplementation(
    taskId: string,
    goal: string,
    planner: PlannerArtifact,
    implementation: ImplementationArtifact,
    signal: AbortSignal,
  ): Promise<ReviewArtifact> {
    const gitEvidence = await this.gitEvidence();
    return this.roleRunner.runReviewer(
      taskId,
      goal,
      planner,
      asObject(implementation),
      gitEvidence,
      signal,
    );
  }

  private async persistRoleArtifacts(
    taskId: string,
    supervisor: SupervisorArtifact,
    planner: PlannerArtifact,
    implementation: ImplementationArtifact,
    review: ReviewArtifact,
  ): Promise<void> {
    const taskDir = this.taskStore.getTaskDir(taskId);
    await Promise.all([
      this.roleRunner.writeArtifact(taskDir, 'supervisor.json', supervisor),
      this.roleRunner.writeArtifact(taskDir, 'plan.json', planner),
      this.roleRunner.writeArtifact(taskDir, 'implementation.json', implementation),
      this.roleRunner.writeArtifact(taskDir, 'review.json', review),
    ]);
  }

  private async blockCurrentTask(
    conversationRoot: string,
    detail: string,
    reason: TransitionReason,
  ): Promise<void> {
    const taskId = this.getTaskId() ?? await this.resolveConversationHead(conversationRoot);
    if (!taskId) { return; }
    await this.blockTask(taskId, detail, reason);
  }

  private async blockTask(
    taskId: string,
    detail: string,
    reason: TransitionReason,
  ): Promise<void> {
    const task = await this.taskStore.getTask(taskId);
    if (!task) { return; }
    const phase = task.phase ?? statusToDefaultPhase(task.status);
    if (phase === 'blocked' || phase === 'failed' || phase === 'cancelled') { return; }
    if (!canTransition(phase, 'blocked')) {
      Logger.warn(`[TrustedSequentialAgentRuntime] Cannot block task ${taskId} from phase ${phase}: ${detail}`);
      return;
    }
    const machine = new AgentStateMachine(this.taskStore);
    await machine.transition(taskId, 'blocked', {
      reason,
      detail,
      blockedReason: detail,
    });
    await this.taskStore.updateTask(taskId, { validationPassed: false });
    await this.taskStore.appendEvent(taskId, 'task_blocked', { reason, detail });
    await this.taskStore.writeSnapshot(taskId);
  }

  private startHeartbeat(conversationRoot: string): ReturnType<typeof setInterval> {
    const interval = Math.max(5000, Config.getProgressHeartbeatMs());
    const timer = setInterval(() => {
      void this.writeHeartbeat(conversationRoot, false, 'running');
    }, interval);
    timer.unref?.();
    return timer;
  }

  private async writeHeartbeat(
    conversationRoot: string,
    stopped: boolean,
    stage: string,
  ): Promise<void> {
    const resolved = await this.resolveConversationHead(conversationRoot);
    const taskId = this.getTaskId() ?? resolved ?? conversationRoot;
    const task = await this.taskStore.getTask(taskId);
    let phase = 'preparing';
    let status = 'created';
    let usage: unknown;
    let pendingApprovalId: string | undefined;
    let blockedReason: string | undefined;
    if (task) {
      try {
        const snapshot = await this.getTask(taskId);
        phase = snapshot.phase;
        status = snapshot.task.status;
        usage = snapshot.usage;
        pendingApprovalId = snapshot.pendingApproval?.approvalId;
        blockedReason = snapshot.blockedReason;
      } catch {
        phase = task.phase ?? statusToDefaultPhase(task.status);
        status = task.status;
      }
    }
    const heartbeat = {
      schemaVersion: 1,
      taskId,
      conversationRoot,
      timestamp: nowIso(),
      stopped,
      stage,
      phase,
      status,
      usage,
      pendingApprovalId,
      blockedReason,
    };
    const destination = path.join(this.taskStore.getTaskDir(taskId), 'heartbeat.json');
    const temporary = `${destination}.${process.pid}.tmp`;
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(temporary, JSON.stringify(heartbeat, null, 2), 'utf8');
    await fs.rename(temporary, destination);
  }

  private async gitEvidence(): Promise<string> {
    try {
      await fs.access(path.join(this.roleWorkspaceRoot, '.git'));
      const [status, stat, diff] = await Promise.all([
        execFileAsync('git', ['status', '--short'], {
          cwd: this.roleWorkspaceRoot,
          timeout: 5000,
          windowsHide: true,
          maxBuffer: 1024 * 1024,
        }),
        execFileAsync('git', ['diff', '--stat'], {
          cwd: this.roleWorkspaceRoot,
          timeout: 5000,
          windowsHide: true,
          maxBuffer: 1024 * 1024,
        }),
        execFileAsync('git', ['diff', '--unified=2'], {
          cwd: this.roleWorkspaceRoot,
          timeout: 10000,
          windowsHide: true,
          maxBuffer: 2 * 1024 * 1024,
        }),
      ]);
      return [
        '## git status --short',
        status.stdout,
        '## git diff --stat',
        stat.stdout,
        '## git diff --unified=2',
        diff.stdout.slice(0, 30_000),
      ].join('\n');
    } catch (error) {
      return `Git evidence unavailable: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  private async readJson(filename: string): Promise<Record<string, unknown>> {
    try {
      return asObject(JSON.parse(await fs.readFile(filename, 'utf8')));
    } catch {
      return {};
    }
  }

  private createWorkflowRoot(): string {
    return `workflow_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }
}
