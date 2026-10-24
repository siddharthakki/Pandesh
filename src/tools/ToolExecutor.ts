import { ToolCall, ToolResult, ToolContext, ToolExecutionEvents } from './ToolTypes';
import { ToolRegistry, ExtendedToolContext } from './ToolRegistry';
import { PolicyDecision, PolicyEngine } from '../policy/PolicyEngine';
import { ApprovalFlow } from '../policy/ApprovalFlow';
import { CheckpointManager } from '../agent/CheckpointManager';
import { DEFAULT_TASK_BUDGETS } from '../agent/AgentEngineTypes';
import { AuditService } from '../services/AuditService';
import { Config } from '../config/Config';
import { TaskStore } from '../agent/TaskStore';
import { Logger } from '../services/Logger';
import { parseUnifiedPatch } from '../editing/PatchParser';
import { ContractEnforcer, TaskContract } from '../autonomy/TaskContract';
import { TaskContractStore } from '../autonomy/TaskContractStore';
import {
  canonicalizeStrictTaskArguments,
  extractStrictTaskScope,
  evaluateStrictTaskAction,
  StrictTaskScope,
} from '../agent/StrictTaskScope';
import {
  SerializablePermissionContext,
  StalePermissionContextError,
  denialFromAuthorization,
  formatPermissionDenial,
  grantsFromPermissionContext,
  validateBoundPermissionContext,
} from './PermissionContext';
import type { CoreClient } from '../core-client/CoreClient';
import { CoreDeniedActionsGuard } from './CoreDeniedActionsGuard';

/**
 * M38: tool names whose authorization, execution, and evidence are entirely
 * owned by Core (core/domain/capabilityDispatch.ts) — see ADR-7 in
 * AI_OS_HISTORY.md. Never authorized locally, never executed locally, never
 * recorded as a local authoritative audit record.
 */
export const CORE_BACKED_CAPABILITY_TOOLS: ReadonlySet<string> = new Set([
  'governed_research',
  'github_read_issue',
  'github_comment_on_issue',
  // M39: memory is a Core-owned governed capability on the identical path —
  // never a local store, never a second approval authority (ADR-7).
  'memory_remember',
  'memory_recall',
  'memory_resolve_contradiction',
  'memory_impact',
  'memory_export',
  'memory_forget',
]);

/**
 * M39: minimal human-readable labels for the existing capability approval
 * card. These do NOT introduce a second approval protocol — the card, the
 * envelope, and the decision are all still M38's.
 */
export const MEMORY_APPROVAL_PROMPTS: Readonly<Record<string, string>> = Object.freeze({
  memory_remember: 'Remember this decision?',
  memory_forget: 'Forget this memory?',
  memory_resolve_contradiction: 'Resolve this contradiction?',
});

export interface ToolExecutorDependencies {
  workspaceRoot: string;
  approvalFlow: ApprovalFlow;
  checkpointManager: CheckpointManager;
  auditService: AuditService;
  policyEngine?: PolicyEngine;
  taskStore?: TaskStore;
  taskId?: string;
  permissionContext?: SerializablePermissionContext;
  permissionRunId?: string;
  /** M38: required to reach any Core-backed capability tool. Without it,
   * those tools fail closed rather than falling back to local execution. */
  coreClient?: CoreClient;
  /** M38: shared across a task's ToolExecutor calls so a Core denial also
   * blocks an equivalent run_command bypass attempt within the same task. */
  deniedActionsGuard?: CoreDeniedActionsGuard;
}

function extractPatchPaths(patch: unknown): string[] {
  if (typeof patch !== 'string' || !patch.trim()) { return []; }
  try {
    return parseUnifiedPatch(patch)
      .map(file => file.newPath ?? file.oldPath)
      .filter((candidate): candidate is string => Boolean(candidate));
  } catch {
    return [];
  }
}

export function extractFilePaths(toolName: string, args: Record<string, unknown>): string[] {
  if (toolName === 'rename_file' || toolName === 'move_file') {
    const result: string[] = [];
    if (typeof args['from'] === 'string' && args['from']) { result.push(args['from']); }
    if (typeof args['to'] === 'string' && args['to']) { result.push(args['to']); }
    return result;
  }
  if (toolName === 'apply_patch' || toolName === 'edit_file') {
    const patchPaths = extractPatchPaths(args['patch']);
    if (patchPaths.length > 0) { return [...new Set(patchPaths)]; }
  }
  const candidate = args['path'];
  if (typeof candidate === 'string' && candidate) { return [candidate]; }
  const candidates = args['paths'];
  if (Array.isArray(candidates)) {
    return [...new Set(candidates.filter((item): item is string => typeof item === 'string'))];
  }
  return [];
}

