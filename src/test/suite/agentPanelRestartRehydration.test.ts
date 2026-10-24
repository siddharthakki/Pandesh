import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { AgentRuntime } from '../../agent/AgentRuntime';
import { AutonomousTaskRuntime } from '../../activation/M15AutonomousRuntime';
import { DurableTaskQueue, IsolatedWorktreeManager, TaskResourceScheduler, createDefaultAutonomousTask } from '../../autonomous/M15AutonomousWork';
import { AgentPanel } from '../../ui/AgentPanel';
import * as extensionModule from '../../extension';
import type { ApprovalRecord, AttemptRehydrationRecord, AttemptStatus } from '../../../core/shared/wireTypes';

interface PostedMessage { type: string; [key: string]: unknown }

function context(): vscode.ExtensionContext {
  return {
    subscriptions: [],
    extensionUri: vscode.Uri.file(process.cwd()),
    secrets: { get: async () => undefined, store: async () => undefined, delete: async () => undefined, onDidChange: () => ({ dispose: () => undefined }) },
    extension: { packageJSON: { scripts: {}, contributes: { commands: [] } } },
  } as unknown as vscode.ExtensionContext;
}

function attachPanel(root: string, posted: PostedMessage[]) {
  const panel = new AgentPanel(context(), root);
  let messageHandler: ((msg: unknown) => void) | undefined;
  const webview = {
    options: {}, html: '', cspSource: 'vscode-webview://restart-test',
    asWebviewUri: (uri: vscode.Uri) => uri,
    postMessage: (message: PostedMessage) => { posted.push(message); return Promise.resolve(true); },
    onDidReceiveMessage: (handler: (msg: unknown) => void) => { messageHandler = handler; return { dispose: () => undefined }; },
  };
  panel.resolveWebviewView({
    webview, show: () => undefined, onDidDispose: () => ({ dispose: () => undefined }), visible: true,
  } as unknown as vscode.WebviewView, {} as never, {} as never);
  // This mock's `postMessage` always succeeds immediately regardless of
  // timing — i.e. it already models "a webview that is ready the instant it
  // is created" — so announce readiness (M38's `webviewReady`-gated approval
  // card queue, see AgentPanel's `postApprovalCardMessage`) right away too,
  // keeping this helper's long-standing "everything posts immediately"
  // contract for the many existing callers that never otherwise send
  // `webviewReady`. `attachPanelWithReadyGate` below is the one that actually
  // exercises the not-yet-ready race.
  messageHandler?.({ type: 'webviewReady', mode: 'autonomous' });
  return panel;
}

/**
 * Like `attachPanel`, but models a webview whose script has not yet loaded
 * and registered its `message` listener: any message posted while `ready` is
 * false is discarded (mirroring real `webview.postMessage` silently dropping
 * a post made before the receiving page is listening) instead of being
 * recorded into `posted`. Also captures the `onDidReceiveMessage` callback so
 * the test can simulate the webview sending `webviewReady` once its script
 * has "loaded".
 */
function attachPanelWithReadyGate(root: string, posted: PostedMessage[]) {
  const panel = new AgentPanel(context(), root);
  let ready = false;
  let messageHandler: ((msg: unknown) => void) | undefined;
  const webview = {
    options: {}, html: '', cspSource: 'vscode-webview://restart-test',
    asWebviewUri: (uri: vscode.Uri) => uri,
    postMessage: (message: PostedMessage) => {
      if (ready) posted.push(message);
      return Promise.resolve(ready);
    },
    onDidReceiveMessage: (handler: (msg: unknown) => void) => { messageHandler = handler; return { dispose: () => undefined }; },
  };
  panel.resolveWebviewView({
    webview, show: () => undefined, onDidDispose: () => ({ dispose: () => undefined }), visible: true,
  } as unknown as vscode.WebviewView, {} as never, {} as never);
  return {
    panel,
    sendWebviewReady: () => {
      ready = true;
      messageHandler?.({ type: 'webviewReady', mode: 'autonomous' });
    },
  };
}

function approval(attemptId: string, kind: ApprovalRecord['kind'] = 'proposal'): ApprovalRecord {
  return {
    id: `appr_${kind}_original`, attemptId, kind, status: 'pending',
    requestedAt: '2026-07-16T10:00:00.000Z', resolvedAt: null, resolution: null,
    summary: kind === 'proposal' ? { proposalId: 'proposal-original' } : kind === 'mutation' ? { requestId: 'mutation-original' } : { delivery: true }, claimOwner: null, claimExpiresAt: null,
    envelopeVersion: 1, expectedAttemptRevision: 3, expectedAttemptStatus: 'waiting_for_approval',
    requestedActionDigest: 'digest-original', frozenContextHash: 'hash-original', revision: 1,
  };
}

function record(
  root: string,
  id: string,
  kind: 'baat_kar' | 'saath_kar' | 'karke_dikha',
  status: AttemptStatus,
  recovery: AttemptRehydrationRecord['recovery'],
  approvals: ApprovalRecord[] = [],
): AttemptRehydrationRecord {
  const conversationId = kind === 'karke_dikha' ? null : `conv_${id}`;
  return {
    attempt: {
      id, requestId: `req_${id}`, predecessorAttemptId: null, kind, status,
      // Fresh: a never-started attempt is only re-executed on reload inside the crash window after submit.
      createdAt: new Date(Date.now() - 30_000).toISOString(), updatedAt: '2026-07-16T10:01:00.000Z',
      startedAt: status === 'created' ? null : '2026-07-16T10:00:01.000Z', completedAt: null,
      cancelledAt: null, cancelRequestedAt: null, failureReason: null,
      claimOwner: status === 'created' ? null : 'worker-original',
      claimExpiresAt: status === 'created' ? null : new Date(Date.now() + 120_000).toISOString(),
      fenceToken: status === 'created' ? null : 'fence-original', fenceGeneration: status === 'created' ? 0 : 1, revision: 3,
    },
    request: {
      id: `req_${id}`, createdAt: '2026-07-16T10:00:00.000Z', clientId: 'original-client',
      currentMessage: `goal ${id}`, requestedMode: kind, resolvedMode: kind, routeReason: 'explicit',
      conversationId, storyId: null, projectId: null, repositoryId: null, repositoryLocationId: null,
      requestedProvider: 'ollama', requestedModel: 'test-model', toolPermissionPolicy: {}, contextPolicy: {},
      correlationId: `corr_${id}`, idempotencyKey: `idem_${id}`,
    },
    context: {
      id: `ctx_${id}`, contextIdentity: `identity_${id}`, requestId: `req_${id}`, attemptId: id,
      resolvedMode: kind, workspaceRoot: root, repositoryId: null, repositoryLocationId: null,
      taskInput: `goal ${id}`, selectedProvider: 'ollama', selectedModel: 'test-model',
      permittedCapabilities: { hasWorkspace: true, gitCapable: true, allowedTools: [], contextPolicy: {} },
      approvalPolicy: {}, schemaVersion: 1, createdAt: '2026-07-16T10:00:00.000Z', contextHash: 'hash-original',
    },
    approvals,
    events: [{
      sequence: 1, id: `event_${id}`, domain: 'attempt', entityId: id, eventType: 'attempt_created',
      actor: 'core', clientId: null, idempotencyKey: null, createdAt: '2026-07-16T10:00:00.000Z', metadata: {}, resultingRevision: 1,
    }],
    recovery,
  };
}

