/**
 * Golden-journey harness: wires a REAL `AgentPanel` (extension host) to a
 * REAL webview-v2 React app (`src/webview-v2/App`), connected through a fake
 * `postMessage` channel that stands in for VS Code's webview bridge — the
 * only pieces replaced are true external boundaries: the separate Core
 * process (`CoreClient`/`CoreManager`, faked deterministically below) and,
 * for Karke Dikha, the LLM (`InferenceProvider`, stubbed below). Everything
 * in between — `handleWebviewMessage`, `routeComposerSubmission`,
 * `sendToAgent`, `handleCoreRuntimeEvent`/`handleCoreRuntimeToken`, the M15
 * `AutonomousTaskRuntime`, and webview-v2's `translateHostMessage`/`reduceUiV2`
 * — runs for real.
 *
 * Consolidates the `attachPanel`/fake-Core-client pattern already proven in
 * src/test/suite/baatKarCoreDurability.test.ts and the real-M15-runtime
 * pattern in src/test/suite/agentPanelAutonomousMode.test.ts into one shared
 * module, per the golden-journey test-strategy reset.
 */
import { act } from '@testing-library/react';
import * as fsp from 'node:fs/promises';
import { spawn } from 'node:child_process';
import * as vscode from 'vscode';
import { AgentPanel } from '../../ui/AgentPanel';
import { AutonomousTaskRuntime } from '../../activation/M15AutonomousRuntime';
import {
  DurableTaskQueue,
  IsolatedWorktreeManager,
  TaskResourceScheduler,
  createDefaultAutonomousTask,
} from '../../autonomous/M15AutonomousWork';
import type { InferenceProvider, ModelInfo, ProviderChatOptions, ChatMessage, ChatResponse, ToolDefinition } from '../../providers/ProviderTypes';
import type { RuntimeEventRecord, RuntimeTokenFrame } from '../../../core/shared/wireTypes';
import type { ApprovalRecord, AttemptRehydrationRecord, AttemptStatus } from '../../../core/shared/wireTypes';

export { DurableTaskQueue, IsolatedWorktreeManager, TaskResourceScheduler, createDefaultAutonomousTask, AutonomousTaskRuntime };

export interface PostedMessage { type: string; [key: string]: unknown }

// ---------------------------------------------------------------------------
// Extension-context / webview-view fakes
// ---------------------------------------------------------------------------

export function fakeContext(): vscode.ExtensionContext {
  return {
    subscriptions: [],
    extensionUri: vscode.Uri.file(process.cwd()),
    secrets: { get: async () => undefined, store: async () => undefined, delete: async () => undefined, onDidChange: () => ({ dispose: () => undefined }) },
    extension: { packageJSON: { scripts: {}, contributes: { commands: [] } } },
  } as unknown as vscode.ExtensionContext;
}

export interface HostHandle {
  panel: AgentPanel;
  posted: PostedMessage[];
  /** Feed a raw webview -> host message directly (bypassing the React UI). */
  receive: (msg: unknown) => void;
}

/**
 * Instantiates a real `AgentPanel` and resolves it against a fake
 * `vscode.WebviewView` whose `postMessage` both records every outbound
 * message AND (wrapped in `act`) dispatches a real `window` `message` event,
 * so a webview-v2 `App` mounted in the same jsdom document receives it
 * exactly as it would from the real VS Code webview bridge.
 */
export function attachHost(root: string, workspaceAvailable = true): HostHandle {
  const posted: PostedMessage[] = [];
  const context = fakeContext();
  const panel = new AgentPanel(context, root, workspaceAvailable);
  let receiveImpl: (msg: unknown) => void = () => undefined;
  const webview = {
    options: {},
    html: '',
    cspSource: 'vscode-webview://golden-journey',
    asWebviewUri: (uri: vscode.Uri) => uri,
    postMessage: (msg: PostedMessage) => {
      posted.push(msg);
      act(() => {
        window.dispatchEvent(new MessageEvent('message', { data: msg }));
      });
      return Promise.resolve(true);
    },
    onDidReceiveMessage: (cb: (msg: unknown) => void) => { receiveImpl = cb; return { dispose: () => undefined }; },
  };
  const webviewView = {
    webview,
    show: () => undefined,
    onDidDispose: () => ({ dispose: () => undefined }),
    visible: true,
  } as unknown as vscode.WebviewView;
  panel.resolveWebviewView(webviewView, {} as vscode.WebviewViewResolveContext, {} as vscode.CancellationToken);
  return { panel, posted, receive: (msg: unknown) => receiveImpl(msg) };
}

