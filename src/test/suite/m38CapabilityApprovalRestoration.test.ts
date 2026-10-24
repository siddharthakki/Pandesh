import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { AgentPanel } from '../../ui/AgentPanel';
import * as extensionModule from '../../extension';
import type { CapabilityActionDisplayEntry, CapabilityActionRestoreEntry, CapabilityActionsSnapshot, CapabilityDispatchResult, ApprovalRecord, AttemptStatus, AttemptRehydrationRecord } from '../../../core/shared/wireTypes';

/**
 * M38 restart restoration: proves a pending (or recently-terminal) governed
 * capability approval card re-derives from Core's own durable state — via
 * `AgentPanel.restoreCapabilityApprovalCards()` / `CoreClient.listCapabilityActions`
 * — after (a) a webview recreation and (b) a simulated fresh Extension Host
 * (a brand-new `AgentPanel` + brand-new `CoreClient` instance pointed at the
 * same underlying fake Core state, proving nothing extension-host-local was
 * required), without resubmitting the task and without ever double-executing
 * the external mutation. Follows the fixture conventions of
 * `agentPanelRestartRehydration.test.ts` (attachPanel/context/manager helpers)
 * and the FakeCoreClient conventions of `m38PackagedThreeCapabilityWorkflow.test.ts`.
 */

interface PostedMessage { type: string; [key: string]: unknown }

function context(): vscode.ExtensionContext {
  return {
    subscriptions: [],
    extensionUri: vscode.Uri.file(process.cwd()),
    secrets: { get: async () => undefined, store: async () => undefined, delete: async () => undefined, onDidChange: () => ({ dispose: () => undefined }) },
    extension: { packageJSON: { scripts: {}, contributes: { commands: [] } } },
    globalState: { get: () => undefined, update: async () => undefined },
  } as unknown as vscode.ExtensionContext;
}

function attachPanel(root: string, posted: PostedMessage[]): AgentPanel {
  const panel = new AgentPanel(context(), root);
  let receive: ((msg: unknown) => void) | undefined;
  const webview = {
    options: {}, html: '', cspSource: 'vscode-webview://m38-restore-test',
    asWebviewUri: (uri: vscode.Uri) => uri,
    postMessage: (message: PostedMessage) => { posted.push(message); return Promise.resolve(true); },
    onDidReceiveMessage: (handler: (msg: unknown) => void) => { receive = handler; return { dispose: () => undefined }; },
  };
  panel.resolveWebviewView({
    webview, show: () => undefined, onDidDispose: () => ({ dispose: () => undefined }), visible: true,
  } as unknown as vscode.WebviewView, {} as never, {} as never);
  // These tests are about restoration LOGIC, not the readiness handshake: they
  // assert the card is delivered, which in production only happens once the
  // webview script has attached its listener and reported ready. M39 routes
  // durable restoration messages through that readiness queue (see
  // AgentPanel.postApprovalCardMessage), so model a ready webview here. The
  // race itself is covered by m39RestorationReadinessRace.test.ts.
  receive?.({ type: 'webviewReady', mode: 'chat' });
  return panel;
}

async function runRestore(panel: AgentPanel): Promise<void> {
  const internals = panel as unknown as {
    completeWorkspaceRestoration(): Promise<void>;
    restoreCapabilityApprovalCards(): Promise<void>;
  };
  await internals.completeWorkspaceRestoration();
  await internals.restoreCapabilityApprovalCards();
}

/** Shared fake Core state — a single source of truth simulating Core's
 * durable SQLite state, which multiple independent FakeCoreClient instances
 * (and multiple independent AgentPanel instances) can be pointed at, proving
 * restoration is genuinely Core-authoritative rather than relying on any
 * extension-host-local memory. */
class FakeCoreState {
  action: CapabilityActionRestoreEntry;
  attemptId = 'att_m38_restore_1';
  dispatchCalls: Array<{ correlationId: string; toolName: string; arguments: Record<string, unknown> }> = [];
  resolveCalls: Array<{ approvalId: string; resolution: string }> = [];

  constructor(overrides: Partial<CapabilityActionRestoreEntry> = {}) {
    this.action = {
      approvalId: 'appr_m38_restore_1',
      attemptId: this.attemptId,
      kind: 'mutation',
      status: 'pending',
      actionable: true,
      toolName: 'github_comment_on_issue',
      arguments: { number: 42, body: 'Root cause analysis.' },
      requestedAt: '2026-07-24T10:00:00.000Z',
      resolvedAt: null,
      resolution: null,
      expectedAttemptRevision: 4,
      expectedAttemptStatus: 'waiting_for_approval',
      requestedActionDigest: 'digest-m38-restore-1',
      frozenContextHash: 'context-m38-restore-1',
      revision: 1,
      outcome: 'pending',
      invocation: null,
      ...overrides,
    };
  }

  snapshot(): CapabilityActionsSnapshot {
    return { attemptId: this.attemptId, actions: [this.action] };
  }

