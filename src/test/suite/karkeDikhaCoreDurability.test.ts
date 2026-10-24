import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import * as vscodeMock from '../mocks/vscode';
import { AgentPanel } from '../../ui/AgentPanel';
import { AutonomousTaskRuntime } from '../../activation/M15AutonomousRuntime';
import { DurableTaskQueue, IsolatedWorktreeManager, TaskResourceScheduler, createDefaultAutonomousTask } from '../../autonomous/M15AutonomousWork';
import { ProviderGateway } from '../../providers/ProviderGateway';
import { InferenceProvider, ModelInfo, ProviderChatOptions, ChatMessage, ChatResponse, ToolDefinition } from '../../providers/ProviderTypes';
import * as extensionModule from '../../extension';

interface PostedMessage {
  type: string;
  [key: string]: unknown;
}

class StubCodingProvider implements InferenceProvider {
  readonly providerType = 'ollama' as const;
  completion = JSON.stringify({
    version: 1,
    taskSummary: 'Karke Dikha Core durability acceptance',
    operations: [{ type: 'create', path: 'src/generated/x.ts', reason: 'acceptance', content: 'export const ok = true;\n' }],
    validationCommands: [{ kind: 'npm-script', script: 'verify' }],
    warnings: [],
    status: 'proposed',
  });
  async healthCheck(): Promise<void> {}
  async listModels(): Promise<ModelInfo[]> { return [{ name: 'qwen3-coder:30b', contextWindow: 40960 }]; }
  async chat(messages: ChatMessage[], _tools: ToolDefinition[], _options: ProviderChatOptions): Promise<ChatResponse> {
    // The lightweight tier now runs through the bounded pre-proposal
    // investigation loop, which requests an action envelope rather than a
    // bare CodingProposal; the five-stage graph carries no such marker.
    const prompt = messages.map(message => message.content).join('\n');
    const content = prompt.includes('Investigation turn')
      ? JSON.stringify({ action: 'submit_proposal', proposal: JSON.parse(this.completion) })
      : this.completion;
    return { message: { role: 'assistant', content }, done: true };
  }
}

async function initGit(root: string): Promise<void> {
  const { spawn } = await import('child_process');
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { verify: 'node -e "process.exit(0)"' } }));
  for (const args of [['init'], ['config', 'user.email', 't@example.com'], ['config', 'user.name', 'T'], ['add', '.'], ['commit', '-m', 'init']]) {
    await new Promise<void>((resolve, reject) => {
      const child = spawn('git', args, { cwd: root, shell: false, windowsHide: true });
      child.on('error', reject);
      child.on('close', code => (code === 0 ? resolve() : reject(new Error(`git ${args.join(' ')}`))));
    });
  }
}

function fakeContext(root: string): vscode.ExtensionContext {
  return {
    subscriptions: [],
    extensionUri: vscode.Uri.file(process.cwd()),
    secrets: { get: async () => undefined, store: async () => undefined, delete: async () => undefined, onDidChange: () => ({ dispose: () => undefined }) },
    extension: { packageJSON: { scripts: {}, contributes: { commands: [] } } },
  } as unknown as vscode.ExtensionContext;
}