/**
 * Wires `window.acquireVsCodeApi` so a webview-v2 `App` rendered afterwards
 * sends its outbound `postMessage` calls straight into the host's real
 * `onDidReceiveMessage` handler — completing the bidirectional bridge.
 * Call BEFORE rendering `<App />` (its mount effect posts `webviewReady`
 * synchronously and needs the bridge live already).
 */
export function bridgeWebviewApiToHost(host: HostHandle): void {
  (window as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({
    postMessage: (msg: unknown) => host.receive(msg),
    getState: () => undefined,
    setState: () => undefined,
  });
}

export function clearVsCodeApiBridge(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (window as any).acquireVsCodeApi;
}

// ---------------------------------------------------------------------------
// Fake Core client / manager (Baat Kar / Ask / Plan / Saath Kar boundary)
// ---------------------------------------------------------------------------

/**
 * In-memory stand-in for Core's `conversation_working_state` table —
 * enough fidelity for the Objective Arbitration golden test below to drive
 * the REAL `AgentPanel.prepareTurnContinuity`/`recordTurnContinuity` through
 * the same optional-client hooks `CoreClient` exposes, keyed by
 * `${conversationId}::${workspaceIdentity}` exactly as Core scopes it.
 */
interface FakeWorkingState {
  conversationId: string;
  workspaceIdentity: string;
  objectiveId: string;
  currentObjective: string;
  latestUserIntent: string;
  latestExecutionPolicy: string | null;
  relevantFiles: Array<{ path: string; contentHash: string; observedAt: string }>;
  relevantSymbols: string[];
  userConstraints: Array<{ id: string; text: string; createdAt: string }>;
  latestFindingsSummary: string | null;
  pendingAction: unknown;
  latestTaskId: string | null;
  latestProposalId: string | null;
  latestValidationSummary: string | null;
  pendingNewObjective: boolean;
  awaitingObjectiveClarification: boolean;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export function fakeCoreClient() {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  let conversationCounter = 0;
  let attemptCounter = 0;
  const conversationMessages = new Map<string, Array<{ role: string; content: string }>>();
  let ledger: {
    workspaceIdentity: string;
    currentConversationId: string | null;
    currentCoreConversationId: string | null;
    conversations: Array<Record<string, unknown>>;
  } = { workspaceIdentity: '', currentConversationId: null, currentCoreConversationId: null, conversations: [] };
  const ledgerSnapshot = () => ({ schemaVersion: 1, ...ledger, turns: [], migrationMetadata: {} });

  return {
    calls,
    conversationMessages,
    async createConversation(...args: unknown[]) {
      calls.push({ method: 'createConversation', args });
      conversationCounter += 1;
      const id = `conv_${conversationCounter}`;
      conversationMessages.set(id, []);
      return { id, title: (args[0] as { title?: string | null })?.title ?? null };
    },
    async getWorkspaceConversationLedger(workspaceIdentity: string) {
      calls.push({ method: 'getWorkspaceConversationLedger', args: [workspaceIdentity] });
      if (!ledger.workspaceIdentity) ledger.workspaceIdentity = workspaceIdentity;
      return ledgerSnapshot();
    },
    async bindWorkspaceConversation(input: { workspaceIdentity: string; localConversationId: string; conversationId: string; title?: string | null }) {
      calls.push({ method: 'bindWorkspaceConversation', args: [input] });
      const now = new Date().toISOString();
      if (!ledger.conversations.some((c) => c['localConversationId'] === input.localConversationId)) {
        ledger.conversations.push({ ...input, createdAt: now, updatedAt: now, archivedAt: null, schemaVersion: 1, migrationMetadata: {} });
      }
      ledger = { ...ledger, workspaceIdentity: input.workspaceIdentity, currentConversationId: input.localConversationId, currentCoreConversationId: input.conversationId };
      return ledgerSnapshot();
    },
    async selectWorkspaceConversation(workspaceIdentity: string, localConversationId: string) {
      calls.push({ method: 'selectWorkspaceConversation', args: [workspaceIdentity, localConversationId] });
      const selected = ledger.conversations.find((c) => c['localConversationId'] === localConversationId);
      ledger = { ...ledger, workspaceIdentity, currentConversationId: localConversationId, currentCoreConversationId: (selected?.['conversationId'] as string) ?? null };
      return ledgerSnapshot();
    },
    async appendMessage(conversationId: string, input: { role: string; content: string }) {
      calls.push({ method: 'appendMessage', args: [conversationId, input] });
      conversationMessages.get(conversationId)?.push({ role: input.role, content: input.content });
      return { seq: calls.length, id: `msg_${calls.length}` };
    },
    async listMessages(conversationId: string) {
      calls.push({ method: 'listMessages', args: [conversationId] });
      const messages = conversationMessages.get(conversationId) ?? [];
      return { messages: messages.map((m, i) => ({ seq: i, id: `msg_${i}`, conversationId, ...m, modelInvocationId: null, createdAt: new Date().toISOString() })) };
    },
    async listResponseAlternatives() { return { alternatives: [] }; },
    async listConversationResearch() { return { research: [] }; },
    async listCapabilityActions() { return { attemptId: null, actions: [] }; },
    async listRecentWorkspaceCapabilityActions() { return { actions: [] }; },
    async getConversationBranch() { return { branch: null }; },
    async listMessageCitations() { return { citations: [] }; },
    async selectResponseAlternative(conversationId: string, alternativeId: string) { return { id: alternativeId }; },
    async listConversationMessageAttachments() { return { byMessage: {} }; },
    async getAttachment(attachmentId: string) { return { id: attachmentId, kind: 'text' }; },
    async submit(...args: unknown[]) {
      calls.push({ method: 'submit', args });
      attemptCounter += 1;
      return { request: { id: `req_${attemptCounter}` }, attempt: { id: `att_${attemptCounter}`, status: 'created' }, planningOnly: false };
    },
    async executeAttempt(attemptId: string, ...rest: unknown[]) {
      calls.push({ method: 'executeAttempt', args: [attemptId, ...rest] });
      return { status: 'accepted', attemptId };
    },
    async cancelAttempt(...args: unknown[]) {
      calls.push({ method: 'cancelAttempt', args });
      return { id: args[0], status: 'cancelling' };
    },
    async getAttempt(attemptId: string) {
      calls.push({ method: 'getAttempt', args: [attemptId] });
      return { id: attemptId, status: 'failed', failureReason: 'unknown failure' };
    },
    async getAttemptContext(attemptId: string) {
      calls.push({ method: 'getAttemptContext', args: [attemptId] });
      return { attemptId };
    },
    async getWorkspaceAttemptRehydration(...args: unknown[]) {
      calls.push({ method: 'getWorkspaceAttemptRehydration', args });
      return { workspaceRoot: args[0], attempts: [] };
    },
    async request(routePath: string, init: unknown) {
      calls.push({ method: 'request', args: [routePath, init] });
      return { ok: true };
    },
  };
}

export type FakeCoreClient = ReturnType<typeof fakeCoreClient>;

/**
 * Adds an in-memory `conversation_working_state` (get/save/clear) to a
 * client that doesn't otherwise have one. Deliberately NOT part of the base
 * `fakeCoreClient()`: `AgentPanel` treats these three methods as optional
 * (`client?.getConversationWorkingState`, etc.) and no-ops the whole
 * Durable Conversational Continuity path when they're absent — which every
 * OTHER golden test (Karke Dikha, mode switching, restart rehydration, …)
 * relies on implicitly by using the bare `fakeCoreClient()`/`mergedCoreClient()`.
 * Adding real persistence there would silently change those tests' behavior
 * across turns. Callers that need real continuity — this file's Objective
 * Arbitration test — opt in explicitly with this wrapper instead.
 */
export function withFakeConversationWorkingState<T extends { calls: Array<{ method: string; args: unknown[] }> }>(client: T): T {
  let workingStateVersion = 0;
  const workingStates = new Map<string, FakeWorkingState>();
  const workingStateKey = (conversationId: string, workspaceIdentity: string) => `${conversationId}::${workspaceIdentity}`;
  return {
    ...client,
    async getConversationWorkingState(conversationId: string, workspaceIdentity: string) {
      client.calls.push({ method: 'getConversationWorkingState', args: [conversationId, workspaceIdentity] });
      const existing = workingStates.get(workingStateKey(conversationId, workspaceIdentity));
      return existing ?? null;
    },
    async saveConversationWorkingState(conversationId: string, input: Record<string, unknown>) {
      client.calls.push({ method: 'saveConversationWorkingState', args: [conversationId, input] });
      const workspaceIdentity = String(input.workspaceIdentity ?? '');
      const key = workingStateKey(conversationId, workspaceIdentity);
      const existing = workingStates.get(key) ?? null;
      const now = new Date().toISOString();
      const startsNew = Boolean(input.startNewObjective) || !existing;
      workingStateVersion += 1;
      const record: FakeWorkingState = {
        conversationId,
        workspaceIdentity,
        objectiveId: startsNew ? `obj_${workingStateVersion}` : (existing as FakeWorkingState).objectiveId,
        currentObjective: String(input.currentObjective ?? ''),
        latestUserIntent: String(input.latestUserIntent ?? ''),
        latestExecutionPolicy: (input.latestExecutionPolicy as string | null) ?? null,
        relevantFiles: (input.relevantFiles as FakeWorkingState['relevantFiles']) ?? [],
        relevantSymbols: (input.relevantSymbols as string[]) ?? [],
        userConstraints: (input.userConstraints as FakeWorkingState['userConstraints']) ?? [],
        latestFindingsSummary: (input.latestFindingsSummary as string | null) ?? null,
        pendingAction: input.pendingAction ?? null,
        latestTaskId: (input.latestTaskId as string | null) ?? null,
        latestProposalId: (input.latestProposalId as string | null) ?? null,
        latestValidationSummary: (input.latestValidationSummary as string | null) ?? null,
        pendingNewObjective: Boolean(input.pendingNewObjective),
        awaitingObjectiveClarification: Boolean(input.awaitingObjectiveClarification),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        version: (existing?.version ?? 0) + 1,
      };
      workingStates.set(key, record);
      return record;
    },
    async clearConversationWorkingState(conversationId: string, workspaceIdentity: string) {
      client.calls.push({ method: 'clearConversationWorkingState', args: [conversationId, workspaceIdentity] });
      workingStates.delete(workingStateKey(conversationId, workspaceIdentity));
    },
  };
}

export function fakeCoreManager(client: FakeCoreClient) {
  const runtimeEventListeners: Array<(e: RuntimeEventRecord) => void> = [];
  const runtimeTokenListeners: Array<(f: RuntimeTokenFrame) => void> = [];
  return {
    getClient: () => client,
    getStatus: () => ({ state: 'connected' }),
    onRuntimeEvent: (cb: (e: RuntimeEventRecord) => void) => { runtimeEventListeners.push(cb); return { dispose: () => undefined }; },
    onRuntimeToken: (cb: (f: RuntimeTokenFrame) => void) => { runtimeTokenListeners.push(cb); return { dispose: () => undefined }; },
    fireRuntimeEvent(event: Partial<RuntimeEventRecord> & Pick<RuntimeEventRecord, 'domain' | 'entityId' | 'eventType'>) {
      const full: RuntimeEventRecord = {
        sequence: 1,
        id: `evt_${Math.random().toString(36).slice(2)}`,
        actor: 'core:executor',
        clientId: null,
        idempotencyKey: null,
        createdAt: new Date().toISOString(),
        metadata: {},
        resultingRevision: null,
        ...event,
      };
      for (const cb of runtimeEventListeners) cb(full);
    },
    fireRuntimeToken(frame: RuntimeTokenFrame) {
      for (const cb of runtimeTokenListeners) cb(frame);
    },
  };
}

export type FakeCoreManager = ReturnType<typeof fakeCoreManager>;

/**
 * Drives a full deterministic Baat Kar / Saath Kar turn on an already-open
 * attempt: streams `text` as token frames, then transitions the attempt to
 * `completed` — reproducing exactly the sequence `handleCoreRuntimeToken`/
 * `handleCoreRuntimeEvent` expect from the real Core process.
 */
export function completeAttemptWithText(manager: FakeCoreManager, attemptId: string, text: string): void {
  manager.fireRuntimeToken({ attemptId, delta: text, sequence: 1 });
  manager.fireRuntimeEvent({ domain: 'attempt', entityId: attemptId, eventType: 'attempt_transitioned', metadata: { to: 'completed' } });
}

export async function flush(ms = 20): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForCalls(client: { calls: Array<{ method: string }> }, method: string, count: number, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (client.calls.filter((call) => call.method === method).length >= count) return;
    if (Date.now() > deadline) throw new Error(`Core '${method}' was never called ${count} time(s)`);
    await flush();
  }
}

export async function waitForPosted(posted: PostedMessage[], predicate: (m: PostedMessage) => boolean, timeoutMs = 5000): Promise<PostedMessage> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = posted.find(predicate);
    if (found) return found;
    if (Date.now() > deadline) throw new Error(`Expected message never posted (waited ${timeoutMs}ms). Posted so far: ${posted.map((m) => m.type).join(', ')}`);
    await flush();
  }
}