export class ToolExecutor {
  private readonly policyEngine: PolicyEngine;
  private readonly approvalFlow: ApprovalFlow;
  private readonly checkpointManager: CheckpointManager;
  private readonly auditService: AuditService;
  private readonly taskStore?: TaskStore;
  private readonly taskId?: string;
  private readonly permissionContext?: SerializablePermissionContext;
  private readonly permissionRunId?: string;
  private readonly contractStore?: TaskContractStore;
  private readonly contractEnforcer = new ContractEnforcer();
  private readonly coreClient?: CoreClient;
  private readonly deniedActionsGuard: CoreDeniedActionsGuard;
  private readonly workspaceRoot: string;

  constructor(deps: ToolExecutorDependencies) {
    this.approvalFlow = deps.approvalFlow;
    this.checkpointManager = deps.checkpointManager;
    this.auditService = deps.auditService;
    this.policyEngine = deps.policyEngine ?? new PolicyEngine();
    this.taskStore = deps.taskStore;
    this.taskId = deps.taskId;
    this.permissionContext = deps.permissionContext;
    this.permissionRunId = deps.permissionRunId;
    this.contractStore = deps.taskStore ? new TaskContractStore(deps.taskStore) : undefined;
    this.coreClient = deps.coreClient;
    this.deniedActionsGuard = deps.deniedActionsGuard ?? new CoreDeniedActionsGuard();
    this.workspaceRoot = deps.workspaceRoot;
  }

  clearRejections(): void {
    this.policyEngine.clearRejections();
  }

