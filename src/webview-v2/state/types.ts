// UI v2 Phase 1 state shape. Only the fields this phase needs are implemented;
// the rest of the shape is reserved so later phases don't have to redesign it.

export interface ConversationMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  /** true while this assistant message is still receiving content */
  streaming?: boolean;
  error?: string;
}

export interface StreamState {
  active: boolean;
  messageId?: string;
}

// Phase 3 — real task/approval projection, sourced only from
// autonomousTaskStarted/autonomousTaskStatus and the proposal/mutation/
// delivery approval request/resolved events AgentPanel already emits (see
// src/ui/AgentPanel.ts `pollAutonomousTaskUnserialized`,
// `surfaceProposalApproval`/`surfaceMutationApproval`/`surfaceDeliveryApproval`).
// This is presentation-only: it never re-derives lifecycle state, it only
// stores the fields the backend already computed.

export interface TaskActivityEvent {
  id: string;
  kind: string;
  title: string;
  detail?: string;
  rawProgress?: string;
  timestamp?: string;
  pandaState?: string;
  isSubagent?: boolean;
}

export interface TaskValidationTotals { commands: number; failed: number }

export interface TaskDeliveryEvidence {
  changedFileCount?: number;
  destinationBranch?: string;
  taskBranchName?: string;
  deliveryCommitSha?: string;
  worktreeClean?: boolean;
  validationPassCount?: number;
}

export interface TaskResolvedGates { proposal: boolean; mutation: boolean }

/** One active/most-recent autonomous task. Golden journeys require "exactly
 * one TaskCard", so this is a single slot, not a list. */
export interface TaskProjection {
  taskId: string;
  attemptId?: string;
  submissionId?: string;
  goal: string;
  state: string;
  provider?: string;
  model?: string;
  autonomyMode?: string;
  pandaState?: string;
  activity: TaskActivityEvent[];
  failure?: unknown;
  validationFailure?: unknown;
  validationTotals?: TaskValidationTotals;
  validationRepairAttempts?: number;
  resolvedGates: TaskResolvedGates;
  diffReview?: unknown;
  deliveryEvidence?: TaskDeliveryEvidence;
  restartRestored?: boolean;
  retryEligibility?: unknown;
  terminalSummary?: string;
  proposalSummary?: string;
}

/** Mirrors AgentPanel.ts's `AUTONOMOUS_TERMINAL_STATES` — presentation-only
 * copy, never re-derives backend lifecycle logic. */
export const AUTONOMOUS_TERMINAL_STATES = new Set(['completed', 'failed', 'blocked', 'cancelled']);

export type ApprovalKind = 'proposal' | 'mutation' | 'delivery';

/** One outstanding (unresolved) approval card. Removed from state the moment
 * the authoritative `*ApprovalResolved` event arrives — React never resolves
 * a card optimistically on click. */
export interface ApprovalProjection {
  kind: ApprovalKind;
  taskId: string;
  attemptId?: string;
  proposalId?: string;
  requestId?: string;
  version?: number;
  taskSummary?: string;
  operations?: unknown[];
  validationCommands?: unknown[];
  warnings?: unknown[];
  operationCount?: number;
  targets?: string[];
  elevatedConfirmationRequired?: boolean;
}

export interface WorkspaceProjection { placeholder?: never }

/** Canonical AgentMode identifiers (src/config/ConfigSchema.ts) plus the 'autonomous' sibling concept. */
export type ModeId = 'chat' | 'ask' | 'plan' | 'agent' | 'autonomous';

export const MODE_LABELS: Record<ModeId, string> = {
  chat: 'Baat Kar',
  ask: 'Ask',
  plan: 'Plan',
  agent: 'Saath Kar',
  autonomous: 'Karke Dikha',
};

export interface ConversationSummary {
  id: string;
  title: string;
  updatedAt?: string;
}

export interface StatusState {
  mode: ModeId;
  provider?: string;
  model?: string;
  permission?: string;
  running: boolean;
  runningLabel?: string;
  blocked?: boolean;
  completed?: boolean;
}

export interface UiState {
  submitting: boolean;
  fatalError?: string;
  historyOpen: boolean;
  activityOpen: boolean;
}