// ---------------------------------------------------------------------------
// Real M15 autonomous runtime (Karke Dikha boundary): only the LLM and the
// Core RPC surface are faked; DurableTaskQueue/IsolatedWorktreeManager/
// AutonomousTaskRuntime/GovernedCodingExecutor all run for real against a
// real temp git repository.
// ---------------------------------------------------------------------------

export class StubCodingProvider implements InferenceProvider {
  readonly providerType = 'ollama' as const;
  constructor(private readonly completionJson: string) {}
  async healthCheck(): Promise<void> {}
  async listModels(): Promise<ModelInfo[]> { return [{ name: 'qwen3-coder:30b', contextWindow: 40960 }]; }
  async chat(_messages: ChatMessage[], _tools: ToolDefinition[], _options: ProviderChatOptions): Promise<ChatResponse> {
    return { message: { role: 'assistant', content: this.completionJson }, done: true };
  }
}

/** A deterministic single-file-create proposal, accepted by CodingPlanner's schema. */
export function trivialProposalCompletion(path: string, content: string, verifyScript = 'verify'): string {
  return JSON.stringify({
    version: 1,
    taskSummary: 'Golden journey acceptance',
    operations: [{ type: 'create', path, reason: 'golden journey', content }],
    validationCommands: [{ kind: 'npm-script', script: verifyScript }],
    warnings: [],
    status: 'proposed',
  });
}

