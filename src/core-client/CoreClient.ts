import * as crypto from 'node:crypto';
import { WebSocket } from 'ws';
import type { CoreConnectionState, CoreConnectionStatus } from './ConnectionState';
import type { TaskOverviewRow } from '../../core/domain/taskOverview';
import type {
  BoardSnapshot,
  CoreInfo,
  StoryEventRecord,
  RuntimeEventRecord,
  RuntimeTokenFrame,
  ConversationRailEntry,
  ConversationRecord,
  ConversationMessageRecord,
  ConversationMode,
  MessageRole,
  RequestEnvelopeRecord,
  RequestedMode,
  ResolvedMode,
  ContextPolicy,
  ToolPermissionPolicy,
  AttemptRecord,
  AttemptStatus,
  AttemptKind,
  ModelInvocationRecord,
  ToolInvocationRecord,
  ApprovalRecord,
  ApprovalKind,
  CheckpointRecord,
  AttemptContextRecord,
  KarkeDikhaValidationEvidence,
  KarkeDikhaValidationResult,
  WorkspaceAttemptRehydration,
  TaskHistoryEntry,
  TaskHistoryDetail,
  ModelSelectionEvidence,
  RepositoryContextPackage,
  AttemptRetryEligibility,
  AttemptRetryStrategy,
  ExecutionQualityEvidenceInput,
  AttachmentRecord,
  AttachmentKind,
  ArtifactRecord,
  ArtifactKind,
  ResearchSessionRecord,
  ResearchApprovalRecord,
  ResearchSourceRecord,
  CitationRecord,
  ConversationBranchRecord,
  ResponseAlternativeRecord,
  ConversationSearchResult,
  ConversationExport,
  EngineeringProductRequestRecord,
  EngineeringSprintRecord,
  EngineeringSprintItemRecord,
  EngineeringAssignmentRecord,
  EngineeringCiEvidenceRecord,
  CapabilityDispatchResult,
  CapabilityActionsSnapshot,
  RecentWorkspaceCapabilityActionsSnapshot,
  WorkspaceConversationLedgerSnapshot,
  ConversationWorkingStateRecord,
  ConversationConstraint,
  ConversationRelevantFile,
  ConversationPendingAction,
  ConversationExecutionPolicy,
  ClientType,
  ConnectorId,
  ConnectorStatus,
  ConnectorPermissions,
  AssistantBrief,
  DailyBriefRoutine,
} from '../../core/shared/wireTypes';

const MAX_RECONNECT_DELAY_MS = 30_000;
const BASE_RECONNECT_DELAY_MS = 1_000;
/**
 * How many times the client reopens the WebSocket on its own before it stops
 * and hands the decision back to the operator.
 *
 * Five attempts with exponential backoff is about half a minute of trying:
 * long enough for a Core that is restarting to come back on its own, short
 * enough that a Core that is gone does not leave the app looking broken for
 * minutes. After the cap the client is `disconnected`, the host re-launches
 * the Core once, and the operator gets a "Retry" button if that did not work.
 */
const MAX_RECONNECT_ATTEMPTS = 5;
const HEARTBEAT_STALE_MS = 45_000; // no server ping/pong/message for this long => assume dead, reconnect

export interface CoreClientOptions {
  baseUrl: string;
  token: string;
  clientId: string;
  clientVersion: string;
  /** Defaults to `vscode` so the extension host is unchanged. */
  clientType?: ClientType;
  /** Host-only secret sent as X-Host-Token on decisions that stand for the user (worker approvals). */
  hostToken?: string;
  /**
   * Test seam. Production Core pings every 15s; the watchdog uses 45s.
   * Override only in focused heartbeat tests.
   */
  heartbeatStaleMs?: number;
  onStatusChange?: (status: CoreConnectionStatus) => void;
  onStoryEvent?: (event: StoryEventRecord) => void;
  onRuntimeEvent?: (event: RuntimeEventRecord) => void;
  /** Ephemeral live token deltas (M32 Priority 1 Core-owned execution). Not
   * deduped/replayed — see `RuntimeTokenFrame`'s doc comment. */
  onRuntimeToken?: (frame: RuntimeTokenFrame) => void;
}

interface CoreRequestInit {
  method?: string;
  body?: unknown;
  idempotencyKey?: string;
  query?: Record<string, string | number | boolean | undefined>;
  headers?: Record<string, string>;
}

export interface CoreKarkeDikhaWorkerCredentials {
  fenceToken: string;
  owner: string;
  frozenContextHash: string;
}

export interface CoreKarkeDikhaWorkerClaim {
  attempt: AttemptRecord;
  context: AttemptContextRecord;
  fence: { attemptId: string; token: string; generation: number; owner: string; expiresAt: string };
}

export class CoreApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'CoreApiError';
  }
}

/**
 * Production Core client: real HTTP requests, a real authenticated
 * WebSocket connection with bounded exponential-backoff reconnect and
 * replay-on-reconnect via `/v1/events?after=`, and event dedup by ID. Never
 * falls back to any local Board store when disconnected — callers see the
 * connection state and must wait/retry.
 */
export class CoreClient {
  private status: CoreConnectionStatus = { state: 'starting' };
  private ws: WebSocket | undefined;
  private lastSeenSequence = 0;
  private seenEventIds = new Set<string>();
  private lastSeenRuntimeSequence = 0;
  private seenRuntimeEventIds = new Set<string>();
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private heartbeatWatchdog: NodeJS.Timeout | undefined;
  private lastMessageAt = Date.now();
  private disposed = false;

  constructor(private readonly options: CoreClientOptions) {}

  getStatus(): CoreConnectionStatus {
    return this.status;
  }

  private setStatus(status: CoreConnectionStatus): void {
    this.status = status;
    this.options.onStatusChange?.(status);
  }

  async start(): Promise<void> {
    await this.registerClient();
    const snapshot = await this.fetchBoardSnapshot();
    this.lastSeenSequence = snapshot.latestSequence;
    this.connectWebSocket();
  }

  async registerClient(): Promise<void> {
    await this.request('/v1/clients/register', {
      method: 'POST',
      body: {
        clientType: this.options.clientType ?? 'vscode',
        clientVersion: this.options.clientVersion,
      },
    });
  }

  async fetchBoardSnapshot(projectId?: string): Promise<BoardSnapshot> {
    return this.request<BoardSnapshot>('/v1/board/snapshot', { query: { projectId } });
  }

  // M37 engineering-company API. The Core owns these durable records; this
  // client is only a transport and never keeps a fallback organization store.
  async createEngineeringProductRequest(input: Record<string, unknown>): Promise<EngineeringProductRequestRecord> { return this.request('/v1/engineering/product-requests', { method: 'POST', body: input }); }
  async approveEngineeringProductRequest(id: string): Promise<EngineeringProductRequestRecord> { return this.request(`/v1/engineering/product-requests/${id}/approve`, { method: 'POST', body: {} }); }
  async planEngineeringSprint(input: Record<string, unknown>): Promise<{ sprint: EngineeringSprintRecord; items: EngineeringSprintItemRecord[] }> { return this.request('/v1/engineering/sprints', { method: 'POST', body: input }); }
  async startEngineeringSprint(id: string): Promise<EngineeringSprintRecord> { return this.request(`/v1/engineering/sprints/${id}/start`, { method: 'POST', body: {} }); }
  async dispatchEngineeringSprint(id: string, input: Record<string, unknown>): Promise<EngineeringAssignmentRecord | undefined> { return this.request(`/v1/engineering/sprints/${id}/dispatch`, { method: 'POST', body: input }); }
  async ingestEngineeringCiFailure(input: Record<string, unknown>): Promise<EngineeringCiEvidenceRecord> { return this.request('/v1/engineering/ci/failure', { method: 'POST', body: input }); }
  async engineeringSnapshot(projectId: string): Promise<{ requests: EngineeringProductRequestRecord[]; sprints: EngineeringSprintRecord[]; assignments: EngineeringAssignmentRecord[]; ci: EngineeringCiEvidenceRecord[] }> { return this.request('/v1/engineering/snapshot', { query: { projectId } }); }