  resolve(approvalId: string, input: { resolution: 'approved' | 'rejected'; expectedAttemptRevision: number; requestedActionDigest: string }): ApprovalRecord {
    this.resolveCalls.push({ approvalId, resolution: input.resolution });
    if (this.action.status !== 'pending' || input.expectedAttemptRevision !== this.action.expectedAttemptRevision || input.requestedActionDigest !== this.action.requestedActionDigest) {
      throw new Error('revision_mismatch: approval is stale or already resolved');
    }
    this.action = {
      ...this.action,
      status: input.resolution,
      actionable: false,
      resolution: input.resolution,
      resolvedAt: '2026-07-24T10:05:00.000Z',
      outcome: input.resolution === 'approved' ? 'approved' : 'rejected',
      revision: this.action.revision + 1,
    };
    return {
      id: approvalId, attemptId: this.attemptId, kind: 'mutation', status: input.resolution,
      requestedAt: this.action.requestedAt, resolvedAt: this.action.resolvedAt, resolution: input.resolution,
      summary: { toolName: this.action.toolName, arguments: this.action.arguments }, claimOwner: null, claimExpiresAt: null,
      envelopeVersion: 1, expectedAttemptRevision: this.action.expectedAttemptRevision, expectedAttemptStatus: this.action.expectedAttemptStatus,
      requestedActionDigest: this.action.requestedActionDigest, frozenContextHash: this.action.frozenContextHash, revision: this.action.revision,
    };
  }

  dispatchAfterApproval(correlationId: string, toolName: string, args: Record<string, unknown>): CapabilityDispatchResult {
    this.dispatchCalls.push({ correlationId, toolName, arguments: args });
    if (this.action.status !== 'approved') {
      throw new Error('cannot execute: approval is not approved');
    }
    this.action = { ...this.action, outcome: 'succeeded', invocation: { id: 'tinv_m38_restore_1', status: 'succeeded', evidence: { output: 'posted' }, exitCode: 0 } };
    return {
      outcome: 'executed', attemptId: this.attemptId,
      toolInvocation: { id: 'tinv_m38_restore_1', attemptId: this.attemptId, toolName, argsSummary: args, status: 'succeeded', startedAt: '2026-07-24T10:05:01.000Z', endedAt: '2026-07-24T10:05:02.000Z', exitCode: 0, evidence: { output: 'posted' } },
    };
  }
}

class FakeCoreClient {
  constructor(private readonly state: FakeCoreState) {}
  async getWorkspaceConversationLedger(workspaceIdentity: string) {
    return {
      schemaVersion: 1 as const,
      workspaceIdentity,
      currentConversationId: 'default',
      currentCoreConversationId: 'conv_m38_restore',
      conversations: [{
        localConversationId: 'default',
        conversationId: 'conv_m38_restore',
        title: null,
        createdAt: '2026-07-24T09:58:00.000Z',
        updatedAt: '2026-07-24T10:05:00.000Z',
        archivedAt: null,
      }],
      turns: [],
    };
  }
  async listCapabilityActions(_correlationId: string): Promise<CapabilityActionsSnapshot> { return this.state.snapshot(); }
  async listRecentWorkspaceCapabilityActions() {
    return {
      attemptId: this.state.attemptId,
      actions: [{
        ...this.state.action,
        correlationId: 'conv_m38_restore',
        realAttemptId: this.state.attemptId,
      }],
    };
  }
  async resolveCapabilityApproval(approvalId: string, input: { resolution: 'approved' | 'rejected'; attemptId: string; expectedAttemptRevision: number; expectedAttemptStatus: AttemptStatus; requestedActionDigest: string; frozenContextHash: string }): Promise<ApprovalRecord> {
    return this.state.resolve(approvalId, input);
  }
  async dispatchCapability(input: { correlationId: string; toolName: string; arguments: Record<string, unknown>; cwd: string }): Promise<CapabilityDispatchResult> {
    return this.state.dispatchAfterApproval(input.correlationId, input.toolName, input.arguments);
  }
  async cancelCapabilityAction(_attemptId: string): Promise<unknown> { return { status: 'cancelling' }; }
  async listMessages(): Promise<{ messages: never[] }> { return { messages: [] }; }
}

function manager(client: FakeCoreClient) {
  return {
    getClient: () => client,
    onRuntimeEvent: () => ({ dispose: () => undefined }),
    onRuntimeToken: () => ({ dispose: () => undefined }),
  };
}