export async function initGitFixture(root: string, packageJson: Record<string, unknown> = { scripts: { verify: 'node -e "process.exit(0)"' } }): Promise<void> {
  await fsp.writeFile(`${root}/package.json`, JSON.stringify(packageJson, null, 2));
  for (const args of [['init'], ['config', 'user.email', 't@example.com'], ['config', 'user.name', 'T'], ['add', '.'], ['commit', '-m', 'init']]) {
    await new Promise<void>((resolve, reject) => {
      const child = spawn('git', args, { cwd: root, shell: false, windowsHide: true });
      child.on('error', reject);
      child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`git ${args.join(' ')} exited ${code}`))));
    });
  }
}

/** Minimal Core RPC surface `AutonomousTaskRuntime`/M15 needs — distinct from
 * `fakeCoreClient()` above, which serves the Baat/Saath Kar `sendToAgent` path. */
export function karkeDikhaCoreClient(root: string) {
  let approvalCounter = 0;
  let goal = '';
  const submissions: Array<Record<string, unknown>> = [];
  let workspaceIdentity = '';
  let currentConversationId: string | null = null;
  let currentCoreConversationId: string | null = null;
  const conversations: Array<Record<string, unknown>> = [];
  const ledger = () => ({ schemaVersion: 1, workspaceIdentity, currentConversationId, currentCoreConversationId, conversations, turns: [], migrationMetadata: {} });
  return {
    submissions,
    async getWorkspaceConversationLedger(identity: string) { workspaceIdentity = identity; return ledger(); },
    async createConversation(input: { title?: string | null }) { return { id: 'conv_test', title: input.title ?? null }; },
    async bindWorkspaceConversation(input: { workspaceIdentity: string; localConversationId: string; conversationId: string; title?: string | null }) {
      workspaceIdentity = input.workspaceIdentity;
      currentConversationId = input.localConversationId;
      currentCoreConversationId = input.conversationId;
      if (conversations.length === 0) {
        const now = new Date().toISOString();
        conversations.push({ ...input, createdAt: now, updatedAt: now, archivedAt: null, schemaVersion: 1, migrationMetadata: {} });
      }
      return ledger();
    },
    async listMessages() { return { messages: [] }; },
    async listConversationMessageAttachments() { return { byMessage: {} }; },
    async listConversationResearch() { return { research: [] }; },
    async listResponseAlternatives() { return { alternatives: [] }; },
    async getConversationBranch() { return { branch: null }; },
    async listCapabilityActions() { return { attemptId: null, actions: [] }; },
    async listRecentWorkspaceCapabilityActions() { return { actions: [] }; },
    async submit(input: { currentMessage: string } & Record<string, unknown>) {
      submissions.push(input);
      goal = input.currentMessage;
      return { request: { id: 'req_test' }, attempt: { id: 'att_test', status: 'created' }, planningOnly: false };
    },
    async claimKarkeDikhaAttempt(_attemptId: string, input: { owner: string }) {
      return {
        attempt: { id: 'att_test', status: 'running' },
        context: {
          id: 'ctx_test', contextIdentity: 'ctx_test', requestId: 'req_test', attemptId: 'att_test', resolvedMode: 'karke_dikha',
          workspaceRoot: root, repositoryId: null, repositoryLocationId: null, taskInput: goal,
          selectedProvider: 'ollama', selectedModel: 'fake-coder',
          permittedCapabilities: { hasWorkspace: true, gitCapable: true, allowedTools: [], contextPolicy: {} },
          approvalPolicy: {}, schemaVersion: 1, createdAt: new Date().toISOString(), contextHash: 'ctx_hash',
        },
        fence: { attemptId: 'att_test', token: 'fence_test', generation: 1, owner: input.owner, expiresAt: new Date(Date.now() + 120_000).toISOString() },
      };
    },
    async heartbeatKarkeDikhaAttempt() { return { id: 'att_test', status: 'running' }; },
    async requestKarkeDikhaApproval(_attemptId: string, _credentials: unknown, input: { kind: string }) {
      approvalCounter += 1;
      return {
        attempt: { id: 'att_test', status: 'waiting_for_approval' },
        approval: {
          id: `appr_${approvalCounter}`, attemptId: 'att_test', kind: input.kind, status: 'pending',
          expectedAttemptRevision: approvalCounter + 2, expectedAttemptStatus: 'waiting_for_approval',
          requestedActionDigest: `digest_${approvalCounter}`, frozenContextHash: 'ctx_hash', revision: 1,
        },
      };
    },
    async resolveKarkeDikhaApproval(approval: unknown) { return { attempt: { id: 'att_test', status: 'running' }, approval }; },
    async beginKarkeDikhaValidation() { return { id: 'att_test', status: 'validating' }; },
    async reportKarkeDikhaValidation() {
      approvalCounter += 1;
      return {
        outcome: 'waiting_for_delivery_approval', attempt: { id: 'att_test', status: 'waiting_for_approval' },
        approval: {
          id: `appr_${approvalCounter}`, attemptId: 'att_test', kind: 'delivery', status: 'pending', expectedAttemptRevision: 10,
          expectedAttemptStatus: 'waiting_for_approval', requestedActionDigest: 'delivery', frozenContextHash: 'ctx_hash', revision: 1,
        },
      };
    },
    async completeKarkeDikhaAttempt() { return { id: 'att_test', status: 'completed' }; },
    async failKarkeDikhaAttempt() { return { id: 'att_test', status: 'failed' }; },
    async cancelKarkeDikhaAttempt() { return { id: 'att_test', status: 'cancelled' }; },
  };
}

