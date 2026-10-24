import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import * as vscodeMock from '../mocks/vscode';
import { AgentPanel } from '../../ui/AgentPanel';
import { OnboardingService } from '../../onboarding/OnboardingService';
import { runOrcaRouterRemoval, runOrcaRouterSetup } from '../../onboarding/OnboardingOrcaRouterSetup';
import {
  ORCAROUTER_SECRET_KEY,
  OrcaRouterService,
  decodeOrcaRouterModel,
  encodeOrcaRouterModel,
  orcaRouterServiceFor,
  type OrcaRouterCoreSink,
} from '../../providers/OrcaRouter';
import { Config } from '../../config/Config';
import type { RuntimeEventRecord, RuntimeTokenFrame } from '../../../core/shared/wireTypes';

/**
 * Manual OrcaRouter cloud selection, from Setup to the Core submission, against a mock OpenAI-compatible endpoint.
 * The local Ollama provider is a spy: a manual cloud pick must never consult it for selection. Execution against the
 * Core backend (exact URL, Authorization header, exact model, no local call) is proven in core/test/orcaRouterCloud.test.ts.
 */
const dependencyMocks = vi.hoisted(() => ({
  getCoreManager: vi.fn(),
  createProvider: vi.fn(),
}));

vi.mock('../../extension', () => ({
  getCoreManager: dependencyMocks.getCoreManager,
}));

vi.mock('../../providers/ProviderGateway', () => ({
  ProviderGateway: {
    create: dependencyMocks.createProvider,
    resolveCloudFallback: async () => ({ available: false, reason: 'policy_local_only' }),
  },
}));

const ORCA_BASE = 'https://api.orcarouter.ai/v1';
const API_KEY = 'sk-orca-UAT-SECRET-9876'; // gitleaks:allow

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

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await flush();
  }
}

function secretStorage(): vscode.SecretStorage & { raw: Map<string, string> } {
  const raw = new Map<string, string>();
  return {
    raw,
    get: async (key: string) => raw.get(key),
    store: async (key: string, value: string) => { raw.set(key, value); },
    delete: async (key: string) => { raw.delete(key); },
    onDidChange: () => ({ dispose: () => undefined }),
  } as unknown as vscode.SecretStorage & { raw: Map<string, string> };
}

function contextWith(secrets: vscode.SecretStorage): vscode.ExtensionContext {
  return {
    subscriptions: [],
    extensionUri: vscode.Uri.file(process.cwd()),
    secrets,
    extension: { packageJSON: { scripts: {}, contributes: { commands: [] } } },
  } as unknown as vscode.ExtensionContext;
}

