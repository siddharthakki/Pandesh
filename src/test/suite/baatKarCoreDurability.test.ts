import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import * as vscodeMock from '../mocks/vscode';
import { AgentPanel } from '../../ui/AgentPanel';
import { AgentRuntime } from '../../agent/AgentRuntime';
import { RepositoryContextService } from '../../context/RepositoryContextService';
import { RepoFastPath } from '../../repository/RepoFastPath';
import type { RuntimeEventRecord, RuntimeTokenFrame } from '../../../core/shared/wireTypes';

const dependencyMocks = vi.hoisted(() => ({
  getCoreManager: vi.fn(),
  createProvider: vi.fn(),
}));

vi.mock('../../extension', () => ({
  getCoreManager: dependencyMocks.getCoreManager,
}));

vi.mock('../../providers/ProviderGateway', () => ({
  ProviderGateway: { create: dependencyMocks.createProvider },
}));

interface PostedMessage {
  type: string;
  [key: string]: unknown;
}

function fakeContext(): vscode.ExtensionContext {
  return {
    subscriptions: [],
    extensionUri: vscode.Uri.file(process.cwd()),
    secrets: { get: async () => undefined, store: async () => undefined, delete: async () => undefined, onDidChange: () => ({ dispose: () => undefined }) },
    extension: { packageJSON: { scripts: {}, contributes: { commands: [] } } },
  } as unknown as vscode.ExtensionContext;
}

function attachPanel(root: string, posted: PostedMessage[], workspaceAvailable = true): { panel: AgentPanel; receive: (msg: unknown) => void } {
  const context = fakeContext();
  const panel = new AgentPanel(context, root, workspaceAvailable);
  let receive: (msg: unknown) => void = () => undefined;
  const webview = {
    options: {},
    html: '',
    cspSource: 'vscode-webview://test',
    asWebviewUri: (uri: vscode.Uri) => uri,
    postMessage: (msg: PostedMessage) => { posted.push(msg); return Promise.resolve(true); },
    onDidReceiveMessage: (cb: (msg: unknown) => void) => { receive = cb; return { dispose: () => undefined }; },
  };
  const webviewView = {
    webview,
    show: () => undefined,
    onDidDispose: () => ({ dispose: () => undefined }),
    visible: true,
  } as unknown as vscode.WebviewView;
  panel.resolveWebviewView(webviewView, {} as vscode.WebviewViewResolveContext, {} as vscode.CancellationToken);
  return { panel, receive: (msg: unknown) => receive(msg) };
}

/** Structural fake matching the subset of CoreClient AgentPanel's Core-execution
 * cutover calls — records every call for assertions, never touches a real Core. */
function fakeCoreClient() {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  let conversationCounter = 0;
  let attemptCounter = 0;
  const conversationMessages = new Map<string, Array<{ role: string; content: string }>>();
  let projectedMessages: Array<{ role: string; content: string }> | undefined;
  let responseAlternatives: Array<{ id: string; userMessageId: string; assistantMessageId: string; ordinal: number; active: boolean }> = [];
  let ledgerTurns: Array<Record<string, unknown>> = [];
  const attempts = new Map<string, Record<string, unknown>>();
  const attemptContexts = new Map<string, Record<string, unknown>>();
  let submitImpl: ((args: unknown[]) => { request: { id: string }; attempt: { id: string }; planningOnly: boolean }) | undefined;
  let executeImpl: ((attemptId: string) => void) | undefined;
  let ledger: {
    workspaceIdentity: string;
    currentConversationId: string | null;
    currentCoreConversationId: string | null;
    conversations: Array<{
      workspaceIdentity: string;
      localConversationId: string;
      conversationId: string;
      title: string | null;
      createdAt: string;
      updatedAt: string;
      archivedAt: null;
      schemaVersion: number;
      migrationMetadata: Record<string, unknown>;
    }>;
  } = {
    workspaceIdentity: '',
    currentConversationId: null,
    currentCoreConversationId: null,
    conversations: [],
  };
  const ledgerSnapshot = () => ({ schemaVersion: 1, ...ledger, turns: ledgerTurns, migrationMetadata: {} });

  return {
    calls,
    conversationMessages,
    /** Test hook: override what `submit()` returns (e.g. to reject). */
    setSubmitImpl(fn: typeof submitImpl) { submitImpl = fn; },
    setExecuteImpl(fn: typeof executeImpl) { executeImpl = fn; },
    setConversationMessages(conversationId: string, messages: Array<{ role: string; content: string }>) { conversationMessages.set(conversationId, messages); projectedMessages = messages; },
    setResponseAlternatives(alternatives: typeof responseAlternatives) { responseAlternatives = alternatives; },
    setLedgerTurns(turns: Array<Record<string, unknown>>) { ledgerTurns = turns; },
    setAttempt(attemptId: string, attempt: Record<string, unknown>, context: Record<string, unknown>) {
      attempts.set(attemptId, { id: attemptId, ...attempt });
      attemptContexts.set(attemptId, { attemptId, ...context });
    },
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
    async bindWorkspaceConversation(input: {
      workspaceIdentity: string;
      localConversationId: string;
      conversationId: string;
      title?: string | null;
    }) {
      calls.push({ method: 'bindWorkspaceConversation', args: [input] });
      const now = new Date().toISOString();
      const existing = ledger.conversations.find(item => item.localConversationId === input.localConversationId);
      if (!existing) {
        ledger.conversations.push({
          workspaceIdentity: input.workspaceIdentity,
          localConversationId: input.localConversationId,
          conversationId: input.conversationId,
          title: input.title ?? null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          schemaVersion: 1,
          migrationMetadata: {},
        });
      }
      ledger = {
        ...ledger,
        workspaceIdentity: input.workspaceIdentity,
        currentConversationId: input.localConversationId,
        currentCoreConversationId: input.conversationId,
      };
      return ledgerSnapshot();
    },
    async selectWorkspaceConversation(workspaceIdentity: string, localConversationId: string) {
      calls.push({ method: 'selectWorkspaceConversation', args: [workspaceIdentity, localConversationId] });
      const selected = ledger.conversations.find(item => item.localConversationId === localConversationId);
      ledger = {
        ...ledger,
        workspaceIdentity,
        currentConversationId: localConversationId,
        currentCoreConversationId: selected?.conversationId ?? null,
      };
      return ledgerSnapshot();
    },
    async appendMessage(conversationId: string, input: { role: string; content: string }) {
      calls.push({ method: 'appendMessage', args: [conversationId, input] });
      conversationMessages.get(conversationId)?.push({ role: input.role, content: input.content });
      return { seq: calls.length, id: `msg_${calls.length}` };
    },
    async listMessages(conversationId: string) {
      calls.push({ method: 'listMessages', args: [conversationId] });
      return { messages: (projectedMessages ?? conversationMessages.get(conversationId) ?? []).map((m, i) => ({ seq: i, id: `msg_${i}`, conversationId, ...m, modelInvocationId: null, createdAt: new Date().toISOString() })) };
    },
    async listResponseAlternatives(conversationId: string) {
      calls.push({ method: 'listResponseAlternatives', args: [conversationId] });
      return { alternatives: responseAlternatives };
    },
    async listConversationResearch() { return { research: [] }; },
    async listCapabilityActions() { return { attemptId: null, actions: [] }; },
    async listRecentWorkspaceCapabilityActions() { return { actions: [] }; },
    async getConversationBranch() { return { branch: null }; },
    async listMessageCitations() { return { citations: [] }; },
    async selectResponseAlternative(conversationId: string, alternativeId: string) {
      calls.push({ method: 'selectResponseAlternative', args: [conversationId, alternativeId] });
      return { id: alternativeId };
    },
    async listConversationMessageAttachments(conversationId: string) {
      calls.push({ method: 'listConversationMessageAttachments', args: [conversationId] });
      return { byMessage: {} };
    },
    async getAttachment(attachmentId: string) {
      calls.push({ method: 'getAttachment', args: [attachmentId] });
      return { id: attachmentId, kind: 'text' };
    },
    async submit(...args: unknown[]) {
      calls.push({ method: 'submit', args });
      if (submitImpl) return submitImpl(args);
      attemptCounter += 1;
      return { request: { id: `req_${attemptCounter}` }, attempt: { id: `att_${attemptCounter}`, status: 'created' }, planningOnly: false };
    },
    async executeAttempt(attemptId: string, ...rest: unknown[]) {
      calls.push({ method: 'executeAttempt', args: [attemptId, ...rest] });
      executeImpl?.(attemptId);
      return { status: 'accepted', attemptId };
    },
    async cancelAttempt(...args: unknown[]) {
      calls.push({ method: 'cancelAttempt', args });
      return { id: args[0], status: 'cancelling' };
    },
    async getAttempt(attemptId: string) {
      calls.push({ method: 'getAttempt', args: [attemptId] });
      return attempts.get(attemptId) ?? { id: attemptId, status: 'failed', failureReason: 'unknown failure' };
    },
    async getAttemptContext(attemptId: string) {
      calls.push({ method: 'getAttemptContext', args: [attemptId] });
      return attemptContexts.get(attemptId) ?? { attemptId };
    },
    async request(routePath: string, init: unknown) {
      calls.push({ method: 'request', args: [routePath, init] });
      return { ok: true };
    },
  };
}