export interface UiV2State {
  conversation: ConversationMessage[];
  stream: StreamState;
  taskProjection?: TaskProjection;
  approvals: ApprovalProjection[];
  workspace: WorkspaceProjection;
  ui: UiState;
  status: StatusState;
  conversations: ConversationSummary[];
  selectedConversationId?: string;
}

export function createInitialState(): UiV2State {
  return {
    conversation: [],
    stream: { active: false },
    taskProjection: undefined,
    approvals: [],
    workspace: {},
    ui: { submitting: false, historyOpen: false, activityOpen: false },
    status: { mode: 'agent', running: false },
    conversations: [],
  };
}

export type UiV2Action =
  | { type: 'user_submit'; id: string; content: string }
  | { type: 'assistant_token'; id: string; delta: string }
  | { type: 'assistant_content'; id: string; content: string }
  | { type: 'assistant_stopped'; id: string }
  | { type: 'assistant_error'; id: string; message: string }
  | { type: 'submitting_changed'; submitting: boolean }
  | { type: 'fatal_error'; message: string }
  | { type: 'hydrate'; messages: ConversationMessage[] }
  | { type: 'mode_changed'; mode: ModeId }
  | { type: 'model_changed'; model: string; provider?: string }
  | { type: 'execution_started'; mode: ModeId; label: string }
  | { type: 'tool_start'; toolName: string }
  | { type: 'conversations_loaded'; conversations: ConversationSummary[]; selectedConversationId?: string }
  | { type: 'conversation_upserted'; conversation: ConversationSummary }
  | { type: 'conversation_deleted'; id: string }
  | { type: 'new_conversation'; id: string }
  | { type: 'toggle_history' }
  | { type: 'toggle_activity' }
  | { type: 'open_activity' }
  | {
      type: 'autonomous_task_started';
      taskId: string;
      attemptId?: string;
      submissionId?: string;
      state: string;
      goal: string;
      autonomyMode?: string;
    }
  | { type: 'autonomous_task_status'; status: Partial<TaskProjection> & { taskId: string; state: string } }
  | {
      type: 'proposal_approval_request';
      taskId: string;
      attemptId?: string;
      proposalId: string;
      version?: number;
      taskSummary?: string;
      operations?: unknown[];
      validationCommands?: unknown[];
      warnings?: unknown[];
    }
  | { type: 'proposal_approval_resolved'; taskId: string; proposalId: string; decision: string }
  | {
      type: 'mutation_approval_request';
      taskId: string;
      attemptId?: string;
      requestId: string;
      proposalId?: string;
      operationCount?: number;
      targets?: string[];
      elevatedConfirmationRequired?: boolean;
    }
  | { type: 'mutation_approval_resolved'; taskId: string; requestId: string; decision: string }
  | { type: 'delivery_approval_request'; taskId: string; attemptId?: string }
  | { type: 'delivery_approval_resolved'; taskId: string; decision: string }
  | { type: 'task_steered'; taskId: string }
  | { type: 'task_steer_rejected'; taskId: string; reason: string };

