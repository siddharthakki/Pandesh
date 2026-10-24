import { ToolRegistry } from '../tools/ToolRegistry';
import { ToolExecutor } from '../tools/ToolExecutor';
import type { CoreClient } from '../core-client/CoreClient';
import type { CoreDeniedActionsGuard } from '../tools/CoreDeniedActionsGuard';
import { ContextManager } from './ContextManager';
import { ApprovalFlow } from '../policy/ApprovalFlow';
import { CheckpointManager } from './CheckpointManager';
import { AuditService } from '../services/AuditService';
import { Config } from '../config/Config';
import { ToolContext, AgentLoopEvents, ChatMessage, ToolCall } from '../tools/ToolTypes';
import { ModelRouter } from './ModelRouter';
import { InferenceProvider, ProviderApiError } from '../providers/ProviderTypes';
import { AgentMode } from '../config/ConfigSchema';
import { ModelCapabilityRegistry } from '../models/ModelCapabilityRegistry';
import { TaskStore } from './TaskStore';
import {
  getRepositoryEvidenceRequirements,
  RepositoryEvidenceKind,
} from './TaskIntent';
import { SerializablePermissionContext } from '../tools/PermissionContext';
import { ModelDispatchPlanner } from '../reliability/ModelDispatchPlanner';
import {
  fingerprintToolResult,
  ToolCallNormalizer,
  ToolLoopDetector,
} from '../reliability/ToolCallReliability';

const NAVIGATION_TOOLS = new Set(['find_relevant', 'find_references', 'impact_analysis', 'repo_map']);

const REPOSITORY_READ_TOOLS = new Set([
  'read_file',
  'read_file_range',
  'list_directory',
  'search_files',
  'grep',
  'find_relevant',
  'find_references',
  'impact_analysis',
  'repo_map',
  'git_status',
  'git_diff',
  'git_branch',
  'git_log',
]);

function toolSatisfiesEvidence(toolName: string, evidence: RepositoryEvidenceKind): boolean {
  switch (evidence) {
    case 'file_read':
      return toolName === 'read_file' || toolName === 'read_file_range';
    case 'directory_listing':
      return toolName === 'list_directory';
    case 'file_search':
      return toolName === 'search_files' || toolName === 'list_directory';
    case 'any_read':
      return REPOSITORY_READ_TOOLS.has(toolName);
  }
}

function describeEvidence(evidence: RepositoryEvidenceKind): string {
  switch (evidence) {
    case 'file_read': return 'file contents via read_file or read_file_range';
    case 'directory_listing': return 'directory entries via list_directory';
    case 'file_search': return 'matching files or a count via search_files or list_directory';
    case 'any_read': return 'repository state via a read-only repository tool';
  }
}

export interface IToolExecutor {
  execute(
    toolCall: ToolCall,
    context: ToolContext,
    events?: import('../tools/ToolTypes').ToolExecutionEvents,
    signal?: AbortSignal,
  ): Promise<import('../tools/ToolTypes').ToolResult>;
  clearRejections?(): void;
}

export interface AgentLoopDependencies {
  workspaceRoot: string;
  approvalFlow: ApprovalFlow;
  checkpointManager: CheckpointManager;
  auditService: AuditService;
  provider: InferenceProvider;
  modelOverride?: string;
  mode?: AgentMode;
  executor?: IToolExecutor;
  taskStore?: TaskStore;
  taskId?: string;
  maxIterations?: number;
  beforeModelCall?: (iteration: number) => Promise<void> | void;
  beforeToolCall?: (toolCall: ToolCall, iteration: number) => Promise<void> | void;
  permissionContext?: SerializablePermissionContext;
  permissionRunId?: string;
  /** M38: required to reach any Core-backed governed capability tool
   * (governed_research, github_read_issue, github_comment_on_issue). */
  coreClient?: CoreClient;
  deniedActionsGuard?: CoreDeniedActionsGuard;
}