function attachPanelWith(context: vscode.ExtensionContext, root: string, posted: PostedMessage[]): { panel: AgentPanel; receive: (msg: unknown) => void } {
  const panel = new AgentPanel(context, root, true);
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

/** A mock OrcaRouter: OpenAI-compatible /models, bearer-authenticated. Counts every request. */
function mockOrcaRouterEndpoint(models: string[], validKey = API_KEY) {
  const requests: Array<{ url: string; authorization: string | undefined }> = [];
  const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const authorization = (init?.headers as Record<string, string> | undefined)?.Authorization;
    requests.push({ url, authorization });
    if (!url.startsWith(ORCA_BASE)) return new Response('unexpected host', { status: 500 });
    if (authorization !== `Bearer ${validKey}`) return new Response('{"error":"invalid key"}', { status: 401 });
    if (url.endsWith('/models')) return new Response(JSON.stringify({ data: models.map(id => ({ id })) }), { status: 200 });
    return new Response('not found', { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { requests, fetchMock };
}

function fakeSink() {
  const delivered: Array<{ baseUrl: string; apiKey: string }> = [];
  let cleared = 0;
  const sink: OrcaRouterCoreSink = {
    setOrcaRouterCredential: async (baseUrl, apiKey) => { delivered.push({ baseUrl, apiKey }); return { configured: true }; },
    clearOrcaRouterCredential: async () => { cleared += 1; return { configured: false }; },
  };
  return { sink, delivered, cleared: () => cleared };
}

function scriptInputs(...values: Array<string | undefined>) {
  const queue = [...values];
  return vi.spyOn(vscodeMock.window, 'showInputBox').mockImplementation(() => Promise.resolve(queue.shift()) as never);
}

function localOllama() {
  const listCallers: string[] = [];
  const provider = {
    listModels: vi.fn(async () => { listCallers.push(new Error().stack ?? ''); return [{ name: 'qwen3-coder:30b', modifiedAt: '2026-01-01T00:00:00.000Z', contextWindow: 32_768 }]; }),
    healthCheck: vi.fn(async () => undefined),
    getModelContextMetadata: vi.fn(async () => undefined),
    listResidentModels: vi.fn(async () => undefined),
    chat: vi.fn(async () => { throw new Error('local chat must not be used'); }),
    listCallers,
  };
  dependencyMocks.createProvider.mockResolvedValue(provider);
  return provider;
}

function submitBody(client: ReturnType<typeof fakeCoreClient>) {
  return client.calls.find(call => call.method === 'submit')!.args[0] as {
    requestedProvider: string;
    requestedModel: string;
    modelSelection: { selectedProvider: string; selectedModel: string; userOverrode: boolean; routingPolicy?: string };
  };
}

describe('OrcaRouter manual cloud models: Setup → picker → exact selection', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-orca-'));
    dependencyMocks.getCoreManager.mockReset();
    dependencyMocks.createProvider.mockReset();
    vscodeMock._resetConfig();
    // Predates the free-only spend policy and uses unclassified models, so this suite opts in to paid cloud.
    vscodeMock._setConfig('ollama-agent.cloudSpendMode', 'UNRESTRICTED');
    vscodeMock._setConfig('ollama-agent.providerType', 'ollama');
    vscodeMock._setConfig('ollama-agent.model', '');
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('encodes the provider into the picker value and decodes only exact OrcaRouter values', () => {
    expect(encodeOrcaRouterModel('acme/model-x')).toBe('orcarouter::acme/model-x');
    expect(decodeOrcaRouterModel('orcarouter::acme/model-x')).toBe('acme/model-x');
    // A local Ollama model that merely contains "orcarouter" is never mistaken for a cloud pick.
    expect(decodeOrcaRouterModel('orcarouter/Qwen3.8-27B-Uncensored:Q4_K_M')).toBeUndefined();
    expect(decodeOrcaRouterModel('qwen3-coder:30b')).toBeUndefined();
    expect(decodeOrcaRouterModel('orcarouter::')).toBeUndefined();
    expect(decodeOrcaRouterModel(undefined)).toBeUndefined();
  });

  it('CREDENTIAL PERSISTENCE + ACTIVATION + IMMEDIATE REFRESH: setup stores the key as a secret, activates the provider and delivers it to Core without a restart', async () => {
    const endpoint = mockOrcaRouterEndpoint(['acme/model-x', 'acme/model-y']);
    const secrets = secretStorage();
    const context = contextWith(secrets);
    const service = orcaRouterServiceFor(secrets);
    expect(await service.resolveConfig()).toBeUndefined();

    const posted: PostedMessage[] = [];
    localOllama();
    dependencyMocks.getCoreManager.mockReturnValue(fakeCoreManager(fakeCoreClient()));
    const { receive } = attachPanelWith(context, root, posted);
    receive({ type: 'getModels' });
    await waitFor(() => posted.some(m => m.type === 'modelsLoaded'), 'initial modelsLoaded');
    const before = posted.filter(m => m.type === 'modelsLoaded').at(-1) as { models: Array<{ name: string }> };
    expect(before.models.map(m => m.name)).toEqual(['qwen3-coder:30b']);

    const core = fakeSink();
    scriptInputs(ORCA_BASE, API_KEY);
    expect(await runOrcaRouterSetup(context, { getCore: () => core.sink })).toBe(true);

    // Secret in SecretStorage only; the non-secret base URL in settings; the key nowhere else.
    expect(secrets.raw.get(ORCAROUTER_SECRET_KEY)).toBe(API_KEY);
    expect(Config.getOrcaRouterApiBase()).toBe(ORCA_BASE);
    expect(vscodeMock._lastInformationMessage()).not.toContain(API_KEY);
    expect(JSON.stringify(posted)).not.toContain(API_KEY);

    // Provider is configured/available immediately, and Core got the credential — no restart.
    expect(await service.resolveConfig()).toMatchObject({ apiBase: ORCA_BASE, apiKey: API_KEY, source: 'orcarouter' });
    expect(core.delivered).toEqual([{ baseUrl: ORCA_BASE, apiKey: API_KEY }]);

    // The picker refreshed on its own and now offers the cloud models next to the local one.
    await waitFor(() => (posted.filter(m => m.type === 'modelsLoaded').at(-1) as { models: unknown[] }).models.length === 3, 'refreshed modelsLoaded');
    const after = posted.filter(m => m.type === 'modelsLoaded').at(-1) as { models: Array<{ name: string; label?: string; provider?: string; cloud?: boolean }> };
    expect(after.models).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'qwen3-coder:30b' }),
      expect.objectContaining({ name: 'orcarouter::acme/model-x', label: 'acme/model-x — OrcaRouter (cloud)', provider: 'orcarouter', cloud: true, freeness: 'unknown' }),
      expect.objectContaining({ name: 'orcarouter::acme/model-y', label: 'acme/model-y — OrcaRouter (cloud)', provider: 'orcarouter', cloud: true, freeness: 'unknown' }),
    ]));
    expect(endpoint.requests.every(r => r.authorization === `Bearer ${API_KEY}`)).toBe(true);
  });

  it('MANUAL EXACT SELECTION: picking an OrcaRouter model submits exactly that provider and model, never consulting or falling back to Ollama', async () => {
    mockOrcaRouterEndpoint(['acme/model-x', 'acme/model-y']);
    const secrets = secretStorage();
    secrets.raw.set(ORCAROUTER_SECRET_KEY, API_KEY);
    vscodeMock._setConfig('ollama-agent.orcaRouterApiBase', ORCA_BASE);
    const ollama = localOllama();
    const client = fakeCoreClient();
    dependencyMocks.getCoreManager.mockReturnValue(fakeCoreManager(client));
    const posted: PostedMessage[] = [];
    const { receive } = attachPanelWith(contextWith(secrets), root, posted);

    receive({ type: 'sendMessage', mode: 'chat', text: 'Say hello in one word.', conversationId: 'orca-1', model: 'orcarouter::acme/model-y' });
    await waitFor(() => client.calls.some(call => call.method === 'submit'), 'Core submit');

    const body = submitBody(client);
    expect(body.requestedProvider).toBe('orcarouter');
    expect(body.requestedModel).toBe('acme/model-y');
    expect(body.modelSelection).toMatchObject({ selectedProvider: 'orcarouter', selectedModel: 'acme/model-y', userOverrode: true, routingPolicy: 'explicit-orcarouter' });
    expect(JSON.stringify(body)).not.toContain(API_KEY);
    const suitability = posted.find(m => m.type === 'modelSuitability') as { details: { selectedProvider: string; selectedModel: string; userOverrode: boolean } };
    expect(suitability.details).toMatchObject({ selectedProvider: 'orcarouter', selectedModel: 'acme/model-y', userOverrode: true });

    // Selection never consulted the local provider for this turn.
    // The only local listing is the picker's own hydration (loadModels); the selection path never asked Ollama anything.
    expect(ollama.listCallers.every(stack => stack.includes('loadModels'))).toBe(true);
    expect(ollama.chat).not.toHaveBeenCalled();
  });

  it('refuses a manual pick that OrcaRouter no longer lists instead of substituting another model', async () => {
    mockOrcaRouterEndpoint(['acme/model-x']);
    const secrets = secretStorage();
    secrets.raw.set(ORCAROUTER_SECRET_KEY, API_KEY);
    vscodeMock._setConfig('ollama-agent.orcaRouterApiBase', ORCA_BASE);
    localOllama();
    const client = fakeCoreClient();
    dependencyMocks.getCoreManager.mockReturnValue(fakeCoreManager(client));
    const posted: PostedMessage[] = [];
    const { receive } = attachPanelWith(contextWith(secrets), root, posted);

    receive({ type: 'sendMessage', mode: 'chat', text: 'Say hello.', conversationId: 'orca-gone', model: 'orcarouter::acme/removed' });
    await waitFor(() => posted.some(m => m.type === 'error'), 'visible error');
    expect(client.calls.some(call => call.method === 'submit')).toBe(false);
    expect(JSON.stringify(posted.filter(m => m.type === 'error'))).toMatch(/does not list \\?"acme\/removed\\?"/);
  });

  it('RELOAD: a fresh service and panel over the same SecretStorage still offer and select the cloud model; the secret stays secret', async () => {
    mockOrcaRouterEndpoint(['acme/model-x']);
    const secrets = secretStorage();
    const first = contextWith(secrets);
    scriptInputs(ORCA_BASE, API_KEY);
    expect(await runOrcaRouterSetup(first, { getCore: () => undefined })).toBe(true);

    // "Reload": nothing in memory survives; only SecretStorage and settings do.
    const reloaded = new OrcaRouterService(secrets);
    expect(await reloaded.resolveConfig()).toMatchObject({ apiBase: ORCA_BASE, apiKey: API_KEY });
    expect(await reloaded.listModels({ force: true })).toMatchObject({ ok: true });

    localOllama();
    const client = fakeCoreClient();
    dependencyMocks.getCoreManager.mockReturnValue(fakeCoreManager(client));
    const posted: PostedMessage[] = [];
    const { receive } = attachPanelWith(contextWith(secrets), root, posted);
    receive({ type: 'getModels' });
    await waitFor(() => posted.some(m => m.type === 'modelsLoaded'), 'modelsLoaded after reload');
    const loaded = posted.filter(m => m.type === 'modelsLoaded').at(-1) as { models: Array<{ name: string }> };
    expect(loaded.models.map(m => m.name)).toContain('orcarouter::acme/model-x');
    expect(JSON.stringify(posted)).not.toContain(API_KEY);

    receive({ type: 'sendMessage', mode: 'chat', text: 'Say hello.', conversationId: 'orca-reload', model: 'orcarouter::acme/model-x' });
    await waitFor(() => client.calls.some(call => call.method === 'submit'), 'Core submit after reload');
    expect(submitBody(client).modelSelection).toMatchObject({ selectedProvider: 'orcarouter', selectedModel: 'acme/model-x' });
  });

  it('BAD CONFIG: a rejected key fails visibly, stores nothing, and OrcaRouter is not marked ready', async () => {
    mockOrcaRouterEndpoint(['acme/model-x']);
    const secrets = secretStorage();
    const context = contextWith(secrets);
    const core = fakeSink();
    scriptInputs(ORCA_BASE, 'sk-wrong-key-0000');

    expect(await runOrcaRouterSetup(context, { getCore: () => core.sink })).toBe(false);
    expect(vscodeMock._lastErrorMessage()).toMatch(/Nothing was saved/);
    expect(vscodeMock._lastErrorMessage()).not.toContain('sk-wrong-key-0000');
    expect(secrets.raw.size).toBe(0);
    expect(core.delivered).toEqual([]);
    expect(await orcaRouterServiceFor(secrets).resolveConfig()).toBeUndefined();

    // Setup reflects reality: not configured.
    localOllama();
    const readiness = await new OnboardingService(secrets).assess();
    expect(readiness.orcaRouter).toMatchObject({ configured: false });
  });

  it('BAD CONFIG: malformed URLs and empty keys are refused before any network call, and a key echoed in an error is redacted', async () => {
    const endpoint = mockOrcaRouterEndpoint(['acme/model-x']);
    const secrets = secretStorage();
    const service = new OrcaRouterService(secrets);
    expect(await service.connect({ apiBase: 'ftp://nope', apiKey: API_KEY })).toMatchObject({ ok: false });
    expect(await service.connect({ apiBase: ORCA_BASE, apiKey: '   ' })).toMatchObject({ ok: false });
    expect(endpoint.fetchMock).not.toHaveBeenCalled();

    const leaky = new OrcaRouterService(secrets, () => ({ listModels: async () => { throw new Error(`upstream said key ${API_KEY} is bad`); } }));
    const result = await leaky.connect({ apiBase: ORCA_BASE, apiKey: API_KEY });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(API_KEY);
    expect(secrets.raw.size).toBe(0);
  });

  it('SETUP READINESS: configured state is read from storage only and opening Setup never contacts OrcaRouter', async () => {
    const endpoint = mockOrcaRouterEndpoint(['acme/model-x']);
    const secrets = secretStorage();
    secrets.raw.set(ORCAROUTER_SECRET_KEY, API_KEY);
    vscodeMock._setConfig('ollama-agent.orcaRouterApiBase', ORCA_BASE);
    localOllama();
    const readiness = await new OnboardingService(secrets).assess();
    expect(readiness.orcaRouter).toMatchObject({ configured: true, apiBase: 'https://api.orcarouter.ai/v1' });
    expect(JSON.stringify(readiness)).not.toContain(API_KEY);
    expect(endpoint.fetchMock).not.toHaveBeenCalled();
  });

  it('LEGACY: credentials the old Setup saved as the cloud fallback pair are picked up when they point at OrcaRouter, and only then', async () => {
    const secrets = secretStorage();
    secrets.raw.set('ollama-agent.cloudFallbackApiKey', API_KEY);
    vscodeMock._setConfig('ollama-agent.cloudFallbackApiBase', ORCA_BASE);
    expect(await new OrcaRouterService(secrets).resolveConfig()).toMatchObject({ apiBase: ORCA_BASE, apiKey: API_KEY, source: 'legacy-cloud-fallback' });

    vscodeMock._setConfig('ollama-agent.cloudFallbackApiBase', 'https://api.example.com/v1');
    expect(await new OrcaRouterService(secrets).resolveConfig()).toBeUndefined();
  });

  it('REMOVAL: clears the secret and the Core copy, and the cloud models leave the picker', async () => {
    mockOrcaRouterEndpoint(['acme/model-x']);
    const secrets = secretStorage();
    const context = contextWith(secrets);
    const core = fakeSink();
    scriptInputs(ORCA_BASE, API_KEY);
    await runOrcaRouterSetup(context, { getCore: () => core.sink });
    await runOrcaRouterRemoval(context, { getCore: () => core.sink });
    expect(secrets.raw.has(ORCAROUTER_SECRET_KEY)).toBe(false);
    expect(core.cleared()).toBe(1);
    expect(await orcaRouterServiceFor(secrets).listModels()).toMatchObject({ ok: false, kind: 'not_configured' });
  });
});