export function reduceUiV2(state: UiV2State, action: UiV2Action): UiV2State {
  switch (action.type) {
    case 'user_submit':
      return {
        ...state,
        conversation: [
          ...state.conversation,
          { id: action.id, role: 'user', content: action.content },
        ],
        ui: { ...state.ui, submitting: true },
      };
    case 'assistant_token': {
      const existing = state.conversation.find((m) => m.id === action.id);
      const content = (existing?.content ?? '') + action.delta;
      return {
        ...state,
        conversation: upsertAssistant(state.conversation, action.id, content, undefined, true),
        stream: { active: true, messageId: action.id },
      };
    }
    case 'assistant_content':
      return {
        ...state,
        conversation: upsertAssistant(state.conversation, action.id, action.content),
        ui: { ...state.ui, submitting: false },
        stream: { active: false },
        status: { ...state.status, running: false, runningLabel: undefined, completed: true },
      };
    case 'assistant_stopped': {
      const existing = state.conversation.find((m) => m.id === action.id);
      return {
        ...state,
        conversation: existing
          ? upsertAssistant(state.conversation, action.id, existing.content)
          : state.conversation,
        ui: { ...state.ui, submitting: false },
        stream: { active: false },
        status: { ...state.status, running: false, runningLabel: undefined },
      };
    }
    case 'assistant_error':
      return {
        ...state,
        conversation: upsertAssistant(state.conversation, action.id, '', action.message),
        ui: { ...state.ui, submitting: false },
        stream: { active: false },
        status: { ...state.status, running: false, runningLabel: undefined, blocked: true },
      };
    case 'submitting_changed':
      return { ...state, ui: { ...state.ui, submitting: action.submitting } };
    case 'fatal_error':
      return { ...state, ui: { ...state.ui, fatalError: action.message, submitting: false } };
    case 'hydrate':
      return { ...state, conversation: action.messages };
    case 'mode_changed':
      return { ...state, status: { ...state.status, mode: action.mode } };
    case 'model_changed':
      return {
        ...state,
        status: {
          ...state.status,
          model: action.model,
          provider: action.provider ?? state.status.provider,
        },
      };
    case 'execution_started':
      return {
        ...state,
        status: {
          ...state.status,
          mode: action.mode,
          running: true,
          runningLabel: action.label,
          completed: false,
        },
      };
    case 'tool_start':
      return {
        ...state,
        status: { ...state.status, running: true, runningLabel: `Running ${action.toolName}` },
      };
    case 'conversations_loaded':
      return {
        ...state,
        conversations: action.conversations,
        selectedConversationId: action.selectedConversationId ?? state.selectedConversationId,
      };
    case 'conversation_upserted': {
      const idx = state.conversations.findIndex((c) => c.id === action.conversation.id);
      const conversations =
        idx === -1
          ? [action.conversation, ...state.conversations]
          : state.conversations.map((c) => (c.id === action.conversation.id ? action.conversation : c));
      return { ...state, conversations };
    }
    case 'conversation_deleted':
      return { ...state, conversations: state.conversations.filter((c) => c.id !== action.id) };
    case 'new_conversation':
      return { ...state, conversation: [], selectedConversationId: action.id };
    case 'toggle_history':
      return { ...state, ui: { ...state.ui, historyOpen: !state.ui.historyOpen, activityOpen: false } };
    case 'toggle_activity':
      return { ...state, ui: { ...state.ui, activityOpen: !state.ui.activityOpen, historyOpen: false } };
    case 'open_activity':
      return { ...state, ui: { ...state.ui, activityOpen: true, historyOpen: false } };
    case 'autonomous_task_started':
      return {
        ...state,
        ui: { ...state.ui, submitting: false },
        taskProjection: {
          taskId: action.taskId,
          attemptId: action.attemptId,
          submissionId: action.submissionId,
          goal: action.goal,
          state: action.state,
          autonomyMode: action.autonomyMode,
          activity: [],
          resolvedGates: { proposal: false, mutation: false },
        },
        // Only ever one active task at a time — a fresh task's approvals
        // start clean rather than carrying over a prior task's stale cards.
        approvals: [],
      };
    case 'autonomous_task_status': {
      const s = action.status;
      const existing = state.taskProjection?.taskId === s.taskId ? state.taskProjection : undefined;
      return {
        ...state,
        taskProjection: {
          taskId: s.taskId,
          attemptId: s.attemptId ?? existing?.attemptId,
          submissionId: existing?.submissionId,
          goal: s.goal ?? existing?.goal ?? '',
          state: s.state,
          provider: s.provider ?? existing?.provider,
          model: s.model ?? existing?.model,
          autonomyMode: s.autonomyMode ?? existing?.autonomyMode,
          pandaState: s.pandaState ?? existing?.pandaState,
          activity: s.activity ?? existing?.activity ?? [],
          failure: 'failure' in s ? s.failure : existing?.failure,
          validationFailure: 'validationFailure' in s ? s.validationFailure : existing?.validationFailure,
          validationTotals: s.validationTotals ?? existing?.validationTotals,
          validationRepairAttempts: s.validationRepairAttempts ?? existing?.validationRepairAttempts,
          resolvedGates: s.resolvedGates ?? existing?.resolvedGates ?? { proposal: false, mutation: false },
          diffReview: 'diffReview' in s ? s.diffReview : existing?.diffReview,
          deliveryEvidence: s.deliveryEvidence ?? existing?.deliveryEvidence,
          restartRestored: s.restartRestored ?? existing?.restartRestored,
          retryEligibility: 'retryEligibility' in s ? s.retryEligibility : existing?.retryEligibility,
          terminalSummary: s.terminalSummary ?? existing?.terminalSummary,
          proposalSummary: s.proposalSummary ?? existing?.proposalSummary,
        },
      };
    }
    case 'proposal_approval_request': {
      const next: ApprovalProjection = {
        kind: 'proposal',
        taskId: action.taskId,
        attemptId: action.attemptId,
        proposalId: action.proposalId,
        version: action.version,
        taskSummary: action.taskSummary,
        operations: action.operations,
        validationCommands: action.validationCommands,
        warnings: action.warnings,
      };
      return { ...state, approvals: upsertApproval(state.approvals, next) };
    }
    case 'proposal_approval_resolved':
      return {
        ...state,
        approvals: state.approvals.filter(
          (a) => !(a.kind === 'proposal' && a.taskId === action.taskId && a.proposalId === action.proposalId),
        ),
      };
    case 'mutation_approval_request': {
      const next: ApprovalProjection = {
        kind: 'mutation',
        taskId: action.taskId,
        attemptId: action.attemptId,
        requestId: action.requestId,
        proposalId: action.proposalId,
        operationCount: action.operationCount,
        targets: action.targets,
        elevatedConfirmationRequired: action.elevatedConfirmationRequired,
      };
      return { ...state, approvals: upsertApproval(state.approvals, next) };
    }
    case 'mutation_approval_resolved':
      return {
        ...state,
        approvals: state.approvals.filter(
          (a) => !(a.kind === 'mutation' && a.taskId === action.taskId && a.requestId === action.requestId),
        ),
      };
    case 'delivery_approval_request': {
      const next: ApprovalProjection = { kind: 'delivery', taskId: action.taskId, attemptId: action.attemptId };
      return { ...state, approvals: upsertApproval(state.approvals, next) };
    }
    case 'delivery_approval_resolved':
      return { ...state, approvals: state.approvals.filter((a) => !(a.kind === 'delivery' && a.taskId === action.taskId)) };
    case 'task_steered': {
      if (state.taskProjection?.taskId !== action.taskId) return state;
      const ackEvent: TaskActivityEvent = { id: `steered_${Date.now()}`, kind: 'steered', title: 'Guidance delivered to task' };
      return {
        ...state,
        taskProjection: { ...state.taskProjection, activity: [...state.taskProjection.activity, ackEvent] },
      };
    }
    case 'task_steer_rejected': {
      // The host could not deliver the guidance. Say so in the task's own activity rather than implying it was
      // applied; the message is not lost (the v2 composer does not clear on a steer).
      if (state.taskProjection?.taskId !== action.taskId) return state;
      const rejection: TaskActivityEvent = {
        id: `steer_rejected_${Date.now()}`,
        kind: 'steer_rejected',
        title: 'Guidance was not applied',
        detail: action.reason,
      };
      return {
        ...state,
        taskProjection: { ...state.taskProjection, activity: [...state.taskProjection.activity, rejection] },
      };
    }
    default:
      return state;
  }
}

function upsertApproval(approvals: ApprovalProjection[], next: ApprovalProjection): ApprovalProjection[] {
  const matches = (a: ApprovalProjection) =>
    a.kind === next.kind
    && a.taskId === next.taskId
    && a.proposalId === next.proposalId
    && a.requestId === next.requestId;
  const idx = approvals.findIndex(matches);
  if (idx === -1) return [...approvals, next];
  const copy = approvals.slice();
  copy[idx] = next;
  return copy;
}

function upsertAssistant(
  messages: ConversationMessage[],
  id: string,
  content: string,
  error?: string,
  streaming?: boolean,
): ConversationMessage[] {
  const idx = messages.findIndex((m) => m.id === id);
  const next: ConversationMessage = { id, role: 'assistant', content, error, streaming };
  if (idx === -1) return [...messages, next];
  const copy = messages.slice();
  copy[idx] = next;
  return copy;
}