export class AgentLoop {
  private readonly provider: InferenceProvider;
  private readonly executor: IToolExecutor;
  private readonly modelOverride?: string;
  private readonly mode: AgentMode;
  private readonly taskStore?: TaskStore;
  private readonly taskId?: string;
  private readonly maxIterations?: number;
  private readonly beforeModelCall?: AgentLoopDependencies['beforeModelCall'];
  private readonly beforeToolCall?: AgentLoopDependencies['beforeToolCall'];

  constructor(
    private readonly contextManager: ContextManager,
    deps: AgentLoopDependencies,
  ) {
    this.provider = deps.provider;
    this.modelOverride = deps.modelOverride;
    this.mode = deps.mode ?? 'agent';
    this.taskStore = deps.taskStore;
    this.taskId = deps.taskId;
    this.maxIterations = deps.maxIterations;
    this.beforeModelCall = deps.beforeModelCall;
    this.beforeToolCall = deps.beforeToolCall;
    this.executor = deps.executor ?? new ToolExecutor({
      workspaceRoot: deps.workspaceRoot,
      approvalFlow: deps.approvalFlow,
      checkpointManager: deps.checkpointManager,
      auditService: deps.auditService,
          taskStore: deps.taskStore,
          taskId: deps.taskId,
          permissionContext: deps.permissionContext,
          permissionRunId: deps.permissionRunId,
          coreClient: deps.coreClient,
          deniedActionsGuard: deps.deniedActionsGuard,
        });
  }

