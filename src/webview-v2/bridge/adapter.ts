import type { ModeId, TaskActivityEvent, TaskProjection, UiV2Action } from '../state/types';
import {
  checkExhaustive,
  hasMessageType,
  type AgentMode,
  type HostToWebviewMessage,
  type SendMessageMessage,
  type StartAutonomousTaskMessage,
  type WebviewModeChangedMessage,
  type WebviewReadyMessage,
} from '../../shared/webviewProtocol';

// The compatibility surface between the legacy AgentPanel host messages and UI
// v2's typed actions. This adapter is intentionally NOT authoritative: it does
// not own lifecycle, retries, or task/approval state. Outbound builders are
// typed against src/shared/webviewProtocol.ts (the real AgentPanel contract,
// see that module's doc comment for how it was verified); inbound translation
// switches exhaustively over `HostToWebviewMessage` so a new message type
// added to that union is a compile error here until explicitly classified —
// not a message this adapter silently drops.
//
// UI v2 now projects chat plus the real autonomous task/approval surface.
// Messages still outside that migration slice (workspace/readiness,
// attachments, repository intelligence, permissions, research) are explicitly
// acknowledged below rather than silently dropped.

function normalizeTaskActivityEvents(value: unknown): TaskActivityEvent[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const activity: TaskActivityEvent[] = [];
  for (const [index, raw] of value.entries()) {
    if (!raw || typeof raw !== 'object') continue;
    const event = raw as Record<string, unknown>;
    const title = typeof event.title === 'string' && event.title.trim()
      ? event.title
      : typeof event.renderedProgress === 'string' && event.renderedProgress.trim()
        ? event.renderedProgress
        : undefined;
    if (!title) continue;

    const eventId = typeof event.eventId === 'string' && event.eventId
      ? event.eventId
      : typeof event.seq === 'number' || typeof event.seq === 'string'
        ? String(event.seq)
        : `event_${index}`;
    activity.push({
      id: eventId,
      kind: typeof event.kind === 'string' ? event.kind : 'progress',
      title,
      detail: typeof event.detail === 'string' ? event.detail : undefined,
      rawProgress: typeof event.rawProgress === 'string' ? event.rawProgress : undefined,
      timestamp: typeof event.timestamp === 'string' ? event.timestamp : undefined,
      pandaState: typeof event.pandaState === 'string' ? event.pandaState : undefined,
      isSubagent: typeof event.isSubagent === 'boolean' ? event.isSubagent : undefined,
    });
  }
  return activity;
}

/** `sendMessage.mode` is `AgentMode` (no `'autonomous'` value) — a Karke Dikha
 * submission uses `startAutonomousTask` instead, which carries no mode field
 * at all. `agentModeFor` maps the five UI buttons onto that split. */
function agentModeFor(mode: ModeId): AgentMode | undefined {
  return mode === 'autonomous' ? undefined : mode;
}

export function buildSendMessage(text: string, conversationId: string, mode: ModeId): SendMessageMessage {
  const agentMode = agentModeFor(mode);
  return {
    type: 'sendMessage',
    text,
    // Baat Kar/Ask/Plan/Saath Kar all use `sendMessage`; a caller must route
    // Karke Dikha through `buildStartAutonomousTask` instead (see
    // `agentModeFor`) — falling back to 'agent' here would silently mis-route
    // an autonomous submission onto the Saath Kar Core kind.
    mode: agentMode ?? 'agent',
    model: '',
    attachmentIds: [],
    conversationId,
  };
}

export function buildStartAutonomousTask(text: string, submissionId?: string): StartAutonomousTaskMessage {
  return { type: 'startAutonomousTask', text, submissionId };
}

export function buildWebviewReady(mode: ModeId): WebviewReadyMessage {
  return { type: 'webviewReady', mode };
}

// Shell-parity outbound builders, mirroring media/chat.js / chat-sidebar-ui.js exactly.
export function buildModeChanged(mode: ModeId): WebviewModeChangedMessage {
  return { type: 'webviewModeChanged', mode };
}

export function buildNewConversation(): { type: 'newConversation' } {
  return { type: 'newConversation' };
}

export function buildSelectConversation(id: string): { type: 'selectConversation'; id: string } {
  return { type: 'selectConversation', id };
}