function fakeClient(records: AttemptRehydrationRecord[]) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const currentCoreConversationId = records.find(item => item.request.conversationId)?.request.conversationId ?? null;
  let workspaceIdentity = '';
  const ledger = () => ({
    schemaVersion: 1,
    workspaceIdentity,
    currentConversationId: currentCoreConversationId ? 'default' : null,
    currentCoreConversationId,
    conversations: currentCoreConversationId ? [{
      workspaceIdentity,
      localConversationId: 'default',
      conversationId: currentCoreConversationId,
      title: 'Restored conversation',
      createdAt: '2026-07-16T10:00:00.000Z',
      updatedAt: '2026-07-16T10:01:00.000Z',
      archivedAt: null,
      schemaVersion: 1,
      migrationMetadata: {},
    }] : [],
    turns: [],
    migrationMetadata: {},
  });
  return {
    calls,
    async getWorkspaceConversationLedger(identity: string) {
      calls.push({ method: 'getWorkspaceConversationLedger', args: [identity] });
      workspaceIdentity = identity;
      return ledger();
    },
    async getWorkspaceAttemptRehydration(...args: unknown[]) { calls.push({ method: 'getWorkspaceAttemptRehydration', args }); return { workspaceRoot: args[0], attempts: records }; },
    async executeAttempt(...args: unknown[]) { calls.push({ method: 'executeAttempt', args }); return { status: 'accepted', attemptId: args[0] }; },
    async getAttempt(id: string) { calls.push({ method: 'getAttempt', args: [id] }); return records.find(item => item.attempt.id === id)!.attempt; },
    async claimKarkeDikhaAttempt(...args: unknown[]) { calls.push({ method: 'claimKarkeDikhaAttempt', args }); throw new Error('claim should not be called'); },
    async heartbeatKarkeDikhaAttempt(...args: unknown[]) { calls.push({ method: 'heartbeatKarkeDikhaAttempt', args }); },
    async requestKarkeDikhaApproval(...args: unknown[]) { calls.push({ method: 'requestKarkeDikhaApproval', args }); },
    async resolveKarkeDikhaApproval(...args: unknown[]) { calls.push({ method: 'resolveKarkeDikhaApproval', args }); },
    async beginKarkeDikhaValidation(...args: unknown[]) { calls.push({ method: 'beginKarkeDikhaValidation', args }); },
    async reportKarkeDikhaValidation(...args: unknown[]) { calls.push({ method: 'reportKarkeDikhaValidation', args }); },
    async completeKarkeDikhaAttempt(...args: unknown[]) { calls.push({ method: 'completeKarkeDikhaAttempt', args }); },
    async failKarkeDikhaAttempt(...args: unknown[]) { calls.push({ method: 'failKarkeDikhaAttempt', args }); },
    async cancelKarkeDikhaAttempt(...args: unknown[]) { calls.push({ method: 'cancelKarkeDikhaAttempt', args }); },
    async listMessages() { return { messages: [] }; },
    async listConversationMessageAttachments() { return { byMessage: {} }; },
    async listConversationResearch() { return { research: [] }; },
    async listResponseAlternatives() { return { alternatives: [] }; },
    async getConversationBranch() { return { branch: null }; },
    async listCapabilityActions() { return { attemptId: null, actions: [] }; },
    async listRecentWorkspaceCapabilityActions() { return { actions: [] }; },
  };
}

function manager(client: ReturnType<typeof fakeClient>) {
  return {
    getClient: () => client,
    onRuntimeEvent: () => ({ dispose: () => undefined }),
    onRuntimeToken: () => ({ dispose: () => undefined }),
  };
}