  async run(
    ctx: ToolContext,
    events: AgentLoopEvents,
    signal?: AbortSignal,
  ): Promise<{ finalContent: string; iterations: number; stoppedByLimit: boolean }> {
    const maxIterations = this.maxIterations ?? Config.getMaxIterations();
    const messages = this.contextManager.getMessages();
    const hasImages = messages.some(message => message.images && message.images.length > 0);
    const hasDocuments = this.contextManager.hasDocuments();
    const isChatMode = this.mode === 'chat';
    const repositoryEvidenceRequirements = [...new Set(
      messages
        .filter(message => message.role === 'user')
        .flatMap(message => getRepositoryEvidenceRequirements(message.content)),
    )];
    const model = this.modelOverride ?? ModelRouter.selectModel(messages, hasImages, hasDocuments);
    const routeReason = this.modelOverride
      ? `user selected → ${this.modelOverride}`
      : ModelRouter.describeSelection(messages, hasImages, hasDocuments);
    events.onModelSelected?.(model, routeReason);

    const capRegistry = ModelCapabilityRegistry.getInstance();
    const caps = capRegistry.getCapabilities(model, this.provider.providerType);
    if (caps.embeddingOnly) {
      const message = `Model "${model}" is embedding-only and cannot be used for chat or agent tasks. Change the model in settings.`;
      events.onError?.(message);
      return { finalContent: message, iterations: 0, stoppedByLimit: false };
    }

    // Navigation tools cost ~350 prompt tokens; on an 8K-or-smaller window that is too dear, so those models keep grep/read.
    const tools = (hasImages || !caps.tools) ? []
      : ToolRegistry.schemasForMode(this.mode).filter(tool => !NAVIGATION_TOOLS.has(tool.function.name) || caps.contextWindow > 8192);
    this.executor.clearRejections?.();
    const loopContext: ToolContext = { ...ctx, model, mode: this.mode };
    // One shared preflight service (Blocker 2): profile, context-limit
    // resolution, exact provider options and structured-output decision are
    // produced by the same code path used by governed Forge execution.
    const session = await ModelDispatchPlanner.createSession({
      model,
      provider: this.provider,
      toolsActive: tools.length > 0,
      hasImages,
      signal,
    });
    const profile = session.profile;
    const chatOptions = session.options;

    let iterations = 0;
    let evidenceReminderCount = 0;
    const satisfiedRepositoryEvidence = new Set<RepositoryEvidenceKind>();
    const rejectedFingerprints = new Set<string>();
    const fingerprint = (call: ToolCall): string => `${call.function.name}:${JSON.stringify(call.function.arguments)}`;
    const normalizer = new ToolCallNormalizer();
    const loopDetector = new ToolLoopDetector(profile.duplicateCallThreshold);

    for (let index = 0; index < maxIterations; index++) {
      if (signal?.aborted) {
        events.onStopped?.();
        return { finalContent: 'Stopped by user.', iterations, stoppedByLimit: false };
      }

      iterations = index + 1;
      try {
        await this.beforeModelCall?.(iterations);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        events.onError?.(message);
        return { finalContent: message, iterations: iterations - 1, stoppedByLimit: true };
      }
      events.onIterationStart?.(iterations);
      const preflight = session.preflight(this.contextManager.getMessages(), tools);
      events.onContextUsage?.(preflight);
      if (!preflight.ok) {
        const message = preflight.reason ?? 'Request blocked before model dispatch: context budget exceeded.';
        events.onReliabilityEvent?.({ code: 'context_budget_exceeded', message });
        events.onError?.(message);
        return { finalContent: message, iterations: iterations - 1, stoppedByLimit: true };
      }

      const missingRepositoryEvidence = repositoryEvidenceRequirements.filter(
        requirement => !satisfiedRepositoryEvidence.has(requirement),
      );
      const mustCollectRepositoryEvidence = !isChatMode && missingRepositoryEvidence.length > 0;
      let assistantMessage: ChatMessage;
      if (this.provider.chatStream && tools.length === 0 && !mustCollectRepositoryEvidence) {
        let finalContent = '';
        const streamedToolCalls: ToolCall[] = [];
        try {
          for await (const event of this.provider.chatStream(
            this.contextManager.getMessages(), tools, chatOptions, signal,
          )) {
            if (signal?.aborted) { break; }
            if (event.type === 'token') { events.onToken?.(event.delta); }
            else if (event.type === 'tool_call') { streamedToolCalls.push(event.toolCall); }
            else if (event.type === 'done') { finalContent = event.content; }
          }
        } catch (error) {
          if (signal?.aborted) {
            events.onStopped?.();
            return { finalContent: 'Stopped by user.', iterations, stoppedByLimit: false };
          }
          const message = classifyProviderError(error);
          events.onError?.(message);
          return { finalContent: `Error: ${message}`, iterations, stoppedByLimit: false };
        }
        if (signal?.aborted) {
          events.onStopped?.();
          return { finalContent: 'Stopped by user.', iterations, stoppedByLimit: false };
        }
        assistantMessage = {
          role: 'assistant',
          content: finalContent,
          tool_calls: streamedToolCalls.length > 0 ? streamedToolCalls : undefined,
        };
      } else {
        try {
          const response = await this.provider.chat(
            this.contextManager.getMessages(), tools, chatOptions, signal,
          );
          assistantMessage = response.message;
        } catch (error) {
          if (signal?.aborted) {
            events.onStopped?.();
            return { finalContent: 'Stopped by user.', iterations, stoppedByLimit: false };
          }
          const message = classifyProviderError(error);
          events.onError?.(message);
          return { finalContent: `Error: ${message}`, iterations, stoppedByLimit: false };
        }
      }

      if (tools.length > 0) {
        // The single authoritative normalization path: native calls, XML
        // blocks and JSON envelopes all pass through the same protocol
        // gating, schema validation and bounded repair (Blockers 8–11).
        const normalized = normalizer.normalize({
          content: assistantMessage.content,
          nativeCalls: assistantMessage.tool_calls,
          tools,
          profile,
          repairBudgetTokens: preflight.repairReserve,
        });
        if (!normalized.ok) {
          const message = normalized.reason ?? 'Malformed tool call could not be normalized safely.';
          events.onReliabilityEvent?.({ code: normalized.code ?? 'malformed_tool_call', message, steps: normalized.steps });
          events.onError?.(message);
          return { finalContent: message, iterations, stoppedByLimit: false };
        }
        if (normalized.calls.length > 0) {
          assistantMessage = {
            ...assistantMessage,
            content: normalized.textContent,
            tool_calls: normalized.calls,
          };
          if (normalized.steps.length > 0 || normalized.repaired) {
            events.onReliabilityEvent?.({
              code: normalized.repaired ? 'tool_call_repaired' : 'tool_call_normalized',
              message: normalized.repaired ? 'Malformed tool call repaired and schema validated.' : 'Tool call normalized and schema validated.',
              steps: normalized.steps,
            });
          }
        }
      }

      this.contextManager.addAssistantMessage(assistantMessage);
      const toolCalls = assistantMessage.tool_calls ?? [];
      if (toolCalls.length === 0 || isChatMode) {
        if (mustCollectRepositoryEvidence) {
          evidenceReminderCount += 1;
          if (evidenceReminderCount >= 3) {
            const missing = missingRepositoryEvidence.map(describeEvidence).join('; ');
            const message = `Stopped: the model did not collect all required repository evidence. Missing: ${missing}.`;
            events.onError?.(message);
            return { finalContent: message, iterations, stoppedByLimit: true };
          }
          const missing = missingRepositoryEvidence.map(describeEvidence).join('; ');
          this.contextManager.addUserMessage([
            'Repository evidence is required before answering this read-only inspection.',
            `Still missing: ${missing}.`,
            'Use the provided read-only tools now. Do not answer from memory, inferred context, or prior conversation content.',
          ].join(' '));
          continue;
        }
        if (isChatMode && toolCalls.length > 0) {
          const names = toolCalls.map(call => call.function.name).join(', ');
          events.onAssistantContent?.(`⚠ Tools are disabled in Chat mode (model requested: ${names}).`);
        }
        const finalContent = assistantMessage.content || '(No response content)';
        events.onDone?.(finalContent);
        return { finalContent, iterations, stoppedByLimit: false };
      }

      if (assistantMessage.content?.trim()) {
        events.onAssistantContent?.(assistantMessage.content);
      }

      for (const toolCall of toolCalls) {
        if (signal?.aborted) { break; }
        const toolFingerprint = fingerprint(toolCall);
        if (rejectedFingerprints.has(toolFingerprint)) {
          const message = 'Stopped: model repeated a tool call that the user rejected.';
          events.onError?.(message);
          return { finalContent: message, iterations, stoppedByLimit: false };
        }
        const loopCheck = loopDetector.beforeDispatch(toolCall);
        if (!loopCheck.ok) {
          const message = loopCheck.reason ?? 'Stopped tool loop before dispatch.';
          events.onReliabilityEvent?.({ code: loopCheck.code ?? 'tool_loop_detected', message, pattern: loopCheck.pattern });
          events.onError?.(message);
          return { finalContent: message, iterations, stoppedByLimit: true };
        }

        try {
          await this.beforeToolCall?.(toolCall, iterations);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          events.onError?.(message);
          return { finalContent: message, iterations, stoppedByLimit: true };
        }

        const turnId = `${loopContext.turnId}_i${index}_${toolCall.function.name}`;
        const iterationId = `${loopContext.turnId}_iter${index}`;
        const toolContext: ToolContext = { ...loopContext, turnId, iterationId };
        const registered = ToolRegistry.get(toolCall.function.name);
        const mayMutate = registered?.mutatesWorkspace === true || toolCall.function.name === 'run_command';

        await this.persistToolEvent('tool_started', toolCall, { iterationId, mayMutate });
        events.onToolStart?.(toolCall.function.name, toolCall.function.arguments);
        const result = await this.executor.execute(toolCall, toolContext, undefined, signal);
        await this.persistToolEvent(result.ok ? 'tool_completed' : 'tool_failed', toolCall, {
          iterationId,
          mayMutate,
          ok: result.ok,
          error: result.ok ? undefined : result.error,
          blocked: result.ok ? undefined : result.blocked,
          policyViolation: result.ok ? undefined : result.policyViolation,
        });
        events.onToolResult?.(toolCall.function.name, result);

        if (result.ok) {
          for (const requirement of repositoryEvidenceRequirements) {
            if (toolSatisfiesEvidence(toolCall.function.name, requirement)) {
              satisfiedRepositoryEvidence.add(requirement);
            }
          }
        }

        const classification = result.ok
          ? 'success'
          : result.policyViolation
            ? 'policy_violation'
            : result.blocked
              ? 'blocked'
              : result.requiresApproval
                ? 'requires_approval'
                : 'failed';
        const loopObservation = loopDetector.recordResult(toolCall, {
          ok: result.ok,
          mutatedWorkspace: result.ok && mayMutate,
          classification,
          resultFingerprint: fingerprintToolResult(
            result.ok ? result.data : { error: result.error, classification },
          ),
        });

        if (!result.ok && result.policyViolation) {
          const message = `Stopped on policy violation: ${result.error}`;
          events.onError?.(message);
          return { finalContent: message, iterations, stoppedByLimit: false };
        }

        if (!loopObservation.ok) {
          const message = loopObservation.reason ?? 'Stopped repeated failed tool call.';
          events.onReliabilityEvent?.({ code: loopObservation.code ?? 'tool_loop_detected', message, pattern: loopObservation.pattern });
          events.onError?.(message);
          return { finalContent: message, iterations, stoppedByLimit: true };
        }
        if (!result.ok && result.requiresApproval) { rejectedFingerprints.add(toolFingerprint); }
        this.contextManager.addToolResult(toolCall.function.name, {
          tool: toolCall.function.name,
          args: toolCall.function.arguments,
          ok: result.ok,
          result: result.ok ? result.data : undefined,
          error: result.ok ? undefined : result.error,
        }, toolCall.id);
      }

      if (signal?.aborted) {
        events.onStopped?.();
        return { finalContent: 'Stopped by user.', iterations, stoppedByLimit: false };
      }
    }

    const message = `Stopped: reached maximum tool-call iteration limit (${maxIterations}).`;
    events.onError?.(message);
    return { finalContent: message, iterations, stoppedByLimit: true };
  }