export type KarkeDikhaCoreClient = ReturnType<typeof karkeDikhaCoreClient>;

export interface AutonomousInfra {
  queue: DurableTaskQueue;
  resources: TaskResourceScheduler;
  worktrees: IsolatedWorktreeManager;
  runtime: AutonomousTaskRuntime;
  coreClient: KarkeDikhaCoreClient;
  dispose: () => void;
}

/**
 * A single Core client surface exposing BOTH the `sendToAgent` (Baat Kar /
 * Ask / Plan / Saath Kar) methods AND the M15 Karke Dikha RPC methods, for
 * tests that exercise mode-switching across all five modes in one session —
 * `getCoreManager()` is a process-lifetime singleton, so a torture test that
 * submits through every mode needs one client answering to all of them.
 */
export function mergedCoreClient(root: string) {
  const base = fakeCoreClient();
  const kd = karkeDikhaCoreClient(root);
  let lastGoal = '';
  return {
    ...base,
    async submit(...args: unknown[]) {
      const input = args[0] as { currentMessage?: string; requestedMode?: string };
      if (input?.currentMessage) lastGoal = input.currentMessage;
      if (input?.requestedMode === 'karke_dikha') return kd.submit(input as never);
      return base.submit(...args);
    },
    claimKarkeDikhaAttempt: (...args: Parameters<KarkeDikhaCoreClient['claimKarkeDikhaAttempt']>) => {
      void lastGoal;
      return kd.claimKarkeDikhaAttempt(...args);
    },
    heartbeatKarkeDikhaAttempt: kd.heartbeatKarkeDikhaAttempt,
    requestKarkeDikhaApproval: kd.requestKarkeDikhaApproval,
    resolveKarkeDikhaApproval: kd.resolveKarkeDikhaApproval,
    beginKarkeDikhaValidation: kd.beginKarkeDikhaValidation,
    reportKarkeDikhaValidation: kd.reportKarkeDikhaValidation,
    completeKarkeDikhaAttempt: kd.completeKarkeDikhaAttempt,
    failKarkeDikhaAttempt: kd.failKarkeDikhaAttempt,
    cancelKarkeDikhaAttempt: kd.cancelKarkeDikhaAttempt,
  };
}