// Approval / steering outbound builders. Each emits the EXACT existing host
// reply message name/shape (src/shared/webviewProtocol.ts `WebviewToHostMessage`)
// — React never invents a new intent here.
export function buildApproveProposal(taskId: string, proposalId: string): { type: 'approveProposal'; taskId: string; proposalId: string } {
  return { type: 'approveProposal', taskId, proposalId };
}
export function buildRejectProposal(taskId: string, proposalId: string): { type: 'rejectProposal'; taskId: string; proposalId: string } {
  return { type: 'rejectProposal', taskId, proposalId };
}
export function buildRequestProposalRevision(
  taskId: string,
  proposalId: string,
  instructions: string,
): { type: 'requestProposalRevision'; taskId: string; proposalId: string; instructions: string } {
  return { type: 'requestProposalRevision', taskId, proposalId, instructions };
}
export function buildApproveMutation(taskId: string, requestId: string): { type: 'approveMutation'; taskId: string; requestId: string } {
  return { type: 'approveMutation', taskId, requestId };
}
export function buildDenyMutation(taskId: string, requestId: string): { type: 'denyMutation'; taskId: string; requestId: string } {
  return { type: 'denyMutation', taskId, requestId };
}
export function buildApproveDelivery(taskId: string): { type: 'approveAutonomousDelivery'; taskId: string } {
  return { type: 'approveAutonomousDelivery', taskId };
}
export function buildRejectDelivery(taskId: string): { type: 'rejectAutonomousDelivery'; taskId: string } {
  return { type: 'rejectAutonomousDelivery', taskId };
}
export function buildSteerTask(taskId: string, message: string): { type: 'steerTask'; taskId: string; message: string } {
  return { type: 'steerTask', taskId, message };
}

/**
 * Translates one inbound host message into zero or one UiV2Action.
 * `pendingAssistantId` is the id of the assistant message currently being
 * awaited (assigned by the caller when it submits a user message), since the
 * legacy `assistantContent` event carries no message id of its own.
 */
