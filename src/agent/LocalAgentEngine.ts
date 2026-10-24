import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import { AgentLoop } from './AgentLoop';
import { ContextManager } from './ContextManager';
import { CheckpointManager } from './CheckpointManager';
import { TaskStore } from './TaskStore';
import { AgentStateMachine, statusToDefaultPhase } from './AgentStateMachine';
import { BudgetTracker, BudgetCheck } from './BudgetTracker';
import {
  AgentEngine,
  AgentEngineEvent,
  AgentPhase,
  AgentTaskSnapshot,
  ApprovalDecision,
  ContinueTaskInput,
  DEFAULT_TASK_BUDGETS,
  EngineSubscription,
  ForgeInvocationAuditMetadata,
  ForgeInvocationStatus,
  RollbackTarget,
  StartTaskRequest,
  SteeringMessage,
  TaskBudgets,
  TaskFilter,
  TaskUsage,
  ValidationCommandRequest,
  createInitialUsage,
} from './AgentEngineTypes';
import { projectAgentSnapshotToForgeStatus } from './ForgeStatusProjection';
import { PersistedMessage, PersistedTask } from './TaskTypes';
import { ApprovalFlow, ApprovalRequest } from '../policy/ApprovalFlow';
import { AuditService } from '../services/AuditService';
import { ProviderGateway } from '../providers/ProviderGateway';
import { buildSystemPrompt } from '../prompts/systemPrompt';
import { Config } from '../config/Config';
import { AgentMode } from '../config/ConfigSchema';
import { AgentLoopEvents, OllamaMessage, ToolContext, ToolResult } from '../tools/ToolTypes';
import { ValidationRunner } from '../validation/ValidationRunner';
import { TaskResultEvidence, ValidationCategory, ValidationSummary } from '../validation/ValidationTypes';
import { Logger } from '../services/Logger';
import { SerializablePermissionContext, StalePermissionContextError } from '../tools/PermissionContext';
import type { CoreClient } from '../core-client/CoreClient';
import { CoreDeniedActionsGuard } from '../tools/CoreDeniedActionsGuard';

interface ActiveExecution {
  controller: AbortController;
  requestedControl?: 'pause' | 'cancel';
  previousPhase: AgentPhase;
}

export interface RunSettings {
  validationCommands?: ValidationCommandRequest[];
  allowedPaths?: string[];
  permissionContext?: SerializablePermissionContext;
}