  /** Delivers the OrcaRouter credential to Core's memory-only store (never persisted or echoed back). */
  async setOrcaRouterCredential(baseUrl: string, apiKey: string): Promise<{ configured: boolean; baseUrl?: string }> {
    return this.request('/v1/providers/orcarouter/credential', { method: 'POST', body: { baseUrl, apiKey } });
  }

  async clearOrcaRouterCredential(): Promise<{ configured: boolean }> {
    return this.request('/v1/providers/orcarouter/credential', { method: 'DELETE' });
  }

  /** Cloud pool credentials: same memory-only contract as OrcaRouter, for any catalog provider id. */
  async setProviderCredential(provider: string, baseUrl: string, apiKey: string): Promise<{ configured: boolean; baseUrl?: string }> {
    return this.request(`/v1/providers/${encodeURIComponent(provider)}/credential`, { method: 'POST', body: { baseUrl, apiKey } });
  }

  async clearProviderCredential(provider: string): Promise<{ configured: boolean }> {
    return this.request(`/v1/providers/${encodeURIComponent(provider)}/credential`, { method: 'DELETE' });
  }

  async clearAllProviderCredentials(): Promise<{ providers: string[] }> {
    return this.request('/v1/providers', { method: 'DELETE' });
  }

  async request<T>(path: string, init: CoreRequestInit = {}): Promise<T> {
    const url = new URL(path, this.options.baseUrl);
    if (init.query) {
      for (const [key, value] of Object.entries(init.query)) {
        if (value !== undefined) url.searchParams.set(key, String(value));
      }
    }
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.options.token}`,
      'X-Client-Id': this.options.clientId,
      ...init.headers,
    };
    if (init.body !== undefined) headers['Content-Type'] = 'application/json';
    if (init.idempotencyKey) headers['Idempotency-Key'] = init.idempotencyKey;
    else if (init.method && init.method !== 'GET') headers['Idempotency-Key'] = crypto.randomUUID();

    const res = await fetch(url, {
      method: init.method ?? 'GET',
      headers,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });

    if (res.status === 401 || res.status === 403) {
      this.setStatus({ state: 'authentication_failed', detail: `${path} rejected credentials` });
    }

    const bodyJson = await res.json().catch(() => undefined);
    if (!res.ok) {
      const error = (bodyJson as { error?: { code: string; message: string; details?: Record<string, unknown> } } | undefined)?.error;
      throw new CoreApiError(res.status, error?.code ?? 'internal_error', error?.message ?? `request to ${path} failed`, error?.details);
    }
    return bodyJson as T;
  }

  private connectWebSocket(): void {
    if (this.disposed) return;
    const wsUrl = this.options.baseUrl.replace(/^http/, 'ws') + '/v1/ws';
    const socket = new WebSocket(wsUrl, { headers: { Authorization: `Bearer ${this.options.token}` } });
    this.ws = socket;

    socket.on('open', () => {
      this.markSocketAlive();
      this.startHeartbeatWatchdog();
    });

    socket.on('message', (raw) => {
      this.markSocketAlive();
      this.handleMessage(raw.toString());
    });

    // Core sends WebSocket ping frames every 15s and records our pong. The
    // watchdog previously ignored both ping and pong, so a quiet-but-healthy
    // socket looked dead after 45s and reconnect churned. Either frame is
    // proof of liveness.
    socket.on('ping', () => this.markSocketAlive());
    socket.on('pong', () => this.markSocketAlive());

    socket.on('close', () => {
      this.stopHeartbeatWatchdog();
      if (!this.disposed) this.scheduleReconnect();
    });

    socket.on('error', () => {
      // 'close' fires after 'error' for connection failures; reconnect is scheduled there.
    });

    socket.on('unexpected-response', (_req, res) => {
      if (res.statusCode === 401 || res.statusCode === 403) {
        this.setStatus({ state: 'authentication_failed', detail: 'WebSocket handshake rejected credentials' });
      }
    });
  }

  private handleMessage(raw: string): void {
    let msg: {
      type: string;
      instanceId?: string;
      latestSequence?: number;
      event?: StoryEventRecord | RuntimeEventRecord;
      attemptId?: string;
      invocationId?: string;
      delta?: string;
    };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.type === 'connected') {
      this.reconnectAttempt = 0;
      this.setStatus({ state: 'connected', coreVersion: undefined });
      void this.replayMissedEvents();
      void this.replayMissedRuntimeEvents();
      return;
    }

    if (msg.type === 'event' && msg.event) {
      this.ingestEvent(msg.event as StoryEventRecord);
    }

    if (msg.type === 'runtime_event' && msg.event) {
      this.ingestRuntimeEvent(msg.event as RuntimeEventRecord);
    }

    if (msg.type === 'runtime_token' && msg.attemptId && msg.invocationId && msg.delta !== undefined) {
      this.options.onRuntimeToken?.({ attemptId: msg.attemptId, invocationId: msg.invocationId, delta: msg.delta });
    }
  }

  private ingestEvent(event: StoryEventRecord): void {
    if (this.seenEventIds.has(event.id)) return;
    this.seenEventIds.add(event.id);
    if (this.seenEventIds.size > 5000) {
      // Bound memory: drop the oldest half once the dedup set grows large. Safe because
      // sequence-based replay is the source of truth for anything this doesn't catch.
      const toDelete = [...this.seenEventIds].slice(0, 2500);
      for (const id of toDelete) this.seenEventIds.delete(id);
    }
    if (event.sequence > this.lastSeenSequence) this.lastSeenSequence = event.sequence;
    this.options.onStoryEvent?.(event);
  }

  private ingestRuntimeEvent(event: RuntimeEventRecord): void {
    if (this.seenRuntimeEventIds.has(event.id)) return;
    this.seenRuntimeEventIds.add(event.id);
    if (this.seenRuntimeEventIds.size > 5000) {
      const toDelete = [...this.seenRuntimeEventIds].slice(0, 2500);
      for (const id of toDelete) this.seenRuntimeEventIds.delete(id);
    }
    if (event.sequence > this.lastSeenRuntimeSequence) this.lastSeenRuntimeSequence = event.sequence;
    this.options.onRuntimeEvent?.(event);
  }

  private async replayMissedEvents(): Promise<void> {
    try {
      const result = await this.request<{ events: StoryEventRecord[] }>('/v1/events', {
        query: { after: this.lastSeenSequence, limit: 200 },
      });
      for (const event of result.events) this.ingestEvent(event);
    } catch {
      // Replay failure isn't fatal — the WS stream will keep delivering new events; a future
      // reconnect will try replay again from wherever lastSeenSequence has advanced to.
    }
  }

  private async replayMissedRuntimeEvents(): Promise<void> {
    try {
      const result = await this.request<{ events: RuntimeEventRecord[] }>('/v1/runtime-events', {
        query: { after: this.lastSeenRuntimeSequence, limit: 200 },
      });
      for (const event of result.events) this.ingestRuntimeEvent(event);
    } catch {
      // Same non-fatal contract as replayMissedEvents.
    }
  }

  // --- M32: durable agent-runtime convenience methods ---

  async createConversation(input: { mode: ConversationMode; projectId?: string | null; repositoryId?: string | null; title?: string | null }): Promise<ConversationRecord> {
    return this.request<ConversationRecord>('/v1/conversations', { method: 'POST', body: input });
  }

  async getWorkspaceConversationLedger(workspaceIdentity: string): Promise<WorkspaceConversationLedgerSnapshot> {
    return this.request('/v1/workspace-conversation-ledger', { query: { workspaceIdentity } });
  }

  async bindWorkspaceConversation(input: {
    workspaceIdentity: string;
    localConversationId: string;
    conversationId: string;
    title?: string | null;
    makeCurrent?: boolean;
    migrationMetadata?: Record<string, unknown>;
  }): Promise<WorkspaceConversationLedgerSnapshot> {
    return this.request('/v1/workspace-conversation-ledger/bind', { method: 'POST', body: input });
  }

  /**
   * Durable Conversational Continuity V1. Workspace-scoped by construction:
   * Core returns `null` (never another project's objective) when the stored
   * record belongs to a different workspace identity.
   */
  async getConversationWorkingState(
    conversationId: string,
    workspaceIdentity: string,
  ): Promise<ConversationWorkingStateRecord | null> {
    const { workingState } = await this.request<{ workingState: ConversationWorkingStateRecord | null }>(
      `/v1/conversations/${encodeURIComponent(conversationId)}/working-state`,
      { query: { workspaceIdentity } },
    );
    return workingState ?? null;
  }

  async saveConversationWorkingState(
    conversationId: string,
    input: {
      workspaceIdentity: string;
      startNewObjective?: boolean;
      currentObjective: string;
      latestUserIntent: string;
      latestExecutionPolicy?: ConversationExecutionPolicy | null;
      relevantFiles?: ConversationRelevantFile[];
      relevantSymbols?: string[];
      userConstraints?: ConversationConstraint[];
      latestFindingsSummary?: string | null;
      pendingAction?: ConversationPendingAction | null;
      latestTaskId?: string | null;
      latestProposalId?: string | null;
      latestValidationSummary?: string | null;
      pendingNewObjective?: boolean;
      awaitingObjectiveClarification?: boolean;
    },
  ): Promise<ConversationWorkingStateRecord> {
    const { workingState } = await this.request<{ workingState: ConversationWorkingStateRecord }>(
      `/v1/conversations/${encodeURIComponent(conversationId)}/working-state`,
      { method: 'POST', body: input },
    );
    return workingState;
  }

  async clearConversationWorkingState(
    conversationId: string,
    workspaceIdentity: string,
  ): Promise<void> {
    await this.request<{ cleared: boolean }>(
      `/v1/conversations/${encodeURIComponent(conversationId)}/working-state`,
      { method: 'DELETE', query: { workspaceIdentity } },
    );
  }

  async selectWorkspaceConversation(
    workspaceIdentity: string,
    localConversationId: string,
  ): Promise<WorkspaceConversationLedgerSnapshot> {
    return this.request('/v1/workspace-conversation-ledger/select', {
      method: 'POST',
      body: { workspaceIdentity, localConversationId },
    });
  }

  async archiveWorkspaceConversation(
    workspaceIdentity: string,
    localConversationId: string,
  ): Promise<WorkspaceConversationLedgerSnapshot> {
    return this.request('/v1/workspace-conversation-ledger/archive', {
      method: 'POST',
      body: { workspaceIdentity, localConversationId },
    });
  }

  async listConversations(query?: { mode?: ConversationMode; includeArchived?: boolean }): Promise<{ conversations: ConversationRailEntry[] }> {
    return this.request('/v1/conversations', { query });
  }

  /** Development stories executed through Kandev: counts plus one compact row per story. */
  async getDevStories(projectId?: string): Promise<{ available: boolean; counts: Record<string, number>; stories: Array<Record<string, unknown>> }> {
    return this.request('/v1/dev-stories', { query: { projectId } });
  }

  async decideDevStoryPermission(storyId: string, pendingId: string, allow: boolean, via: 'window' | 'phone' = 'window'): Promise<{ ok: boolean }> {
    return this.request(`/v1/dev-stories/${encodeURIComponent(storyId)}/permissions/${encodeURIComponent(pendingId)}`, { method: 'POST', body: { allow, via }, headers: this.options.hostToken ? { 'X-Host-Token': this.options.hostToken } : undefined });
  }

  async stopAllDevStories(): Promise<{ stopped: string[]; stillRunning: string[]; kandevAvailable: boolean }> {
    return this.request('/v1/dev-stories/stop-all', { method: 'POST', body: {} });
  }

  async approveDevStoryReview(storyId: string): Promise<{ ok: boolean }> {
    return this.request(`/v1/dev-stories/${encodeURIComponent(storyId)}/approve-review`, { method: 'POST', body: {} });
  }

  /** Verify and integrate the work a stopped worker left in its worktree, without starting a worker. */
  async verifyExistingDevStory(storyId: string): Promise<{ outcome: 'integrated' | 'blocked' | 'awaiting-review'; status: string; commit: string | null; reason: string | null }> {
    return this.request(`/v1/dev-stories/${encodeURIComponent(storyId)}/verify-existing`, { method: 'POST', body: {} });
  }

  async retryDevStory(storyId: string): Promise<{ ok: boolean }> {
    return this.request(`/v1/dev-stories/${encodeURIComponent(storyId)}/retry`, { method: 'POST', body: {} });
  }

  async getDevStory(storyId: string): Promise<{ story: any; timeline: Array<{ at: string; event: string; text: string }>; changedFiles: string[] }> {
    return this.request(`/v1/dev-stories/${encodeURIComponent(storyId)}`);
  }

  /** Confirm (or fail) the steps a device check needs a physical phone for — e.g. mobile Tasks itself. */
  async confirmDeviceVerification(storyId: string, ok: boolean, note?: string): Promise<{ ok: boolean }> {
    return this.request(`/v1/dev-stories/${encodeURIComponent(storyId)}/device-verified`, { method: 'POST', body: { ok, note } });
  }

  async listArtifacts(conversationId?: string): Promise<{ artifacts: ArtifactRecord[] }> {
    return this.request('/v1/artifacts', { query: { conversationId } });
  }

  async getArtifact(artifactId: string): Promise<ArtifactRecord> {
    return this.request(`/v1/artifacts/${encodeURIComponent(artifactId)}`);
  }

  async registerArtifact(input: { conversationId?: string | null; requestId?: string | null; attemptId?: string | null; kind: ArtifactKind; title: string; mimeType: string; absolutePath: string; source: string; metadata?: Record<string, unknown> }): Promise<ArtifactRecord> {
    return this.request('/v1/artifacts', { method: 'POST', body: input });
  }

  async getConversation(conversationId: string): Promise<ConversationRecord> {
    return this.request(`/v1/conversations/${encodeURIComponent(conversationId)}`);
  }

  async archiveConversation(conversationId: string): Promise<ConversationRecord> {
    return this.request(`/v1/conversations/${encodeURIComponent(conversationId)}/archive`, { method: 'POST', body: {} });
  }

  async unarchiveConversation(conversationId: string): Promise<ConversationRecord> {
    return this.request(`/v1/conversations/${encodeURIComponent(conversationId)}/unarchive`, { method: 'POST', body: {} });
  }

  async renameConversation(conversationId: string, title: string): Promise<ConversationRecord> {
    return this.request(`/v1/conversations/${encodeURIComponent(conversationId)}/rename`, { method: 'POST', body: { title } });
  }

  async pinConversation(conversationId: string): Promise<ConversationRecord> {
    return this.request(`/v1/conversations/${encodeURIComponent(conversationId)}/pin`, { method: 'POST', body: {} });
  }

  async unpinConversation(conversationId: string): Promise<ConversationRecord> {
    return this.request(`/v1/conversations/${encodeURIComponent(conversationId)}/unpin`, { method: 'POST', body: {} });
  }

  async appendMessage(conversationId: string, input: { role: MessageRole; content: string; modelInvocationId?: string | null }): Promise<ConversationMessageRecord> {
    return this.request<ConversationMessageRecord>(`/v1/conversations/${conversationId}/messages`, { method: 'POST', body: input });
  }

  async listMessages(conversationId: string, query?: { limit?: number; afterSeq?: number }): Promise<{ messages: ConversationMessageRecord[] }> {
    return this.request(`/v1/conversations/${conversationId}/messages`, { query });
  }

  async searchConversations(query: string, limit?: number): Promise<{ results: ConversationSearchResult[] }> {
    return this.request('/v1/conversations/search', { query: { query, limit } });
  }

  async branchConversation(conversationId: string, input: { branchPointMessageId: string; title?: string }): Promise<ConversationRecord> {
    return this.request(`/v1/conversations/${conversationId}/branch`, { method: 'POST', body: input });
  }

  async getConversationBranch(conversationId: string): Promise<{ branch: ConversationBranchRecord | null }> {
    return this.request(`/v1/conversations/${conversationId}/branch`);
  }

  async listResponseAlternatives(conversationId: string, userMessageId?: string): Promise<{ alternatives: ResponseAlternativeRecord[] }> {
    return this.request(`/v1/conversations/${conversationId}/alternatives`, { query: { userMessageId } });
  }

  async selectResponseAlternative(conversationId: string, alternativeId: string): Promise<ResponseAlternativeRecord> {
    return this.request(`/v1/conversations/${conversationId}/alternatives/${alternativeId}/select`, { method: 'POST', body: {} });
  }

  async regenerateResponse(conversationId: string, assistantMessageId: string): Promise<{ request: RequestEnvelopeRecord; attempt: AttemptRecord; planningOnly: boolean; messageId: string | null }> {
    return this.request(`/v1/conversations/${conversationId}/regenerate`, { method: 'POST', body: { assistantMessageId } });
  }

  async exportConversation(conversationId: string, format: 'json' | 'markdown'): Promise<{ format: 'json'; content: ConversationExport } | { format: 'markdown'; content: string }> {
    return this.request(`/v1/conversations/${conversationId}/export`, { query: { format } });
  }

  // --- Everyday Tools (Notes / Reminders) ---
  async listEverydayNotes(query?: string): Promise<{ notes: Array<{ id: string; title: string; body: string; createdAt: string; updatedAt: string; deletedAt: string | null }> }> {
    return this.request('/v1/everyday/notes', { query: query ? { query } : undefined });
  }

  async createEverydayNote(input: { title?: string; body: string }): Promise<{ id: string; title: string; body: string; createdAt: string; updatedAt: string; deletedAt: string | null }> {
    return this.request('/v1/everyday/notes', { method: 'POST', body: input });
  }

  async updateEverydayNote(id: string, input: { title?: string; body?: string }): Promise<{ id: string; title: string; body: string; createdAt: string; updatedAt: string; deletedAt: string | null }> {
    return this.request(`/v1/everyday/notes/${encodeURIComponent(id)}`, { method: 'PATCH', body: input });
  }

  async deleteEverydayNote(id: string): Promise<{ id: string; title: string; body: string; createdAt: string; updatedAt: string; deletedAt: string | null }> {
    return this.request(`/v1/everyday/notes/${encodeURIComponent(id)}`, { method: 'DELETE', body: {} });
  }

  async listEverydayReminders(status: 'open' | 'all' | 'scheduled' | 'completed' | 'cancelled' | 'notified' = 'open'): Promise<{
    reminders: Array<Record<string, unknown>>;
    due: Array<Record<string, unknown>>;
  }> {
    return this.request('/v1/everyday/reminders', { query: { status } });
  }

  async createEverydayReminder(input: { title: string; body?: string; dueAt: string; timezone?: string }): Promise<Record<string, unknown>> {
    return this.request('/v1/everyday/reminders', { method: 'POST', body: input });
  }

  async completeEverydayReminder(id: string): Promise<Record<string, unknown>> {
    return this.request(`/v1/everyday/reminders/${encodeURIComponent(id)}/complete`, { method: 'POST', body: {} });
  }

  async cancelEverydayReminder(id: string): Promise<Record<string, unknown>> {
    return this.request(`/v1/everyday/reminders/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: {} });
  }

  async markEverydayReminderNotified(id: string): Promise<Record<string, unknown>> {
    return this.request(`/v1/everyday/reminders/${encodeURIComponent(id)}/notified`, { method: 'POST', body: {} });
  }

  // --- Durable Command Queue ---
  async getCommandQueue(): Promise<{
    active: Record<string, unknown> | null;
    confirming: Record<string, unknown> | null;
    waiting: Array<Record<string, unknown>>;
    recentTerminal: Array<Record<string, unknown>>;
  }> {
    return this.request('/v1/command-queue');
  }

  /** Hands an instruction to a task that is still working. `accepted: false` says why it could not be (finished, not steerable). */
  async steerAttempt(attemptId: string, text: string, options: { correction?: boolean } = {}): Promise<{ accepted: boolean; reason?: string; mode?: 'superseded' | 'steered' }> {
    return this.request(`/v1/attempts/${encodeURIComponent(attemptId)}/steer`, { method: 'POST', body: options.correction ? { text, correction: true } : { text } });
  }

  async enqueueCommand(input: { instruction: string; title?: string; source?: string; dependsOnId?: string | null }): Promise<Record<string, unknown>> {
    return this.request('/v1/command-queue', { method: 'POST', body: input });
  }

  async editCommandQueueItem(id: string, input: { instruction?: string; title?: string }): Promise<Record<string, unknown>> {
    return this.request(`/v1/command-queue/${encodeURIComponent(id)}`, { method: 'PATCH', body: input });
  }

  async reorderCommandQueueItem(id: string, ordinal: number): Promise<Record<string, unknown>> {
    return this.request(`/v1/command-queue/${encodeURIComponent(id)}/reorder`, { method: 'POST', body: { ordinal } });
  }

  async skipCommandQueueItem(id: string): Promise<Record<string, unknown>> {
    return this.request(`/v1/command-queue/${encodeURIComponent(id)}/skip`, { method: 'POST', body: {} });
  }

  async postponeCommandQueueItem(id: string, until: string): Promise<Record<string, unknown>> {
    return this.request(`/v1/command-queue/${encodeURIComponent(id)}/postpone`, { method: 'POST', body: { until } });
  }

  async removeCommandQueueItem(id: string): Promise<Record<string, unknown>> {
    return this.request(`/v1/command-queue/${encodeURIComponent(id)}/remove`, { method: 'POST', body: {} });
  }

  async offerNextCommandConfirmation(): Promise<{ item: Record<string, unknown> | null }> {
    return this.request('/v1/command-queue/offer-next', { method: 'POST', body: {} });
  }

  async confirmCommandRun(id: string, token: string, revision: number): Promise<Record<string, unknown>> {
    return this.request(`/v1/command-queue/${encodeURIComponent(id)}/confirm-run`, {
      method: 'POST',
      body: { token, revision },
    });
  }

  async completeCommandQueueItem(id: string, input: { outcome?: string; attemptId?: string; requestId?: string } = {}): Promise<Record<string, unknown>> {
    return this.request(`/v1/command-queue/${encodeURIComponent(id)}/complete`, { method: 'POST', body: input });
  }

  async failCommandQueueItem(id: string, error: string, input: { attemptId?: string; requestId?: string } = {}): Promise<Record<string, unknown>> {
    return this.request(`/v1/command-queue/${encodeURIComponent(id)}/fail`, { method: 'POST', body: { error, ...input } });
  }

  async reconcileCommandQueue(): Promise<{ items: Array<Record<string, unknown>> }> {
    return this.request('/v1/command-queue/reconcile', { method: 'POST', body: {} });
  }

  async classifyRoute(
    currentMessage: string,
    context?: { hasWorkspace?: boolean; gitCapable?: boolean; conversationId?: string; storyId?: string },
  ): Promise<{ resolvedMode: ResolvedMode; routeReason: string; planningOnly: boolean; contextPolicy: ContextPolicy }> {
    return this.request('/v1/routing/classify', { method: 'POST', body: { currentMessage, ...context } });
  }

  /**
   * The one atomic Core submission path (M32 correction Phase 2/3, audit
   * F1/F5): wraps `POST /v1/submit`, which classifies (only when
   * `requestedMode` is `'auto'`), builds the context policy, creates the
   * immutable request, and creates its first attempt — all in one Core-side
   * transaction. Replaces the three-round-trip `classifyRoute` +
   * `createRequestEnvelope` + `createAttempt` pattern for any new call site:
   * this method does no classification or routing itself, it only forwards
   * the caller's input to Core and returns the one canonical
   * `{ request, attempt }` result Core produced.
   */
  async submit(input: {
    currentMessage: string;
    requestedMode: RequestedMode;
    conversationId?: string | null;
    storyId?: string | null;
    projectId?: string | null;
    repositoryId?: string | null;
    repositoryLocationId?: string | null;
    requestedProvider?: string | null;
    requestedModel?: string | null;
    /** Opt-in Core-owned local model routing. Explicit model evidence still wins. */
    autoSelectModel?: boolean;
    /** The user's explicit `ollama-agent.contextWindow` for a Core-routed (Auto) attempt. */
    contextWindowOverrideTokens?: number;
    modelSelection?: ModelSelectionEvidence;
    repositoryContext?: RepositoryContextPackage;
    workspaceRoot?: string | null;
    toolPermissionPolicy?: ToolPermissionPolicy;
    hasWorkspace?: boolean;
    gitCapable?: boolean;
    correlationId?: string;
    /** Stable, already-`ready` attachment ids for this turn (max 5). Requires
     * `conversationId`. Frozen into the attempt context by Core. */
    attachmentIds?: string[];
  }): Promise<{ request: RequestEnvelopeRecord; attempt: AttemptRecord; planningOnly: boolean; messageId: string | null; modelSelection: ModelSelectionEvidence }> {
    return this.request('/v1/submit', { method: 'POST', body: input });
  }

  async createRequestEnvelope(input: {
    currentMessage: string;
    requestedMode: RequestedMode;
    resolvedMode: ResolvedMode;
    routeReason: string;
    conversationId?: string | null;
    storyId?: string | null;
    projectId?: string | null;
    repositoryId?: string | null;
    repositoryLocationId?: string | null;
    requestedProvider?: string | null;
    requestedModel?: string | null;
    toolPermissionPolicy?: ToolPermissionPolicy;
    contextPolicy: ContextPolicy;
    correlationId?: string;
  }): Promise<RequestEnvelopeRecord> {
    return this.request<RequestEnvelopeRecord>('/v1/requests', { method: 'POST', body: input });
  }

  async createAttempt(input: { requestId: string; kind: AttemptKind }): Promise<AttemptRecord> {
    return this.request<AttemptRecord>('/v1/attempts', { method: 'POST', body: input });
  }

  async transitionAttempt(attemptId: string, input: { toStatus: AttemptStatus; expectedRevision?: number; reason?: string }): Promise<AttemptRecord> {
    return this.request<AttemptRecord>(`/v1/attempts/${attemptId}/transition`, { method: 'POST', body: input });
  }

  async cancelAttempt(attemptId: string): Promise<AttemptRecord> {
    return this.request<AttemptRecord>(`/v1/attempts/${attemptId}/cancel`, { method: 'POST', body: {} });
  }

  async retryAttempt(attemptId: string, input: {
    strategy?: AttemptRetryStrategy;
    guidance?: string;
    selectedProvider?: string;
    selectedModel?: string;
    modelSelection?: ModelSelectionEvidence;
  } = {}): Promise<AttemptRecord> {
    return this.request<AttemptRecord>(`/v1/attempts/${attemptId}/retry`, { method: 'POST', body: input });
  }

  async getAttemptRetryEligibility(attemptId: string): Promise<AttemptRetryEligibility> {
    return this.request<AttemptRetryEligibility>(`/v1/attempts/${attemptId}/retry-eligibility`);
  }

  async recordKarkeDikhaExecutionQuality(
    attemptId: string,
    credentials: CoreKarkeDikhaWorkerCredentials,
    evidence: ExecutionQualityEvidenceInput,
  ): Promise<RuntimeEventRecord> {
    return this.request<RuntimeEventRecord>(`/v1/karke-dikha/attempts/${attemptId}/execution-quality`, {
      method: 'POST',
      body: { ...credentials, ...evidence },
    });
  }

  async startModelInvocation(attemptId: string, input: { requestedProvider?: string | null; requestedModel?: string | null; policyProvider?: string | null; policyModel?: string | null }): Promise<ModelInvocationRecord> {
    return this.request<ModelInvocationRecord>(`/v1/attempts/${attemptId}/model-invocations`, { method: 'POST', body: input });
  }

  async completeModelInvocation(id: string, input: { status: 'succeeded' | 'failed' | 'cancelled'; actualProvider?: string | null; actualModel?: string | null; fallbackUsed?: boolean; fallbackReason?: string | null; usageMetadata?: Record<string, unknown> }): Promise<ModelInvocationRecord> {
    return this.request<ModelInvocationRecord>(`/v1/model-invocations/${id}/complete`, { method: 'POST', body: input });
  }

  async startToolInvocation(attemptId: string, input: { toolName: string; argsSummary?: Record<string, unknown> }): Promise<ToolInvocationRecord> {
    return this.request<ToolInvocationRecord>(`/v1/attempts/${attemptId}/tool-invocations`, { method: 'POST', body: input });
  }

  async completeToolInvocation(id: string, input: { status: 'succeeded' | 'failed' | 'cancelled'; exitCode?: number | null; evidence?: Record<string, unknown> }): Promise<ToolInvocationRecord> {
    return this.request<ToolInvocationRecord>(`/v1/tool-invocations/${id}/complete`, { method: 'POST', body: input });
  }

  async createApproval(attemptId: string, input: { kind: ApprovalKind; summary?: Record<string, unknown> }): Promise<ApprovalRecord> {
    return this.request<ApprovalRecord>(`/v1/attempts/${attemptId}/approvals`, { method: 'POST', body: input });
  }

  async resolveApproval(id: string, input: {
    resolution: 'approved' | 'rejected';
    attemptId?: string;
    gate?: ApprovalKind;
    expectedAttemptRevision?: number;
    expectedAttemptStatus?: AttemptStatus;
    requestedActionDigest?: string;
    frozenContextHash?: string;
    expectedRevision?: number;
  }): Promise<ApprovalRecord> {
    return this.request<ApprovalRecord>(`/v1/approvals/${id}/resolve`, { method: 'POST', body: input });
  }

  async createCheckpoint(attemptId: string, input: { kind: string; metadata?: Record<string, unknown> }): Promise<CheckpointRecord> {
    return this.request<CheckpointRecord>(`/v1/attempts/${attemptId}/checkpoints`, { method: 'POST', body: input });
  }

  async getAttempt(attemptId: string): Promise<AttemptRecord> {
    return this.request<AttemptRecord>(`/v1/attempts/${attemptId}`);
  }

  async getRequest(requestId: string): Promise<RequestEnvelopeRecord> {
    return this.request<RequestEnvelopeRecord>(`/v1/requests/${requestId}`);
  }

  async getAttemptContext(attemptId: string): Promise<AttemptContextRecord> {
    return this.request<AttemptContextRecord>(`/v1/attempts/${attemptId}/context`);
  }

  async claimKarkeDikhaAttempt(attemptId: string, input: { owner: string; leaseMs?: number }): Promise<CoreKarkeDikhaWorkerClaim> {
    return this.request(`/v1/karke-dikha/attempts/${attemptId}/claim`, { method: 'POST', body: input });
  }

  async heartbeatKarkeDikhaAttempt(attemptId: string, credentials: CoreKarkeDikhaWorkerCredentials): Promise<AttemptRecord> {
    return this.request(`/v1/karke-dikha/attempts/${attemptId}/heartbeat`, { method: 'POST', body: credentials });
  }

  async requestKarkeDikhaApproval(
    attemptId: string,
    credentials: CoreKarkeDikhaWorkerCredentials,
    input: { kind: 'proposal' | 'mutation'; summary: Record<string, unknown> },
  ): Promise<{ attempt: AttemptRecord; approval: ApprovalRecord }> {
    return this.request(`/v1/karke-dikha/attempts/${attemptId}/approvals`, {
      method: 'POST',
      body: { ...credentials, ...input },
    });
  }

  async resolveKarkeDikhaApproval(
    approval: ApprovalRecord,
    credentials: CoreKarkeDikhaWorkerCredentials,
    input: { resolution: 'approved' | 'rejected'; disposition?: 'cancel' | 'revise' },
  ): Promise<{ attempt: AttemptRecord; approval: ApprovalRecord }> {
    return this.request(`/v1/karke-dikha/approvals/${approval.id}/resolve`, {
      method: 'POST',
      body: {
        ...credentials,
        ...input,
        attemptId: approval.attemptId,
        gate: approval.kind,
        expectedAttemptRevision: approval.expectedAttemptRevision,
        expectedAttemptStatus: approval.expectedAttemptStatus,
        requestedActionDigest: approval.requestedActionDigest,
        expectedRevision: approval.revision,
      },
    });
  }

  async beginKarkeDikhaValidation(attemptId: string, credentials: CoreKarkeDikhaWorkerCredentials): Promise<AttemptRecord> {
    return this.request(`/v1/karke-dikha/attempts/${attemptId}/validation/start`, { method: 'POST', body: credentials });
  }

  async reportKarkeDikhaValidation(
    attemptId: string,
    credentials: CoreKarkeDikhaWorkerCredentials,
    evidence: KarkeDikhaValidationEvidence,
  ): Promise<KarkeDikhaValidationResult> {
    return this.request(`/v1/karke-dikha/attempts/${attemptId}/validation/report`, {
      method: 'POST',
      body: { ...credentials, evidence },
    });
  }

  async completeKarkeDikhaAttempt(
    attemptId: string,
    credentials: CoreKarkeDikhaWorkerCredentials,
    summary?: Record<string, unknown>,
  ): Promise<AttemptRecord> {
    return this.request(`/v1/karke-dikha/attempts/${attemptId}/complete`, { method: 'POST', body: { ...credentials, summary } });
  }

  async failKarkeDikhaAttempt(
    attemptId: string,
    credentials: CoreKarkeDikhaWorkerCredentials,
    failureReason: string,
  ): Promise<AttemptRecord> {
    return this.request(`/v1/karke-dikha/attempts/${attemptId}/fail`, { method: 'POST', body: { ...credentials, failureReason } });
  }

  async cancelKarkeDikhaAttempt(attemptId: string, credentials: CoreKarkeDikhaWorkerCredentials): Promise<AttemptRecord> {
    return this.request(`/v1/karke-dikha/attempts/${attemptId}/cancel`, { method: 'POST', body: credentials });
  }

  /**
   * Asks the Core to *run* this attempt in-process (M32 Priority 1 — Core-owned
   * execution). Fire-and-forget on the Core side (202 Accepted): the model call
   * and any Saath Kar tool processes execute inside the Core, so they survive
   * this Extension Host going away. Progress is observed via the runtime_event /
   * runtime_token WS channel and attempt polling.
   */
  async executeAttempt(attemptId: string, input: { workingDirectory?: string } = {}): Promise<{ status: string; attemptId: string }> {
    return this.request(`/v1/attempts/${attemptId}/execute`, { method: 'POST', body: input });
  }

  async getAttemptRecovery(attemptId: string): Promise<{ classification: 'safely_resumable' | 'safely_retryable_from_scratch' | 'awaiting_human_approval' | 'requires_reconciliation' | 'terminal'; contextIdentity: string; contextHash: string }> {
    return this.request(`/v1/attempts/${attemptId}/recovery`);
  }

  /** Durable task rows for the Tasks screen: status, model, worker, current activity, last event. */
  async getTaskOverview(limit = 20): Promise<{ tasks: TaskOverviewRow[] }> {
    return this.request('/v1/tasks/overview', { query: { limit } });
  }

  async listAttempts(query?: { requestId?: string; status?: AttemptStatus; activeOnly?: boolean; limit?: number; offset?: number }): Promise<{ attempts: AttemptRecord[] }> {
    return this.request('/v1/attempts', { query });
  }

  /** M33: durable task-history projection (additive Core read API). */
  async listTaskHistory(query?: { limit?: number; offset?: number; workspaceRoot?: string }): Promise<{ tasks: TaskHistoryEntry[] }> {
    return this.request('/v1/history/tasks', { query });
  }

  async getTaskHistoryDetail(attemptId: string): Promise<TaskHistoryDetail> {
    return this.request(`/v1/history/tasks/${attemptId}`);
  }

  /** One read-only activation snapshot, already scoped by Core to this exact
   * workspace and to non-terminal attempts. */
  async getWorkspaceAttemptRehydration(workspaceRoot: string): Promise<WorkspaceAttemptRehydration> {
    return this.request('/v1/workspaces/attempt-rehydration', { query: { workspaceRoot } });
  }

  /** M38: read-only capability-card display query, independent of
   * `getWorkspaceAttemptRehydration`'s active-execution-recovery contract —
   * a resolved/denied capability card must keep restoring for display even
   * after the attempt that created it has gone terminal. Never depends on
   * `rehydrateCoreAttempts()` having run first. */
  async listRecentWorkspaceCapabilityActions(workspaceRoot: string): Promise<RecentWorkspaceCapabilityActionsSnapshot> {
    return this.request('/v1/workspaces/recent-capability-actions', { query: { workspaceRoot } });
  }

  // --- M36: durable attachments (first vertical slice) ---

  /** Creates a pending (`uploading`) attachment record. No bytes travel with
   * this call — see `uploadAttachmentBytes`, a separate bounded raw upload. */
  async createAttachment(
    conversationId: string,
    input: { originalName: string; declaredMimeType: string; kind: AttachmentKind; byteSize: number },
  ): Promise<AttachmentRecord> {
    return this.request<AttachmentRecord>(`/v1/conversations/${conversationId}/attachments`, { method: 'POST', body: input });
  }

  /**
   * Streams raw bytes to the Core's bounded binary upload route — never
   * base64/JSON, since Core's normal JSON body cap is 1 MiB. Accepts a
   * Node `ReadableStream` (e.g. `fs.createReadStream`) plus the exact
   * declared byte size so the whole attachment is never buffered in the
   * Extension Host process; `declaredByteSize` becomes the `Content-Length`
   * header, which the Core route requires and validates against the
   * attachment's declared `byteSize`. Node's `fetch` requires
   * `duplex: 'half'` for a streaming request body.
   */
  async uploadAttachmentBytes(attachmentId: string, source: NodeJS.ReadableStream, declaredByteSize: number): Promise<AttachmentRecord> {
    const url = new URL(`/v1/attachments/${attachmentId}/bytes`, this.options.baseUrl);
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.options.token}`,
        'X-Client-Id': this.options.clientId,
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(declaredByteSize),
      },
      // Node's fetch BodyInit typing doesn't accept a Node ReadableStream
      // directly, but undici's fetch accepts one at runtime when `duplex`
      // is set — this keeps the file off the JS heap during upload.
      body: source as unknown as BodyInit,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });
    const bodyJson = await res.json().catch(() => undefined);
    if (!res.ok) {
      const error = (bodyJson as { error?: { code: string; message: string; details?: Record<string, unknown> } } | undefined)?.error;
      throw new CoreApiError(res.status, error?.code ?? 'internal_error', error?.message ?? 'attachment upload failed', error?.details);
    }
    return bodyJson as AttachmentRecord;
  }

  async getAttachment(attachmentId: string): Promise<AttachmentRecord> {
    return this.request<AttachmentRecord>(`/v1/attachments/${attachmentId}`);
  }

  async listConversationAttachments(conversationId: string): Promise<{ attachments: AttachmentRecord[] }> {
    return this.request(`/v1/conversations/${conversationId}/attachments`);
  }

  /** Restart restoration (M36): attachments linked to each message, keyed by messageId. */
  async listConversationMessageAttachments(conversationId: string): Promise<{ byMessage: Record<string, AttachmentRecord[]> }> {
    return this.request(`/v1/conversations/${conversationId}/message-attachments`);
  }

  async createResearch(conversationId: string, query: string): Promise<{ session: ResearchSessionRecord; approval: ResearchApprovalRecord }> {
    return this.request(`/v1/conversations/${conversationId}/research`, { method: 'POST', body: { query } });
  }

  async resolveResearch(sessionId: string, input: { approvalId: string; requestedActionDigest: string; resolution: 'approved' | 'rejected' }): Promise<ResearchSessionRecord> {
    return this.request(`/v1/research/${sessionId}/resolve`, { method: 'POST', body: input });
  }

  async getResearch(sessionId: string): Promise<{ session: ResearchSessionRecord; sources: ResearchSourceRecord[] }> {
    return this.request(`/v1/research/${sessionId}`);
  }

  async listConversationResearch(conversationId: string): Promise<{ research: ResearchSessionRecord[] }> {
    return this.request(`/v1/conversations/${conversationId}/research`);
  }

  async listMessageCitations(messageId: string): Promise<{ citations: CitationRecord[] }> {
    return this.request(`/v1/messages/${messageId}/citations`);
  }

  async deleteAttachment(attachmentId: string): Promise<AttachmentRecord> {
    return this.request<AttachmentRecord>(`/v1/attachments/${attachmentId}/delete`, { method: 'POST', body: {} });
  }

  /**
   * M38: the only way to reach a governed external-service capability
   * (GitHub, etc.). Core owns the decision, approval, evidence, and
   * idempotency entirely — this call never decides or executes locally.
   * See core/domain/capabilityDispatch.ts.
   */
  async dispatchCapability(input: {
    correlationId: string;
    toolName: string;
    arguments: Record<string, unknown>;
    cwd: string;
  }): Promise<CapabilityDispatchResult> {
    return this.request('/v1/capabilities/dispatch', { method: 'POST', body: input });
  }

  /** Relays a human decision to the exact Core approval envelope returned by
   * `dispatchCapability` — never fabricates or widens the envelope fields. */
  /** Aborts any in-flight adapter call for this capability action and marks
   * the anchor attempt cancelling — idempotent, safe to call more than once. */
  async cancelCapabilityAction(attemptId: string): Promise<AttemptRecord> {
    return this.request(`/v1/capabilities/attempts/${attemptId}/cancel`, { method: 'POST', body: {} });
  }

  /**
   * `resumedAttemptId` is non-null when this approval belonged to a Saath Kar
   * attempt whose `RuntimeExecutor` model loop was suspended on it — Core
   * already resumed that attempt's loop (and, for an approval, already
   * executed the action) as part of resolving it. Callers must not also
   * dispatch the action themselves in that case (see `AgentPanel.resolveRestoredCapabilityApproval`).
   */
  async resolveCapabilityApproval(approvalId: string, input: {
    resolution: 'approved' | 'rejected';
    attemptId: string;
    expectedAttemptRevision: number;
    expectedAttemptStatus: AttemptStatus;
    requestedActionDigest: string;
    frozenContextHash: string;
  }): Promise<ApprovalRecord & { resumedAttemptId: string | null }> {
    return this.request(`/v1/capabilities/approvals/${approvalId}/resolve`, { method: 'POST', body: input });
  }

  /**
   * M38 restart restoration: reads back the restorable capability actions
   * (pending or recently-terminal 'mutation' approvals) anchored on this
   * correlationId — e.g. the chat panel's durable `conversationId` — without
   * creating anything. Used by `AgentPanel` to re-derive approval cards after
   * a webview recreation or Extension Host restart.
   */
  async listCapabilityActions(correlationId: string): Promise<CapabilityActionsSnapshot> {
    return this.request(`/v1/capabilities/actions?correlationId=${encodeURIComponent(correlationId)}`);
  }

  /**
   * Jarvis Connector Foundation: truthful state (`not_configured` /
   * `connecting` / `connected` / `degraded` / `unavailable`) and
   * read/draft/execute permission grants for Gmail, Google Calendar,
   * WhatsApp, and Printer. See core/domain/connectors.ts.
   */
  async listConnectors(): Promise<{ connectors: ConnectorStatus[] }> {
    return this.request('/v1/connectors');
  }

  /**
   * Pandesh's brief: the operator's Home attention items and the Today
   * briefing, plus the same brief rendered as text so the conversation and
   * the app always say the same thing.
   *
   * `external` additionally reads the live calendar and mailbox through the
   * connector adapters. It is off by default so a Home load stays fast.
   */
  async getAssistantBrief(external = false): Promise<{ brief: AssistantBrief; markdown: string }> {
    return this.request('/v1/assistant/brief', { query: { external: external ? '1' : '0' } });
  }

  /** The user-configured daily brief routine, or null when it was never set up. */
  async getDailyBriefRoutine(): Promise<{ routine: DailyBriefRoutine | null }> {
    return this.request('/v1/assistant/routine/daily-brief');
  }

  /** Creates, reschedules, enables or disables the daily brief routine. */
  async configureDailyBriefRoutine(input: {
    dailyTime: string;
    timezone?: string;
    enabled?: boolean;
  }): Promise<{ routine: DailyBriefRoutine | null }> {
    return this.request('/v1/assistant/routine/daily-brief', { method: 'POST', body: input });
  }

  /**
   * Answers a pending approval from the operator's own click on a visible card.
   * Core reads the approval envelope from the approval record itself, so the
   * decision can never be widened — and a stale card is refused, not applied.
   */
  async resolveAssistantApproval(
    approvalId: string,
    resolution: 'approved' | 'rejected',
  ): Promise<{ id: string; status: string; resolution: string | null; resumedAttemptId: string | null }> {
    return this.request(`/v1/assistant/approvals/${encodeURIComponent(approvalId)}/resolve`, {
      method: 'POST',
      body: { resolution },
    });
  }

  /** Grants or revokes exactly one read/draft/execute tier for one connector.
   * Reading a connector must never grant drafting or execution — each tier is
   * set independently. */
  async setConnectorPermission(connectorId: ConnectorId, input: { tier: 'read' | 'draft' | 'execute'; granted: boolean }): Promise<{ permissions: ConnectorPermissions }> {
    return this.request(`/v1/connectors/${encodeURIComponent(connectorId)}/permissions`, { method: 'POST', body: input });
  }

  /**
   * Pushes a freshly minted short-lived Gmail access token into Core's
   * in-memory store (`core/runtime/connectors/gmailAccessTokenStore.ts`) over
   * this same authenticated loopback connection — this is how a token refresh
   * reaches Core without restarting it. Desktop owns minting/refresh entirely;
   * Core never sees the refresh token. Core re-probes Gmail health as part of
   * handling this request and returns the result, so a push that lands on an
   * otherwise-healthy connector makes it immediately dispatchable — no
   * separate round trip, no Core restart.
   */
  async pushGmailAccessToken(input: { accessToken: string; expiresAt: string; accountEmail: string; scopes?: string[] }): Promise<{ ok: true; connector: ConnectorStatus; connectors?: Partial<Record<ConnectorId, ConnectorStatus>> }> {
    return this.request('/v1/connectors/gmail/access-token', { method: 'PATCH', body: input });
  }

  /** Clears Core's in-memory Gmail access token (disconnect/revocation) and
   * re-probes, so a previously cached "available" health can never outlive
   * the token that made it true. */
  async clearGmailAccessToken(): Promise<{ ok: true; connector: ConnectorStatus }> {
    return this.request('/v1/connectors/gmail/access-token', { method: 'DELETE' });
  }

  /** Explicit operator-triggered re-probe (Gmail diagnostics "Retry"),
   * generic across connectors — reuses the one health authority in
   * `core/domain/connectors.ts`, never a second one. */
  async retryConnectorProbe(connectorId: ConnectorId): Promise<{ connector: ConnectorStatus }> {
    return this.request(`/v1/connectors/${encodeURIComponent(connectorId)}/probe`, { method: 'POST' });
  }

  /** Local-only summary of an email thread's already-fetched messages — a
   * raw, tool-free completion, never routed through OpenRouter or the agent
   * loop. See core/runtime/gmailSummary.ts. */
  async summarizeGmailThread(input: { model: string; messages: Array<{ from: string; subject: string; date: string; bodyText: string }> }): Promise<{ summary: string }> {
    return this.request('/v1/gmail/summarize-thread', { method: 'POST', body: input });
  }

  /**
   * M39: the durable tool-invocation evidence recorded on an attempt. Used by
   * `AgentPanel` to fetch a governed capability call's full result (which
   * lives on the capability anchor attempt, not the Saath Kar attempt) so the
   * chat webview can render it — Core stays the only source of that evidence.
   */
  async listToolInvocations(attemptId: string): Promise<{ toolInvocations: ToolInvocationRecord[] }> {
    return this.request(`/v1/attempts/${encodeURIComponent(attemptId)}/tool-invocations`);
  }

  private scheduleReconnect(): void {
    if (this.disposed) return;
    this.reconnectAttempt += 1;
    if (this.reconnectAttempt > MAX_RECONNECT_ATTEMPTS) {
      // Bounded. An unbounded reconnect loop against a Core that is not there
      // is a background job that never ends and never recovers on its own: the
      // user sees a counter climbing for hours and has no idea what to do.
      // After the cap the client stops, says so in words, and waits for the
      // operator to ask it to try again.
      this.stopHeartbeatWatchdog();
      this.setStatus({
        state: 'disconnected',
        detail: 'The local Core did not answer. Pandesh stopped retrying on its own — use Retry to try again, or restart the Core.',
      });
      return;
    }
    const delay = Math.min(BASE_RECONNECT_DELAY_MS * 2 ** (this.reconnectAttempt - 1), MAX_RECONNECT_DELAY_MS);
    // The operator sees a sentence, not a counter. The attempt number is
    // still tracked internally for the backoff, but it is never user-facing.
    this.setStatus({ state: 'reconnecting', detail: 'The local Core is not answering. Reconnecting…' });
    this.reconnectTimer = setTimeout(() => this.connectWebSocket(), delay);
  }

  /**
   * Reconnects now, on the operator's request.
   *
   * This is the recovery action behind the "Retry" button. It resets the
   * attempt counter, so a human retry always starts from a clean slate
   * instead of inheriting a long backoff.
   */
  retryConnection(): void {
    if (this.disposed) return;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.reconnectAttempt = 0;
    this.setStatus({ state: 'reconnecting', detail: 'The local Core is not answering. Reconnecting…' });
    this.connectWebSocket();
  }

  private markSocketAlive(): void {
    this.lastMessageAt = Date.now();
  }

  private heartbeatStaleMs(): number {
    return this.options.heartbeatStaleMs ?? HEARTBEAT_STALE_MS;
  }

  private startHeartbeatWatchdog(): void {
    this.stopHeartbeatWatchdog();
    const staleMs = this.heartbeatStaleMs();
    this.heartbeatWatchdog = setInterval(() => {
      if (Date.now() - this.lastMessageAt > staleMs) {
        this.ws?.terminate();
      }
    }, staleMs / 2);
  }

  private stopHeartbeatWatchdog(): void {
    if (this.heartbeatWatchdog) {
      clearInterval(this.heartbeatWatchdog);
      this.heartbeatWatchdog = undefined;
    }
  }

  /** Disconnects this client only — never terminates the Core process itself. */
  dispose(): void {
    this.disposed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.stopHeartbeatWatchdog();
    this.ws?.close();
  }
}