export function buildAutonomousInfra(root: string): AutonomousInfra {
  const queue = new DurableTaskQueue(root);
  const resources = new TaskResourceScheduler({ maxActiveTasks: 2, maxActiveMutatingTasks: 1, modelConcurrency: { '*': 2 } });
  const worktrees = new IsolatedWorktreeManager(root);
  const runtime = new AutonomousTaskRuntime(fakeContext(), root, queue, resources, worktrees);
  const coreClient = karkeDikhaCoreClient(root);
  return { queue, resources, worktrees, runtime, coreClient, dispose: () => runtime.dispose() };
}

// ---------------------------------------------------------------------------
// Restart / rehydration fixtures — a fresh DurableTaskQueue/AutonomousTaskRuntime
// pointed at the SAME on-disk root models a real extension-host restart (the
// queue re-reads durable state from disk rather than reusing an in-memory
// object), paired with a `getWorkspaceAttemptRehydration` Core fake so
// `AgentPanel.rehydrateCoreAttempts()` restores the exact same approval.
// Adapted from src/test/suite/agentPanelRestartRehydration.test.ts.
// ---------------------------------------------------------------------------

export function buildAutonomousInfraForRoot(root: string): AutonomousInfra {
  return buildAutonomousInfra(root);
}

export function pendingApprovalRecord(attemptId: string, kind: ApprovalRecord['kind'] = 'proposal'): ApprovalRecord {
  return {
    id: `appr_${kind}_${attemptId}`, attemptId, kind, status: 'pending',
    requestedAt: '2026-07-16T10:00:00.000Z', resolvedAt: null, resolution: null,
    summary: kind === 'proposal' ? { proposalId: `proposal_${attemptId}` } : kind === 'mutation' ? { requestId: `mutation_${attemptId}` } : { delivery: true },
    claimOwner: null, claimExpiresAt: null,
    envelopeVersion: 1, expectedAttemptRevision: 3, expectedAttemptStatus: 'waiting_for_approval',
    requestedActionDigest: `digest_${attemptId}`, frozenContextHash: `hash_${attemptId}`, revision: 1,
  };
}