function attachPanel(root: string, posted: PostedMessage[]): { panel: AgentPanel; receive: (msg: unknown) => void } {
  const context = fakeContext(root);
  const panel = new AgentPanel(context, root);
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

function fakeCoreClient(options: { submitShouldReject?: boolean; submitGate?: Promise<void> } = {}) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  let requestCounter = 0;
  let attemptCounter = 0;
  let approvalCounter = 0;
  let conversationCounter = 0;
  let lastSubmission: Record<string, unknown> = {};
  const conversations: Array<Record<string, unknown>> = [];
  let currentConversationId: string | null = null;
  const ledger = () => ({
    schemaVersion: 1 as const,
    workspaceIdentity: rootIdentity,
    currentConversationId,
    currentCoreConversationId: currentConversationId
      ? String(conversations.find(item => item.localConversationId === currentConversationId)?.conversationId ?? '')
      : null,
    conversations,
    turns: [],
  });
  let rootIdentity = '';
  return {
    calls,
    async getWorkspaceConversationLedger(workspaceIdentity: string) {
      rootIdentity = workspaceIdentity;
      calls.push({ method: 'getWorkspaceConversationLedger', args: [workspaceIdentity] });
      return ledger();
    },
    async createConversation(input: { title?: string | null }) {
      calls.push({ method: 'createConversation', args: [input] });
      conversationCounter += 1;
      return { id: `conv_${conversationCounter}`, title: input.title ?? null };
    },
    async bindWorkspaceConversation(input: {
      workspaceIdentity: string;
      localConversationId: string;
      conversationId: string;
      title?: string | null;
      makeCurrent?: boolean;
    }) {
      calls.push({ method: 'bindWorkspaceConversation', args: [input] });
      rootIdentity = input.workspaceIdentity;
      conversations.push({
        localConversationId: input.localConversationId,
        conversationId: input.conversationId,
        title: input.title ?? null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        archivedAt: null,
      });
      if (input.makeCurrent) currentConversationId = input.localConversationId;
      return ledger();
    },
    async listRecentWorkspaceCapabilityActions() {
      return { actions: [] };
    },
    async submit(...args: unknown[]) {
      calls.push({ method: 'submit', args });
      if (options.submitGate) await options.submitGate;
      if (options.submitShouldReject) throw new Error('Core rejected the submission (simulated)');
      lastSubmission = args[0] as Record<string, unknown>;
      requestCounter += 1;
      attemptCounter += 1;
      return {
        request: { id: `req_${requestCounter}` },
        attempt: { id: `att_${attemptCounter}`, status: 'created' },
        planningOnly: false,
      };
    },
    async claimKarkeDikhaAttempt(attemptId: string, input: { owner: string }) {
      calls.push({ method: 'claimKarkeDikhaAttempt', args: [attemptId, input] });
      return {
        attempt: { id: attemptId, status: 'running' },
        context: {
          id: `ctx_${attemptId}`,
          contextIdentity: `ctx_${attemptId}`,
          requestId: `req_${attemptCounter}`,
          attemptId,
          resolvedMode: 'karke_dikha',
          workspaceRoot: String(lastSubmission.workspaceRoot),
          repositoryId: null,
          repositoryLocationId: null,
          taskInput: String(lastSubmission.currentMessage),
          selectedProvider: String(lastSubmission.requestedProvider),
          selectedModel: String(lastSubmission.requestedModel),
          modelSelection: lastSubmission.modelSelection,
          permittedCapabilities: { hasWorkspace: true, gitCapable: true, allowedTools: [], contextPolicy: {} },
          approvalPolicy: lastSubmission.toolPermissionPolicy ?? {},
          schemaVersion: 1,
          createdAt: new Date().toISOString(),
          contextHash: `hash_${attemptId}`,
        },
        fence: { attemptId, token: `fence_${attemptId}`, generation: 1, owner: input.owner, expiresAt: new Date(Date.now() + 120_000).toISOString() },
      };
    },
    async heartbeatKarkeDikhaAttempt(...args: unknown[]) {
      calls.push({ method: 'heartbeatKarkeDikhaAttempt', args });
      return { id: args[0], status: 'running' };
    },
    async requestKarkeDikhaApproval(attemptId: string, credentials: unknown, input: { kind: string; summary?: Record<string, unknown> }) {
      calls.push({ method: 'requestKarkeDikhaApproval', args: [attemptId, credentials, input] });
      approvalCounter += 1;
      return { attempt: { id: attemptId, status: 'waiting_for_approval' }, approval: {
        id: `appr_${approvalCounter}`,
        attemptId,
        kind: input.kind,
        status: 'pending',
        expectedAttemptRevision: approvalCounter + 2,
        expectedAttemptStatus: 'waiting_for_approval',
        requestedActionDigest: `digest_${approvalCounter}`,
        frozenContextHash: `hash_${attemptId}`,
        revision: 1,
      } };
    },
    async resolveKarkeDikhaApproval(...args: unknown[]) {
      calls.push({ method: 'resolveKarkeDikhaApproval', args });
      return { attempt: { status: 'running' }, approval: args[0] };
    },
    async beginKarkeDikhaValidation(...args: unknown[]) {
      calls.push({ method: 'beginKarkeDikhaValidation', args });
      return { id: args[0], status: 'validating' };
    },
    async reportKarkeDikhaValidation(attemptId: string, credentials: unknown, evidence: unknown) {
      calls.push({ method: 'reportKarkeDikhaValidation', args: [attemptId, credentials, evidence] });
      approvalCounter += 1;
      return { outcome: 'waiting_for_delivery_approval', attempt: { id: attemptId, status: 'waiting_for_approval' }, approval: {
        id: `appr_${approvalCounter}`, attemptId, kind: 'delivery', status: 'pending', expectedAttemptRevision: 10,
        expectedAttemptStatus: 'waiting_for_approval', requestedActionDigest: 'delivery-digest', frozenContextHash: `hash_${attemptId}`, revision: 1,
      } };
    },
    async recordKarkeDikhaExecutionQuality(...args: unknown[]) {
      calls.push({ method: 'recordKarkeDikhaExecutionQuality', args });
      return { id: 'quality_1' };
    },
    async completeKarkeDikhaAttempt(...args: unknown[]) {
      calls.push({ method: 'completeKarkeDikhaAttempt', args });
      return { id: args[0], status: 'completed' };
    },
    async failKarkeDikhaAttempt(...args: unknown[]) {
      calls.push({ method: 'failKarkeDikhaAttempt', args });
      return { id: args[0], status: 'failed' };
    },
    async cancelKarkeDikhaAttempt(...args: unknown[]) {
      calls.push({ method: 'cancelKarkeDikhaAttempt', args });
      return { id: args[0], status: 'cancelled' };
    },
  };
}