function fakeCoreManager(client: ReturnType<typeof fakeCoreClient>) {
  const runtimeEventListeners: Array<(e: RuntimeEventRecord) => void> = [];
  const runtimeTokenListeners: Array<(f: RuntimeTokenFrame) => void> = [];
  return {
    getClient: () => client,
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

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

/**
 * A Saath Kar turn selects bounded repository context (index + git status)
 * before it submits, so its submission is no longer observable after a single
 * fixed tick the way a plain Baat turn's is. Waits for the Core call itself
 * rather than for a duration.
 */
async function waitForCalls(
  client: { calls: Array<{ method: string }> },
  method: string,
  count: number,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (client.calls.filter((call) => call.method === method).length >= count) return;
    if (Date.now() > deadline) throw new Error(`Core '${method}' was never called ${count} time(s)`);
    await flush();
  }
}

describe('Baat Kar / Saath Kar Core execution cutover (M32 correction)', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-core-exec-'));
    dependencyMocks.getCoreManager.mockReset();
    dependencyMocks.createProvider.mockReset();
    dependencyMocks.createProvider.mockResolvedValue({
      listModels: async () => [
        { name: 'persisted-model', modifiedAt: '2026-01-01T00:00:00.000Z' },
        { name: 'qwen2.5-coder:14b', modifiedAt: '2026-01-01T00:00:00.000Z', contextWindow: 32_768 },
        { name: 'qwen3-coder:30b', modifiedAt: '2026-01-01T00:00:00.000Z', contextWindow: 32_768 },
      ],
    });
    vscodeMock._resetConfig();
    vscodeMock._setConfig('ollama-agent.providerType', 'ollama');
    vscodeMock._setConfig('ollama-agent.model', 'persisted-model');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it.each([
    'Write a Python function that checks whether a string is a palindrome.',
    'Write a function to compute Fibonacci numbers.',
    'Show me a Python example that checks prime numbers.',
    'Write a bash script that renames every file in a folder to lowercase.',
    'Create a regex that matches email addresses.',
    'Implement binary search in TypeScript.',
    'Explain dependency injection in one paragraph.',
    'What is the capital of France?',
  ])('keeps standalone code generation out of repository reads and mode gates: %s', async original => {
    const query = vi.spyOn(RepoFastPath.prototype, 'repoQuery');
    const symbols = vi.spyOn(RepoFastPath.prototype, 'knowsSymbols');
    const client = fakeCoreClient();
    dependencyMocks.getCoreManager.mockReturnValue(fakeCoreManager(client));
    const posted: PostedMessage[] = [];
    const { receive } = attachPanel(root, posted);
    receive({ type: 'sendMessage', mode: 'chat', text: original, conversationId: 'generic-code' });
    await waitForCalls(client, 'submit', 1);
    const body = client.calls.find(call => call.method === 'submit')!.args[0] as { repositoryContext?: unknown; requestedMode: string };
    expect(body.requestedMode).toBe('baat_kar');
    expect(body.repositoryContext).toBeUndefined();
    expect(query).not.toHaveBeenCalled();
    expect(symbols).not.toHaveBeenCalled();
    expect(posted.some(message => message.type === 'modeChangeRequired' || message.type === 'repositoryContextEvidence')).toBe(false);
  });

  it('builds bounded repository context for a Baat repository question and submits it without altering the user message', async () => {
    vi.spyOn(RepoFastPath.prototype, 'repoQuery').mockResolvedValue(null as any);
    const build = vi.spyOn(RepositoryContextService.prototype, 'build').mockResolvedValue({
      prompt: '## Automatically selected repository context\n### src/models/TaskModelSelection.ts\nexport function selectTaskModel() {}',
      files: [{ path: 'src/models/TaskModelSelection.ts', score: 42, estimatedTokens: 32, reasons: [{ reason: 'path matches selection', score: 16 }], snippet: 'export function selectTaskModel() {}', truncated: false }],
      diagnostics: {
        queryTerms: ['task-model', 'selection', 'implemented'], providerContextWindow: 32768, inputBudget: 30268,
        estimatedTokens: 48, omittedCount: 0,
        selectedFiles: [{ path: 'src/models/TaskModelSelection.ts', score: 42, estimatedTokens: 32, reasons: [{ reason: 'path matches selection', score: 16 }] }],
        rejectedFiles: [], inventorySize: 1, inventoryTruncated: false,
      },
      index: {
        schemaVersion: 2, workspaceRoot: root,
        identity: { repositoryRoot: root, branch: 'dev/current', headCommit: 'abc', worktree: root, detached: false, schemaVersion: 2 },
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), state: 'ready', files: [], ignoredPatterns: [], truncated: false,
        statistics: { files: 1, symbols: 1, imports: 0, tests: 0, configs: 0, buildFiles: 0, markdown: 0, changedFiles: 0, deletedFiles: 0 },
        pins: [], exclusions: [],
      },
    });
    const client = fakeCoreClient();
    dependencyMocks.getCoreManager.mockReturnValue(fakeCoreManager(client));
    const posted: PostedMessage[] = [];
    const { receive } = attachPanel(root, posted);
    const original = 'Where is task-model selection implemented and what does it do?';

    receive({ type: 'sendMessage', mode: 'chat', text: original, conversationId: 'repo-aware' });
    await waitForCalls(client, 'submit', 1);

    expect(build).toHaveBeenCalledWith(expect.objectContaining({ query: original, mode: 'chat' }));
    const body = client.calls.find(call => call.method === 'submit')?.args[0] as { currentMessage: string; requestedMode: string; repositoryContext?: { prompt: string } };
    expect(body.currentMessage).toBe(original);
    expect(body.requestedMode).toBe('baat_kar');
    expect(body.repositoryContext?.prompt).toContain('TaskModelSelection.ts');
    expect(posted).toContainEqual(expect.objectContaining({ type: 'repositoryContextEvidence', available: true, fileCount: 1, estimatedTokens: 48 }));
    expect(client.calls.some(call => call.method === 'appendMessage')).toBe(false);
  });

  it('reuses the frozen repository package when Resume follows a grounded empty response', async () => {
    const build = vi.spyOn(RepositoryContextService.prototype, 'build').mockResolvedValue({
      prompt: '## Automatically selected repository context\n### src/ordercalc/pricing.ts\nexport function computeTotal() {}',
      files: [{ path: 'src/ordercalc/pricing.ts', score: 42, estimatedTokens: 32, reasons: [{ reason: 'path matches selection', score: 16 }], snippet: 'export function computeTotal() {}', truncated: false }],
      diagnostics: {
        queryTerms: ['pricing', 'implementation'], providerContextWindow: 32768, inputBudget: 30268,
        estimatedTokens: 48, omittedCount: 0,
        selectedFiles: [{ path: 'src/ordercalc/pricing.ts', score: 42, estimatedTokens: 32, reasons: [{ reason: 'path matches selection', score: 16 }] }],
        rejectedFiles: [], inventorySize: 1, inventoryTruncated: false,
      },
      index: {
        schemaVersion: 2, workspaceRoot: root,
        identity: { repositoryRoot: root, branch: 'dev/current', headCommit: 'abc', worktree: root, detached: false, schemaVersion: 2 },
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), state: 'ready', files: [], ignoredPatterns: [], truncated: false,
        statistics: { files: 1, symbols: 1, imports: 0, tests: 0, configs: 0, buildFiles: 0, markdown: 0, changedFiles: 0, deletedFiles: 0 },
        pins: [], exclusions: [],
      },
    });
    const client = fakeCoreClient();
    const manager = fakeCoreManager(client);
    dependencyMocks.getCoreManager.mockReturnValue(manager);
    const posted: PostedMessage[] = [];
    const { receive } = attachPanel(root, posted);

    receive({ type: 'sendMessage', mode: 'chat', text: 'Review the repository pricing implementation.', conversationId: 'grounded-resume' });
    await waitForCalls(client, 'submit', 1);
    const firstBody = client.calls.find(call => call.method === 'submit')?.args[0] as {
      modelSelection: Record<string, unknown>;
      repositoryContext: { prompt: string; selectedFiles: Array<{ path: string; estimatedTokens: number }>; estimatedTokens: number; packageHash?: string };
    };

    manager.fireRuntimeEvent({
      domain: 'attempt',
      entityId: 'att_1',
      eventType: 'attempt_failed',
      metadata: { failureReason: 'model produced an empty response' },
    });
    await flush();
    client.setLedgerTurns([{
      seq: 1,
      id: 'turn_req_1',
      conversationId: 'conv_1',
      requestId: 'req_1',
      attemptId: 'att_1',
      mode: 'baat_kar',
      outcome: 'failed',
    }]);
    client.setAttempt('att_1', {
      status: 'failed',
      failureReason: 'model produced an empty response',
    }, {
      modelSelection: firstBody.modelSelection,
      repositoryContext: firstBody.repositoryContext,
    });

    receive({ type: 'sendMessage', mode: 'chat', text: 'Resume', conversationId: 'grounded-resume' });
    await waitForCalls(client, 'submit', 2);
    const submissions = client.calls.filter(call => call.method === 'submit');
    const resumedBody = submissions[1].args[0] as {
      currentMessage: string;
      modelSelection: Record<string, unknown>;
      repositoryContext?: typeof firstBody.repositoryContext;
    };

    expect(build).toHaveBeenCalledTimes(1);
    expect(resumedBody.currentMessage).toBe('Resume');
    expect(resumedBody.modelSelection).toEqual(firstBody.modelSelection);
    expect(resumedBody.repositoryContext).toEqual(firstBody.repositoryContext);
    expect(client.calls).toContainEqual({ method: 'getAttempt', args: ['att_1'] });
    expect(client.calls).toContainEqual({ method: 'getAttemptContext', args: ['att_1'] });
    expect(posted.filter(message => message.type === 'repositoryContextEvidence')).toContainEqual(expect.objectContaining({
      available: true,
      fileCount: 1,
      estimatedTokens: 48,
      paths: ['src/ordercalc/pricing.ts'],
    }));
  });

  it('keeps no-workspace and generic Baat chat on the existing plain-chat path', async () => {
    const build = vi.spyOn(RepositoryContextService.prototype, 'build');
    const client = fakeCoreClient();
    dependencyMocks.getCoreManager.mockReturnValue(fakeCoreManager(client));
    const posted: PostedMessage[] = [];
    const noWorkspace = attachPanel(root, posted, false);

    noWorkspace.receive({ type: 'sendMessage', mode: 'chat', text: 'What does this repository contain?', conversationId: 'no-workspace' });
    await flush();

    expect(build).not.toHaveBeenCalled();
    const noWorkspaceBody = client.calls.find(call => call.method === 'submit')?.args[0] as { repositoryContext?: unknown; workspaceRoot?: string | null; modelSelection: { requiredCapabilities: { repositoryExploration: boolean; toolCalling: boolean; fileModification: boolean } } };
    expect(noWorkspaceBody.repositoryContext).toBeUndefined();
    expect(noWorkspaceBody.workspaceRoot).toBeNull();
    expect(noWorkspaceBody.modelSelection.requiredCapabilities).toEqual(expect.objectContaining({ repositoryExploration: false, toolCalling: false, fileModification: false }));

    const genericClient = fakeCoreClient();
    dependencyMocks.getCoreManager.mockReturnValue(fakeCoreManager(genericClient));
    const genericPosted: PostedMessage[] = [];
    const generic = attachPanel(root, genericPosted);
    generic.receive({ type: 'sendMessage', mode: 'chat', text: 'Tell me a short joke.', conversationId: 'generic' });
    await flush();
    expect(build).not.toHaveBeenCalled();
  });

  it('fails closed (Phase 2 grounding contract) when repository-context retrieval fails for a repository-specific Baat question, instead of falling back to ungrounded plain chat', async () => {
    vi.spyOn(RepoFastPath.prototype, 'repoQuery').mockResolvedValue(null as any);
    vi.spyOn(RepositoryContextService.prototype, 'build').mockRejectedValue(new Error('index unavailable'));
    const client = fakeCoreClient();
    dependencyMocks.getCoreManager.mockReturnValue(fakeCoreManager(client));
    const posted: PostedMessage[] = [];
    const { receive } = attachPanel(root, posted);
    const original = 'Explain this repository structure.';

    receive({ type: 'sendMessage', mode: 'chat', text: original, conversationId: 'degraded' });
    await flush();

    // The repository-read path failed for a question that WAS identified as
    // repository-specific — the turn must never reach Core/the model without
    // evidence (that would be the legacy hallucination bug). No submit, no
    // executeAttempt, no tool/approval activity — just the fail-closed error.
    expect(client.calls.some(call => call.method === 'submit')).toBe(false);
    expect(client.calls.some(call => call.method === 'executeAttempt')).toBe(false);
    expect(posted).toContainEqual(expect.objectContaining({ type: 'repositoryContextEvidence', available: false }));
    expect(posted).toContainEqual(expect.objectContaining({
      type: 'error',
      message: "Repository context is currently unavailable, so I can't verify that from this workspace.",
    }));
    expect(posted.some(message => message.type === 'approvalRequest' || message.type === 'autonomousTaskStarted' || message.type === 'toolStart')).toBe(false);
  });

  it('still answers a generic, non-repository Baat question as plain chat even when repository grounding is unavailable', async () => {
    vi.spyOn(RepositoryContextService.prototype, 'build').mockRejectedValue(new Error('index unavailable'));
    const client = fakeCoreClient();
    dependencyMocks.getCoreManager.mockReturnValue(fakeCoreManager(client));
    const posted: PostedMessage[] = [];
    const { receive } = attachPanel(root, posted);
    const original = 'Explain dependency injection in one paragraph.';

    receive({ type: 'sendMessage', mode: 'chat', text: original, conversationId: 'generic-degraded' });
    await flush();

    // Not a repository-specific question, so grounding is never attempted —
    // the turn proceeds as ordinary plain chat, unaffected by the repository
    // index being unavailable.
    const body = client.calls.find(call => call.method === 'submit')?.args[0] as { currentMessage: string; requestedMode: string; repositoryContext?: unknown };
    expect(body).toEqual(expect.objectContaining({ currentMessage: original, requestedMode: 'baat_kar' }));
    expect(body.repositoryContext).toBeUndefined();
    expect(client.calls.some(call => call.method === 'executeAttempt')).toBe(true);
    expect(posted.some(message => message.type === 'error')).toBe(false);
  });

  it('fails closed when the repository context selector returns no evidence at all for a repository-specific question', async () => {
    vi.spyOn(RepoFastPath.prototype, 'repoQuery').mockResolvedValue(null as any);
    const build = vi.spyOn(RepositoryContextService.prototype, 'build').mockResolvedValue({
      prompt: '',
      files: [],
      diagnostics: {
        queryTerms: [], providerContextWindow: 32768, inputBudget: 30268,
        estimatedTokens: 0, omittedCount: 0,
        selectedFiles: [], rejectedFiles: [], inventorySize: 0, inventoryTruncated: false,
      },
      index: {
        schemaVersion: 2, workspaceRoot: root,
        identity: { repositoryRoot: root, branch: 'dev/current', headCommit: 'abc', worktree: root, detached: false, schemaVersion: 2 },
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), state: 'ready', files: [], ignoredPatterns: [], truncated: false,
        statistics: { files: 0, symbols: 0, imports: 0, tests: 0, configs: 0, buildFiles: 0, markdown: 0, changedFiles: 0, deletedFiles: 0 },
        pins: [], exclusions: [],
      },
    });
    const client = fakeCoreClient();
    dependencyMocks.getCoreManager.mockReturnValue(fakeCoreManager(client));
    const posted: PostedMessage[] = [];
    const { receive } = attachPanel(root, posted);

    receive({ type: 'sendMessage', mode: 'chat', text: 'Review src/ui/AgentPanel.ts for me.', conversationId: 'empty-evidence' });
    await flush();

    expect(client.calls.some(call => call.method === 'submit')).toBe(false);
    expect(posted).toContainEqual(expect.objectContaining({
      type: 'error',
      message: "Repository context is currently unavailable, so I can't verify that from this workspace.",
    }));
  });

  it('Baat Kar calls Core execution (submit + executeAttempt) and never calls AgentRuntime.run()', async () => {
    const client = fakeCoreClient();
    const manager = fakeCoreManager(client);
    const runSpy = vi.spyOn(AgentRuntime.prototype, 'run');
    dependencyMocks.getCoreManager.mockReturnValue(manager);

    const posted: PostedMessage[] = [];
    const { receive } = attachPanel(root, posted);
    receive({ type: 'sendMessage', mode: 'chat', text: 'What is the capital of France?', conversationId: 'webview-conv-1' });
    await flush();

    expect(runSpy).not.toHaveBeenCalled();
    const submitCall = client.calls.find((c) => c.method === 'submit');
    expect(submitCall).toBeDefined();
    expect((submitCall?.args[0] as { requestedMode: string }).requestedMode).toBe('baat_kar');
    const executeCall = client.calls.find((c) => c.method === 'executeAttempt');
    expect(executeCall).toBeDefined();
    expect(executeCall?.args[0]).toBe('att_1');
  });

  it('sends bounded repository context with a Saath Kar turn, through the same selection service Baat Kar uses', async () => {
    await fs.writeFile(
      path.join(root, 'inventory-helper.ts'),
      'export function inventoryTotal(counts: number[]): number {\n  return counts.reduce((sum, value) => sum + value, 0);\n}\n',
      'utf8',
    );
    const client = fakeCoreClient();
    dependencyMocks.getCoreManager.mockReturnValue(fakeCoreManager(client));

    const posted: PostedMessage[] = [];
    const { receive } = attachPanel(root, posted);
    receive({ type: 'sendMessage', mode: 'agent', text: 'Update inventoryTotal in inventory-helper.ts to ignore negatives', conversationId: 'webview-conv-repo-saath' });
    await waitForCalls(client, 'executeAttempt', 1);
    await flush();

    const body = client.calls.find(call => call.method === 'submit')?.args[0] as {
      requestedMode: string;
      repositoryContext?: { prompt: string; selectedFiles: Array<{ path: string }> };
    };
    expect(body.requestedMode).toBe('saath_kar');
    expect(body.repositoryContext?.selectedFiles.map(file => file.path)).toContain('inventory-helper.ts');
    expect(posted).toContainEqual(expect.objectContaining({ type: 'repositoryContextEvidence', available: true }));
  });

  describe('a whole-repository inspection of a large repository', () => {
    const inspection = 'Inspect this repository and explain its architecture, major components, and current state. Do not modify anything.';
    const previousIndexRoot = process.env.OLLAMA_AGENT_REPOSITORY_INDEX_ROOT;

    beforeEach(async () => {
      process.env.OLLAMA_AGENT_REPOSITORY_INDEX_ROOT = path.join(root, '..', `${path.basename(root)}-index`);
      vscodeMock._setConfig('ollama-agent.contextWindow', 32_768);
      await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'large-fixture' }), 'utf8');
      await fs.writeFile(path.join(root, 'README.md'), '# Large fixture\n', 'utf8');
      // ~600k characters of real source: several times the old 100k failure point.
      const body = Array.from({ length: 110 }, (_, line) => `  const step${line} = input * ${line}; // domain rule ${line}`).join('\n');
      for (let index = 0; index < 120; index += 1) {
        const directory = path.join(root, 'src', ['api', 'domain', 'workers'][index % 3]);
        await fs.mkdir(directory, { recursive: true });
        await fs.writeFile(path.join(directory, `module${index}.ts`), `export function module${index}(input: number) {\n${body}\n  return input;\n}\n`, 'utf8');
      }
    });

    afterEach(async () => {
      await fs.rm(process.env.OLLAMA_AGENT_REPOSITORY_INDEX_ROOT!, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      if (previousIndexRoot === undefined) delete process.env.OLLAMA_AGENT_REPOSITORY_INDEX_ROOT;
      else process.env.OLLAMA_AGENT_REPOSITORY_INDEX_ROOT = previousIndexRoot;
    });

    for (const [mode, requestedMode] of [['chat', 'baat_kar'], ['agent', 'saath_kar']] as const) {
      it(`submits a bounded package Core accepts and executes (${requestedMode})`, async () => {
        const { normalizeRepositoryContext } = await import('../../../core/domain/attemptContext');
        const client = fakeCoreClient();
        dependencyMocks.getCoreManager.mockReturnValue(fakeCoreManager(client));
        const posted: PostedMessage[] = [];
        const { receive } = attachPanel(root, posted);

        receive({ type: 'sendMessage', mode, text: inspection, conversationId: `large-repo-${requestedMode}` });
        await waitForCalls(client, 'executeAttempt', 1, 20_000);

        const body = client.calls.find(call => call.method === 'submit')?.args[0] as {
          requestedMode: string;
          repositoryContext?: { prompt: string; selectedFiles: Array<{ path: string; estimatedTokens: number }>; estimatedTokens: number; packageHash?: string };
        };
        expect(body.requestedMode).toBe(requestedMode);
        const context = body.repositoryContext!;
        expect(context.prompt).toMatch(/### Repository overview|Repository evidence retrieved by the host/);
        expect(context.prompt.length).toBeLessThan(100_000);
        expect(() => normalizeRepositoryContext(context)).not.toThrow();
        expect(posted).not.toContainEqual(expect.objectContaining({ type: 'error' }));
        const evidence = posted.find(message => message.type === 'repositoryContextEvidence' && message.available === true) as
          { budget?: { candidateChars: number; selectedChars: number; budgetChars: number; modelContext: number }; available?: boolean } | undefined;
        expect(evidence?.available).toBe(true);
        if (evidence?.budget) {
          expect(evidence.budget.candidateChars).toBeGreaterThan(500_000);
          expect(evidence.budget.selectedChars).toBeGreaterThan(0);
          expect(evidence.budget.selectedChars).toBeLessThanOrEqual(context.prompt.length);
          expect(evidence.budget.selectedChars).toBeLessThanOrEqual(evidence.budget.budgetChars);
          expect(evidence.budget.modelContext).toBeLessThanOrEqual(32_768);
        }
      }, 30_000);
    }
  });

  it('Saath Kar calls Core execution (submit + executeAttempt with workingDirectory) and never calls AgentRuntime.run()', async () => {
    const client = fakeCoreClient();
    const manager = fakeCoreManager(client);
    const runSpy = vi.spyOn(AgentRuntime.prototype, 'run');
    dependencyMocks.getCoreManager.mockReturnValue(manager);

    const posted: PostedMessage[] = [];
    const { receive } = attachPanel(root, posted);
    receive({ type: 'sendMessage', mode: 'agent', text: 'read the readme', conversationId: 'webview-conv-2' });
    await waitForCalls(client, 'executeAttempt', 1);
    await flush();

    expect(runSpy).not.toHaveBeenCalled();
    const submitCall = client.calls.find((c) => c.method === 'submit');
    expect((submitCall?.args[0] as { requestedMode: string }).requestedMode).toBe('saath_kar');
    const executeCall = client.calls.find((c) => c.method === 'executeAttempt');
    expect(executeCall).toBeDefined();
    expect(executeCall?.args[1]).toEqual({ workingDirectory: root });
  });

  it('uses the Core-issued request/attempt id for execution and event correlation', async () => {
    const client = fakeCoreClient();
    const manager = fakeCoreManager(client);
    dependencyMocks.getCoreManager.mockReturnValue(manager);

    const posted: PostedMessage[] = [];
    const { receive } = attachPanel(root, posted);
    receive({ type: 'sendMessage', mode: 'chat', text: 'What is 2 + 2?', conversationId: 'webview-conv-3' });
    await waitForCalls(client, 'executeAttempt', 1);

    const executeCall = client.calls.find((c) => c.method === 'executeAttempt');
    const attemptId = executeCall?.args[0] as string;
    expect(attemptId).toBe('att_1');

    manager.fireRuntimeEvent({ domain: 'attempt', entityId: attemptId, eventType: 'attempt_transitioned', metadata: { from: 'running', to: 'completed' } });
    await flush();

    expect(posted.some((m) => m.type === 'done')).toBe(true);
  });

  it('projects the durable response-alternative group onto the live terminal bubble', async () => {
    const client = fakeCoreClient();
    const durableMessages = [
      { role: 'user', content: 'continue the branch' },
      { role: 'assistant', content: 'Original answer [S1]' },
      { role: 'assistant', content: 'Regenerated answer [S1]' },
    ];
    // The mount-time default-conversation restore can reserve conv_1 before
    // this independent webview conversation is submitted as conv_2.
    client.setConversationMessages('conv_1', durableMessages);
    client.setConversationMessages('conv_2', durableMessages);
    client.setResponseAlternatives([
      { id: 'alt_original', userMessageId: 'msg_0', assistantMessageId: 'msg_1', ordinal: 0, active: false },
      { id: 'alt_regenerated', userMessageId: 'msg_0', assistantMessageId: 'msg_2', ordinal: 1, active: true },
    ]);
    const manager = fakeCoreManager(client);
    dependencyMocks.getCoreManager.mockReturnValue(manager);

    const posted: PostedMessage[] = [];
    const { receive } = attachPanel(root, posted);
    receive({ type: 'sendMessage', mode: 'chat', text: 'continue the branch', conversationId: 'webview-conv-alternatives' });
    await flush();
    const attemptId = client.calls.find((call) => call.method === 'executeAttempt')?.args[0] as string;
    expect(attemptId).toBeTruthy();
    manager.fireRuntimeEvent({ domain: 'attempt', entityId: attemptId, eventType: 'attempt_transitioned', metadata: { from: 'running', to: 'completed' } });
    await flush();

    const done = posted.find((message) => message.type === 'done');
    expect(done).toEqual(expect.objectContaining({
      content: 'Regenerated answer [S1]',
      messageId: 'msg_2',
      alternatives: [
        expect.objectContaining({ id: 'alt_original', ordinal: 0, active: false }),
        expect.objectContaining({ id: 'alt_regenerated', ordinal: 1, active: true }),
      ],
    }));
    expect(client.calls.some((call) => call.method === 'listResponseAlternatives')).toBe(true);
  });

  it('replaces an already-restored transcript after selecting a durable response alternative', async () => {
    const client = fakeCoreClient();
    client.setConversationMessages('conv_1', [
      { role: 'user', content: 'continue the branch' },
      { role: 'assistant', content: 'Selected original answer' },
    ]);
    client.setResponseAlternatives([{ id: 'alt_original', userMessageId: 'msg_0', assistantMessageId: 'msg_1', ordinal: 0, active: true }]);
    dependencyMocks.getCoreManager.mockReturnValue(fakeCoreManager(client));

    const posted: PostedMessage[] = [];
    const { receive } = attachPanel(root, posted);
    await flush();
    // A user can only click a response alternative once the webview script is
    // running, so the webview has necessarily reported readiness by then.
    // M39 routes durable restoration messages through the readiness queue
    // (see AgentPanel.postApprovalCardMessage), so this must be modelled.
    receive({ type: 'webviewReady', mode: 'chat' });
    await flush();
    receive({ type: 'selectResponseAlternative', alternativeId: 'alt_original' });
    await flush();

    expect(client.calls.some((call) => call.method === 'selectResponseAlternative')).toBe(true);
    expect(posted.filter((message) => message.type === 'restoreTranscript').at(-1)).toEqual(expect.objectContaining({ replaceExisting: true }));
  });

  it('translates runtime_token frames into the existing token webview message', async () => {
    const client = fakeCoreClient();
    const manager = fakeCoreManager(client);
    dependencyMocks.getCoreManager.mockReturnValue(manager);

    const posted: PostedMessage[] = [];
    const { receive } = attachPanel(root, posted);
    receive({ type: 'sendMessage', mode: 'chat', text: 'What is 2 + 2?', conversationId: 'webview-conv-4' });
    await waitForCalls(client, 'executeAttempt', 1);

    manager.fireRuntimeToken({ attemptId: 'att_1', invocationId: 'inv_1', delta: 'Par' });
    manager.fireRuntimeToken({ attemptId: 'att_1', invocationId: 'inv_1', delta: 'is' });
    await flush();

    const tokenMessages = posted.filter((m) => m.type === 'token');
    expect(tokenMessages.map((m) => m.delta)).toEqual(['Par', 'is']);
  });

  it('translates tool_invocation_started/completed events into toolStart/toolResult webview messages', async () => {
    const client = fakeCoreClient();
    const manager = fakeCoreManager(client);
    dependencyMocks.getCoreManager.mockReturnValue(manager);

    const posted: PostedMessage[] = [];
    const { receive } = attachPanel(root, posted);
    receive({ type: 'sendMessage', mode: 'agent', text: 'read the readme', conversationId: 'webview-conv-5' });
    await waitForCalls(client, 'executeAttempt', 1);
    await flush();

    manager.fireRuntimeEvent({
      domain: 'tool_invocation',
      entityId: 'tinv_1',
      eventType: 'tool_invocation_started',
      metadata: { attemptId: 'att_1', toolName: 'read_file', argsSummary: { path: 'README.md' } },
    });
    await flush();
    const toolStart = posted.find((m) => m.type === 'toolStart');
    expect(toolStart).toEqual(expect.objectContaining({ type: 'toolStart', toolName: 'read_file', args: { path: 'README.md' } }));

    manager.fireRuntimeEvent({
      domain: 'tool_invocation',
      entityId: 'tinv_1',
      eventType: 'tool_invocation_completed',
      metadata: { attemptId: 'att_1', status: 'succeeded', exitCode: 0, evidence: { output: 'hello' } },
    });
    await flush();
    const toolResult = posted.find((m) => m.type === 'toolResult');
    expect(toolResult).toEqual(expect.objectContaining({ type: 'toolResult', toolName: 'read_file', ok: true, result: { output: 'hello' } }));
  });

  it('completes the UI turn exactly once even if the terminal event is delivered twice', async () => {
    const client = fakeCoreClient();
    const manager = fakeCoreManager(client);
    dependencyMocks.getCoreManager.mockReturnValue(manager);

    const posted: PostedMessage[] = [];
    const { receive } = attachPanel(root, posted);
    receive({ type: 'sendMessage', mode: 'chat', text: 'What is 2 + 2?', conversationId: 'webview-conv-6' });
    await flush();

    manager.fireRuntimeEvent({ domain: 'attempt', entityId: 'att_1', eventType: 'attempt_transitioned', metadata: { from: 'running', to: 'completed' } });
    manager.fireRuntimeEvent({ domain: 'attempt', entityId: 'att_1', eventType: 'attempt_transitioned', metadata: { from: 'completed', to: 'completed' } });
    await flush();

    expect(posted.filter((m) => m.type === 'done')).toHaveLength(1);
  });

  it('ignores events for another or stale attempt without mutating the active turn', async () => {
    const client = fakeCoreClient();
    const manager = fakeCoreManager(client);
    dependencyMocks.getCoreManager.mockReturnValue(manager);

    const posted: PostedMessage[] = [];
    const { receive } = attachPanel(root, posted);
    receive({ type: 'sendMessage', mode: 'chat', text: 'What is 2 + 2?', conversationId: 'webview-conv-7' });
    await waitForCalls(client, 'executeAttempt', 1);

    // A completion event for an attempt this panel never started.
    manager.fireRuntimeEvent({ domain: 'attempt', entityId: 'att_from_another_window', eventType: 'attempt_failed', metadata: { failureReason: 'boom' } });
    await flush();
    expect(posted.some((m) => m.type === 'done' || m.type === 'error')).toBe(false);

    // The real attempt still completes normally afterward.
    manager.fireRuntimeEvent({ domain: 'attempt', entityId: 'att_1', eventType: 'attempt_transitioned', metadata: { from: 'running', to: 'completed' } });
    await flush();
    expect(posted.some((m) => m.type === 'done')).toBe(true);
  });

  it('ignores a duplicate terminal event and any late event after the turn already went terminal', async () => {
    const client = fakeCoreClient();
    const manager = fakeCoreManager(client);
    dependencyMocks.getCoreManager.mockReturnValue(manager);

    const posted: PostedMessage[] = [];
    const { receive } = attachPanel(root, posted);
    receive({ type: 'sendMessage', mode: 'chat', text: 'What is 2 + 2?', conversationId: 'webview-conv-8' });
    await flush();

    manager.fireRuntimeEvent({ domain: 'attempt', entityId: 'att_1', eventType: 'attempt_transitioned', metadata: { from: 'running', to: 'completed' } });
    await flush();
    expect(posted.filter((m) => m.type === 'done')).toHaveLength(1);

    // Late token + a late failure for the now-terminal attempt must be no-ops.
    manager.fireRuntimeToken({ attemptId: 'att_1', invocationId: 'inv_1', delta: 'late' });
    manager.fireRuntimeEvent({ domain: 'attempt', entityId: 'att_1', eventType: 'attempt_failed', metadata: { failureReason: 'late failure' } });
    await flush();

    expect(posted.filter((m) => m.type === 'done')).toHaveLength(1);
    expect(posted.some((m) => m.type === 'error')).toBe(false);
    expect(posted.some((m) => m.type === 'token' && m.delta === 'late')).toBe(false);
  });

  it('a Core execution failure surfaces as a structured error and never falls back to AgentRuntime.run()', async () => {
    const client = fakeCoreClient();
    client.setSubmitImpl(() => { throw new Error('Core rejected the submission'); });
    const manager = fakeCoreManager(client);
    const runSpy = vi.spyOn(AgentRuntime.prototype, 'run');
    dependencyMocks.getCoreManager.mockReturnValue(manager);

    const posted: PostedMessage[] = [];
    const { receive } = attachPanel(root, posted);
    receive({ type: 'sendMessage', mode: 'chat', text: 'What is 2 + 2?', conversationId: 'webview-conv-9' });
    await vi.waitFor(() => expect(posted.some((message) => message.type === 'error')).toBe(true));

    expect(runSpy).not.toHaveBeenCalled();
    const errorMessage = posted.find((m) => m.type === 'error');
    expect(errorMessage).toBeDefined();
    expect(String(errorMessage?.message)).toContain('Core rejected the submission');
    expect(posted.some((m) => m.type === 'done')).toBe(false);
  });

  it('a Core execution failure when Core is unreachable also never falls back to AgentRuntime.run()', async () => {
    const runSpy = vi.spyOn(AgentRuntime.prototype, 'run');
    dependencyMocks.getCoreManager.mockReturnValue(undefined);

    const posted: PostedMessage[] = [];
    const { receive } = attachPanel(root, posted);
    receive({ type: 'sendMessage', mode: 'chat', text: 'What is 2 + 2?', conversationId: 'webview-conv-10' });
    await vi.waitFor(() => expect(posted.some((message) => message.type === 'error')).toBe(true));

    expect(runSpy).not.toHaveBeenCalled();
    expect(posted.some((m) => m.type === 'error')).toBe(true);
  });

  it('preserves the requested model override and conversation/context wiring in the submission', async () => {
    vscodeMock._setConfig('ollama-agent.chatModel', 'qwen2.5-coder:7b');
    dependencyMocks.createProvider.mockResolvedValue({
      listModels: async () => [
        { name: 'persisted-model', modifiedAt: '2026-01-01T00:00:00.000Z' },
        { name: 'qwen2.5-coder:7b', modifiedAt: '2026-01-01T00:00:00.000Z', contextWindow: 32_768 },
        { name: 'qwen2.5-coder:14b', modifiedAt: '2026-01-01T00:00:00.000Z', contextWindow: 32_768 },
        { name: 'qwen3-coder:30b', modifiedAt: '2026-01-01T00:00:00.000Z', contextWindow: 32_768 },
      ],
    });
    const client = fakeCoreClient();
    const manager = fakeCoreManager(client);
    dependencyMocks.getCoreManager.mockReturnValue(manager);

    const posted: PostedMessage[] = [];
    const { receive } = attachPanel(root, posted);
    receive({ type: 'sendMessage', mode: 'chat', text: 'What is 2 + 2?', conversationId: 'webview-conv-11', model: 'qwen2.5-coder:7b' });
    await waitForCalls(client, 'submit', 1);

    const submitCall = client.calls.find((c) => c.method === 'submit');
    const body = submitCall?.args[0] as { requestedModel?: string | null; conversationId?: string; currentMessage: string };
    expect(body.requestedModel).toBe('qwen2.5-coder:7b');
    expect(body.currentMessage).toBe('What is 2 + 2?');
    expect(typeof body.conversationId).toBe('string');

    const createConversationCall = client.calls.find((c) => c.method === 'createConversation');
    expect((createConversationCall?.args[0] as { mode: string }).mode).toBe('baat_kar');
    // M36: the user message is appended atomically by Core's submitRequest
    // (as part of the same transaction as attachment linking + request +
    // attempt creation), not via a separate appendMessage round-trip.
    expect(client.calls.some((c) => c.method === 'appendMessage')).toBe(false);
  });

  it('routes stopGeneration through Core cancelAttempt, not the legacy runtime stop path', async () => {
    const client = fakeCoreClient();
    const manager = fakeCoreManager(client);
    const stopSpy = vi.spyOn(AgentRuntime.prototype, 'stop');
    dependencyMocks.getCoreManager.mockReturnValue(manager);

    const posted: PostedMessage[] = [];
    const { receive } = attachPanel(root, posted);
    receive({ type: 'sendMessage', mode: 'chat', text: 'What is 2 + 2?', conversationId: 'webview-conv-12' });
    await waitForCalls(client, 'executeAttempt', 1);

    receive({ type: 'stopGeneration' });
    await flush();

    expect(stopSpy).not.toHaveBeenCalled();
    const cancelCall = client.calls.find((c) => c.method === 'cancelAttempt');
    expect(cancelCall).toBeDefined();
    expect(cancelCall?.args[0]).toBe('att_1');

    manager.fireRuntimeEvent({ domain: 'attempt', entityId: 'att_1', eventType: 'attempt_cancelled' });
    await flush();
    expect(posted.some((m) => m.type === 'stopped')).toBe(true);
  });

  it('routes the ollama-agent.stop command through Core cancelAttempt as well, not just stopGeneration', async () => {
    const client = fakeCoreClient();
    const manager = fakeCoreManager(client);
    dependencyMocks.getCoreManager.mockReturnValue(manager);

    const posted: PostedMessage[] = [];
    const { panel, receive } = attachPanel(root, posted);
    receive({ type: 'sendMessage', mode: 'chat', text: 'What is 2 + 2?', conversationId: 'webview-conv-13' });
    await waitForCalls(client, 'executeAttempt', 1);

    panel.stop();
    await flush();

    const cancelCall = client.calls.find((c) => c.method === 'cancelAttempt');
    expect(cancelCall).toBeDefined();
    expect(cancelCall?.args[0]).toBe('att_1');
  });

  it('uses one durable Core conversation when the same visible conversation switches from Baat Kar to Saath Kar', async () => {
    const client = fakeCoreClient();
    const manager = fakeCoreManager(client);
    dependencyMocks.getCoreManager.mockReturnValue(manager);
    const posted: PostedMessage[] = [];
    const { receive } = attachPanel(root, posted);

    receive({ type: 'sendMessage', mode: 'chat', text: 'First Baat turn', conversationId: 'default' });
    await flush();
    manager.fireRuntimeEvent({
      domain: 'attempt',
      entityId: 'att_1',
      eventType: 'attempt_transitioned',
      metadata: { from: 'running', to: 'completed' },
    });
    await flush();
    receive({ type: 'sendMessage', mode: 'agent', text: 'Then Saath turn', conversationId: 'default' });
    await waitForCalls(client, 'submit', 2);
    await flush();

    const submissions = client.calls.filter(call => call.method === 'submit');
    expect(submissions).toHaveLength(2);
    expect((submissions[0].args[0] as { conversationId: string }).conversationId).toBe('conv_1');
    expect((submissions[1].args[0] as { conversationId: string }).conversationId).toBe('conv_1');
    expect(client.calls.filter(call => call.method === 'createConversation')).toHaveLength(1);
    expect(client.calls.filter(call => call.method === 'bindWorkspaceConversation')).toHaveLength(1);
  });

  it('restores the durable pointer, History index, and transcript into a fresh AgentPanel instance', async () => {
    const client = fakeCoreClient();
    const manager = fakeCoreManager(client);
    dependencyMocks.getCoreManager.mockReturnValue(manager);

    const firstPosted: PostedMessage[] = [];
    const first = attachPanel(root, firstPosted);
    first.receive({ type: 'sendMessage', mode: 'chat', text: 'What gets persisted?', conversationId: 'default' });
    await flush();
    client.setConversationMessages('conv_1', [
      { role: 'user', content: 'Persist me' },
      { role: 'assistant', content: 'Persisted answer' },
      { role: 'user', content: 'Saath request' },
      { role: 'assistant', content: 'Saath answer' },
    ]);

    // A new panel has no in-memory conversation map or webview state. It must
    // reconstruct exclusively through the fake Core ledger shared by this
    // test, mirroring a second Extension Host against the same Core database.
    const restoredPosted: PostedMessage[] = [];
    const restored = attachPanel(root, restoredPosted);
    restored.receive({ type: 'webviewReady', mode: 'chat' });
    await vi.waitFor(() => {
      expect(restoredPosted.some(message => message.type === 'restoreTranscript')).toBe(true);
      expect(restoredPosted.some(message => message.type === 'persistedConversationsLoaded')).toBe(true);
    });

    const transcript = restoredPosted.find(message => message.type === 'restoreTranscript');
    expect(transcript).toEqual(expect.objectContaining({
      conversationId: 'default',
      messages: [
        expect.objectContaining({ role: 'user', content: 'Persist me' }),
        expect.objectContaining({ role: 'assistant', content: 'Persisted answer' }),
        expect.objectContaining({ role: 'user', content: 'Saath request' }),
        expect.objectContaining({ role: 'assistant', content: 'Saath answer' }),
      ],
    }));
    const history = restoredPosted.find(message => message.type === 'persistedConversationsLoaded');
    expect(history?.conversations).toEqual([
      expect.objectContaining({ id: 'default', status: 'current' }),
    ]);
  });
});