export function attemptRehydrationRecord(
  root: string,
  attemptId: string,
  status: AttemptStatus,
  recovery: AttemptRehydrationRecord['recovery'],
  approvals: ApprovalRecord[] = [],
): AttemptRehydrationRecord {
  return {
    attempt: {
      id: attemptId, requestId: `req_${attemptId}`, predecessorAttemptId: null, kind: 'karke_dikha', status,
      createdAt: '2026-07-16T10:00:00.000Z', updatedAt: '2026-07-16T10:01:00.000Z',
      startedAt: status === 'created' ? null : '2026-07-16T10:00:01.000Z', completedAt: null,
      cancelledAt: null, cancelRequestedAt: null, failureReason: null,
      claimOwner: status === 'created' ? null : 'worker-original',
      claimExpiresAt: status === 'created' ? null : new Date(Date.now() + 120_000).toISOString(),
      fenceToken: status === 'created' ? null : 'fence-original', fenceGeneration: status === 'created' ? 0 : 1, revision: 3,
    },
    request: {
      id: `req_${attemptId}`, createdAt: '2026-07-16T10:00:00.000Z', clientId: 'original-client',
      currentMessage: `goal ${attemptId}`, requestedMode: 'karke_dikha', resolvedMode: 'karke_dikha', routeReason: 'explicit',
      conversationId: null, storyId: null, projectId: null, repositoryId: null, repositoryLocationId: null,
      requestedProvider: 'ollama', requestedModel: 'test-model', toolPermissionPolicy: {}, contextPolicy: {},
      correlationId: `corr_${attemptId}`, idempotencyKey: `idem_${attemptId}`,
    },
    context: {
      id: `ctx_${attemptId}`, contextIdentity: `identity_${attemptId}`, requestId: `req_${attemptId}`, attemptId,
      resolvedMode: 'karke_dikha', workspaceRoot: root, repositoryId: null, repositoryLocationId: null,
      taskInput: `goal ${attemptId}`, selectedProvider: 'ollama', selectedModel: 'test-model',
      permittedCapabilities: { hasWorkspace: true, gitCapable: true, allowedTools: [], contextPolicy: {} },
      approvalPolicy: {}, schemaVersion: 1, createdAt: '2026-07-16T10:00:00.000Z', contextHash: `hash_${attemptId}`,
    },
    approvals,
    events: [{
      sequence: 1, id: `event_${attemptId}`, domain: 'attempt', entityId: attemptId, eventType: 'attempt_created',
      actor: 'core', clientId: null, idempotencyKey: null, createdAt: '2026-07-16T10:00:00.000Z', metadata: {}, resultingRevision: 1,
    }],
    recovery,
  };
}