describe('AgentPanel Core restart rehydration', () => {
  let root: string;
  let runtime: AutonomousTaskRuntime;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'm32-panel-rehydrate-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    runtime?.dispose();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it('restores the newest existing Baat/Saath attempt once and never falls back to AgentRuntime.run()', async () => {
    const baat = record(root, 'att_baat_existing', 'baat_kar', 'created', 'safely_retryable_from_scratch');
    const historical = record(root, 'att_baat_historical', 'baat_kar', 'created', 'safely_retryable_from_scratch');
    const olderBaat = { ...historical, attempt: { ...historical.attempt, updatedAt: '2026-07-15T10:00:00.000Z' } };
    const saath = record(root, 'att_saath_existing', 'saath_kar', 'created', 'safely_retryable_from_scratch');
    const client = fakeClient([baat, olderBaat, saath]);
    vi.spyOn(extensionModule, 'getCoreManager').mockReturnValue(manager(client) as never);
    const runSpy = vi.spyOn(AgentRuntime.prototype, 'run');
    const posted: PostedMessage[] = [];
    const panel = attachPanel(root, posted);

    await Promise.all([panel.rehydrateCoreAttempts(), panel.rehydrateCoreAttempts()]);

    expect(client.calls.filter(call => call.method === 'getWorkspaceAttemptRehydration')).toHaveLength(1);
    expect(client.calls.filter(call => call.method === 'executeAttempt').map(call => call.args[0])).toEqual(['att_baat_existing']);
    expect(client.calls.some(call => call.method === 'submit')).toBe(false);
    expect(posted.filter(message => message.type === 'coreExecutionRestored').map(message => message.attemptId)).toEqual(['att_baat_existing']);
    expect(runSpy).not.toHaveBeenCalled();
  });

  it('uses the same activation read path for a claimable Saath Kar attempt', async () => {
    const saath = record(root, 'att_saath_existing', 'saath_kar', 'created', 'safely_retryable_from_scratch');
    const client = fakeClient([saath]);
    vi.spyOn(extensionModule, 'getCoreManager').mockReturnValue(manager(client) as never);
    const runSpy = vi.spyOn(AgentRuntime.prototype, 'run');
    const panel = attachPanel(root, []);

    await panel.rehydrateCoreAttempts();

    expect(client.calls.find(call => call.method === 'executeAttempt')?.args).toEqual([
      'att_saath_existing', { workingDirectory: root },
    ]);
    expect(runSpy).not.toHaveBeenCalled();
  });

  it('a reload never executes or re-projects a completed Saath task, however many times it rehydrates', async () => {
    const done = record(root, 'att_saath_three_files', 'saath_kar', 'completed', 'terminal');
    done.attempt.completedAt = '2026-07-16T10:05:00.000Z';
    done.events.push(
      ...['one.txt', 'two.txt', 'three.txt'].map((file, index) => ({
        sequence: index + 2, id: `event_tool_${file}`, domain: 'tool_invocation' as const, entityId: `inv_${file}`,
        eventType: 'tool_invocation_completed', actor: 'core', clientId: null, idempotencyKey: null,
        createdAt: '2026-07-16T10:02:00.000Z', metadata: { attemptId: 'att_saath_three_files', toolName: 'propose_file_change', status: 'succeeded' }, resultingRevision: 1,
      })),
    );
    const client = fakeClient([done]);
    vi.spyOn(extensionModule, 'getCoreManager').mockReturnValue(manager(client) as never);
    const posted: PostedMessage[] = [];
    const panel = attachPanel(root, posted);

    await panel.rehydrateCoreAttempts();
    await panel.rehydrateCoreAttempts();
    // A second webview resolving (another reload of the view) must not replay the task either.
    attachPanel(root, posted);
    await panel.rehydrateCoreAttempts();

    const mutating = ['executeAttempt', 'claimKarkeDikhaAttempt', 'submit', 'requestKarkeDikhaApproval', 'resolveKarkeDikhaApproval'];
    expect(client.calls.filter(call => mutating.includes(call.method))).toEqual([]);
    expect(posted.filter(message => message.type === 'dhaaga')).toEqual([]);
    expect(posted.filter(message => message.type === 'coreExecutionRestored' || message.type === 'toolStart' || message.type === 'toolResult')).toEqual([]);
  });

  it('a restored in-flight task is projected into the Dhaaga exactly once across repeated rehydration', async () => {
    const running = record(root, 'att_saath_inflight', 'saath_kar', 'running', 'safely_resumable');
    const client = fakeClient([running]);
    vi.spyOn(extensionModule, 'getCoreManager').mockReturnValue(manager(client) as never);
    const posted: PostedMessage[] = [];
    const panel = attachPanel(root, posted);

    await panel.rehydrateCoreAttempts();
    await panel.rehydrateCoreAttempts();

    expect(client.calls.some(call => call.method === 'executeAttempt')).toBe(false);
    const snapshots = posted.filter(message => message.type === 'dhaaga' && message.op === 'snapshot');
    expect(snapshots).toHaveLength(1);
    expect(posted.filter(message => message.type === 'coreExecutionRestored')).toHaveLength(1);
  });

  it('does not silently start an old never-started Saath task on reload', async () => {
    const stale = record(root, 'att_saath_old_queued', 'saath_kar', 'created', 'safely_retryable_from_scratch');
    stale.attempt.createdAt = new Date(Date.now() - 2 * 24 * 60 * 60_000).toISOString();
    const client = fakeClient([stale]);
    vi.spyOn(extensionModule, 'getCoreManager').mockReturnValue(manager(client) as never);
    const posted: PostedMessage[] = [];
    const panel = attachPanel(root, posted);

    await panel.rehydrateCoreAttempts();

    expect(client.calls.some(call => call.method === 'executeAttempt')).toBe(false);
    expect(posted.find(message => message.type === 'coreAttemptRecoveryRequired')).toMatchObject({ attemptId: 'att_saath_old_queued', reason: 'stale_not_started' });
  });

  it('reconnects Karke Dikha to the existing M15 projection and exact pending approval without claiming a second valid worker', async () => {
    const attemptId = 'att_karke_existing';
    const pending = approval(attemptId);
    const queue = new DurableTaskQueue(root);
    const base = await queue.enqueue({ ...createDefaultAutonomousTask(root, `goal ${attemptId}`), taskId: attemptId, attemptId });
    const running = await queue.update({
      ...base,
      state: 'waiting_for_proposal_approval',
      pendingProposal: { proposalId: 'proposal-original', version: 1, taskSummary: 'original', operations: [], validationCommands: [], warnings: [] },
    }, 'proposal_pending', {});
    expect(running.taskId).toBe(attemptId);
    runtime = new AutonomousTaskRuntime(context(), root, queue, new TaskResourceScheduler({
      maxActiveTasks: 1, maxActiveMutatingTasks: 1, modelConcurrency: { '*': 1 },
    }), new IsolatedWorktreeManager(root));
    runtime.requireCoreAuthorityForNewWork();
    const restoreSpy = vi.spyOn(runtime, 'restoreCoreAuthority');
    const wakeSpy = vi.spyOn(runtime, 'wake');
    const client = fakeClient([record(root, attemptId, 'karke_dikha', 'waiting_for_approval', 'awaiting_human_approval', [pending])]);
    vi.spyOn(extensionModule, 'getCoreManager').mockReturnValue(manager(client) as never);
    const posted: PostedMessage[] = [];
    const panel = attachPanel(root, posted);
    panel.attachAutonomous(queue, runtime);

    await panel.rehydrateCoreAttempts();

    expect(restoreSpy).toHaveBeenCalledTimes(1);
    expect(restoreSpy.mock.calls[0][0]).toBe(attemptId);
    expect(restoreSpy.mock.calls[0][2]).toEqual([pending]);
    expect(client.calls.some(call => call.method === 'claimKarkeDikhaAttempt')).toBe(false);
    expect(wakeSpy).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(posted.some(message => message.type === 'proposalApprovalRequest' && message.taskId === attemptId)).toBe(true);
    });
    expect((await queue.list()).map(task => task.taskId)).toEqual([attemptId]);
  });

  it.each([
    { kind: 'mutation' as const, state: 'waiting_for_mutation_approval' as const, messageType: 'mutationApprovalRequest' },
    { kind: 'delivery' as const, state: 'waiting_for_delivery_approval' as const, messageType: 'deliveryApprovalRequest' },
  ])('restores the same Core $kind approval envelope and M15 projection', async ({ kind, state, messageType }) => {
    const attemptId = `att_${kind}_existing`;
    const pending = approval(attemptId, kind);
    const queue = new DurableTaskQueue(root);
    const base = await queue.enqueue({ ...createDefaultAutonomousTask(root, `goal ${attemptId}`), taskId: attemptId, attemptId });
    await queue.update({
      ...base,
      state,
      ...(kind === 'mutation' ? {
        pendingMutationApproval: {
          requestId: 'mutation-original', proposalId: 'proposal-original', operationCount: 1,
          targets: ['src/a.ts'], elevatedConfirmationRequired: false,
        },
      } : {}),
    }, `${kind}_pending`, {});
    runtime = new AutonomousTaskRuntime(context(), root, queue, new TaskResourceScheduler({
      maxActiveTasks: 1, maxActiveMutatingTasks: 1, modelConcurrency: { '*': 1 },
    }), new IsolatedWorktreeManager(root));
    runtime.requireCoreAuthorityForNewWork();
    const restoreSpy = vi.spyOn(runtime, 'restoreCoreAuthority');
    const client = fakeClient([record(root, attemptId, 'karke_dikha', 'waiting_for_approval', 'awaiting_human_approval', [pending])]);
    vi.spyOn(extensionModule, 'getCoreManager').mockReturnValue(manager(client) as never);
    const posted: PostedMessage[] = [];
    const panel = attachPanel(root, posted);
    panel.attachAutonomous(queue, runtime);

    await panel.rehydrateCoreAttempts();

    expect(restoreSpy.mock.calls[0][2]).toEqual([pending]);
    await vi.waitFor(() => {
      expect(posted.some(message => message.type === messageType && message.taskId === attemptId)).toBe(true);
    });
    expect(client.calls.some(call => call.method === 'claimKarkeDikhaAttempt')).toBe(false);
  });

  it('rehydrates resolved proposal and mutation cards from durable events alongside a still-pending delivery gate after relaunch', async () => {
    const attemptId = 'att_delivery_with_history';
    const pending = approval(attemptId, 'delivery');
    const queue = new DurableTaskQueue(root);
    const base = await queue.enqueue({ ...createDefaultAutonomousTask(root, `goal ${attemptId}`), taskId: attemptId, attemptId });
    const proposalSummary = {
      proposalId: 'proposal-original', version: 1, taskSummary: 'original summary',
      operations: [{ type: 'replace', path: 'src/a.ts', reason: 'fix' }],
      validationCommands: [{ kind: 'npm-script', script: 'verify' }], warnings: [],
    };
    const afterProposalPending = await queue.update(
      { ...base, state: 'waiting_for_proposal_approval', pendingProposal: proposalSummary },
      'proposal_pending', { ...proposalSummary },
    );
    const afterProposalResolved = await queue.update(
      { ...afterProposalPending, pendingProposal: undefined },
      'proposal_approved', { proposalId: proposalSummary.proposalId },
    );
    const mutationSummary = {
      requestId: 'mutation-original', proposalId: proposalSummary.proposalId, operationCount: 1,
      targets: ['src/a.ts'], elevatedConfirmationRequired: true,
    };
    const afterMutationPending = await queue.update(
      { ...afterProposalResolved, state: 'waiting_for_mutation_approval', pendingMutationApproval: mutationSummary },
      'mutation_pending', { ...mutationSummary },
    );
    await queue.update(
      { ...afterMutationPending, state: 'waiting_for_delivery_approval', pendingMutationApproval: undefined },
      'mutation_approved', { requestId: mutationSummary.requestId },
    );

    runtime = new AutonomousTaskRuntime(context(), root, queue, new TaskResourceScheduler({
      maxActiveTasks: 1, maxActiveMutatingTasks: 1, modelConcurrency: { '*': 1 },
    }), new IsolatedWorktreeManager(root));
    runtime.requireCoreAuthorityForNewWork();
    const client = fakeClient([record(root, attemptId, 'karke_dikha', 'waiting_for_approval', 'awaiting_human_approval', [pending])]);
    vi.spyOn(extensionModule, 'getCoreManager').mockReturnValue(manager(client) as never);
    const posted: PostedMessage[] = [];
    const panel = attachPanel(root, posted);
    panel.attachAutonomous(queue, runtime);

    await panel.rehydrateCoreAttempts();

    await vi.waitFor(() => {
      expect(posted.some(message => message.type === 'deliveryApprovalRequest' && message.taskId === attemptId)).toBe(true);
    });

    const indexOf = (type: string) => posted.findIndex(message => message.type === type && message.taskId === attemptId);
    const proposalRequestIndex = indexOf('proposalApprovalRequest');
    const proposalResolvedIndex = indexOf('proposalApprovalResolved');
    const mutationRequestIndex = indexOf('mutationApprovalRequest');
    const mutationResolvedIndex = indexOf('mutationApprovalResolved');
    const deliveryRequestIndex = indexOf('deliveryApprovalRequest');

    expect(proposalRequestIndex).toBeGreaterThanOrEqual(0);
    expect(proposalResolvedIndex).toBeGreaterThan(proposalRequestIndex);
    expect(mutationRequestIndex).toBeGreaterThan(proposalResolvedIndex);
    expect(mutationResolvedIndex).toBeGreaterThan(mutationRequestIndex);
    expect(deliveryRequestIndex).toBeGreaterThan(mutationResolvedIndex);

    expect(posted[proposalResolvedIndex].decision).toBe('approved');
    expect(posted[mutationResolvedIndex].decision).toBe('approved');
    expect(posted[proposalRequestIndex].taskSummary).toBe('original summary');
    expect(posted[proposalRequestIndex].operations).toEqual(proposalSummary.operations);
    expect(posted[mutationRequestIndex].targets).toEqual(['src/a.ts']);
    expect(posted[mutationRequestIndex].elevatedConfirmationRequired).toBe(true);
  });

  it('does not double-start a valid active Karke worker', async () => {
    const liveId = 'att_live';
    const queue = new DurableTaskQueue(root);
    await queue.enqueue({ ...createDefaultAutonomousTask(root, `goal ${liveId}`), taskId: liveId, attemptId: liveId });
    runtime = new AutonomousTaskRuntime(context(), root, queue, new TaskResourceScheduler({
      maxActiveTasks: 1, maxActiveMutatingTasks: 1, modelConcurrency: { '*': 1 },
    }), new IsolatedWorktreeManager(root));
    runtime.requireCoreAuthorityForNewWork();
    const wakeSpy = vi.spyOn(runtime, 'wake');
    const client = fakeClient([record(root, liveId, 'karke_dikha', 'running', 'safely_resumable')]);
    vi.spyOn(extensionModule, 'getCoreManager').mockReturnValue(manager(client) as never);
    const posted: PostedMessage[] = [];
    const panel = attachPanel(root, posted);
    panel.attachAutonomous(queue, runtime);

    await panel.rehydrateCoreAttempts();

    expect(wakeSpy).not.toHaveBeenCalled();
    expect(client.calls.some(call => call.method === 'claimKarkeDikhaAttempt')).toBe(false);
    expect(posted.some(message => message.type === 'autonomousTaskActive' && message.taskId === liveId)).toBe(true);
  });

  it('does not post a spurious mutationApprovalResolved when task.state transiently reports `running` while pendingMutationApproval is still set', async () => {
    // Regression for the M35 packaged restart-acceptance failure: the coarse
    // `state` enum can read a transient intermediate value (e.g. `running`)
    // for a poll tick or two while the mutation gate is still genuinely
    // outstanding — a normal eventual-consistency artifact between when the
    // pending record clears and when `state` settles. reconcileStaleApprovalCards
    // used to key staleness on `task.state === 'waiting_for_mutation_approval'`
    // alone, so that transient mismatch was indistinguishable from a real
    // resolution and produced a spurious `mutationApprovalResolved` — which
    // permanently stranded the mutation card disabled client-side, since the
    // client (correctly) never resurfaces an already-surfaced gate without an
    // explicit request message, and the host never resends one it already sent.
    const attemptId = 'att_mutation_flicker';
    const queue = new DurableTaskQueue(root);
    const base = await queue.enqueue({ ...createDefaultAutonomousTask(root, `goal ${attemptId}`), taskId: attemptId, attemptId });
    const mutationSummary = {
      requestId: 'mutation-1', proposalId: 'proposal-1', operationCount: 1,
      targets: ['src/a.ts'], elevatedConfirmationRequired: false,
    };
    const pending = await queue.update(
      { ...base, state: 'waiting_for_mutation_approval', pendingMutationApproval: mutationSummary },
      'mutation_pending', { ...mutationSummary },
    );
    runtime = new AutonomousTaskRuntime(context(), root, queue, new TaskResourceScheduler({
      maxActiveTasks: 1, maxActiveMutatingTasks: 1, modelConcurrency: { '*': 1 },
    }), new IsolatedWorktreeManager(root));
    runtime.requireCoreAuthorityForNewWork();
    const client = fakeClient([]);
    vi.spyOn(extensionModule, 'getCoreManager').mockReturnValue(manager(client) as never);
    const posted: PostedMessage[] = [];
    const panel = attachPanel(root, posted);
    panel.attachAutonomous(queue, runtime);

    // Poll 1: mutation genuinely pending, state correctly reflects it — the
    // gate is surfaced to the (fresh) webview session. startAutonomousPolling
    // is what a real reconnect/relaunch uses to both mark this task active
    // and fire the first poll; later polls reuse the same private method.
    const panelInternals = panel as unknown as {
      pollAutonomousTask(taskId: string): Promise<void>;
      startAutonomousPolling(taskId: string): void;
      autonomousPollTimer?: ReturnType<typeof setInterval>;
    };
    panelInternals.startAutonomousPolling(attemptId);
    await (panel as unknown as { pollAutonomousTask(taskId: string): Promise<void> }).pollAutonomousTask(attemptId);
    expect(posted.some(message => message.type === 'mutationApprovalRequest' && message.taskId === attemptId)).toBe(true);
    if (panelInternals.autonomousPollTimer) clearInterval(panelInternals.autonomousPollTimer);

    // Poll 2: the transient flicker — state briefly reports `running` while
    // pendingMutationApproval is untouched (still the same request). Must
    // NOT be treated as a resolution.
    await queue.update({ ...pending, state: 'running' }, 'progress', {});
    await (panel as unknown as { pollAutonomousTask(taskId: string): Promise<void> }).pollAutonomousTask(attemptId);
    expect(posted.some(message => message.type === 'mutationApprovalResolved')).toBe(false);

    // Poll 3: state settles back; still pending, still no resolution.
    await queue.update({ ...pending, state: 'waiting_for_mutation_approval' }, 'progress', {});
    await (panel as unknown as { pollAutonomousTask(taskId: string): Promise<void> }).pollAutonomousTask(attemptId);
    expect(posted.some(message => message.type === 'mutationApprovalResolved')).toBe(false);

    // Poll 4: pendingMutationApproval genuinely clears (resolved by some
    // means other than a click through this session, e.g. a different
    // window) — reconcileStaleApprovalCards has no access to the real
    // decision from the task record alone, so it self-heals the stranded
    // card with the generic 'resolved' decision. This posts exactly once.
    await queue.update(
      { ...pending, state: 'waiting_for_delivery_approval', pendingMutationApproval: undefined },
      'mutation_approved', { requestId: mutationSummary.requestId },
    );
    await (panel as unknown as { pollAutonomousTask(taskId: string): Promise<void> }).pollAutonomousTask(attemptId);
    const resolved = posted.filter(message => message.type === 'mutationApprovalResolved');
    expect(resolved).toHaveLength(1);
    expect(resolved[0].decision).toBe('resolved');
  });

  it('does not post a spurious mutationApprovalResolved when pendingMutationApproval transiently reads absent while task.state still reports `waiting_for_mutation_approval`', async () => {
    // Regression for the packaged m35-inline-approval acceptance flake
    // (timeout: "M35 mutation approval card to become actionable"). This is
    // the mirror image of the `running`-flicker regression above: here
    // `task.state` itself is NOT stale — it correctly still names
    // `waiting_for_mutation_approval` as the current gate — but the separate
    // `pendingMutationApproval` field on that same read transiently comes
    // back unset (an eventual-consistency artifact of the two fields being
    // written/read as part of the same durably-persisted projection). The
    // prior fix's `!task.pendingMutationApproval || ...` staleness check
    // trusted an absent pending field unconditionally, so this exact race
    // produced a spurious `mutationApprovalResolved` for a gate nothing had
    // actually resolved, permanently disabling the freshly surfaced (and
    // still visible) mutation card client-side — reproduced live via three
    // standalone `m35-inline-approval` packaged-acceptance runs against an
    // exact-head VSIX, one of which hit this exact race.
    const attemptId = 'att_mutation_pending_field_flicker';
    const queue = new DurableTaskQueue(root);
    const base = await queue.enqueue({ ...createDefaultAutonomousTask(root, `goal ${attemptId}`), taskId: attemptId, attemptId });
    const mutationSummary = {
      requestId: 'mutation-1', proposalId: 'proposal-1', operationCount: 1,
      targets: ['src/a.ts'], elevatedConfirmationRequired: false,
    };
    const pending = await queue.update(
      { ...base, state: 'waiting_for_mutation_approval', pendingMutationApproval: mutationSummary },
      'mutation_pending', { ...mutationSummary },
    );
    runtime = new AutonomousTaskRuntime(context(), root, queue, new TaskResourceScheduler({
      maxActiveTasks: 1, maxActiveMutatingTasks: 1, modelConcurrency: { '*': 1 },
    }), new IsolatedWorktreeManager(root));
    runtime.requireCoreAuthorityForNewWork();
    const client = fakeClient([]);
    vi.spyOn(extensionModule, 'getCoreManager').mockReturnValue(manager(client) as never);
    const posted: PostedMessage[] = [];
    const panel = attachPanel(root, posted);
    panel.attachAutonomous(queue, runtime);

    const panelInternals = panel as unknown as {
      pollAutonomousTask(taskId: string): Promise<void>;
      startAutonomousPolling(taskId: string): void;
      autonomousPollTimer?: ReturnType<typeof setInterval>;
    };
    panelInternals.startAutonomousPolling(attemptId);
    await (panel as unknown as { pollAutonomousTask(taskId: string): Promise<void> }).pollAutonomousTask(attemptId);
    expect(posted.some(message => message.type === 'mutationApprovalRequest' && message.taskId === attemptId)).toBe(true);
    if (panelInternals.autonomousPollTimer) clearInterval(panelInternals.autonomousPollTimer);

    // Poll 2: the transient flicker — `pendingMutationApproval` reads absent
    // on this poll even though `state` still unambiguously names this exact
    // gate as current. Must NOT be treated as a resolution.
    await queue.update({ ...pending, pendingMutationApproval: undefined }, 'progress', {});
    await (panel as unknown as { pollAutonomousTask(taskId: string): Promise<void> }).pollAutonomousTask(attemptId);
    expect(posted.some(message => message.type === 'mutationApprovalResolved')).toBe(false);

    // Poll 3: the field settles back; still pending, still no resolution.
    await queue.update({ ...pending, pendingMutationApproval: mutationSummary }, 'progress', {});
    await (panel as unknown as { pollAutonomousTask(taskId: string): Promise<void> }).pollAutonomousTask(attemptId);
    expect(posted.some(message => message.type === 'mutationApprovalResolved')).toBe(false);

    // Poll 4: genuinely resolved (both state advances and the field clears
    // together) — this must still self-heal and resolve exactly once.
    await queue.update(
      { ...pending, state: 'waiting_for_delivery_approval', pendingMutationApproval: undefined },
      'mutation_approved', { requestId: mutationSummary.requestId },
    );
    await (panel as unknown as { pollAutonomousTask(taskId: string): Promise<void> }).pollAutonomousTask(attemptId);
    const resolved = posted.filter(message => message.type === 'mutationApprovalResolved');
    expect(resolved).toHaveLength(1);
    expect(resolved[0].decision).toBe('resolved');
  });

  it('serializes overlapping pollAutonomousTask calls so a slow, stale read can never spuriously resolve a gate a faster, fresher concurrent read just activated', async () => {
    // This is the actual root cause of the packaged m35-package-provenance
    // acceptance failure (ground-truthed via a client-side gate-lifecycle
    // trace during live diagnosis): pollAutonomousTask can be invoked twice
    // concurrently for the same task — once from the periodic
    // setInterval(AUTONOMOUS_POLL_INTERVAL_MS) tick, once from an explicit
    // `await this.pollAutonomousTask(taskId)` right after an approval action
    // (e.g. approveProposal) — and each independently reads the durable task
    // record from disk. Without serialization, a poll that happens to start
    // slightly earlier but resolve its disk read LATER than a concurrent one
    // can observe a stale, in-between snapshot (state not yet advanced,
    // pendingMutationApproval not yet written) even though a mutation gate
    // was already genuinely activated and surfaced to the webview by the
    // other, fresher-reading poll moments earlier. reconcileStaleApprovalCards
    // then correctly-by-its-own-logic treats that stale snapshot as proof the
    // freshly-surfaced mutation gate is superseded and posts a spurious
    // mutationApprovalResolved — permanently disabling the actionable card
    // client-side. The fix serializes every pollAutonomousTask call for this
    // panel onto one chain so no second call's disk read can ever start
    // until the previous one (and everything it decided from it) has fully
    // completed.
    const attemptId = 'att_overlapping_poll_race';
    const queue = new DurableTaskQueue(root);
    const base = await queue.enqueue({ ...createDefaultAutonomousTask(root, `goal ${attemptId}`), taskId: attemptId, attemptId });
    const staleProposalOnlyRecord = { ...base, state: 'waiting_for_proposal_approval' as const, pendingMutationApproval: undefined };
    const mutationSummary = {
      requestId: 'mutation-1', proposalId: 'proposal-1', operationCount: 1,
      targets: ['src/a.ts'], elevatedConfirmationRequired: false,
    };
    const freshMutationPendingRecord = await queue.update(
      { ...base, state: 'waiting_for_mutation_approval', pendingMutationApproval: mutationSummary },
      'mutation_pending', { ...mutationSummary },
    );

    runtime = new AutonomousTaskRuntime(context(), root, queue, new TaskResourceScheduler({
      maxActiveTasks: 1, maxActiveMutatingTasks: 1, modelConcurrency: { '*': 1 },
    }), new IsolatedWorktreeManager(root));
    runtime.requireCoreAuthorityForNewWork();
    const client = fakeClient([]);
    vi.spyOn(extensionModule, 'getCoreManager').mockReturnValue(manager(client) as never);
    const posted: PostedMessage[] = [];
    const panel = attachPanel(root, posted);
    panel.attachAutonomous(queue, runtime);
    (panel as unknown as { autonomousActiveTaskId: string }).autonomousActiveTaskId = attemptId;

    // Deferred control over queue.get() resolution order: call 1 (simulating
    // the interval tick, reading the STALE proposal-only snapshot) is held
    // open until call 2 (simulating the explicit post-approval poll, reading
    // the FRESH mutation-pending snapshot) has already been fully triggered —
    // proving that without serialization, call 1's stale read would land
    // AFTER call 2's fresh one and could still undo it.
    let releaseStaleRead: (() => void) | undefined;
    const staleReadGate = new Promise<void>(resolve => { releaseStaleRead = resolve; });
    let getCallCount = 0;
    const getSpy = vi.spyOn(queue, 'get').mockImplementation(async (id: string) => {
      getCallCount += 1;
      if (getCallCount === 1) {
        await staleReadGate;
        return staleProposalOnlyRecord;
      }
      return freshMutationPendingRecord;
    });

    const panelInternals = panel as unknown as { pollAutonomousTask(taskId: string): Promise<void> };
    const call1 = panelInternals.pollAutonomousTask(attemptId); // starts first, its queue.get() blocks
    const call2 = panelInternals.pollAutonomousTask(attemptId); // starts second (fresh mutation-pending read)
    // Give call 2 a chance to run to completion (or, if unserialized, to at
    // least issue and resolve its own queue.get()) before releasing call 1's
    // blocked read.
    await new Promise(resolve => setTimeout(resolve, 20));
    releaseStaleRead?.();
    await Promise.all([call1, call2]);

    expect(getSpy).toHaveBeenCalled();
    expect(posted.some(message => message.type === 'mutationApprovalRequest' && message.taskId === attemptId)).toBe(true);
    expect(posted.some(message => message.type === 'mutationApprovalResolved')).toBe(false);

    // A subsequent genuinely-fresh poll must still see the mutation gate
    // intact and actionable (not stranded disabled).
    await panelInternals.pollAutonomousTask(attemptId);
    expect(posted.some(message => message.type === 'mutationApprovalResolved')).toBe(false);
  });

  it('marks an unsafe interrupted Karke projection recovery-required without claiming or waking it', async () => {
    const attemptId = 'att_unsafe';
    const queue = new DurableTaskQueue(root);
    await queue.enqueue({ ...createDefaultAutonomousTask(root, `goal ${attemptId}`), taskId: attemptId, attemptId });
    runtime = new AutonomousTaskRuntime(context(), root, queue, new TaskResourceScheduler({
      maxActiveTasks: 1, maxActiveMutatingTasks: 1, modelConcurrency: { '*': 1 },
    }), new IsolatedWorktreeManager(root));
    runtime.requireCoreAuthorityForNewWork();
    const wakeSpy = vi.spyOn(runtime, 'wake');
    const client = fakeClient([record(root, attemptId, 'karke_dikha', 'running', 'requires_reconciliation')]);
    vi.spyOn(extensionModule, 'getCoreManager').mockReturnValue(manager(client) as never);
    const posted: PostedMessage[] = [];
    const panel = attachPanel(root, posted);
    panel.attachAutonomous(queue, runtime);

    await panel.rehydrateCoreAttempts();

    expect((await queue.get(attemptId))?.failure?.classification).toBe('recovery_required');
    expect(posted.some(message => message.type === 'coreAttemptRecoveryRequired' && message.attemptId === attemptId)).toBe(true);
    expect(client.calls.some(call => call.method === 'claimKarkeDikhaAttempt')).toBe(false);
    expect(wakeSpy).not.toHaveBeenCalled();
  });

  it('replays resolved proposal/mutation cards and the active delivery gate once the webview confirms readiness, even when an earlier pre-ready poll already marked them surfaced', async () => {
    // Regression for the packaged m35-inline-approval acceptance failure:
    // "expected the resolved proposal card to remain visible after host
    // close/relaunch". Root cause: `startAutonomousPolling`/
    // `renderRehydratedProjection` can invoke `pollAutonomousTask` — and
    // through it `rehydrateResolvedApprovalCards`/`surfaceDeliveryApproval` —
    // before the freshly (re)created webview has finished loading its script
    // and attached its `message` listener. `webview.postMessage` silently
    // drops a message posted before that listener exists, but the
    // surfaced*Cards guards on those methods mark a card "already surfaced"
    // regardless of whether the post was actually delivered, so a dropped
    // pre-ready post permanently prevents that resolved proposal/mutation
    // card (or the still-active delivery card) from ever being (re)posted to
    // a webview that becomes ready moments later.
    const attemptId = 'att_ready_gate_replay';
    const queue = new DurableTaskQueue(root);
    const base = await queue.enqueue({ ...createDefaultAutonomousTask(root, `goal ${attemptId}`), taskId: attemptId, attemptId });
    const proposalSummary = {
      proposalId: 'proposal-1', version: 1, taskSummary: 'ready-gate proposal',
      operations: [{ type: 'replace', path: 'src/a.ts', reason: 'fix' }],
      validationCommands: [{ kind: 'npm-script', script: 'verify' }], warnings: [],
    };
    const afterProposalPending = await queue.update(
      { ...base, state: 'waiting_for_proposal_approval', pendingProposal: proposalSummary },
      'proposal_pending', { ...proposalSummary },
    );
    const afterProposalResolved = await queue.update(
      { ...afterProposalPending, pendingProposal: undefined },
      'proposal_approved', { proposalId: proposalSummary.proposalId },
    );
    const mutationSummary = {
      requestId: 'mutation-1', proposalId: proposalSummary.proposalId, operationCount: 1,
      targets: ['src/a.ts'], elevatedConfirmationRequired: true,
    };
    const afterMutationPending = await queue.update(
      { ...afterProposalResolved, state: 'waiting_for_mutation_approval', pendingMutationApproval: mutationSummary },
      'mutation_pending', { ...mutationSummary },
    );
    await queue.update(
      { ...afterMutationPending, state: 'waiting_for_delivery_approval', pendingMutationApproval: undefined },
      'mutation_approved', { requestId: mutationSummary.requestId },
    );

    runtime = new AutonomousTaskRuntime(context(), root, queue, new TaskResourceScheduler({
      maxActiveTasks: 1, maxActiveMutatingTasks: 1, modelConcurrency: { '*': 1 },
    }), new IsolatedWorktreeManager(root));
    runtime.requireCoreAuthorityForNewWork();
    const client = fakeClient([]);
    vi.spyOn(extensionModule, 'getCoreManager').mockReturnValue(manager(client) as never);

    const posted: PostedMessage[] = [];
    const { panel, sendWebviewReady } = attachPanelWithReadyGate(root, posted);
    panel.attachAutonomous(queue, runtime);

    const panelInternals = panel as unknown as {
      pollAutonomousTask(taskId: string): Promise<void>;
      startAutonomousPolling(taskId: string): void;
      autonomousPollTimer?: ReturnType<typeof setInterval>;
      autonomousActiveTaskId?: string;
    };

    // Step 1: an initial pre-ready poll runs (models `startAutonomousPolling`
    // firing from Core restart rehydration before the webview is ready) and
    // marks the cards surfaced. Its posted messages are discarded by the
    // ready-gated fake webview, modeling the dropped `postMessage` calls a
    // not-yet-loaded webview produces in production. The explicit awaited
    // `pollAutonomousTask` call is chained onto the same serialized poll
    // chain as the implicit fire-and-forget poll `startAutonomousPolling`
    // just kicked off, so awaiting it also waits for that first poll to fully
    // complete.
    panelInternals.startAutonomousPolling(attemptId);
    await panelInternals.pollAutonomousTask(attemptId);
    if (panelInternals.autonomousPollTimer) clearInterval(panelInternals.autonomousPollTimer);
    expect(posted).toHaveLength(0);
    expect(panelInternals.autonomousActiveTaskId).toBe(attemptId);

    // Step 2: the webview becomes ready. This must trigger a readiness-gated
    // replay that posts the full resolved history plus the still-active
    // delivery gate, in chronological order, exactly once.
    sendWebviewReady();
    await vi.waitFor(() => {
      expect(posted.some(message => message.type === 'deliveryApprovalRequest' && message.taskId === attemptId)).toBe(true);
    });

    const indexOf = (type: string) => posted.findIndex(message => message.type === type && message.taskId === attemptId);
    const proposalRequestIndex = indexOf('proposalApprovalRequest');
    const proposalResolvedIndex = indexOf('proposalApprovalResolved');
    const mutationRequestIndex = indexOf('mutationApprovalRequest');
    const mutationResolvedIndex = indexOf('mutationApprovalResolved');
    const deliveryRequestIndex = indexOf('deliveryApprovalRequest');

    expect(proposalRequestIndex).toBeGreaterThanOrEqual(0);
    expect(proposalResolvedIndex).toBeGreaterThan(proposalRequestIndex);
    expect(mutationRequestIndex).toBeGreaterThan(proposalResolvedIndex);
    expect(mutationResolvedIndex).toBeGreaterThan(mutationRequestIndex);
    expect(deliveryRequestIndex).toBeGreaterThan(mutationResolvedIndex);
    expect(posted[proposalResolvedIndex].decision).toBe('approved');
    expect(posted[mutationResolvedIndex].decision).toBe('approved');
    expect(posted.some(message => message.type === 'deliveryApprovalResolved')).toBe(false);

    // No new approval/attempt/task/execution is ever created by the replay.
    expect(client.calls.some(call => call.method === 'claimKarkeDikhaAttempt')).toBe(false);
    expect(client.calls.some(call => call.method === 'executeAttempt')).toBe(false);
    expect((await queue.list()).map(task => task.taskId)).toEqual([attemptId]);

    // Step 3: a duplicate `webviewReady` must not replay a second time or
    // reactivate any resolved gate.
    const approvalCardTypes = new Set([
      'proposalApprovalRequest', 'proposalApprovalResolved',
      'mutationApprovalRequest', 'mutationApprovalResolved',
      'deliveryApprovalRequest', 'deliveryApprovalResolved',
    ]);
    const approvalCardMessagesBeforeDuplicate = posted.filter(message => approvalCardTypes.has(message.type)).length;
    sendWebviewReady();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(posted.filter(message => approvalCardTypes.has(message.type))).toHaveLength(approvalCardMessagesBeforeDuplicate);
  });
});