function hash(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function nowIso(): string {
  return new Date().toISOString();
}

function isTerminal(phase: AgentPhase): boolean {
  return phase === 'completed' || phase === 'failed' || phase === 'cancelled';
}

export class LocalAgentEngine implements AgentEngine {
  readonly taskStore: TaskStore;

  private readonly approval: ApprovalFlow;
  private readonly checkpoint: CheckpointManager;
  private readonly audit: AuditService;
  private readonly stateMachine: AgentStateMachine;
  private readonly validationRunner: ValidationRunner;
  private readonly extensionSessionId: string;
  private readonly listeners = new Map<string, Set<(event: AgentEngineEvent) => void>>();
  private readonly contexts = new Map<string, ContextManager>();
  private readonly active = new Map<string, ActiveExecution>();
  /** M38: one guard per task so a Core denial of a governed capability action
   * blocks an equivalent run_command replay across every turn of that task,
   * not just the turn it was denied on. */
  private readonly deniedActionsGuards = new Map<string, CoreDeniedActionsGuard>();
  private approvalTaskId: string | null = null;
  private approvalRequestCallback?: (request: ApprovalRequest) => void;
  private currentTaskId: string | null = null;
  /** M38: set by the owning panel (see AgentPanel.initRuntime) rather than
   * threaded through this class's long constructor-inheritance chain — a
   * plain module-scope import of the CoreManager singleton here would create
   * a circular-import class-extends ordering failure (getCoreManager lives in
   * ../extension, which imports this file transitively via AgentPanel). */
  private coreClient?: CoreClient;

  constructor(
    private readonly workspaceRoot: string,
    private readonly secrets: vscode.SecretStorage,
  ) {
    this.extensionSessionId = `engine_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.taskStore = new TaskStore(workspaceRoot);
    this.approval = new ApprovalFlow();
    this.checkpoint = new CheckpointManager(workspaceRoot);
    this.audit = new AuditService(workspaceRoot);
    this.stateMachine = new AgentStateMachine(this.taskStore);
    this.validationRunner = new ValidationRunner(workspaceRoot, this.taskStore);

    this.approval.onApprovalRequested = (id, toolName, args, riskLevel) => {
      const taskId = this.approvalTaskId;
      if (!taskId) { return; }
      this.taskStore.persistApproval(taskId, {
        approvalId: id,
        toolName,
        argsSummary: args,
        policyDecision: 'ask-once',
        riskLevel,
        requestedAt: nowIso(),
        status: 'pending',
      }).then(async () => {
        await this.taskStore.updateTask(taskId, { pendingApprovalId: id });
        const task = await this.taskStore.getTask(taskId);
        const phase = task?.phase ?? statusToDefaultPhase(task?.status ?? 'running');
        if (phase === 'executing') {
          await this.transition(taskId, 'waiting_for_approval', 'approval_required');
        }
        this.emit(taskId, 'approval_requested', { id, toolName, args, riskLevel });
      }).catch(error => Logger.error('[LocalAgentEngine] Failed to persist approval:', error));
    };

    this.approval.onApprovalResolved = (id, resolution) => {
      const taskId = this.approvalTaskId;
      if (!taskId) { return; }
      this.taskStore.updateApproval(taskId, id, {
        status: resolution,
        resolvedAt: nowIso(),
        resolution,
      }).then(async () => {
        await this.taskStore.updateTask(taskId, { pendingApprovalId: undefined });
        const task = await this.taskStore.getTask(taskId);
        if ((task?.phase ?? statusToDefaultPhase(task?.status ?? 'running')) === 'waiting_for_approval') {
          await this.transition(
            taskId,
            resolution === 'approved' ? 'executing' : 'blocked',
            resolution === 'approved' ? 'approval_granted' : 'approval_rejected',
            resolution === 'rejected' ? 'User rejected the requested operation.' : undefined,
          );
        }
        this.emit(taskId, 'approval_resolved', { id, resolution });
      }).catch(error => Logger.error('[LocalAgentEngine] Failed to update approval:', error));
    };

    this.approval.setOnRequest(request => {
      this.approvalRequestCallback?.(request);
    });
  }

  setApprovalRequestCallback(callback: (request: ApprovalRequest) => void): void {
    this.approvalRequestCallback = callback;
  }

  /** M38: the Core-backed governed_research/github_read_issue/github_comment_on_issue
   * tools are unavailable until this is set (they fail closed, per ToolExecutor). */
  setCoreClient(client: CoreClient | undefined): void {
    this.coreClient = client;
  }

  async startTask(request: StartTaskRequest): Promise<AgentTaskSnapshot> {
    const taskId = request.taskId ?? this.generateTaskId();
    await this.run(
      request.goal,
      request.mode,
      this.engineEventsToLegacy(taskId),
      request.images,
      request.model,
      taskId,
      {
        validationCommands: request.validationCommands,
      },
      request.budgets,
    );
    return this.getTask(taskId);
  }

  async continueTask(taskId: string, input: ContinueTaskInput, settings: RunSettings = {}): Promise<AgentTaskSnapshot> {
    const task = await this.requireTask(taskId);
    if (isTerminal(task.phase ?? statusToDefaultPhase(task.status))) {
      throw new Error(`Cannot continue terminal task ${taskId}.`);
    }
    await this.run(
      input.text,
      task.mode as AgentMode,
      this.engineEventsToLegacy(taskId),
      input.images,
      input.model ?? task.model,
      taskId,
      {
        validationCommands: this.toValidationCommands(task),
        allowedPaths: task.allowedPaths,
        permissionContext: settings.permissionContext,
      },
    );
    return this.getTask(taskId);
  }

  subscribe(taskId: string, listener: (event: AgentEngineEvent) => void): EngineSubscription {
    const set = this.listeners.get(taskId) ?? new Set<(event: AgentEngineEvent) => void>();
    set.add(listener);
    this.listeners.set(taskId, set);
    return {
      dispose: () => {
        const listeners = this.listeners.get(taskId);
        listeners?.delete(listener);
        if (listeners?.size === 0) { this.listeners.delete(taskId); }
      },
    };
  }

  async respondToApproval(
    taskId: string,
    approvalId: string,
    decision: ApprovalDecision,
  ): Promise<AgentTaskSnapshot> {
    const task = await this.requireTask(taskId);
    if (task.pendingApprovalId && task.pendingApprovalId !== approvalId) {
      throw new Error(`Approval ${approvalId} is not pending for task ${taskId}.`);
    }
    this.approvalTaskId = taskId;
    this.approval.respond(approvalId, decision);
    return this.getTask(taskId);
  }

  async sendSteering(taskId: string, message: string): Promise<AgentTaskSnapshot> {
    const content = message.trim();
    if (!content) { throw new Error('Steering message cannot be empty.'); }
    const task = await this.requireTask(taskId);
    const phase = task.phase ?? statusToDefaultPhase(task.status);
    if (isTerminal(phase)) { throw new Error(`Cannot steer terminal task ${taskId}.`); }

    const steering: SteeringMessage = {
      steeringId: `steer_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      taskId,
      content,
      createdAt: nowIso(),
    };
    await this.taskStore.updateTask(taskId, {
      pendingSteering: [...(task.pendingSteering ?? []), steering],
    });
    await this.taskStore.appendEvent(taskId, 'steering_received', {
      steeringId: steering.steeringId,
      content,
    });
    this.emit(taskId, 'steering_accepted', { steeringId: steering.steeringId });
    return this.getTask(taskId);
  }

  async pauseTask(taskId: string): Promise<AgentTaskSnapshot> {
    const task = await this.requireTask(taskId);
    const phase = task.phase ?? statusToDefaultPhase(task.status);
    if (isTerminal(phase)) { return this.getTask(taskId); }

    const active = this.active.get(taskId);
    if (active) {
      active.requestedControl = 'pause';
      active.controller.abort();
    }
    if (phase !== 'paused') {
      await this.transition(taskId, 'paused', 'user_pause', undefined, phase);
    }
    await this.taskStore.appendEvent(taskId, 'task_paused', { previousPhase: phase });
    this.emit(taskId, 'paused', { previousPhase: phase });
    return this.getTask(taskId);
  }

  async resumeTask(taskId: string, settings: RunSettings = {}): Promise<AgentTaskSnapshot> {
    const task = await this.requireTask(taskId);
    const phase = task.phase ?? statusToDefaultPhase(task.status);
    if (isTerminal(phase)) { throw new Error(`Cannot resume terminal task ${taskId}.`); }
    if (task.blockedReason?.includes('mutation_outcome_uncertain')) {
      throw new Error('Task has an uncertain mutation outcome. Inspect or rollback before resuming.');
    }

    const target = task.resumePhase ?? (phase === 'blocked' ? 'ready' : 'executing');
    if (phase === 'paused' || phase === 'blocked' || phase === 'recovering') {
      await this.transition(taskId, target, 'user_resume');
      await this.taskStore.appendEvent(taskId, 'task_resumed', { target });
      this.emit(taskId, 'resumed', { target });
    }

    await this.execute(taskId, '', undefined, task.model, {
      validationCommands: this.toValidationCommands(task),
      allowedPaths: task.allowedPaths,
      permissionContext: settings.permissionContext,
    });
    return this.getTask(taskId);
  }

  async cancelTask(taskId: string): Promise<AgentTaskSnapshot> {
    const task = await this.requireTask(taskId);
    const phase = task.phase ?? statusToDefaultPhase(task.status);
    if (phase === 'cancelled') { return this.getTask(taskId); }
    if (phase === 'completed' || phase === 'failed') { return this.getTask(taskId); }

    const active = this.active.get(taskId);
    if (active) {
      active.requestedControl = 'cancel';
      active.controller.abort();
    }
    this.approval.cancelAll();
    await this.transition(taskId, 'cancelled', 'user_cancel');
    await this.taskStore.appendEvent(taskId, 'task_cancelled', { reason: 'user_cancel' });
    this.emit(taskId, 'cancelled', {});
    return this.getTask(taskId);
  }

  async getTask(taskId: string): Promise<AgentTaskSnapshot> {
    const task = await this.requireTask(taskId);
    const approvals = await this.taskStore.getCurrentApprovals(taskId);
    const checkpoints = await this.taskStore.getCheckpointRefs(taskId);
    const budgets = { ...DEFAULT_TASK_BUDGETS, ...(task.engineBudgets ?? {}) } as TaskBudgets;
    const usage = { ...createInitialUsage(task.startedAt ?? task.createdAt), ...(task.engineUsage ?? {}) } as TaskUsage;
    return {
      task,
      phase: task.phase ?? statusToDefaultPhase(task.status),
      budgets,
      usage,
      pendingApproval: approvals.find(approval => approval.status === 'pending'),
      checkpoints,
      blockedReason: task.blockedReason,
      validationPassed: task.validationPassed,
    };
  }

  async getForgeInvocationStatus(
    taskId: string,
    invocationId: string,
    audit?: ForgeInvocationAuditMetadata,
  ): Promise<ForgeInvocationStatus> {
    return projectAgentSnapshotToForgeStatus(await this.getTask(taskId), { invocationId, audit });
  }

  async listTasks(filter?: TaskFilter): Promise<AgentTaskSnapshot[]> {
    const tasks = await this.taskStore.listTasks();
    const snapshots = await Promise.all(tasks.map(task => this.getTask(task.taskId)));
    return snapshots.filter(snapshot => {
      if (filter?.phases && !filter.phases.includes(snapshot.phase)) { return false; }
      if (filter?.includeTerminal === false && isTerminal(snapshot.phase)) { return false; }
      return true;
    });
  }

  async rollbackTask(taskId: string, target: RollbackTarget): Promise<AgentTaskSnapshot> {
    await this.requireTask(taskId);
    switch (target.kind) {
      case 'checkpoint':
        await this.checkpoint.rewindCheckpoint(target.checkpointId);
        await this.taskStore.updateCheckpointRef(taskId, target.checkpointId, {
          restorationStatus: 'restored',
        });
        break;
      case 'iteration':
        await this.checkpoint.rewindIteration(target.iterationId);
        break;
      case 'last_action':
        await this.checkpoint.rewindLastCheckpoint();
        break;
      case 'task_start':
        if (!target.confirm) { throw new Error('Task-start rollback requires explicit confirmation.'); }
        await this.checkpoint.rewindAll({ confirm: true });
        break;
    }
    return this.getTask(taskId);
  }

  /**
   * Backward-compatible adapter used by AgentPanel. All execution still flows
   * through the explicit phase machine and validation gate.
   */
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
    const effectiveTaskId = taskId ?? this.currentTaskId ?? this.generateTaskId();
    this.currentTaskId = effectiveTaskId;
    const existing = await this.taskStore.getTask(effectiveTaskId);

    if (!existing) {
      const model = modelOverride ?? Config.getAgentModel();
      const budgets: TaskBudgets = {
        ...DEFAULT_TASK_BUDGETS,
        maxIterations: Config.getMaxIterations(),
        maxCommandDurationMs: Config.getCommandTimeoutMs(),
        ...budgetOverrides,
      };
      const usage = createInitialUsage();
      await this.taskStore.createTask({
        taskId: effectiveTaskId,
        workspaceId: this.workspaceRoot,
        workspaceRoot: this.workspaceRoot,
        userGoal: text,
        mode,
        model,
        providerType: Config.getProviderType(),
        title: text.length > 60 ? `${text.slice(0, 60)}…` : text,
      });
      await this.taskStore.updateTask(effectiveTaskId, {
        phase: 'created',
        engineBudgets: budgets,
        engineUsage: usage,
        validationCommands: settings.validationCommands,
        allowedPaths: settings.allowedPaths,
      });
      await this.taskStore.appendEvent(effectiveTaskId, 'task_created', {
        userGoal: text,
        mode,
        model,
        providerType: Config.getProviderType(),
        workspaceRoot: this.workspaceRoot,
        workspaceId: this.workspaceRoot,
        extensionSessionId: this.extensionSessionId,
      });
      await this.transition(effectiveTaskId, 'understanding', 'user_request');
      await this.taskStore.appendEvent(effectiveTaskId, 'assistant_message', {
        kind: 'understanding_artifact',
        goal: text,
        mode,
        model,
      });
      await this.transition(effectiveTaskId, 'planning', 'model_result');
      await this.writePlan(effectiveTaskId, text, settings.validationCommands);
      await this.transition(effectiveTaskId, 'ready', 'model_result');
    } else {
      const phase = existing.phase ?? statusToDefaultPhase(existing.status);
      if (isTerminal(phase)) {
        throw new Error(`Cannot run terminal task ${effectiveTaskId}. Start a new task instead.`);
      }
      if (settings.validationCommands || settings.allowedPaths) {
        await this.taskStore.updateTask(effectiveTaskId, {
          validationCommands: settings.validationCommands ?? existing.validationCommands,
          allowedPaths: settings.allowedPaths ?? existing.allowedPaths,
        });
      }
    }

    await this.execute(effectiveTaskId, text, images, modelOverride, settings, events);
  }

  stop(): void {
    if (!this.currentTaskId) { return; }
    void this.cancelTask(this.currentTaskId);
  }

  clearSession(): void {
    this.currentTaskId = null;
  }

  isRunning(): boolean {
    return this.currentTaskId !== null && this.active.has(this.currentTaskId);
  }

  getTaskId(): string | null {
    return this.currentTaskId;
  }

  private async execute(
    taskId: string,
    text: string,
    images: string[] | undefined,
    modelOverride: string | undefined,
    settings: RunSettings,
    legacyEvents?: AgentLoopEvents,
  ): Promise<void> {
    if (this.active.has(taskId)) { throw new Error(`Task ${taskId} is already executing.`); }

    const task = await this.requireTask(taskId);
    const phase = task.phase ?? statusToDefaultPhase(task.status);
    const controller = new AbortController();
    this.active.set(taskId, { controller, previousPhase: phase });
    this.approvalTaskId = taskId;

    const lockAcquired = await this.taskStore.acquireLock(taskId, this.extensionSessionId);
    if (!lockAcquired) {
      this.active.delete(taskId);
      throw new Error(`Task ${taskId} is locked by another writer.`);
    }

    try {
      const context = await this.getOrCreateContext(taskId, task.mode as AgentMode);
      await this.applyPendingSteering(taskId, context);
      if (text.trim()) {
        context.addUserMessage(text, images);
        await this.taskStore.appendEvent(taskId, 'user_message', {
          content: text,
          hasImages: (images?.length ?? 0) > 0,
          imageCount: images?.length ?? 0,
        });
      }

      let current = await this.requireTask(taskId);
      let currentPhase = current.phase ?? statusToDefaultPhase(current.status);
      if (currentPhase !== 'executing') {
        await this.transition(taskId, 'executing', 'user_request');
      }

      while (true) {
        current = await this.requireTask(taskId);
        const tracker = new BudgetTracker(current.engineBudgets, current.engineUsage);
        tracker.resume();
        await this.persistUsage(taskId, tracker.snapshot());

        let budgetFailure: BudgetCheck | undefined;
        let outputBytes = 0;
        const wrapped = this.wrapLegacyEvents(taskId, legacyEvents, delta => {
          outputBytes += Buffer.byteLength(delta, 'utf8');
          const check = tracker.consumeOutput(Buffer.byteLength(delta, 'utf8'));
          if (!check.ok && !budgetFailure) {
            budgetFailure = check;
            controller.abort();
          }
        });

        const provider = await ProviderGateway.create(this.secrets);
        let deniedActionsGuard = this.deniedActionsGuards.get(taskId);
        if (!deniedActionsGuard) {
          deniedActionsGuard = new CoreDeniedActionsGuard();
          this.deniedActionsGuards.set(taskId, deniedActionsGuard);
        }
        const loop = new AgentLoop(context, {
          workspaceRoot: this.workspaceRoot,
          approvalFlow: this.approval,
          checkpointManager: this.checkpoint,
          auditService: this.audit,
          provider,
          modelOverride: modelOverride ?? current.model,
          mode: current.mode as AgentMode,
          taskStore: this.taskStore,
          taskId,
          coreClient: this.coreClient,
          deniedActionsGuard,
          maxIterations: Math.max(1, tracker.budgets.maxIterations - tracker.snapshot().iterations),
          beforeModelCall: async iteration => {
            const modelCheck = tracker.consumeModelCall();
            const iterationCheck = tracker.consumeIteration();
            await this.persistUsage(taskId, tracker.snapshot());
            if (!modelCheck.ok) { throw new Error(modelCheck.message); }
            if (!iterationCheck.ok) { throw new Error(iterationCheck.message); }
            await this.taskStore.updateTask(taskId, { currentIteration: iteration });
          },
          beforeToolCall: async toolCall => {
            const toolCheck = tracker.consumeToolCall();
            await this.persistUsage(taskId, tracker.snapshot());
            if (!toolCheck.ok) { throw new Error(toolCheck.message); }
            await this.taskStore.appendEvent(taskId, 'tool_requested', {
              toolName: toolCall.function.name,
              toolCallId: toolCall.id,
            });
          },
          permissionContext: settings.permissionContext,
          permissionRunId: taskId,
        });

        const toolContext: ToolContext = {
          workspaceRoot: this.workspaceRoot,
          sessionId: taskId,
          taskId,
          turnId: `turn_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          model: current.model,
          mode: current.mode as AgentMode,
        };

        const result = await loop.run(toolContext, wrapped, controller.signal);
        await this.persistUsage(taskId, tracker.snapshot());

        const active = this.active.get(taskId);
        if (active?.requestedControl === 'cancel') { return; }
        if (active?.requestedControl === 'pause') { return; }
        if (budgetFailure) {
          await this.handleBudgetFailure(taskId, budgetFailure);
          return;
        }
        if (controller.signal.aborted) { return; }
        if (result.stoppedByLimit) {
          await this.transition(
            taskId,
            'blocked',
            'budget_exhausted',
            result.finalContent,
          );
          await this.taskStore.appendEvent(taskId, 'budget_exhausted', {
            kind: 'iterations',
            message: result.finalContent,
          });
          this.emit(taskId, 'budget_exhausted', { kind: 'iterations' });
          return;
        }

        const checkpoints = await this.taskStore.getCheckpointRefs(taskId);
        const progressFingerprint = hash(JSON.stringify({
          finalContent: result.finalContent,
          checkpointIds: checkpoints.map(checkpoint => checkpoint.checkpointId),
          outputBytes,
        }));
        const progressCheck = tracker.recordProgress(progressFingerprint);
        await this.persistUsage(taskId, tracker.snapshot());
        if (!progressCheck.ok) {
          await this.taskStore.appendEvent(taskId, 'loop_detected', {
            kind: 'no_progress',
            fingerprint: progressFingerprint,
          });
          await this.transition(taskId, 'blocked', 'no_progress', progressCheck.message);
          this.emit(taskId, 'loop_detected', { kind: 'no_progress' });
          return;
        }

        await this.transition(taskId, 'validating', 'model_result');
        const mode = current.mode as AgentMode;
        const validation = mode === 'agent'
          ? await this.validationRunner.run({
              taskId,
              attempt: (current.validationAttempt ?? 0) + 1,
              explicitGates: (settings.validationCommands ?? this.toValidationCommands(current)).map(command => ({
                ...command,
                category: command.category as ValidationCategory,
              })),
              allowedPaths: settings.allowedPaths ?? current.allowedPaths,
              defaultTimeoutMs: tracker.budgets.maxCommandDurationMs,
              signal: controller.signal,
            })
          : await this.createNonAgentValidation(taskId, (current.validationAttempt ?? 0) + 1);

        await this.taskStore.updateTask(taskId, {
          validationPassed: validation.passed,
          validationAttempt: validation.attempt,
        });
        this.emit(taskId, 'validation_result', {
          passed: validation.passed,
          attempt: validation.attempt,
          failureFingerprint: validation.failureFingerprint,
        });

        if (validation.passed) {
          await this.transition(taskId, 'completed', 'validation_passed');
          await this.taskStore.appendEvent(taskId, 'task_completed', {
            validationAttempt: validation.attempt,
          });
          await this.writeResult(taskId, validation, result.finalContent);
          this.emit(taskId, 'completed', { validationAttempt: validation.attempt });
          return;
        }

        tracker.recordValidationFingerprint(validation.failureFingerprint ?? 'validation-failed');
        const usage = tracker.snapshot();
        await this.persistUsage(taskId, usage);
        if (usage.repairAttempts >= tracker.budgets.maxRepairAttempts) {
          await this.transition(taskId, 'failed', 'budget_exhausted', 'Repair budget exhausted.');
          await this.taskStore.updateTask(taskId, {
            failure: {
              message: 'Required validation failed and the repair budget was exhausted.',
              code: 'VALIDATION_REPAIR_EXHAUSTED',
              timestamp: nowIso(),
            },
          });
          this.emit(taskId, 'failed', { reason: 'repair_budget_exhausted' });
          return;
        }
        if (usage.repeatedValidationFailures >= 2) {
          await this.taskStore.appendEvent(taskId, 'loop_detected', {
            kind: 'unchanged_validation_failure',
            fingerprint: validation.failureFingerprint,
          });
          await this.transition(
            taskId,
            'blocked',
            'no_progress',
            'The same required validation failure repeated without progress.',
          );
          this.emit(taskId, 'loop_detected', { kind: 'unchanged_validation_failure' });
          return;
        }

        await this.transition(taskId, 'repairing', 'validation_failed');
        const repairCheck = tracker.consumeRepairAttempt();
        await this.persistUsage(taskId, tracker.snapshot());
        if (!repairCheck.ok) {
          await this.handleBudgetFailure(taskId, repairCheck);
          return;
        }
        await this.taskStore.appendEvent(taskId, 'repair_started', {
          attempt: tracker.snapshot().repairAttempts,
          failureFingerprint: validation.failureFingerprint,
        });
        this.emit(taskId, 'repair_started', {
          attempt: tracker.snapshot().repairAttempts,
        });
        context.addUserMessage(this.buildRepairPrompt(validation, usage.repeatedValidationFailures));
        await this.applyPendingSteering(taskId, context);
        await this.transition(taskId, 'executing', 'repair_requested');
      }
    } catch (error) {
      const active = this.active.get(taskId);
      if (active?.requestedControl === 'pause' || active?.requestedControl === 'cancel') {
        return;
      }
      const isStalePermission = error instanceof StalePermissionContextError;
      const message = error instanceof Error ? error.message : String(error);
      const current = await this.taskStore.getTask(taskId);
      const currentPhase = current?.phase ?? statusToDefaultPhase(current?.status ?? 'running');
      if (!isTerminal(currentPhase)) {
        // A stale permission context fails closed to a resumable, non-terminal state so the
        // next user turn (which mints a fresh context) can proceed without losing history —
        // it must never be silently retried against the same context.
        const targetPhase = isStalePermission ? 'blocked' : 'failed';
        const reason = isStalePermission ? 'stale_permission_context' : 'internal_error';
        await this.transition(taskId, targetPhase, reason, message).catch(() => undefined);
        await this.taskStore.updateTask(taskId, {
          failure: { message, code: isStalePermission ? 'STALE_PERMISSION_CONTEXT' : 'ENGINE_FAILURE', timestamp: nowIso() },
        }).catch(() => undefined);
      }
      legacyEvents?.onError?.(message);
      this.emit(taskId, isStalePermission ? 'blocked' : 'failed', { message });
    } finally {
      await this.taskStore.releaseLock(taskId, this.extensionSessionId).catch(() => undefined);
      this.active.delete(taskId);
      if (this.approvalTaskId === taskId) { this.approvalTaskId = null; }
    }
  }

  private async transition(
    taskId: string,
    to: AgentPhase,
    reason: Parameters<AgentStateMachine['transition']>[2]['reason'],
    detail?: string,
    resumePhase?: AgentPhase,
  ): Promise<void> {
    await this.stateMachine.transition(taskId, to, {
      reason,
      detail,
      resumePhase,
      blockedReason: to === 'blocked' ? detail : undefined,
    });
    this.emit(taskId, 'phase_transition', { to, reason, detail, resumePhase });
  }

  private async getOrCreateContext(taskId: string, mode: AgentMode): Promise<ContextManager> {
    const existing = this.contexts.get(taskId);
    const prompt = buildSystemPrompt(this.workspaceRoot, mode);
    if (existing) {
      existing.updateSystemPrompt(prompt);
      return existing;
    }
    const persisted = await this.taskStore.getMessages(taskId);
    const messages = this.rehydrateMessages(persisted, prompt);
    const context = new ContextManager(prompt, messages, this.makeMessagePersister(taskId));
    this.contexts.set(taskId, context);
    return context;
  }

  private rehydrateMessages(persisted: PersistedMessage[], systemPrompt: string): OllamaMessage[] {
    const messages: OllamaMessage[] = [];
    if (!persisted.some(message => message.role === 'system')) {
      messages.push({ role: 'system', content: systemPrompt });
    }
    for (const message of persisted) {
      const hydrated: OllamaMessage = { role: message.role, content: message.content };
      if (message.role === 'assistant' && message.toolCallIds?.length) {
        hydrated.tool_calls = message.toolCallIds.map(id => ({
          id,
          function: { name: '[restored]', arguments: {} },
        }));
      }
      messages.push(hydrated);
    }
    return messages;
  }

  private makeMessagePersister(taskId: string): (message: OllamaMessage) => void {
    return message => {
      void this.taskStore.appendMessage(taskId, {
        role: message.role,
        content: message.content ?? '',
        timestamp: nowIso(),
        toolCallIds: message.tool_calls?.map(call => call.id ?? call.function.name),
        imageRefs: message.images?.map((_, index) => `[image-ref:${index}]`),
      }).catch(error => Logger.error('[LocalAgentEngine] Failed to persist message:', error));
    };
  }

  private wrapLegacyEvents(
    taskId: string,
    events: AgentLoopEvents | undefined,
    onTokenBytes: (delta: string) => void,
  ): AgentLoopEvents {
    return {
      onToken: delta => {
        onTokenBytes(delta);
        events?.onToken?.(delta);
        this.emit(taskId, 'token_delta', { delta });
      },
      onAssistantContent: content => {
        events?.onAssistantContent?.(content);
        this.emit(taskId, 'model_completed', { contentLength: content.length });
      },
      onIterationStart: iteration => {
        events?.onIterationStart?.(iteration);
        this.emit(taskId, 'model_started', { iteration });
      },
      onModelSelected: (model, reason) => {
        events?.onModelSelected?.(model, reason);
        this.emit(taskId, 'snapshot', { model, reason });
      },
      onToolStart: (toolName, args) => {
        events?.onToolStart?.(toolName, args);
        this.emit(taskId, 'tool_started', { toolName, args });
      },
      onToolResult: (toolName, result: ToolResult) => {
        events?.onToolResult?.(toolName, result);
        this.emit(taskId, result.ok ? 'tool_completed' : 'tool_failed', {
          toolName,
          ok: result.ok,
          error: result.ok ? undefined : result.error,
        });
      },
      onDone: content => {
        events?.onDone?.(content);
        this.emit(taskId, 'model_completed', { contentLength: content.length });
      },
      onContextUsage: usage => {
        events?.onContextUsage?.(usage);
        // Numeric context metadata only — never message text.
        this.emit(taskId, 'snapshot', {
          contextStatus: usage.status,
          contextProjectedTotal: usage.projectedTotal,
          contextEffectiveLimit: usage.limit.effectiveLimit,
          contextProvenance: usage.limit.provenance,
        });
      },
      onRepositoryContext: status => {
        events?.onRepositoryContext?.(status);
        this.emit(taskId, 'snapshot', {
          repositoryIntelligenceState: status.state,
          repositoryBranch: status.identity.branch,
          repositoryHead: status.identity.headCommit,
          repositoryContextTokens: status.estimatedTokens,
          repositoryContextFiles: status.selectedFiles.map(file => file.path),
          repositoryContextOmitted: status.omittedCount,
        });
      },
      onReliabilityEvent: event => {
        events?.onReliabilityEvent?.(event);
        this.emit(taskId, 'snapshot', { reliabilityCode: event.code });
      },
      onError: error => events?.onError?.(error),
      onStopped: () => events?.onStopped?.(),
      onApprovalRequest: events?.onApprovalRequest,
    };
  }

  private engineEventsToLegacy(taskId: string): AgentLoopEvents {
    return {
      onToken: delta => this.emit(taskId, 'token_delta', { delta }),
      onToolStart: (toolName, args) => this.emit(taskId, 'tool_started', { toolName, args }),
      onToolResult: (toolName, result) => this.emit(
        taskId,
        result.ok ? 'tool_completed' : 'tool_failed',
        { toolName, ok: result.ok },
      ),
      onDone: content => this.emit(taskId, 'model_completed', { contentLength: content.length }),
      onError: message => this.emit(taskId, 'failed', { message }),
      onStopped: () => this.emit(taskId, 'cancelled', {}),
    };
  }

  private async applyPendingSteering(taskId: string, context: ContextManager): Promise<void> {
    const task = await this.requireTask(taskId);
    const pending = task.pendingSteering ?? [];
    if (pending.length === 0) { return; }
    const appliedAt = nowIso();
    for (const steering of pending) {
      context.addUserMessage(`[Steering instruction]\n${steering.content}`);
      await this.taskStore.appendEvent(taskId, 'steering_applied', {
        steeringId: steering.steeringId,
        appliedAt,
      });
    }
    await this.taskStore.updateTask(taskId, {
      pendingSteering: pending.map(steering => ({ ...steering, appliedAt })),
    });
  }

  private async persistUsage(taskId: string, usage: TaskUsage): Promise<void> {
    await this.taskStore.updateTask(taskId, { engineUsage: usage });
  }

  private async handleBudgetFailure(taskId: string, failure: BudgetCheck): Promise<void> {
    await this.taskStore.appendEvent(taskId, 'budget_exhausted', {
      kind: failure.kind,
      message: failure.message,
    });
    await this.transition(taskId, 'blocked', 'budget_exhausted', failure.message);
    this.emit(taskId, 'budget_exhausted', {
      kind: failure.kind,
      message: failure.message,
    });
  }

  private async createNonAgentValidation(taskId: string, attempt: number): Promise<ValidationSummary> {
    const timestamp = nowIso();
    const summary: ValidationSummary = {
      schemaVersion: 1,
      taskId,
      attempt,
      startedAt: timestamp,
      completedAt: timestamp,
      passed: true,
      requiredPassed: true,
      results: [],
      filesChanged: [],
      commandsRun: [],
    };
    await this.taskStore.appendEvent(taskId, 'validation_started', {
      attempt,
      skippedForMode: true,
    });
    await this.taskStore.appendEvent(taskId, 'validation_result', {
      attempt,
      passed: true,
      skippedForMode: true,
    });
    return summary;
  }

  private buildRepairPrompt(validation: ValidationSummary, repeatedFailures: number): string {
    const failed = validation.results
      .filter(result => result.gate.required && result.status !== 'passed')
      .map(result => `${result.gate.category}: ${result.gate.command}\n${result.stderr || result.stdout}`)
      .join('\n\n');
    const strategy = repeatedFailures > 0
      ? '\nThe same validation failure repeated. Change strategy instead of repeating the previous edit.'
      : '';
    return `Required validation failed. Repair only the failures below, then stop for validation again.\n\n${failed}${strategy}`;
  }

  private async writePlan(
    taskId: string,
    goal: string,
    validationCommands?: ValidationCommandRequest[],
  ): Promise<void> {
    const taskDir = this.taskStore.getTaskDir(taskId);
    await fs.mkdir(taskDir, { recursive: true });
    const destination = path.join(taskDir, 'plan.md');
    const temp = `${destination}.${process.pid}.tmp`;
    const validation = validationCommands?.length
      ? validationCommands.map(command => `- ${command.required ? '[required]' : '[optional]'} ${command.command}`).join('\n')
      : '- Discover repository compile and test gates before completion.';
    const content = `# Task Plan\n\n## Goal\n${goal}\n\n## Execution\n1. Inspect relevant repository state.\n2. Make bounded changes with checkpoints.\n3. Run mechanical validation.\n4. Repair validation failures within budget.\n5. Complete only when required gates pass.\n\n## Validation\n${validation}\n`;
    await fs.writeFile(temp, content, 'utf8');
    await fs.rename(temp, destination);
  }

  private async writeResult(
    taskId: string,
    validation: ValidationSummary,
    finalContent: string,
  ): Promise<void> {
    const taskDir = this.taskStore.getTaskDir(taskId);
    await fs.mkdir(taskDir, { recursive: true });
    const result: TaskResultEvidence = {
      schemaVersion: 1,
      taskId,
      completedAt: nowIso(),
      success: validation.passed,
      filesChanged: validation.filesChanged,
      commandsRun: validation.commandsRun,
      validation,
      acceptanceResults: validation.results
        .filter(item => item.gate.category === 'acceptance')
        .map(item => ({
          name: item.gate.command,
          passed: item.status === 'passed',
          detail: item.stderr || item.stdout,
        })),
      testsAdded: validation.filesChanged.filter(file => /(?:test|spec)\./i.test(file)),
      limitations: finalContent ? [] : ['The model returned no final narrative content.'],
    };
    const destination = path.join(taskDir, 'result.json');
    const temp = `${destination}.${process.pid}.tmp`;
    await fs.writeFile(temp, JSON.stringify(result, null, 2), 'utf8');
    await fs.rename(temp, destination);
    await this.taskStore.appendEvent(taskId, 'task_result_written', {
      success: result.success,
      filesChanged: result.filesChanged,
      commandsRun: result.commandsRun,
    });
  }

  private toValidationCommands(task: PersistedTask): ValidationCommandRequest[] {
    return (task.validationCommands ?? []).map(command => ({
      id: command.id,
      category: command.category as ValidationCommandRequest['category'],
      command: command.command,
      required: command.required,
      timeoutMs: command.timeoutMs,
    }));
  }

  private async requireTask(taskId: string): Promise<PersistedTask> {
    const task = await this.taskStore.getTask(taskId);
    if (!task) { throw new Error(`Task not found: ${taskId}`); }
    return task;
  }

  private generateTaskId(): string {
    return `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  private emit(taskId: string, type: AgentEngineEvent['type'], payload: Record<string, unknown>): void {
    const event: AgentEngineEvent = {
      eventId: `engine_evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      taskId,
      type,
      timestamp: nowIso(),
      payload,
    };
    for (const listener of this.listeners.get(taskId) ?? []) {
      try { listener(event); } catch (error) {
        Logger.warn('[LocalAgentEngine] Subscriber failed:', error);
      }
    }
  }
}