describe('M38 capability approval webview/restart restoration', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'm38-capability-restore-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it('restores a pending github_comment_on_issue approval automatically after a fresh webview is created, without resubmitting the task', async () => {
    const state = new FakeCoreState();
    const client = new FakeCoreClient(state);
    vi.spyOn(extensionModule, 'getCoreManager').mockReturnValue(manager(client) as never);
    const posted: PostedMessage[] = [];
    const panel = attachPanel(root, posted);

    await runRestore(panel);

    const card = posted.find(m => m.type === 'restoreCapabilityApprovalCard');
    expect(card).toBeDefined();
    expect(card?.resolved).toBe(false);
    expect(card?.approvalId).toBe(state.action.approvalId);
    expect(card?.attemptId).toBe(state.action.attemptId);
    expect(card?.requestedActionDigest).toBe(state.action.requestedActionDigest);
  });

  it('restores the same pending card after a simulated fresh Extension Host (new AgentPanel + new CoreClient, same underlying Core state)', async () => {
    const state = new FakeCoreState();

    // "First Extension Host": the live path that created the pending approval.
    const firstClient = new FakeCoreClient(state);
    vi.spyOn(extensionModule, 'getCoreManager').mockReturnValue(manager(firstClient) as never);
    const firstPosted: PostedMessage[] = [];
    attachPanel(root, firstPosted);

    // "Restarted Extension Host": brand-new AgentPanel instance AND brand-new
    // CoreClient instance — nothing extension-host-local is reused, only the
    // shared FakeCoreState (standing in for Core's durable SQLite DB).
    const secondClient = new FakeCoreClient(state);
    vi.spyOn(extensionModule, 'getCoreManager').mockReturnValue(manager(secondClient) as never);
    const secondPosted: PostedMessage[] = [];
    const secondPanel = attachPanel(root, secondPosted);

    await runRestore(secondPanel);

    const card = secondPosted.find(m => m.type === 'restoreCapabilityApprovalCard');
    expect(card).toBeDefined();
    expect(card?.resolved).toBe(false);
    expect(card?.approvalId).toBe(state.action.approvalId);
    expect(card?.attemptId).toBe(state.action.attemptId);
    expect(card?.requestedActionDigest).toBe(state.action.requestedActionDigest);
  });

  it('approving the restored card results in exactly one dispatchCapability call after resolveCapabilityApproval', async () => {
    const state = new FakeCoreState();
    const client = new FakeCoreClient(state);
    vi.spyOn(extensionModule, 'getCoreManager').mockReturnValue(manager(client) as never);
    const posted: PostedMessage[] = [];
    const panel = attachPanel(root, posted);
    await runRestore(panel);

    await (panel as unknown as { resolveRestoredCapabilityApproval(input: unknown): Promise<void> }).resolveRestoredCapabilityApproval({
      approvalId: state.action.approvalId,
      attemptId: state.action.attemptId,
      toolName: state.action.toolName,
      arguments: state.action.arguments,
      expectedAttemptRevision: state.action.expectedAttemptRevision,
      expectedAttemptStatus: state.action.expectedAttemptStatus,
      requestedActionDigest: state.action.requestedActionDigest,
      frozenContextHash: state.action.frozenContextHash,
      resolution: 'approved',
    });

    expect(state.resolveCalls).toEqual([{ approvalId: state.action.approvalId, resolution: 'approved' }]);
    expect(state.dispatchCalls).toHaveLength(1);
    expect(posted.some(m => m.type === 'capabilityApprovalRestoredResolved' && m.outcome === 'succeeded')).toBe(true);
  });

  it('denying the restored card results in zero dispatchCapability calls', async () => {
    const state = new FakeCoreState();
    const client = new FakeCoreClient(state);
    vi.spyOn(extensionModule, 'getCoreManager').mockReturnValue(manager(client) as never);
    const posted: PostedMessage[] = [];
    const panel = attachPanel(root, posted);
    await runRestore(panel);

    await (panel as unknown as { resolveRestoredCapabilityApproval(input: unknown): Promise<void> }).resolveRestoredCapabilityApproval({
      approvalId: state.action.approvalId,
      attemptId: state.action.attemptId,
      toolName: state.action.toolName,
      arguments: state.action.arguments,
      expectedAttemptRevision: state.action.expectedAttemptRevision,
      expectedAttemptStatus: state.action.expectedAttemptStatus,
      requestedActionDigest: state.action.requestedActionDigest,
      frozenContextHash: state.action.frozenContextHash,
      resolution: 'rejected',
    });

    expect(state.resolveCalls).toEqual([{ approvalId: state.action.approvalId, resolution: 'rejected' }]);
    expect(state.dispatchCalls).toHaveLength(0);
    expect(posted.some(m => m.type === 'capabilityApprovalRestoredResolved' && m.outcome === 'rejected')).toBe(true);
  });

  it('the restored card references the original action/approval identifiers exactly', async () => {
    const state = new FakeCoreState({ approvalId: 'appr_exact_id', requestedActionDigest: 'digest_exact', expectedAttemptRevision: 9 });
    const client = new FakeCoreClient(state);
    vi.spyOn(extensionModule, 'getCoreManager').mockReturnValue(manager(client) as never);
    const posted: PostedMessage[] = [];
    const panel = attachPanel(root, posted);

    await runRestore(panel);

    const card = posted.find(m => m.type === 'restoreCapabilityApprovalCard');
    expect(card?.approvalId).toBe('appr_exact_id');
    expect(card?.requestedActionDigest).toBe('digest_exact');
    expect(card?.expectedAttemptRevision).toBe(9);
  });

  it('a duplicate restore event (calling the restore method twice in the same session) posts exactly one card for the same approvalId', async () => {
    const state = new FakeCoreState();
    const client = new FakeCoreClient(state);
    vi.spyOn(extensionModule, 'getCoreManager').mockReturnValue(manager(client) as never);
    const posted: PostedMessage[] = [];
    const panel = attachPanel(root, posted);

    await runRestore(panel);
    await runRestore(panel);

    const cards = posted.filter(m => m.type === 'restoreCapabilityApprovalCard' && m.approvalId === state.action.approvalId);
    expect(cards).toHaveLength(1);
  });

  it('a stale digest/revision cannot be approved — AgentPanel surfaces the failure rather than silently succeeding or double-executing', async () => {
    const state = new FakeCoreState();
    const client = new FakeCoreClient(state);
    vi.spyOn(extensionModule, 'getCoreManager').mockReturnValue(manager(client) as never);
    const posted: PostedMessage[] = [];
    const panel = attachPanel(root, posted);
    await runRestore(panel);

    // The approval has already moved on (resolved once for real) by the time
    // this stale envelope is submitted.
    state.resolve(state.action.approvalId, { resolution: 'approved', expectedAttemptRevision: state.action.expectedAttemptRevision, requestedActionDigest: state.action.requestedActionDigest });
    const staleRevision = 4; // the ORIGINAL (now stale) revision captured by a restored card

    await (panel as unknown as { resolveRestoredCapabilityApproval(input: unknown): Promise<void> }).resolveRestoredCapabilityApproval({
      approvalId: state.action.approvalId,
      attemptId: state.action.attemptId,
      toolName: state.action.toolName,
      arguments: state.action.arguments,
      expectedAttemptRevision: staleRevision,
      expectedAttemptStatus: 'waiting_for_approval',
      requestedActionDigest: 'digest-m38-restore-1', // the original (now-stale) digest
      frozenContextHash: state.action.frozenContextHash,
      resolution: 'approved',
    });

    expect(posted.some(m => m.type === 'error')).toBe(true);
    expect(posted.some(m => m.type === 'capabilityApprovalRestoredResolved')).toBe(false);
    // No double-execution: the only dispatch call recorded is the one already
    // made by state.resolve's own approval path — none from this failed retry.
    expect(state.dispatchCalls).toHaveLength(0);
  });

  it.each([
    { resolution: 'approved' as const, outcome: 'approved' as const },
    { resolution: 'rejected' as const, outcome: 'rejected' as const },
  ])('a terminal, already-resolved ($resolution) action restores as resolved/non-actionable with outcome $outcome', async ({ resolution, outcome }) => {
    const state = new FakeCoreState();
    state.resolve(state.action.approvalId, { resolution, expectedAttemptRevision: state.action.expectedAttemptRevision, requestedActionDigest: state.action.requestedActionDigest });
    const client = new FakeCoreClient(state);
    vi.spyOn(extensionModule, 'getCoreManager').mockReturnValue(manager(client) as never);
    const posted: PostedMessage[] = [];
    const panel = attachPanel(root, posted);

    await runRestore(panel);

    const card = posted.find(m => m.type === 'restoreCapabilityApprovalCard');
    expect(card?.resolved).toBe(true);
    expect(card?.outcome).toBe(outcome);
  });

  it.each([
    { invocationStatus: 'succeeded' as const },
    { invocationStatus: 'failed' as const },
    { invocationStatus: 'cancelled' as const },
  ])('a completed tool invocation ($invocationStatus) restores as resolved/non-actionable with the matching outcome', async ({ invocationStatus }) => {
    const state = new FakeCoreState({
      status: 'approved', actionable: false, resolution: 'approved', outcome: invocationStatus,
      invocation: { id: 'tinv_x', status: invocationStatus, evidence: {}, exitCode: invocationStatus === 'succeeded' ? 0 : 1 },
    });
    const client = new FakeCoreClient(state);
    vi.spyOn(extensionModule, 'getCoreManager').mockReturnValue(manager(client) as never);
    const posted: PostedMessage[] = [];
    const panel = attachPanel(root, posted);

    await runRestore(panel);

    const card = posted.find(m => m.type === 'restoreCapabilityApprovalCard');
    expect(card?.resolved).toBe(true);
    expect(card?.outcome).toBe(invocationStatus);
  });

  it('restarting again after completion keeps the card resolved (never re-actionable)', async () => {
    const state = new FakeCoreState();
    const client = new FakeCoreClient(state);
    vi.spyOn(extensionModule, 'getCoreManager').mockReturnValue(manager(client) as never);
    const posted1: PostedMessage[] = [];
    const panel1 = attachPanel(root, posted1);
    await runRestore(panel1);
    await (panel1 as unknown as { resolveRestoredCapabilityApproval(input: unknown): Promise<void> }).resolveRestoredCapabilityApproval({
      approvalId: state.action.approvalId, attemptId: state.action.attemptId, toolName: state.action.toolName,
      arguments: state.action.arguments, expectedAttemptRevision: state.action.expectedAttemptRevision,
      expectedAttemptStatus: state.action.expectedAttemptStatus, requestedActionDigest: state.action.requestedActionDigest,
      frozenContextHash: state.action.frozenContextHash, resolution: 'approved',
    });

    // A second "restart": brand new panel + brand new client, same state.
    const secondClient = new FakeCoreClient(state);
    vi.spyOn(extensionModule, 'getCoreManager').mockReturnValue(manager(secondClient) as never);
    const posted2: PostedMessage[] = [];
    const panel2 = attachPanel(root, posted2);
    await runRestore(panel2);

    const card = posted2.find(m => m.type === 'restoreCapabilityApprovalCard');
    expect(card?.resolved).toBe(true);
    expect(card?.outcome).toBe('succeeded');
  });
});