/**
 * A Core client surface exposing only what `AgentPanel.rehydrateCoreAttempts()`
 * needs to restore a durable Karke Dikha attempt across a simulated restart.
 */
export function restartRehydrationCoreClient(records: AttemptRehydrationRecord[]) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  let workspaceIdentity = '';
  const ledger = () => ({
    schemaVersion: 1, workspaceIdentity, currentConversationId: null, currentCoreConversationId: null,
    conversations: [], turns: [], migrationMetadata: {},
  });
  return {
    calls,
    async getWorkspaceConversationLedger(identity: string) {
      calls.push({ method: 'getWorkspaceConversationLedger', args: [identity] });
      workspaceIdentity = identity;
      return ledger();
    },
    async getWorkspaceAttemptRehydration(...args: unknown[]) {
      calls.push({ method: 'getWorkspaceAttemptRehydration', args });
      return { workspaceRoot: args[0], attempts: records };
    },
    async executeAttempt(...args: unknown[]) { calls.push({ method: 'executeAttempt', args }); return { status: 'accepted', attemptId: args[0] }; },
    async getAttempt(id: string) { calls.push({ method: 'getAttempt', args: [id] }); return records.find((item) => item.attempt.id === id)!.attempt; },
    async claimKarkeDikhaAttempt(...args: unknown[]) { calls.push({ method: 'claimKarkeDikhaAttempt', args }); throw new Error('claim should not be called'); },
    async heartbeatKarkeDikhaAttempt(...args: unknown[]) { calls.push({ method: 'heartbeatKarkeDikhaAttempt', args }); },
    async requestKarkeDikhaApproval(...args: unknown[]) { calls.push({ method: 'requestKarkeDikhaApproval', args }); },
    async resolveKarkeDikhaApproval(...args: unknown[]) {
      calls.push({ method: 'resolveKarkeDikhaApproval', args });
      return { attempt: { id: records[0]?.attempt.id, status: 'running' }, approval: args[2] };
    },
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

export function restartRehydrationCoreManager(client: ReturnType<typeof restartRehydrationCoreClient>) {
  return {
    getClient: () => client,
    getStatus: () => ({ state: 'connected' }),
    onRuntimeEvent: () => ({ dispose: () => undefined }),
    onRuntimeToken: () => ({ dispose: () => undefined }),
  };
}