  private async persistToolEvent(
    type: 'tool_started' | 'tool_completed' | 'tool_failed',
    toolCall: ToolCall,
    payload: Record<string, unknown>,
  ): Promise<void> {
    if (!this.taskStore || !this.taskId) { return; }
    await this.taskStore.appendEvent(
      this.taskId,
      type,
      {
        toolName: toolCall.function.name,
        toolCallId: toolCall.id,
        args: toolCall.function.arguments,
        ...payload,
      },
      { correlationId: toolCall.id },
    );
  }
}

export { AgentLoopEvents };

/**
 * Narrow context-overflow phrases (Blocker 13). Deliberately does NOT match
 * every message containing "token": authentication tokens, API tokens and
 * token quotas keep their original classification.
 */
const CONTEXT_OVERFLOW_PATTERN = new RegExp(
  [
    'maximum context length',
    'context window (?:was |is )?exceeded',
    'context length (?:was |is )?exceeded',
    "exceeds? (?:the )?(?:model's )?context (?:window|length)",
    'prompt (?:is )?too long',
    'input (?:is )?too long',
    'num_ctx',
  ].join('|'),
  'i',
);

export function isProviderContextOverflow(error: unknown): boolean {
  if (!(error instanceof ProviderApiError)) { return false; }
  return CONTEXT_OVERFLOW_PATTERN.test(error.message);
}

export function classifyProviderError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (isProviderContextOverflow(error)) {
    return `provider_context_overflow: ${message}`;
  }
  return message;
}