  async execute(
    toolCall: ToolCall,
    context: ToolContext,
    events?: ToolExecutionEvents,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    const toolName = toolCall.function.name;

    // M38: Core-backed capability tools bypass every local decision path
    // below entirely — local PolicyEngine/GovernedToolRegistry must never
    // become the final authority for them (ADR-7).
    if (CORE_BACKED_CAPABILITY_TOOLS.has(toolName)) {
      return this.executeCoreBackedCapability(toolCall, context, events, signal);
    }

    if (toolName === 'run_command') {
      const command = String(toolCall.function.arguments['command'] ?? '');
      const blockedReason = this.deniedActionsGuard.blockedRunCommandReason(command);
      if (blockedReason) {
        return { ok: false, error: blockedReason, blocked: true, policyViolation: true };
      }
    }

    const tool = ToolRegistry.get(toolName);
    if (!tool) { return { ok: false, error: `Tool not found: ${toolName}` }; }
    const authorization = this.authorizeGovernedTool(toolName);
    if (authorization) {
      await this.persistAuthorizationDenied(context, authorization);
      if (authorization.code === 'stale_permission_context') {
        // Fail closed rather than returning a blocked ToolResult the model could retry
        // against the same (already invalid) context — the run must stop here.
        throw new StalePermissionContextError();
      }
      return {
        ok: false,
        error: formatPermissionDenial(authorization),
        blocked: true,
        policyViolation: true,
      };
    }

    const strictScope = await this.getStrictScope(context);
    const args = strictScope
      ? canonicalizeStrictTaskArguments(
          strictScope,
          toolName,
          toolCall.function.arguments,
          context.workspaceRoot,
        )
      : toolCall.function.arguments;
    const filePaths = tool.mutatesWorkspace ? extractFilePaths(toolName, args) : [];
    const strictViolation = strictScope
      ? evaluateStrictTaskAction(strictScope, {
          toolName,
          paths: filePaths,
          command: toolName === 'run_command' ? String(args['command'] ?? '') : undefined,
          arguments: args,
          workspaceRoot: context.workspaceRoot,
          mutatesWorkspace: tool.mutatesWorkspace || toolName === 'run_command',
        })
      : undefined;
    if (strictViolation) {
      const decision: PolicyDecision = {
        action: 'deny',
        reason: strictViolation,
        fingerprint: `strict-scope:${toolName}`,
      };
      await this.persistPolicyDecision(context, decision, null);
      return {
        ok: false,
        error: strictViolation,
        blocked: true,
        policyViolation: true,
      };
    }

    const contract = await this.getEffectiveContract(context);
    let decision = this.policyEngine.evaluate(toolName, args, context.mode);

    if (decision.action !== 'deny' && contract) {
      const contractDecision = this.contractEnforcer.evaluate(contract, {
        toolName,
        paths: filePaths,
        command: toolName === 'run_command' ? String(args['command'] ?? '') : undefined,
        mutatesWorkspace: tool.mutatesWorkspace || toolName === 'run_command',
      });

      if (
        contract.checkpointPolicy === 'required' &&
        tool.mutatesWorkspace &&
        !Config.getEnableCheckpoints()
      ) {
        decision = {
          action: 'deny',
          reason: 'Approved task contract requires checkpoints for workspace mutations.',
          fingerprint: decision.fingerprint,
        };
      } else if (contractDecision.inContract) {
        if (decision.action === 'ask-once') {
          decision = {
            action: 'allow-for-task',
            reason: contractDecision.reason,
            fingerprint: decision.fingerprint,
          };
        }
      } else if (tool.mutatesWorkspace || toolName === 'run_command') {
        decision = {
          action: 'ask-once',
          reason: `${contractDecision.reason} Explicit approval is required for this out-of-contract action.`,
          fingerprint: decision.fingerprint,
        };
      }
    }

    await this.persistPolicyDecision(context, decision, contract);

    if (decision.action === 'deny') {
      return {
        ok: false,
        error: decision.reason,
        blocked: true,
        policyViolation: true,
      };
    }

    if (decision.action === 'ask-once') {
      try {
        const response = await this.approvalFlow.requestApproval(
          toolName,
          args,
          decision.reason,
          'high',
          signal,
        );
        if (response !== 'approved') {
          this.policyEngine.recordRejection(decision.fingerprint);
          return {
            ok: false,
            error: `Tool execution rejected by user: ${toolName}`,
            requiresApproval: true,
          };
        }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }

    let checkpointId: string | null = null;
    if (tool.mutatesWorkspace && Config.getEnableCheckpoints() && filePaths.length > 0) {
      try {
        checkpointId = await this.checkpointManager.createCheckpoint(filePaths, {
          reason: `Before ${toolName}`,
          model: context.model,
          sessionId: context.sessionId,
          turnId: context.turnId,
          toolName,
          toolCallId: toolCall.id,
          args,
          iterationId: context.iterationId,
          taskId: context.taskId,
        });

        if (checkpointId && this.taskStore && this.taskId) {
          await this.taskStore.addCheckpointRef(this.taskId, {
            checkpointId,
            toolCallId: toolCall.id,
            toolName,
            iterationId: context.iterationId,
            timestamp: new Date().toISOString(),
            affectedPaths: filePaths,
            restorationStatus: 'none',
            retained: true,
          });
        }
      } catch (error) {
        const message = `Checkpoint creation failed: ${error instanceof Error ? error.message : String(error)}`;
        this.auditService.log({
          type: 'error',
          sessionId: context.sessionId,
          toolName,
          error: message,
        });
        return { ok: false, error: message, blocked: true };
      }
    }

    const extendedContext: ExtendedToolContext = { ...context, signal };
    let result: ToolResult;
    try {
      if (signal?.aborted) { return { ok: false, error: 'Tool execution cancelled' }; }
      events?.onToolStart?.(toolName, args);
      result = await tool.execute(args, extendedContext);
      events?.onToolResult?.(toolName, result);
    } catch (error) {
      result = { ok: false, error: error instanceof Error ? error.message : String(error) };
      Logger.error(`[ToolExecutor] ${toolName} failed:`, error);
    }

    this.auditService.log({
      type: 'tool_result',
      sessionId: context.sessionId,
      toolName,
      success: result.ok,
      durationMs: 0,
      checkpointId: checkpointId ?? undefined,
      meta: {
        arguments: args,
        affectedPaths: filePaths,
        contractId: contract?.contractId,
        policyAction: decision.action,
        result: result.ok ? result.data : undefined,
        error: result.ok ? undefined : result.error,
      },
    });
    return result;
  }

  /**
   * M38: the entire authorization/execution/evidence decision for a
   * Core-backed capability tool belongs to Core (core/domain/capabilityDispatch.ts).
   * This method only relays: it forwards the normalized call, and if Core
   * returns `approval_required`, it reuses the existing `ApprovalFlow` purely
   * as a presentation/interaction adapter — collecting one human decision and
   * submitting it back to the *exact* Core approval envelope Core returned.
   * It never decides allow/deny itself, never calls the adapter directly, and
   * never writes a competing authoritative audit record.
   */
  private async executeCoreBackedCapability(
    toolCall: ToolCall,
    context: ToolContext,
    events?: ToolExecutionEvents,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    const toolName = toolCall.function.name;
    const args = toolCall.function.arguments;
    events?.onToolStart?.(toolName, args);

    if (!this.coreClient) {
      const result: ToolResult = { ok: false, error: `'${toolName}' requires an active Core connection and is unavailable without one.`, blocked: true };
      events?.onToolResult?.(toolName, result);
      return result;
    }
    const correlationId = context.taskId ?? this.taskId;
    if (!correlationId) {
      const result: ToolResult = { ok: false, error: `'${toolName}' requires a durable task id to anchor its Core approval; none is available.`, blocked: true };
      events?.onToolResult?.(toolName, result);
      return result;
    }

    const dispatch = () => this.coreClient!.dispatchCapability({
      correlationId,
      toolName,
      arguments: args,
      cwd: context.workspaceRoot ?? this.workspaceRoot,
    });

    let dispatched: Awaited<ReturnType<typeof dispatch>>;
    try {
      dispatched = await dispatch();
    } catch (error) {
      const result: ToolResult = { ok: false, error: error instanceof Error ? error.message : String(error) };
      events?.onToolResult?.(toolName, result);
      return result;
    }

    // Every outcome carries the anchor attemptId — once known, a caller
    // aborting `signal` cancels the real Core-side execution, not just this
    // extension-host promise. Best-effort: failures here do not change the
    // tool result the model already received.
    const onAbort = () => { void this.coreClient!.cancelCapabilityAction(dispatched.attemptId).catch(() => undefined); };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      return await this.finishCoreBackedCapability(dispatched, toolName, args, signal, events, dispatch);
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }

  private async finishCoreBackedCapability(
    initial: Awaited<ReturnType<CoreClient['dispatchCapability']>>,
    toolName: string,
    args: Record<string, unknown>,
    signal: AbortSignal | undefined,
    events: ToolExecutionEvents | undefined,
    dispatch: () => ReturnType<CoreClient['dispatchCapability']>,
  ): Promise<ToolResult> {
    let dispatched = initial;
    if (dispatched.outcome === 'approval_required') {
      let resolution: 'approved' | 'rejected';
      try {
        resolution = await this.approvalFlow.requestApproval(
          toolName,
          args,
          MEMORY_APPROVAL_PROMPTS[toolName]
            ?? 'This action calls an external service and requires your approval.',
          'high',
          signal,
        );
      } catch (error) {
        const result: ToolResult = { ok: false, error: error instanceof Error ? error.message : String(error) };
        events?.onToolResult?.(toolName, result);
        return result;
      }
      await this.coreClient!.resolveCapabilityApproval(dispatched.approval.id, {
        resolution,
        attemptId: dispatched.attemptId,
        expectedAttemptRevision: dispatched.approval.expectedAttemptRevision,
        expectedAttemptStatus: dispatched.approval.expectedAttemptStatus,
        requestedActionDigest: dispatched.approval.requestedActionDigest,
        frozenContextHash: dispatched.approval.frozenContextHash,
      });
      dispatched = await dispatch();
    }

    if (dispatched.outcome === 'executed') {
      const ok = dispatched.toolInvocation.status === 'succeeded';
      const result: ToolResult = ok
        ? { ok: true, data: dispatched.toolInvocation.evidence }
        : { ok: false, error: JSON.stringify(dispatched.toolInvocation.evidence) };
      events?.onToolResult?.(toolName, result);
      return result;
    }
    if (dispatched.outcome === 'denied') {
      if (toolName === 'github_comment_on_issue' && typeof args.number === 'number') {
        // Repository is not part of this tool's own arguments (Core scopes it
        // server-side); the guard matches on issue number, optionally
        // narrowed by --repo when present in a run_command replay attempt.
        this.deniedActionsGuard.recordGithubCommentDenied('*', Number(args.number));
      }
      const result: ToolResult = { ok: false, error: dispatched.reason, blocked: true, policyViolation: true };
      events?.onToolResult?.(toolName, result);
      return result;
    }
    // dispatched.outcome is 'unavailable' or 'unknown_tool' here.
    const reason = dispatched.outcome === 'unavailable' ? dispatched.reason : `no governed capability owns '${toolName}'`;
    const result: ToolResult = { ok: false, error: `'${toolName}' is unavailable: ${reason}`, blocked: true };
    events?.onToolResult?.(toolName, result);
    return result;
  }

  private authorizeGovernedTool(toolName: string) {
    if (!this.permissionContext) {
      return undefined;
    }
    const runId = this.permissionRunId ?? this.taskId;
    if (!runId) {
      return { code: 'invalid_permission_context' as const, toolId: `agent.${toolName}`, message: 'No run id was available for permission binding.' };
    }
    const validation = validateBoundPermissionContext(this.permissionContext, runId);
    if (!validation.ok) {
      return { code: validation.code, toolId: `agent.${toolName}`, message: validation.message };
    }
    const decision = ToolRegistry.authorizeGoverned(`agent.${toolName}`, grantsFromPermissionContext(validation.context));
    return denialFromAuthorization(decision, validation.context.profileId);
  }

  private async persistAuthorizationDenied(
    context: ToolContext,
    denial: { code: string; message: string; toolId?: string; missingCapabilities?: readonly string[] },
  ): Promise<void> {
    const taskId = context.taskId ?? this.taskId;
    if (!this.taskStore || !taskId) { return; }
    await this.taskStore.appendEvent(taskId, 'policy_decision', {
      code: denial.code,
      message: denial.message,
      toolId: denial.toolId,
      missingCapabilities: denial.missingCapabilities,
      action: 'deny',
      reason: denial.message,
    }).catch(error => Logger.warn('[ToolExecutor] Failed to persist authorization denial:', error));
  }

  private async getStrictScope(context: ToolContext): Promise<StrictTaskScope | undefined> {
    const taskId = context.taskId ?? this.taskId;
    if (!taskId || !this.taskStore) { return undefined; }
    const task = await this.taskStore.getTask(taskId);
    if (!task) { return undefined; }
    const scope = extractStrictTaskScope(task.userGoal);
    return scope.strict ? scope : undefined;
  }

  private async getEffectiveContract(context: ToolContext): Promise<TaskContract | null> {
    const taskId = context.taskId ?? this.taskId;
    if (!taskId || !this.taskStore || !this.contractStore) { return null; }

    const existing = await this.contractStore.get(taskId);
    if (existing || !Config.getTrustedAutonomyEnabled() || context.mode !== 'agent') {
      return existing;
    }

    const task = await this.taskStore.getTask(taskId);
    if (!task) { return null; }
    return this.contractStore.ensureTrustedContract(taskId, {
      goal: task.userGoal,
      acceptanceCriteria: (task.validationCommands ?? []).map(command =>
        `${command.required ? 'Required' : 'Optional'} ${command.category}: ${command.command}`,
      ),
      allowedPaths: task.allowedPaths?.length ? task.allowedPaths : ['**/*'],
      allowedCommands: (task.validationCommands ?? []).map(command => command.command),
      allowSafeCommands: true,
      budgets: { ...DEFAULT_TASK_BUDGETS, ...(task.engineBudgets ?? {}) },
      approvalPolicy: 'in-contract-autonomous',
      checkpointPolicy: 'required',
    });
  }

  private async persistPolicyDecision(
    context: ToolContext,
    decision: PolicyDecision,
    contract: TaskContract | null,
  ): Promise<void> {
    const taskId = context.taskId ?? this.taskId;
    if (!this.taskStore || !taskId) { return; }
    await this.taskStore.appendEvent(taskId, 'policy_decision', {
      action: decision.action,
      reason: decision.reason,
      fingerprint: decision.fingerprint,
      contractId: contract?.contractId,
      contractRevision: contract?.revision,
    }).catch(error => Logger.warn('[ToolExecutor] Failed to persist policy decision:', error));
  }
}