describe('Karke Dikha M15 worker under Core lifecycle authority', () => {
  let root: string;
  let provider: StubCodingProvider;
  let queue: DurableTaskQueue;
  let resources: TaskResourceScheduler;
  let worktrees: IsolatedWorktreeManager;
  let runtime: AutonomousTaskRuntime;
  let client: ReturnType<typeof fakeCoreClient>;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-karkedikha-core-'));
    await initGit(root);
    provider = new StubCodingProvider();
    vscodeMock._resetConfig();
    vscodeMock._setConfig('ollama-agent.providerType', 'ollama');
    vscodeMock._setConfig('ollama-agent.codingModel', 'fake-coder');
    vscodeMock._setConfig('ollama-agent.model', 'persisted-model');
    vi.spyOn(ProviderGateway, 'create').mockResolvedValue(provider);
    queue = new DurableTaskQueue(root);
    resources = new TaskResourceScheduler({ maxActiveTasks: 2, maxActiveMutatingTasks: 1, modelConcurrency: { '*': 2 } });
    worktrees = new IsolatedWorktreeManager(root);
    runtime = new AutonomousTaskRuntime(fakeContext(root), root, queue, resources, worktrees);
    client = fakeCoreClient();
    vi.spyOn(extensionModule, 'getCoreManager').mockReturnValue({ getClient: () => client } as unknown as ReturnType<typeof extensionModule.getCoreManager>);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vscodeMock._resetConfig();
    runtime.dispose();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  /**
   * Unlike agentPanelAutonomousMode.test.ts's identically-named helpers (which
   * enqueue a synthetic task bypassing the panel/runtime entirely), these wait
   * for an *already-panel-started* real task to reach the pending-approval
   * state naturally — necessary here because the Core attempt/approval
   * durability wiring only fires through the real `startAutonomousTask`
   * entrypoint, matching production: a task's Core attempt is always created
   * when it starts, never synthesized directly in the queue.
   */
  async function pendingProposalTaskFor(taskId: string) {
    return vi.waitFor(async () => {
      const task = await queue.get(taskId);
      if (task?.state !== 'waiting_for_proposal_approval') throw new Error(`not at proposal gate yet (state=${task?.state})`);
      return task;
    }, { timeout: 20000 });
  }

  async function startedTaskId(panel: AgentPanel, receive: (msg: unknown) => void, posted: PostedMessage[]): Promise<string> {
    panel.attachAutonomous(queue, runtime);
    receive({ type: 'startAutonomousTask', text: 'Implement the acceptance feature.' });
    const started = await vi.waitFor(() => {
      const message = posted.find(m => m.type === 'autonomousTaskStarted');
      if (!message) throw new Error('not started yet');
      return message;
    });
    await vi.waitFor(() => {
      if (!client.calls.some(c => c.method === 'submit')) throw new Error('no Core submission yet');
    });
    return String(started.taskId);
  }

  it('submits and claims one Core attempt before M15 work and reuses that id for the local projection', async () => {
    const posted: PostedMessage[] = [];
    const { panel, receive } = attachPanel(root, posted);
    panel.attachAutonomous(queue, runtime);

    receive({ type: 'startAutonomousTask', text: 'Implement the acceptance feature.' });
    await vi.waitFor(() => {
      if (!posted.some(m => m.type === 'autonomousTaskStarted')) throw new Error('not started yet');
    });
    await vi.waitFor(() => {
      if (!client.calls.some(c => c.method === 'claimKarkeDikhaAttempt')) throw new Error('not yet claimed by Core');
    });

    // Exactly one Core submission for one accepted user submission — this is
    // the single authoritative request+attempt, not a shadow record created
    // independently after the M15 task already started.
    const submitCalls = client.calls.filter(c => c.method === 'submit');
    expect(submitCalls).toHaveLength(1);
    expect((submitCalls[0].args[0] as { requestedMode: string }).requestedMode).toBe('karke_dikha');
    expect(submitCalls[0].args[0]).toMatchObject({
      requestedProvider: 'ollama',
      requestedModel: 'qwen3-coder:30b',
      modelSelection: {
        selectedProvider: 'ollama',
        selectedModel: 'qwen3-coder:30b',
        userOverrode: false,
        requiredCapabilities: { fileModification: true, validationAndRepair: true },
      },
    });
    // No legacy two-round-trip createRequestEnvelope/createAttempt calls remain
    // for this path — submit() replaces them atomically.
    expect(client.calls.some(c => c.method === 'createRequestEnvelope')).toBe(false);
    expect(client.calls.some(c => c.method === 'createAttempt')).toBe(false);
    expect(client.calls.findIndex(c => c.method === 'claimKarkeDikhaAttempt')).toBeGreaterThan(client.calls.findIndex(c => c.method === 'submit'));
    const started = posted.find(m => m.type === 'autonomousTaskStarted')!;
    expect(started.taskId).toBe('att_1');
    expect(started.attemptId).toBe('att_1');
    const projection = await queue.get('att_1');
    expect(projection?.taskId).toBe('att_1');
    expect(projection?.attemptId).toBe('att_1');
  });

  it('a Core submission rejection aborts the Karke Dikha start before the M15 task is ever enqueued', async () => {
    client = fakeCoreClient({ submitShouldReject: true });
    vi.spyOn(extensionModule, 'getCoreManager').mockReturnValue({ getClient: () => client } as unknown as ReturnType<typeof extensionModule.getCoreManager>);
    const enqueueSpy = vi.spyOn(queue, 'enqueue');

    const posted: PostedMessage[] = [];
    const { panel, receive } = attachPanel(root, posted);
    panel.attachAutonomous(queue, runtime);

    receive({ type: 'startAutonomousTask', text: 'Implement the acceptance feature.' });
    await vi.waitFor(() => {
      if (!posted.some(m => m.type === 'error')) throw new Error('no error posted yet');
    });

    expect(posted.some(m => m.type === 'autonomousTaskStarted')).toBe(false);
    expect(enqueueSpy).not.toHaveBeenCalled();
    // Only the (rejected) submit call — no fallback createRequestEnvelope/createAttempt path.
    expect(client.calls.filter(call => call.method === 'submit')).toHaveLength(1);
    expect(client.calls.some(call => call.method === 'claimKarkeDikhaAttempt')).toBe(false);
    // An actual Core-side rejection (client.submit() itself threw) must still
    // use the existing, truthful "Core rejected" wording — this fix must not
    // change behavior for a real Core rejection.
    const errorMessage = posted.find(m => m.type === 'error')!;
    expect(String(errorMessage.message)).toBe('Karke Dikha could not be started: Core rejected the submission.');
  });

  it('a local TaskModelSelectionError (no capable model configured) reports a truthful message and is never reported as a Core rejection', async () => {
    // Force zero capable candidates deterministically: nothing is reported as
    // installed/available, so every role-configured model (agent/coding/
    // fallback/etc., whatever they are named) hard-fails "not available" —
    // no reliability threshold or configured-role logic is touched.
    vi.spyOn(provider, 'listModels').mockResolvedValue([]);

    const posted: PostedMessage[] = [];
    const { panel, receive } = attachPanel(root, posted);
    panel.attachAutonomous(queue, runtime);

    receive({ type: 'startAutonomousTask', text: 'Implement the acceptance feature.' });
    await vi.waitFor(() => {
      if (!posted.some(m => m.type === 'error')) throw new Error('no error posted yet');
    });

    const errorMessage = posted.find(m => m.type === 'error')!;
    // Truthful, not the generic Core-rejection wording.
    expect(String(errorMessage.message)).not.toContain('Core rejected the submission');
    expect(String(errorMessage.message)).toContain("couldn't start because no configured model meets this task's requirements");
    expect(String(errorMessage.message)).toContain('Choose a capable model explicitly or update your KarkeDikha model settings');

    // Core was never contacted at all for this submission.
    expect(client.calls.some(call => call.method === 'submit')).toBe(false);
    expect(client.calls.some(call => call.method === 'claimKarkeDikhaAttempt')).toBe(false);
    expect(posted.some(m => m.type === 'autonomousTaskStarted')).toBe(false);
  });

  it('a second startAutonomousTask message arriving while the first is still submitting to Core does not start a second submission or M15 task', async () => {
    let resolveSubmit: (() => void) | undefined;
    const submitGate = new Promise<void>(resolve => { resolveSubmit = resolve; });
    client = fakeCoreClient({ submitGate });
    vi.spyOn(extensionModule, 'getCoreManager').mockReturnValue({ getClient: () => client } as unknown as ReturnType<typeof extensionModule.getCoreManager>);
    const enqueueSpy = vi.spyOn(queue, 'enqueue');

    const posted: PostedMessage[] = [];
    const { panel, receive } = attachPanel(root, posted);
    panel.attachAutonomous(queue, runtime);

    receive({ type: 'startAutonomousTask', text: 'Implement the acceptance feature.' });
    await vi.waitFor(() => {
      if (!client.calls.some(c => c.method === 'submit')) throw new Error('first submission has not started yet');
    });
    // Duplicate/stale message while the first submission is still in flight.
    receive({ type: 'startAutonomousTask', text: 'Implement the acceptance feature.' });
    await vi.waitFor(() => {
      if (!posted.some(m => m.type === 'error')) throw new Error('no rejection posted for the duplicate yet');
    });

    expect(client.calls.filter(c => c.method === 'submit')).toHaveLength(1);
    expect(enqueueSpy).not.toHaveBeenCalled();

    resolveSubmit?.();
    await vi.waitFor(() => {
      if (!posted.some(m => m.type === 'autonomousTaskStarted')) throw new Error('first submission never completed');
    });
    expect(enqueueSpy).toHaveBeenCalledTimes(1);
  });

  it('a proposal approval creates and resolves a Core "proposal" approval', async () => {
    const posted: PostedMessage[] = [];
    const { panel, receive } = attachPanel(root, posted);
    const taskId = await startedTaskId(panel, receive, posted);
    const pending = await pendingProposalTaskFor(taskId);
    receive({ type: 'webviewReady', mode: 'autonomous' });
    await vi.waitFor(() => {
      if (!posted.some(m => m.type === 'proposalApprovalRequest' && m.taskId === pending.taskId)) throw new Error('no proposal card');
    });
    await vi.waitFor(() => {
      if (!client.calls.some(c => c.method === 'requestKarkeDikhaApproval' && (c.args[2] as { kind: string }).kind === 'proposal')) throw new Error('no Core approval request yet');
    });

    receive({ type: 'approveProposal', taskId: pending.taskId, proposalId: pending.pendingProposal!.proposalId });
    await vi.waitFor(() => {
      if (!client.calls.some(c => c.method === 'resolveKarkeDikhaApproval')) throw new Error('not resolved yet');
    });
    const resolveCall = client.calls.find(c => c.method === 'resolveKarkeDikhaApproval');
    expect((resolveCall?.args[2] as { resolution: string }).resolution).toBe('approved');
  });

  it('fails closed without Core and never enqueues an independently authoritative M15 task', async () => {
    vi.spyOn(extensionModule, 'getCoreManager').mockReturnValue(undefined);
    const posted: PostedMessage[] = [];
    const { panel, receive } = attachPanel(root, posted);
    panel.attachAutonomous(queue, runtime);

    receive({ type: 'startAutonomousTask', text: 'Implement the acceptance feature.' });
    await vi.waitFor(() => {
      if (!posted.some(m => m.type === 'error')) throw new Error('not rejected yet');
    });
    expect(posted.some(m => m.type === 'autonomousTaskStarted')).toBe(false);
    expect(await queue.list()).toHaveLength(0);
    expect(client.calls).toHaveLength(0);
  });

  it('blocks an unbound legacy M15 record instead of executing it as a second lifecycle authority', async () => {
    runtime.requireCoreAuthorityForNewWork();
    const unbound = await queue.enqueue(createDefaultAutonomousTask(root, 'Legacy unbound task'));
    runtime.wake();
    await runtime.waitForIdle();

    const projection = await queue.get(unbound.taskId);
    expect(projection?.state).toBe('blocked');
    expect(projection?.failure?.classification).toBe('core_authority_missing');
    expect(client.calls).toHaveLength(0);
  });
});