export function translateHostMessage(
  raw: unknown,
  pendingAssistantId: string | undefined,
): UiV2Action | undefined {
  if (!hasMessageType(raw)) return undefined;
  const msg = raw as HostToWebviewMessage;

  switch (msg.type) {
    case 'token':
      if (!pendingAssistantId) return undefined;
      return { type: 'assistant_token', id: pendingAssistantId, delta: msg.delta };
    case 'done':
      if (!pendingAssistantId) return undefined;
      return { type: 'assistant_content', id: pendingAssistantId, content: msg.content };
    case 'stopped':
      if (!pendingAssistantId) return undefined;
      return { type: 'assistant_stopped', id: pendingAssistantId };
    case 'assistantContent':
      if (!pendingAssistantId) return undefined;
      return { type: 'assistant_content', id: pendingAssistantId, content: msg.content };
    case 'error':
      return pendingAssistantId
        ? { type: 'assistant_error', id: pendingAssistantId, message: msg.message }
        : { type: 'fatal_error', message: msg.message };
    case 'modelSuitability': {
      // Real payload: AgentPanel.ts posts this once per submission with the
      // actually-selected provider/model (`selectModelForTask`'s result) —
      // NOT the fictional `modelSelected` message some older tests assumed.
      const { selectedProvider, selectedModel } = msg.details;
      if (!selectedModel) return undefined;
      return { type: 'model_changed', model: selectedModel, provider: selectedProvider };
    }
    case 'toolStart':
      return { type: 'tool_start', toolName: msg.toolName };
    case 'modelsLoaded':
      return undefined; // Phase 2: model list is not yet projected in UI v2.
    case 'persistedConversationsLoaded': {
      const conversations = msg.conversations.map((c) => ({
        id: c.id,
        title: c.title ?? c.id,
        updatedAt: typeof c.updatedAt === 'string' ? c.updatedAt : undefined,
      }));
      return { type: 'conversations_loaded', conversations };
    }
    case 'conversationCreated':
    case 'conversationUpdated':
      // Real payload nests the conversation (`{ type, conversation: {...} }`),
      // not top-level `id`/`title` fields — see webviewProtocol.ts.
      return {
        type: 'conversation_upserted',
        conversation: {
          id: msg.conversation.id,
          title: msg.conversation.title ?? msg.conversation.id,
          updatedAt: typeof msg.conversation.updatedAt === 'string' ? msg.conversation.updatedAt : undefined,
        },
      };
    case 'conversationDeleted':
      return { type: 'conversation_deleted', id: msg.id };
    case 'newConversation':
      return { type: 'new_conversation', id: msg.id };
    case 'showActivity':
      return { type: 'open_activity' };

    // Phase 3 — task/approval projection. Each translation copies only
    // fields the real AgentPanel payload actually carries (verified against
    // AgentPanel.ts call sites, not the open `[key: string]: unknown` shape).
    case 'autonomousTaskStarted':
      return {
        type: 'autonomous_task_started',
        taskId: msg.taskId,
        attemptId: msg.attemptId,
        submissionId: msg.submissionId,
        state: msg.state,
        goal: msg.goal,
        autonomyMode: msg.autonomyMode,
      };
    case 'autonomousTaskStatus': {
      const status = msg as unknown as Partial<TaskProjection> & {
        taskId: string;
        state: string;
        events?: unknown;
      };
      const activity = normalizeTaskActivityEvents(status.events);
      return {
        type: 'autonomous_task_status',
        status: {
          ...status,
          ...(activity ? { activity } : {}),
        },
      };
    }
    case 'proposalApprovalRequest':
      return {
        type: 'proposal_approval_request',
        taskId: msg.taskId,
        attemptId: msg.attemptId,
        proposalId: msg.proposalId,
        version: msg.version,
        taskSummary: msg.taskSummary,
        operations: msg.operations,
        validationCommands: msg.validationCommands,
        warnings: msg.warnings,
      };
    case 'proposalApprovalResolved':
      return { type: 'proposal_approval_resolved', taskId: msg.taskId, proposalId: msg.proposalId, decision: msg.decision };
    case 'mutationApprovalRequest':
      return {
        type: 'mutation_approval_request',
        taskId: msg.taskId,
        attemptId: msg.attemptId,
        requestId: msg.requestId,
        proposalId: msg.proposalId,
        operationCount: msg.operationCount,
        targets: msg.targets,
        elevatedConfirmationRequired: msg.elevatedConfirmationRequired,
      };
    case 'mutationApprovalResolved':
      return { type: 'mutation_approval_resolved', taskId: msg.taskId, requestId: msg.requestId, decision: msg.decision };
    case 'deliveryApprovalRequest':
      return { type: 'delivery_approval_request', taskId: msg.taskId, attemptId: msg.attemptId };
    case 'deliveryApprovalResolved':
      return { type: 'delivery_approval_resolved', taskId: msg.taskId, decision: msg.decision };
    case 'taskSteered':
      return { type: 'task_steered', taskId: msg.taskId };
    case 'taskSteerRejected':
      return { type: 'task_steer_rejected', taskId: msg.taskId, reason: msg.reason };
    // No task/approval projection exists yet for a rejected submission (it
    // never reached autonomousTaskStarted), so there is nothing to clear
    // there — but it DOES need to release `ui.submitting`, which `fatal_error`
    // already does, so a rejected Karke Dikha submission never leaves the
    // composer stuck disabled.
    case 'autonomousTaskRejected':
      return { type: 'fatal_error', message: msg.reason };

    // Explicitly acknowledged but not yet projected into UiV2State (out of
    // Phase 3 scope). Each is listed by name — never silently dropped by a
    // catch-all default — so a reviewer can see exactly what this adapter
    // still owes the rest of the real contract.
    case 'readinessState':
    case 'workspaceRestorationPending':
    case 'workspaceRestorationResolved':
    case 'workspaceState':
    case 'workspaceRequired':
    case 'conversationContinuity':
    case 'conversationSelected':
    case 'conversationBranched':
    case 'restoreTranscript':
    case 'workspaceRequestResumed':
    case 'repositoryContextEvidence':
    case 'toolResult':
    case 'approvalRequest':
    case 'authorizationDenied':
    case 'researchApprovalRequest':
    case 'researchProgress':
    case 'researchDenied':
    case 'researchCompleted':
    case 'restoreCapabilityApprovalCard':
    case 'capabilityApprovalRestoredResolved':
    case 'autonomousTaskActive':
    case 'autonomousTaskRepositorySnapshot':
    case 'taskResult': // rendered by the legacy result card (media/chat-result-card.js); webview-v2 has no card yet
    case 'autonomousRetryStarted':
    case 'autonomousDiagnosticsCopied':
    case 'coreAttemptRecoveryRequired':
    case 'coreExecutionRestored':
    case 'everydayHistory':
    case 'everydayHistoryDetail':
    case 'taskSnapshot':
    case 'taskResumed':
    case 'taskPaused':
    case 'taskCancelled':
    case 'operationsSnapshot':
    case 'archivedTasksSnapshot':
    case 'tasksArchived':
    case 'repositoryIntelligenceStatus':
    case 'attachmentState':
    case 'workbenchSearchResults':
    case 'regenerationStarted':
    case 'conversationExported':
    case 'localStoryCreated':
    case 'permissionContextState':
    case 'clear':
    case 'autonomousComposerContext':
      return undefined;

    default:
      // Compile-time exhaustiveness only (see checkExhaustive's doc comment):
      // a new HostToWebviewMessage variant without a case above fails the
      // build. At runtime this branch is reached by genuinely unrecognized
      // input (malformed data, a mismatched host build) and must not throw.
      checkExhaustive(msg);
      return undefined;
  }
}