/**
 * M38 regression: `resolveWebviewView` restores capability approval cards
 * from `this.coreExecutionTurns`, which is populated only by
 * `rehydrateCoreAttempts()` (see `runCoreAttemptRehydration`) — a separate
 * async chain kicked off from `extension.ts`'s activation IIFE with no
 * ordering guarantee against `resolveWebviewView` firing. If the webview
 * resolves first, the restore pass finds no Core conversation mapping yet
 * and silently surfaces nothing, with nothing to retry it later — a real
 * pending GitHub approval card could simply never appear after an Extension
 * Host restart. The fix: `runCoreAttemptRehydration` re-runs
 * `restoreCapabilityApprovalCards()` once it finishes populating
 * `coreExecutionTurns`, so whichever chain finishes second is the one that
 * actually posts the card. These tests prove every relevant ordering (not
 * timing/polling — this is a deterministic call-ordering bug) still ends
 * with exactly one correct card, and never throws when rehydration runs
 * before any webview exists at all.
 */
describe('M38 capability approval restoration ordering (webview creation vs. Core attempt rehydration)', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'm38-capability-restore-ordering-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  const CONVERSATION_ID = 'conv_m38_ordering_1';

  function rehydrationRecord(state: FakeCoreState): AttemptRehydrationRecord {
    return {
      attempt: {
        id: state.attemptId, requestId: `req_${state.attemptId}`, predecessorAttemptId: null, kind: 'saath_kar', status: 'waiting_for_approval',
        createdAt: '2026-07-24T09:59:00.000Z', updatedAt: '2026-07-24T09:59:30.000Z',
        startedAt: '2026-07-24T09:59:01.000Z', completedAt: null,
        cancelledAt: null, cancelRequestedAt: null, failureReason: null,
        claimOwner: 'worker-1', claimExpiresAt: new Date(Date.now() + 120_000).toISOString(),
        fenceToken: 'fence-1', fenceGeneration: 1, revision: 4,
      },
      request: {
        id: `req_${state.attemptId}`, createdAt: '2026-07-24T09:59:00.000Z', clientId: 'client-1',
        currentMessage: 'mutate something', requestedMode: 'saath_kar', resolvedMode: 'saath_kar', routeReason: 'explicit',
        conversationId: CONVERSATION_ID, storyId: null, projectId: null, repositoryId: null, repositoryLocationId: null,
        requestedProvider: 'ollama', requestedModel: 'test-model', toolPermissionPolicy: {}, contextPolicy: {},
        correlationId: CONVERSATION_ID, idempotencyKey: `idem_${state.attemptId}`,
      },
      context: {
        id: `ctx_${state.attemptId}`, contextIdentity: `identity_${state.attemptId}`, requestId: `req_${state.attemptId}`, attemptId: state.attemptId,
        resolvedMode: 'saath_kar', workspaceRoot: root, repositoryId: null, repositoryLocationId: null,
        taskInput: 'mutate something', selectedProvider: 'ollama', selectedModel: 'test-model',
        permittedCapabilities: { hasWorkspace: true, gitCapable: true, allowedTools: [], contextPolicy: {} },
        approvalPolicy: {}, schemaVersion: 1, createdAt: '2026-07-24T09:59:00.000Z', contextHash: 'context-m38-ordering-1',
      },
      approvals: [],
      events: [{
        sequence: 1, id: `event_${state.attemptId}`, domain: 'attempt', entityId: state.attemptId, eventType: 'attempt_created',
        actor: 'core', clientId: null, idempotencyKey: null, createdAt: '2026-07-24T09:59:00.000Z', metadata: {}, resultingRevision: 1,
      }],
      recovery: 'awaiting_human_approval',
    };
  }

  /** Only returns the pending action for the real Core conversationId
   * (`coreConversationId`, populated solely via rehydration) — never for the
   * webview-local `this.conversationId` a fresh AgentPanel starts with —
   * so a card only appears once `coreExecutionTurns` genuinely has the
   * mapping, making the ordering race observable instead of accidentally
   * passing regardless of order. */
  class OrderingFakeCoreClient {
    constructor(
      private readonly state: FakeCoreState,
      private readonly records: AttemptRehydrationRecord[],
      /** Simulates `listRecentWorkspaceCapabilityActions` — deliberately a
       * SEPARATE data source from `records`/`getWorkspaceAttemptRehydration`,
       * since in production this read is independent of rehydration and can
       * surface an action whose owning attempt is terminal and therefore
       * absent from `records` entirely. */
      private readonly historicalActions: CapabilityActionRestoreEntry[] = [],
    ) {}
    async getWorkspaceConversationLedger(workspaceIdentity: string) {
      const hasHistoricalConversation = this.historicalActions.length > 0;
      return {
        schemaVersion: 1 as const,
        workspaceIdentity,
        currentConversationId: hasHistoricalConversation ? 'default' : null,
        currentCoreConversationId: hasHistoricalConversation ? CONVERSATION_ID : null,
        conversations: hasHistoricalConversation ? [{
          localConversationId: 'default',
          conversationId: CONVERSATION_ID,
          title: null,
          createdAt: '2026-07-24T09:58:00.000Z',
          updatedAt: '2026-07-24T10:05:00.000Z',
          archivedAt: null,
        }] : [],
        turns: [],
      };
    }
    async bindWorkspaceConversation(input: { workspaceIdentity: string; localConversationId: string; conversationId: string }) {
      return {
        schemaVersion: 1 as const,
        workspaceIdentity: input.workspaceIdentity,
        currentConversationId: input.localConversationId,
        currentCoreConversationId: input.conversationId,
        conversations: [{
          localConversationId: input.localConversationId,
          conversationId: input.conversationId,
          title: null,
          createdAt: '2026-07-24T09:58:00.000Z',
          updatedAt: '2026-07-24T10:05:00.000Z',
          archivedAt: null,
        }],
        turns: [],
      };
    }
    async listCapabilityActions(correlationId: string): Promise<CapabilityActionsSnapshot> {
      return correlationId === CONVERSATION_ID ? this.state.snapshot() : { attemptId: this.state.attemptId, actions: [] };
    }
    async resolveCapabilityApproval(approvalId: string, input: { resolution: 'approved' | 'rejected'; expectedAttemptRevision: number; requestedActionDigest: string }): Promise<ApprovalRecord> {
      return this.state.resolve(approvalId, input);
    }
    async dispatchCapability(input: { correlationId: string; toolName: string; arguments: Record<string, unknown>; cwd: string }): Promise<CapabilityDispatchResult> {
      return this.state.dispatchAfterApproval(input.correlationId, input.toolName, input.arguments);
    }
    async cancelCapabilityAction(): Promise<unknown> { return { status: 'cancelling' }; }
    async listMessages(): Promise<{ messages: never[] }> { return { messages: [] }; }
    async getWorkspaceAttemptRehydration(workspaceRoot: string): Promise<{ workspaceRoot: string; attempts: AttemptRehydrationRecord[] }> {
      return { workspaceRoot, attempts: this.records };
    }
    async getAttempt(id: string) { return this.records.find(r => r.attempt.id === id)!.attempt; }
    async listRecentWorkspaceCapabilityActions(): Promise<{ actions: CapabilityActionRestoreEntry[] }> {
      return { actions: this.historicalActions };
    }
  }

  function makePanel(): AgentPanel {
    return new AgentPanel(context(), root);
  }

  function resolveWebview(panel: AgentPanel, posted: PostedMessage[]): void {
    let receive: ((msg: unknown) => void) | undefined;
    const webview = {
      options: {}, html: '', cspSource: 'vscode-webview://m38-ordering-test',
      asWebviewUri: (uri: vscode.Uri) => uri,
      postMessage: (message: PostedMessage) => { posted.push(message); return Promise.resolve(true); },
      onDidReceiveMessage: (handler: (msg: unknown) => void) => { receive = handler; return { dispose: () => undefined }; },
    };
    panel.resolveWebviewView({
      webview, show: () => undefined, onDidDispose: () => ({ dispose: () => undefined }), visible: true,
    } as unknown as vscode.WebviewView, {} as never, {} as never);
    // Model a webview whose script has attached and reported ready — see the
    // note on the outer attachPanel helper. These ordering tests are about
    // restoration ORDERING, not the readiness handshake.
    receive?.({ type: 'webviewReady', mode: 'chat' });
  }

  it('webview creation finishes before Core attempt rehydration: the first pass finds no mapping, and the post-rehydration retry surfaces the card', async () => {
    const state = new FakeCoreState();
    const client = new OrderingFakeCoreClient(state, [rehydrationRecord(state)]);
    vi.spyOn(extensionModule, 'getCoreManager').mockReturnValue(manager(client as never) as never);

    const posted: PostedMessage[] = [];
    const panel = attachPanel(root, posted);
    await runRestore(panel); // webview's own restore pass completes first — coreExecutionTurns is still empty.
    expect(posted.find(m => m.type === 'restoreCapabilityApprovalCard')).toBeUndefined();

    await panel.rehydrateCoreAttempts(); // populates coreExecutionTurns, then retries restoreCapabilityApprovalCards internally.

    const card = posted.find(m => m.type === 'restoreCapabilityApprovalCard');
    expect(card).toBeDefined();
    expect(card?.approvalId).toBe(state.action.approvalId);
    expect(card?.requestedActionDigest).toBe(state.action.requestedActionDigest);
  });

  it('Core rehydration finishes before webview creation: the later webview restoration surfaces the card normally', async () => {
    const state = new FakeCoreState();
    const client = new OrderingFakeCoreClient(state, [rehydrationRecord(state)]);
    vi.spyOn(extensionModule, 'getCoreManager').mockReturnValue(manager(client as never) as never);

    const panel = makePanel();
    await expect(panel.rehydrateCoreAttempts()).resolves.not.toThrow(); // no webview exists yet; must not fail.

    const posted: PostedMessage[] = [];
    resolveWebview(panel, posted);
    await runRestore(panel); // the webview's own restore pass — coreExecutionTurns is already populated.

    const card = posted.find(m => m.type === 'restoreCapabilityApprovalCard');
    expect(card).toBeDefined();
    expect(card?.approvalId).toBe(state.action.approvalId);
  });

  it('both restoration paths executing (webview pass + post-rehydration retry) post exactly one card for the approval ID', async () => {
    const state = new FakeCoreState();
    const client = new OrderingFakeCoreClient(state, [rehydrationRecord(state)]);
    vi.spyOn(extensionModule, 'getCoreManager').mockReturnValue(manager(client as never) as never);

    const posted: PostedMessage[] = [];
    const panel = attachPanel(root, posted);
    await runRestore(panel);
    await panel.rehydrateCoreAttempts();
    await runRestore(panel); // an extra/overlapping restore pass on top of the two above.

    const cards = posted.filter(m => m.type === 'restoreCapabilityApprovalCard' && m.approvalId === state.action.approvalId);
    expect(cards).toHaveLength(1);
  });

  it('a terminal action whose attempt no longer rehydrates at all (a second restart after completion) still restores, via the independent historical read', async () => {
    // Simulates the real gap this closes: once an attempt is terminal,
    // listWorkspaceAttemptRehydration excludes it by design (see its own
    // docstring), so `records` here is deliberately EMPTY — no
    // coreExecutionTurns entry will ever exist for this approval again, on
    // any future restart. Only `listRecentWorkspaceCapabilityActions`
    // (never `rehydrateCoreAttempts()`) can still find it.
    const state = new FakeCoreState({ status: 'approved', actionable: false, resolution: 'approved', outcome: 'succeeded' });
    const client = new OrderingFakeCoreClient(state, [], [{ ...state.action, correlationId: CONVERSATION_ID } as never]);
    vi.spyOn(extensionModule, 'getCoreManager').mockReturnValue(manager(client as never) as never);

    // rehydrateCoreAttempts() is never called at all in this test — proving
    // the historical read does not depend on it having run, let alone
    // finished first.
    const posted: PostedMessage[] = [];
    const panel = attachPanel(root, posted);
    await runRestore(panel);

    const card = posted.find(m => m.type === 'restoreCapabilityApprovalCard' && m.approvalId === state.action.approvalId);
    expect(card).toBeDefined();
    expect(card?.resolved).toBe(true);
    expect(card?.outcome).toBe('succeeded');
  });

  it('rehydration occurring without an attached webview does not fail, and a subsequently created webview still restores the card', async () => {
    const state = new FakeCoreState();
    const client = new OrderingFakeCoreClient(state, [rehydrationRecord(state)]);
    vi.spyOn(extensionModule, 'getCoreManager').mockReturnValue(manager(client as never) as never);

    const panel = makePanel(); // no webview attached at all yet
    await expect(panel.rehydrateCoreAttempts()).resolves.not.toThrow();

    const posted: PostedMessage[] = [];
    resolveWebview(panel, posted);
    await runRestore(panel);

    const card = posted.find(m => m.type === 'restoreCapabilityApprovalCard');
    expect(card).toBeDefined();
    expect(card?.resolved).toBe(false);
  });

  it.each([
    { resolution: 'approved' as const },
    { resolution: 'rejected' as const },
  ])('the card surfaced by the post-rehydration retry resolves correctly on $resolution — the same checkpoint packaged scenarios C/D exercise', async ({ resolution }) => {
    const state = new FakeCoreState();
    const client = new OrderingFakeCoreClient(state, [rehydrationRecord(state)]);
    vi.spyOn(extensionModule, 'getCoreManager').mockReturnValue(manager(client as never) as never);

    const posted: PostedMessage[] = [];
    const panel = attachPanel(root, posted);
    await runRestore(panel); // webview resolves first, race scenario, exactly like C/D's pre-fix failure point.
    expect(posted.find(m => m.type === 'restoreCapabilityApprovalCard')).toBeUndefined();
    await panel.rehydrateCoreAttempts();
    const card = posted.find(m => m.type === 'restoreCapabilityApprovalCard');
    expect(card).toBeDefined();

    await (panel as unknown as { resolveRestoredCapabilityApproval(input: unknown): Promise<void> }).resolveRestoredCapabilityApproval({
      approvalId: state.action.approvalId,
      attemptId: state.action.attemptId,
      toolName: state.action.toolName,
      arguments: state.action.arguments,
      expectedAttemptRevision: state.action.expectedAttemptRevision,
      expectedAttemptStatus: state.action.expectedAttemptStatus,
      requestedActionDigest: state.action.requestedActionDigest,
      frozenContextHash: state.action.frozenContextHash,
      resolution,
    });

    expect(state.resolveCalls).toEqual([{ approvalId: state.action.approvalId, resolution }]);
    expect(state.dispatchCalls).toHaveLength(resolution === 'approved' ? 1 : 0);
  });

  it('does not surface or resolve a workspace mutation until the exact Saath Kar attempt is active in this workspace', async () => {
    const state = new FakeCoreState({
      toolName: 'run_command',
      arguments: { command: 'create note-saath.txt' },
    });
    const client = new OrderingFakeCoreClient(state, []);
    vi.spyOn(extensionModule, 'getCoreManager').mockReturnValue(manager(client as never) as never);

    const posted: PostedMessage[] = [];
    const panel = attachPanel(root, posted);
    await runRestore(panel);
    expect(posted.find(message => message.type === 'restoreCapabilityApprovalCard')).toBeUndefined();

    await (panel as unknown as { resolveRestoredCapabilityApproval(input: unknown): Promise<void> }).resolveRestoredCapabilityApproval({
      approvalId: state.action.approvalId,
      attemptId: state.action.attemptId,
      toolName: 'github_comment_on_issue',
      arguments: {},
      expectedAttemptRevision: state.action.expectedAttemptRevision,
      expectedAttemptStatus: state.action.expectedAttemptStatus,
      requestedActionDigest: state.action.requestedActionDigest,
      frozenContextHash: state.action.frozenContextHash,
      resolution: 'approved',
    });

    expect(state.resolveCalls).toHaveLength(0);
    expect(state.dispatchCalls).toHaveLength(0);
    expect(posted.some(message => message.type === 'error')).toBe(true);
  });

  it('binds a workspace mutation card to the active Saath Kar attempt and ignores tampered webview scope fields', async () => {
    const state = new FakeCoreState({
      toolName: 'run_command',
      arguments: { command: 'create note-saath.txt' },
    });
    const client = new OrderingFakeCoreClient(state, [rehydrationRecord(state)], [{
      ...state.action,
      correlationId: CONVERSATION_ID,
      realAttemptId: state.attemptId,
    } as CapabilityActionDisplayEntry]);
    vi.spyOn(extensionModule, 'getCoreManager').mockReturnValue(manager(client as never) as never);

    const posted: PostedMessage[] = [];
    const panel = attachPanel(root, posted);
    await panel.rehydrateCoreAttempts();
    await runRestore(panel);
    expect(posted.filter(message => message.type === 'restoreCapabilityApprovalCard')).toHaveLength(1);

    await (panel as unknown as { resolveRestoredCapabilityApproval(input: unknown): Promise<void> }).resolveRestoredCapabilityApproval({
      approvalId: state.action.approvalId,
      attemptId: 'att_other_workspace',
      toolName: 'github_comment_on_issue',
      arguments: { number: 999 },
      expectedAttemptRevision: -1,
      expectedAttemptStatus: 'created',
      requestedActionDigest: 'tampered',
      frozenContextHash: 'tampered',
      resolution: 'approved',
    });

    expect(state.resolveCalls).toEqual([{ approvalId: state.action.approvalId, resolution: 'approved' }]);
    expect(state.dispatchCalls).toEqual([{
      correlationId: CONVERSATION_ID,
      toolName: 'run_command',
      arguments: { command: 'create note-saath.txt' },
    }]);
  });

  it('binds a retried workspace approval to Core’s exact turn when an older turn in the same conversation is still nonterminal', async () => {
    const state = new FakeCoreState({
      toolName: 'run_command',
      arguments: { command: 'printf retry > note-saath.txt' },
    });
    const currentAttemptId = 'att_saath_retry_current';
    const historicalAction: CapabilityActionDisplayEntry = {
      ...state.action,
      correlationId: CONVERSATION_ID,
      realAttemptId: currentAttemptId,
    };
    const client = new OrderingFakeCoreClient(state, [], [historicalAction]);
    vi.spyOn(extensionModule, 'getCoreManager').mockReturnValue(manager(client as never) as never);

    const posted: PostedMessage[] = [];
    const panel = attachPanel(root, posted);
    const turns = (panel as unknown as {
      coreExecutionTurns: Map<string, { attemptId: string; terminal: boolean; mode: 'agent'; coreConversationId: string }>;
    }).coreExecutionTurns;
    const staleTurn = {
      attemptId: 'att_saath_rejected_stale',
      terminal: false,
      mode: 'agent' as const,
      coreConversationId: CONVERSATION_ID,
    };
    turns.set(staleTurn.attemptId, staleTurn);
    turns.set(currentAttemptId, {
      attemptId: currentAttemptId,
      terminal: false,
      mode: 'agent',
      coreConversationId: CONVERSATION_ID,
    });

    (panel as unknown as { handleCoreRuntimeEvent(event: unknown): void }).handleCoreRuntimeEvent({
      sequence: 1,
      id: 'event_saath_retry_waiting',
      domain: 'attempt',
      entityId: currentAttemptId,
      eventType: 'attempt_transitioned',
      actor: 'core',
      clientId: null,
      idempotencyKey: null,
      createdAt: '2026-07-30T09:07:21.242Z',
      metadata: { from: 'running', to: 'waiting_for_approval', reason: null },
      resultingRevision: 3,
    });
    await vi.waitFor(() => {
      expect(posted.filter(message => message.type === 'restoreCapabilityApprovalCard')).toHaveLength(1);
    });

    // The older turn can become terminal after the card is rendered but
    // before the user clicks. Approval authority must remain on Core's exact
    // current attempt, not on the first same-conversation Map entry.
    staleTurn.terminal = true;
    await (panel as unknown as { resolveRestoredCapabilityApproval(input: unknown): Promise<void> }).resolveRestoredCapabilityApproval({
      approvalId: state.action.approvalId,
      attemptId: state.action.attemptId,
      toolName: state.action.toolName,
      arguments: state.action.arguments,
      expectedAttemptRevision: state.action.expectedAttemptRevision,
      expectedAttemptStatus: state.action.expectedAttemptStatus,
      requestedActionDigest: state.action.requestedActionDigest,
      frozenContextHash: state.action.frozenContextHash,
      resolution: 'approved',
    });

    expect(state.resolveCalls).toEqual([{ approvalId: state.action.approvalId, resolution: 'approved' }]);
    expect(state.dispatchCalls).toHaveLength(1);
    expect(posted.some(message => message.type === 'error')).toBe(false);
  });
});
