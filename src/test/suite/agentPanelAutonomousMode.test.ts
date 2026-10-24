import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import * as vscodeMock from '../mocks/vscode';
import { AgentPanel } from '../../ui/AgentPanel';
import { AutonomousTaskRuntime } from '../../activation/M15AutonomousRuntime';
import {
  DurableTaskQueue,
  IsolatedWorktreeManager,
  MAX_AUTONOMOUS_TASK_INPUT_BYTES,
  TaskResourceScheduler,
  createDefaultAutonomousTask,
} from '../../autonomous/M15AutonomousWork';
import { ProviderGateway } from '../../providers/ProviderGateway';
import { InferenceProvider, ModelInfo, ProviderChatOptions, ChatMessage, ChatResponse, ToolDefinition } from '../../providers/ProviderTypes';
import * as extensionModule from '../../extension';
import type { ModelSelectionEvidence } from '../../../core/shared/wireTypes';

interface PostedMessage {
  type: string;
  [key: string]: unknown;
}

class StubCodingProvider implements InferenceProvider {
  readonly providerType = 'ollama' as const;
  completion = JSON.stringify({
    version: 1,
    taskSummary: 'Autonomous chat-mode acceptance',
    operations: [{ type: 'create', path: 'src/generated/chatMode.ts', reason: 'acceptance', content: 'export const ok = true;\n' }],
    validationCommands: [{ kind: 'npm-script', script: 'verify' }],
    warnings: [],
    status: 'proposed',
  });
  async healthCheck(): Promise<void> {}
  async listModels(): Promise<ModelInfo[]> { return [{ name: 'qwen3-coder:30b', contextWindow: 40960 }]; }
  async chat(_messages: ChatMessage[], _tools: ToolDefinition[], _options: ProviderChatOptions): Promise<ChatResponse> {
    return { message: { role: 'assistant', content: this.completion }, done: true };
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

function attachPanel(root: string, posted: PostedMessage[], visible = true): { panel: AgentPanel; receive: (msg: unknown) => void; dispose: () => void } {
  const context = fakeContext(root);
  const panel = new AgentPanel(context, root);
  let receive: (msg: unknown) => void = () => undefined;
  let disposeHandler: () => void = () => undefined;
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
    onDidDispose: (cb: () => void) => { disposeHandler = cb; return { dispose: () => undefined }; },
    visible,
  } as unknown as vscode.WebviewView;
  panel.resolveWebviewView(webviewView, {} as vscode.WebviewViewResolveContext, {} as vscode.CancellationToken);
  return { panel, receive: (msg: unknown) => receive(msg), dispose: () => disposeHandler() };
}

function coreOwnerClient(root: string) {
  let approvalCounter = 0;
  let goal = '';
  const submissions: Array<Record<string, unknown>> = [];
  let workspaceIdentity = '';
  let currentConversationId: string | null = null;
  let currentCoreConversationId: string | null = null;
  const conversations: Array<Record<string, unknown>> = [];
  const ledger = () => ({
    schemaVersion: 1,
    workspaceIdentity,
    currentConversationId,
    currentCoreConversationId,
    conversations,
    turns: [],
    migrationMetadata: {},
  });
  return {
    submissions,
    async getWorkspaceConversationLedger(identity: string) {
      workspaceIdentity = identity;
      return ledger();
    },
    async createConversation(input: { title?: string | null }) {
      return { id: 'conv_test', title: input.title ?? null };
    },
    async bindWorkspaceConversation(input: {
      workspaceIdentity: string;
      localConversationId: string;
      conversationId: string;
      title?: string | null;
    }) {
      workspaceIdentity = input.workspaceIdentity;
      currentConversationId = input.localConversationId;
      currentCoreConversationId = input.conversationId;
      if (conversations.length === 0) {
        const now = new Date().toISOString();
        conversations.push({
          ...input,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          schemaVersion: 1,
          migrationMetadata: {},
        });
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
      return { attempt: { id: 'att_test', status: 'waiting_for_approval' }, approval: {
        id: `appr_${approvalCounter}`, attemptId: 'att_test', kind: input.kind, status: 'pending',
        expectedAttemptRevision: approvalCounter + 2, expectedAttemptStatus: 'waiting_for_approval',
        requestedActionDigest: `digest_${approvalCounter}`, frozenContextHash: 'ctx_hash', revision: 1,
      } };
    },
    async resolveKarkeDikhaApproval(approval: unknown) { return { attempt: { id: 'att_test', status: 'running' }, approval }; },
    async beginKarkeDikhaValidation() { return { id: 'att_test', status: 'validating' }; },
    async reportKarkeDikhaValidation() {
      approvalCounter += 1;
      return { outcome: 'waiting_for_delivery_approval', attempt: { id: 'att_test', status: 'waiting_for_approval' }, approval: {
        id: `appr_${approvalCounter}`, attemptId: 'att_test', kind: 'delivery', status: 'pending', expectedAttemptRevision: 10,
        expectedAttemptStatus: 'waiting_for_approval', requestedActionDigest: 'delivery', frozenContextHash: 'ctx_hash', revision: 1,
      } };
    },
    async completeKarkeDikhaAttempt() { return { id: 'att_test', status: 'completed' }; },
    async failKarkeDikhaAttempt() { return { id: 'att_test', status: 'failed' }; },
    async cancelKarkeDikhaAttempt() { return { id: 'att_test', status: 'cancelled' }; },
  };
}

describe('Agent Chat Autonomous mode', () => {
  let root: string;
  let provider: StubCodingProvider;
  let queue: DurableTaskQueue;
  let resources: TaskResourceScheduler;
  let worktrees: IsolatedWorktreeManager;
  let runtime: AutonomousTaskRuntime;
  let coreClient: ReturnType<typeof coreOwnerClient>;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-chat-autonomous-'));
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
    coreClient = coreOwnerClient(root);
    vi.spyOn(extensionModule, 'getCoreManager').mockReturnValue({ getClient: () => coreClient } as unknown as ReturnType<typeof extensionModule.getCoreManager>);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vscodeMock._resetConfig();
    runtime.dispose();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('conversation identity: a running task from conversation A is never projected into or steerable from conversation B (New Chat, then reload)', async () => {
    const posted: PostedMessage[] = [];
    const { panel, receive } = attachPanel(root, posted);
    panel.attachAutonomous(queue, runtime);
    // Core's durable chain: attempt -> request -> conversation.
    let nextConversation = 'conv_A';
    const core = coreClient as unknown as Record<string, unknown>;
    core.createConversation = async (input: { title?: string | null }) => ({ id: nextConversation, title: input.title ?? null });
    core.getAttempt = async (id: string) => ({ id, requestId: 'req_test' });
    core.getRequest = async () => ({ id: 'req_test', conversationId: 'conv_A' });

    receive({ type: 'startAutonomousTask', text: 'Implement the acceptance feature.' });
    const started = await vi.waitFor(() => {
      const message = posted.find(m => m.type === 'autonomousTaskStarted');
      if (!message) throw new Error('not started yet');
      return message;
    });
    const priv = panel as unknown as {
      autonomousActiveTaskId?: string;
      reconnectAutonomousTask(): Promise<void>;
      routeExplicitSteering(taskId: string, message: string, messageId?: string): Promise<void>;
    };
    expect(priv.autonomousActiveTaskId).toBe(started.taskId);
    // Only a restorable (visibly running / awaiting approval) task can be wrongly
    // re-projected, so wait for one: otherwise the reload assertion is vacuous.
    await vi.waitFor(async () => {
      const state = (await queue.get(String(started.taskId)))?.state ?? '';
      if (!['waiting_for_proposal_approval', 'waiting_for_mutation_approval', 'running', 'validating', 'waiting_for_delivery_approval'].includes(state)) throw new Error('not restorable yet: ' + state);
    }, { timeout: 15000 });

    // A -> New Chat (B). The background task keeps running in the queue.
    nextConversation = 'conv_B';
    receive({ type: 'newConversation' });
    await vi.waitFor(() => {
      if (!posted.some(m => m.type === 'newConversation' && m.reset === true)) throw new Error('New Chat not confirmed');
    });
    expect(priv.autonomousActiveTaskId).toBeUndefined();
    const task = await queue.get(String(started.taskId));
    expect(task && task.state).not.toMatch(/completed|failed|cancelled/);

    // Webview reload / host rehydration: the old task must not re-project.
    const before = posted.length;
    await priv.reconnectAutonomousTask();
    expect(posted.slice(before).some(m => m.type === 'autonomousTaskActive')).toBe(false);
    expect(priv.autonomousActiveTaskId).toBeUndefined();

    // A steer aimed at task A cannot execute while B is current.
    const steerSpy = vi.spyOn(runtime, 'sendSteering');
    await priv.routeExplicitSteering(String(started.taskId), 'change it', 'steer-A');
    expect(steerSpy).not.toHaveBeenCalled();
    expect(posted.some(m => m.type === 'authorizationDenied')).toBe(true);
  });

  it('conversation identity: activation-time Core rehydration recovers a foreign task but never projects it into the current chat', async () => {
    const posted: PostedMessage[] = [];
    const { panel } = attachPanel(root, posted);
    panel.attachAutonomous(queue, runtime);
    let current = 'conv_B';
    const core = coreClient as unknown as Record<string, unknown>;
    core.getWorkspaceConversationLedger = async () => ({ schemaVersion: 1, workspaceIdentity: 'x', currentConversationId: 'local_B', currentCoreConversationId: current, conversations: [], turns: [], migrationMetadata: {} });
    const task = await queue.enqueue(createDefaultAutonomousTask(root, 'background export task'));
    const record = (conversationId: string) => ({
      attempt: { id: task.taskId, status: 'running', kind: 'karke_dikha' },
      request: { id: 'req_x', conversationId },
      context: { contextHash: 'h' }, approvals: [], events: [], recovery: 'safely_resumable',
    });
    const rehydrate = (panel as unknown as { rehydrateKarkeDikhaAttempt(client: unknown, record: unknown): Promise<void> }).rehydrateKarkeDikhaAttempt.bind(panel);

    // Task owned by conversation A while conversation B is current.
    await rehydrate(coreClient, record('conv_A'));
    expect((panel as unknown as { autonomousActiveTaskId?: string }).autonomousActiveTaskId).toBeUndefined();
    expect((panel as unknown as { projectedAutonomousTaskId?: string }).projectedAutonomousTaskId).toBeUndefined();

    // Same task owned by the CURRENT conversation is projected (control).
    await rehydrate(coreClient, record('conv_B'));
    expect((panel as unknown as { autonomousActiveTaskId?: string }).autonomousActiveTaskId).toBe(task.taskId);
    expect((panel as unknown as { projectedAutonomousTaskId?: string }).projectedAutonomousTaskId).toBe(task.taskId);
  });

  it('starting a task calls the existing M15 queue/runtime exactly once and creates no second runtime', async () => {
    const posted: PostedMessage[] = [];
    const { panel, receive } = attachPanel(root, posted);
    const wakeSpy = vi.spyOn(runtime, 'wake');
    panel.attachAutonomous(queue, runtime);

    receive({ type: 'startAutonomousTask', text: 'Implement the acceptance feature.', submissionId: 'submission-visible-ui' });
    await vi.waitFor(() => {
      if (!posted.some(m => m.type === 'autonomousTaskStarted')) throw new Error('not started yet');
    });

    expect(wakeSpy).toHaveBeenCalledTimes(1);
    const tasks = await queue.list();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].goal).toBe('Implement the acceptance feature.');
    expect(posted.find(m => m.type === 'autonomousTaskStarted')).toMatchObject({
      taskId: tasks[0].taskId,
      attemptId: tasks[0].attemptId,
      submissionId: 'submission-visible-ui',
      state: 'queued',
      goal: 'Implement the acceptance feature.',
    });
  });

  it('freezes the trivial exact-content route as host/deterministic without selecting the 30B escalation candidate', async () => {
    const posted: PostedMessage[] = [];
    const { panel, receive } = attachPanel(root, posted);
    panel.attachAutonomous(queue, runtime);

    receive({ type: 'startAutonomousTask', text: 'create note.txt containing Hello' });
    await vi.waitFor(() => {
      if (coreClient.submissions.length !== 1) throw new Error('Core submission not recorded yet');
    });

    expect(coreClient.submissions[0]).toMatchObject({
      requestedProvider: 'host',
      requestedModel: 'deterministic',
      modelSelection: {
        selectedProvider: 'host',
        selectedModel: 'deterministic',
        userOverrode: false,
      },
    });
    const evidence = coreClient.submissions[0].modelSelection as ModelSelectionEvidence;
    expect(evidence.escalationCandidates.some(candidate => candidate.model === 'qwen3-coder:30b')).toBe(true);
    expect(posted.find(message => message.type === 'modelSuitability')).toMatchObject({
      details: { selectedProvider: 'host', selectedModel: 'deterministic' },
    });
  });

  it('rejects oversized input with an actionable message and creates no task', async () => {
    const posted: PostedMessage[] = [];
    const { panel, receive } = attachPanel(root, posted);
    panel.attachAutonomous(queue, runtime);

    const oversized = 'x'.repeat(MAX_AUTONOMOUS_TASK_INPUT_BYTES + 1);
    receive({ type: 'startAutonomousTask', text: oversized });
    await vi.waitFor(() => {
      if (!posted.some(m => m.type === 'autonomousTaskRejected')) throw new Error('not rejected yet');
    });

    const rejection = posted.find(m => m.type === 'autonomousTaskRejected')!;
    expect(rejection.limitBytes).toBe(MAX_AUTONOMOUS_TASK_INPUT_BYTES);
    expect(Number(rejection.utf8ByteCount)).toBeGreaterThan(MAX_AUTONOMOUS_TASK_INPUT_BYTES);
    expect(await queue.list()).toEqual([]);
  });

  it('validates incoming startAutonomousTask messages and rejects non-string/empty text without touching the queue', async () => {
    const posted: PostedMessage[] = [];
    const { panel, receive } = attachPanel(root, posted);
    panel.attachAutonomous(queue, runtime);

    receive({ type: 'startAutonomousTask', text: 42 });
    receive({ type: 'startAutonomousTask', text: '   ' });
    receive({ type: 'startAutonomousTask' });

    expect(await queue.list()).toEqual([]);
    expect(posted.some(m => m.type === 'autonomousTaskStarted')).toBe(false);
  });

  it('progress events update the timeline via autonomousTaskStatus posts', async () => {
    const posted: PostedMessage[] = [];
    const { panel, receive } = attachPanel(root, posted);
    panel.attachAutonomous(queue, runtime);

    receive({ type: 'startAutonomousTask', text: 'Implement the acceptance feature.' });
    const started = await vi.waitFor(() => {
      const message = posted.find(m => m.type === 'autonomousTaskStarted');
      if (!message) throw new Error('not started yet');
      return message;
    });

    await vi.waitFor(() => {
      const statuses = posted.filter(m => m.type === 'autonomousTaskStatus' && m.taskId === started.taskId);
      if (statuses.length === 0) throw new Error('no status posted yet');
    }, { timeout: 15000 });
  });

  it('does not select the original checkout as the mutation workspace', async () => {
    const posted: PostedMessage[] = [];
    const { panel, receive } = attachPanel(root, posted);
    panel.attachAutonomous(queue, runtime);

    receive({ type: 'startAutonomousTask', text: 'Implement the acceptance feature.' });
    const started = await vi.waitFor(() => {
      const message = posted.find(m => m.type === 'autonomousTaskStarted');
      if (!message) throw new Error('not started yet');
      return message;
    }, { timeout: 15000 });

    await vi.waitFor(async () => {
      const task = await queue.get(String(started.taskId));
      if (!task?.worktreeLocation) throw new Error('worktree not bound yet');
    }, { timeout: 15000 });

    const task = await queue.get(String(started.taskId));
    expect(task?.worktreeLocation).toBeTruthy();
    expect(task?.worktreeLocation).not.toBe(root);
  });

  it('does not cancel the task merely because the panel closes', async () => {
    const posted: PostedMessage[] = [];
    const { panel, receive, dispose } = attachPanel(root, posted);
    panel.attachAutonomous(queue, runtime);

    receive({ type: 'startAutonomousTask', text: 'Implement the acceptance feature.' });
    const started = await vi.waitFor(() => {
      const message = posted.find(m => m.type === 'autonomousTaskStarted');
      if (!message) throw new Error('not started yet');
      return message;
    });

    dispose();

    const task = await queue.get(String(started.taskId));
    expect(task?.state).not.toBe('cancelled');
  });

  it('routes Karke Dikha cancellation to the M15/Core projection instead of the legacy runtime', async () => {
    const task = await queue.enqueue(createDefaultAutonomousTask(root, 'cancel the autonomous projection'));
    const posted: PostedMessage[] = [];
    const { panel, receive } = attachPanel(root, posted);
    panel.attachAutonomous(queue, runtime);
    const cancelSpy = vi.spyOn(runtime, 'cancelTask');

    receive({ type: 'cancelTask', taskId: task.taskId });
    await vi.waitFor(() => expect(cancelSpy).toHaveBeenCalledWith(task.taskId));
    expect((await queue.get(task.taskId))?.state).toBe('cancelled');
    expect(posted.some(message => message.type === 'taskCancelled' && message.taskId === task.taskId)).toBe(true);
  });

  it('the real visible-composer host message durably stores the trivial profile and deterministic proposal', async () => {
    const posted: PostedMessage[] = [];
    const { panel, receive } = attachPanel(root, posted);
    vi.spyOn(runtime, 'wake').mockImplementation(() => undefined);
    panel.attachAutonomous(queue, runtime);

    receive({ type: 'startAutonomousTask', text: 'create note.txt containing Hello', submissionId: 'visible-trivial' });
    await vi.waitFor(() => {
      if (!posted.some(m => m.type === 'autonomousTaskStarted')) throw new Error('not started yet');
    });

    const [task] = await queue.list();
    expect(task.goal).toBe('create note.txt containing Hello');
    expect(task.executionProfile).toMatchObject({
      tier: 'trivial',
      maxStages: 0,
      useDeterministicProposal: true,
      deterministicExtraction: { status: 'available', reason: 'accepted' },
    });
    expect(task.deterministicProposal).toEqual({ path: 'note.txt', content: 'Hello' });
    expect(task.providerModelRoutingSnapshot.model).not.toBe('qwen3-coder:30b');
  });

  it('acknowledges autonomous steering only after the durable task-bound receipt exists', async () => {
    const queued = await queue.enqueue(createDefaultAutonomousTask(root, 'create note.txt'));
    // Restorable (visible) task: a hidden queued task is not steerable.
    await queue.transition(queued.taskId, 'preparing');
    await queue.transition(queued.taskId, 'waiting_for_approval');
    const task = await queue.transition(queued.taskId, 'running');
    const posted: PostedMessage[] = [];
    const { panel, receive } = attachPanel(root, posted);
    panel.attachAutonomous(queue, runtime);

    receive({
      type: 'steerTask',
      taskId: task.taskId,
      message: 'Use greeting.txt instead.',
      messageId: 'webview-steer-1',
    });
    await vi.waitFor(() => {
      if (!posted.some(message =>
        message.type === 'taskSteered'
        && message.taskId === task.taskId
        && message.messageId === 'webview-steer-1')) {
        throw new Error('steering not acknowledged yet');
      }
    });

    const persisted = await queue.get(task.taskId);
    expect(persisted?.followUps).toHaveLength(1);
    expect(persisted?.followUps[0]).toMatchObject({
      messageId: 'webview-steer-1',
      sequence: 1,
      scopeChanging: true,
    });
  });

  it('reopening the panel reconnects to the durable task without a new start message', async () => {
    const posted: PostedMessage[] = [];
    const { panel, receive } = attachPanel(root, posted);
    panel.attachAutonomous(queue, runtime);

    receive({ type: 'startAutonomousTask', text: 'Implement the acceptance feature.' });
    const started = await vi.waitFor(() => {
      const message = posted.find(m => m.type === 'autonomousTaskStarted');
      if (!message) throw new Error('not started yet');
      return message;
    });

    await vi.waitFor(async () => {
      const current = await queue.get(started.taskId);
      if (!current || (current.state !== 'running' && current.state !== 'waiting_for_proposal_approval')) {
        throw new Error('task not in running state yet');
      }
    });

    const reopenedPosted: PostedMessage[] = [];
    const reopened = attachPanel(root, reopenedPosted);
    reopened.panel.attachAutonomous(queue, runtime);

    await vi.waitFor(() => {
      if (!reopenedPosted.some(m => m.type === 'autonomousTaskStatus' && m.taskId === started.taskId)) {
        throw new Error('reopened panel did not reconnect yet');
      }
    }, { timeout: 15000 });
  });

  it('reports composer context (provider, model, repository, permission profile) without secrets', async () => {
    const posted: PostedMessage[] = [];
    const { panel, receive } = attachPanel(root, posted);
    panel.attachAutonomous(queue, runtime);

    receive({ type: 'getAutonomousComposerContext' });
    const context = await vi.waitFor(() => {
      const message = posted.find(m => m.type === 'autonomousComposerContext');
      if (!message) throw new Error('no context posted yet');
      return message;
    });

    expect(context.provider).toBe('ollama');
    expect(context.model).toBe('fake-coder');
    expect(context.repositoryName).toBe(path.basename(root));
  });

  it('copies a redacted diagnostics summary, never the raw prompt or file contents', async () => {
    const posted: PostedMessage[] = [];
    const { panel, receive } = attachPanel(root, posted);
    panel.attachAutonomous(queue, runtime);
    let clipboardText = '';
    vi.spyOn(vscode.env.clipboard, 'writeText').mockImplementation(async text => { clipboardText = text; });

    receive({ type: 'startAutonomousTask', text: 'super-secret-implementation-detail-marker' });
    const started = await vi.waitFor(() => {
      const message = posted.find(m => m.type === 'autonomousTaskStarted');
      if (!message) throw new Error('not started yet');
      return message;
    });

    receive({ type: 'copyAutonomousDiagnostics', taskId: started.taskId });
    await vi.waitFor(() => {
      if (!posted.some(m => m.type === 'autonomousDiagnosticsCopied')) throw new Error('not copied yet');
    });

    expect(clipboardText).not.toContain('super-secret-implementation-detail-marker');
    expect(clipboardText).toContain(String(started.taskId));
  });

  it('Phase 9: surfaces stage routing, diff-review verdict, and restart-restored state via the existing diagnostics-copy path', async () => {
    const task = await queue.enqueue(createDefaultAutonomousTask(root, 'phase 9 surfacing test'));
    await queue.update(
      {
        ...task,
        failure: { classification: 'recovery_required', message: 'Interrupted state requires explicit resume.', at: new Date().toISOString() },
        stageRouting: {
          reviewer: {
            stage: 'reviewer',
            provider: 'host',
            model: 'deterministic',
            routingReason: 'no_model_candidate_configured',
            fallbackReason: 'no_model_candidate_configured',
            decidedAt: new Date().toISOString(),
          },
        },
        diffReview: {
          verdict: 'reject',
          requirementFindings: [],
          changedFileFindings: ['unexpected change: src/unexpected.ts'],
          validationFindings: [],
          securityFindings: [],
          explanation: 'Deterministic host evidence found issues; no stage reviewer model configured to override them.',
          reviewerProvider: 'host',
          reviewerModel: 'deterministic',
          decidedAt: new Date().toISOString(),
          approvedScopePaths: ['src/approved.ts'],
        },
      },
      'test_setup',
      {},
    );

    const posted: PostedMessage[] = [];
    const { panel, receive } = attachPanel(root, posted);
    panel.attachAutonomous(queue, runtime);
    let clipboardText = '';
    vi.spyOn(vscode.env.clipboard, 'writeText').mockImplementation(async text => { clipboardText = text; });

    receive({ type: 'copyAutonomousDiagnostics', taskId: task.taskId });
    await vi.waitFor(() => {
      if (!posted.some(m => m.type === 'autonomousDiagnosticsCopied')) throw new Error('not copied yet');
    });

    expect(clipboardText).toContain('Restart-restored: yes');
    expect(clipboardText).toContain('Diff review: reject (reviewer host/deterministic, deterministic)');
    expect(clipboardText).toContain('Reviewer stage routing: host/deterministic — no_model_candidate_configured (fallback: no_model_candidate_configured)');
    expect(clipboardText).toContain('Diff review changed-file findings: unexpected change: src/unexpected.ts');
  });

  it('does not crash and reveals nothing when opening a worktree for an unknown task id', async () => {
    const posted: PostedMessage[] = [];
    const { panel, receive } = attachPanel(root, posted);
    panel.attachAutonomous(queue, runtime);

    receive({ type: 'openAutonomousWorktree', taskId: 'nonexistent-task' });
    await vi.waitFor(() => {
      if (!posted.some(m => m.type === 'error')) throw new Error('no error posted yet');
    });
    expect(posted.find(m => m.type === 'error')?.message).toContain('No isolated worktree');
  });

  async function pendingDeliveryTask() {
    const task = await queue.enqueue(createDefaultAutonomousTask(root, 'delivery gate test'));
    await queue.transition(task.taskId, 'preparing');
    await queue.transition(task.taskId, 'waiting_for_approval');
    await queue.transition(task.taskId, 'running');
    await queue.transition(task.taskId, 'validating');
    return queue.transition(task.taskId, 'waiting_for_delivery_approval');
  }

  /** A terminal blocked task (e.g. invalid proposal rejection). */
  async function blockedTask(goal = 'blocked task test') {
    const task = await queue.enqueue(createDefaultAutonomousTask(root, goal));
    await queue.transition(task.taskId, 'preparing');
    await queue.transition(task.taskId, 'waiting_for_approval');
    await queue.transition(task.taskId, 'running');
    return queue.transition(task.taskId, 'blocked', { failure: { classification: 'invalid_proposal', message: 'validation_command_test_path_missing' } });
  }

  /** An interrupted resumable blocked task (recovery_required). */
  async function resumableBlockedTask(goal = 'resumable blocked task test') {
    const task = await queue.enqueue(createDefaultAutonomousTask(root, goal));
    await queue.transition(task.taskId, 'preparing');
    await queue.transition(task.taskId, 'waiting_for_approval');
    await queue.transition(task.taskId, 'running');
    return queue.update(
      {
        ...task,
        state: 'blocked',
        failure: {
          classification: 'recovery_required',
          message: 'Interrupted state requires explicit resume.',
          at: new Date().toISOString(),
        },
      },
      'task_blocked',
    );
  }


  it('hydrates selected model and repository once after the ready handshake', async () => {
    provider.listModels = async () => [{ name: 'persisted-model', modifiedAt: new Date() }];
    const posted: PostedMessage[] = [];
    const { receive } = attachPanel(root, posted);
    receive({ type: 'webviewReady', mode: 'agent' });
    receive({ type: 'webviewReady', mode: 'agent' });
    await vi.waitFor(() => {
      if (!posted.some(m => m.type === 'modelsLoaded') || !posted.some(m => m.type === 'repositoryIntelligenceStatus')) throw new Error('not hydrated');
    });
    const models = posted.filter(m => m.type === 'modelsLoaded');
    expect(models).toHaveLength(1);
    expect(models[0].selectedModel).toBe('persisted-model');
    expect(models[0].provider).toBe('ollama');
    const repository = posted.find(m => m.type === 'repositoryIntelligenceStatus')?.status as { identity?: { repositoryRoot?: string; branch?: string; headCommit?: string } };
    expect(repository.identity?.repositoryRoot).toBe(root);
    expect(repository.identity?.branch).toBeTruthy();
    expect(repository.identity?.headCommit).toBeTruthy();
  });

  it('replays a pending delivery card and routes approve/reject through runtime governance', async () => {
    const pending = await pendingDeliveryTask();
    const posted: PostedMessage[] = [];
    const { panel, receive } = attachPanel(root, posted);
    panel.attachAutonomous(queue, runtime);
    receive({ type: 'webviewReady', mode: 'autonomous' });
    await vi.waitFor(() => {
      if (!posted.some(m => m.type === 'deliveryApprovalRequest' && m.taskId === pending.taskId)) throw new Error('no delivery card');
    });
    expect(posted.filter(m => m.type === 'deliveryApprovalRequest' && m.taskId === pending.taskId)).toHaveLength(1);
    const approve = vi.spyOn(runtime, 'approveDelivery');
    receive({ type: 'approveAutonomousDelivery', taskId: pending.taskId });
    await vi.waitFor(() => expect(approve).toHaveBeenCalledWith(pending.taskId));
  });

  it('publishes one durable terminal completion immediately and releases the host active-task projection', async () => {
    const pending = await pendingDeliveryTask();
    const posted: PostedMessage[] = [];
    const { panel, receive } = attachPanel(root, posted);
    panel.attachAutonomous(queue, runtime);
    receive({ type: 'webviewReady', mode: 'autonomous' });
    await vi.waitFor(() => {
      if (!posted.some(m => m.type === 'autonomousTaskStatus' && m.taskId === pending.taskId)) {
        throw new Error('active task was not projected');
      }
    });

    vi.spyOn(runtime, 'approveDelivery').mockImplementation(async taskId => {
      await queue.transition(taskId, 'committing', { actor: 'test' });
      await queue.transition(taskId, 'completed', { actor: 'test' });
    });
    receive({ type: 'approveAutonomousDelivery', taskId: pending.taskId });

    await vi.waitFor(() => {
      const terminal = posted.filter(message =>
        message.type === 'autonomousTaskStatus'
        && message.taskId === pending.taskId
        && message.state === 'completed');
      expect(terminal).toHaveLength(1);
    });
    expect((panel as unknown as { autonomousActiveTaskId?: string }).autonomousActiveTaskId).toBeUndefined();
  });

  it('does not let an unanswered native delivery notification block inline terminal publication', async () => {
    const pending = await pendingDeliveryTask();
    vi.spyOn(vscode.window, 'showInformationMessage').mockImplementation(
      (() => new Promise<string | undefined>(() => undefined)) as typeof vscode.window.showInformationMessage,
    );
    const posted: PostedMessage[] = [];
    const { panel, receive } = attachPanel(root, posted, false);
    panel.attachAutonomous(queue, runtime);
    receive({ type: 'webviewReady', mode: 'chat' });
    await vi.waitFor(() => {
      if (!posted.some(message => message.type === 'deliveryApprovalRequest' && message.taskId === pending.taskId)) {
        throw new Error('delivery gate was not projected');
      }
    });

    await queue.transition(pending.taskId, 'committing', { actor: 'test' });
    await queue.transition(pending.taskId, 'completed', { actor: 'test' });
    await vi.waitFor(() => {
      const terminal = posted.filter(message =>
        message.type === 'autonomousTaskStatus'
        && message.taskId === pending.taskId
        && message.state === 'completed');
      expect(terminal).toHaveLength(1);
    });
  });

  it.each([
    ['dismissed', false],
    ['rejected', true],
  ])('does not let a %s native delivery notification block terminal publication', async (_case, rejected) => {
    const pending = await pendingDeliveryTask();
    vi.spyOn(vscode.window, 'showInformationMessage').mockImplementation(
      (() => rejected
        ? Promise.reject(new Error('notification API rejected'))
        : Promise.resolve(undefined)) as typeof vscode.window.showInformationMessage,
    );
    const posted: PostedMessage[] = [];
    const { panel, receive } = attachPanel(root, posted, false);
    panel.attachAutonomous(queue, runtime);
    receive({ type: 'webviewReady', mode: 'chat' });
    await vi.waitFor(() => {
      if (!posted.some(message => message.type === 'deliveryApprovalRequest' && message.taskId === pending.taskId)) {
        throw new Error('delivery gate was not projected');
      }
    });

    await queue.transition(pending.taskId, 'committing', { actor: 'test' });
    await queue.transition(pending.taskId, 'completed', { actor: 'test' });
    await vi.waitFor(() => {
      expect(posted.filter(message =>
        message.type === 'autonomousTaskStatus'
        && message.taskId === pending.taskId
        && message.state === 'completed')).toHaveLength(1);
    });
  });

  it('ignores a native notification callback delayed beyond terminal publication', async () => {
    const pending = await pendingDeliveryTask();
    let resolveNotification!: (action: string | undefined) => void;
    vi.spyOn(vscode.window, 'showInformationMessage').mockReturnValue(
      new Promise(resolve => { resolveNotification = resolve; }) as ReturnType<typeof vscode.window.showInformationMessage>,
    );
    const approve = vi.spyOn(runtime, 'approveDelivery');
    const posted: PostedMessage[] = [];
    const { panel, receive } = attachPanel(root, posted, false);
    panel.attachAutonomous(queue, runtime);
    receive({ type: 'webviewReady', mode: 'chat' });
    await vi.waitFor(() => {
      if (!posted.some(message => message.type === 'deliveryApprovalRequest' && message.taskId === pending.taskId)) {
        throw new Error('delivery gate was not projected');
      }
    });

    await queue.transition(pending.taskId, 'committing', { actor: 'test' });
    await queue.transition(pending.taskId, 'completed', { actor: 'test' });
    await vi.waitFor(() => {
      expect(posted.filter(message =>
        message.type === 'autonomousTaskStatus'
        && message.taskId === pending.taskId
        && message.state === 'completed')).toHaveLength(1);
    });
    resolveNotification('Approve');
    await new Promise(resolve => setTimeout(resolve, 20));

    expect(approve).not.toHaveBeenCalled();
    expect((await queue.get(pending.taskId))?.state).toBe('completed');
    expect(posted.filter(message =>
      message.type === 'autonomousTaskStatus'
      && message.taskId === pending.taskId
      && message.state === 'completed')).toHaveLength(1);
  });

  it('deduplicates rapid terminal polls on the serialized publication chain', async () => {
    const pending = await pendingDeliveryTask();
    const posted: PostedMessage[] = [];
    const { panel, receive } = attachPanel(root, posted);
    panel.attachAutonomous(queue, runtime);
    receive({ type: 'webviewReady', mode: 'autonomous' });
    await queue.transition(pending.taskId, 'committing', { actor: 'test' });
    await queue.transition(pending.taskId, 'completed', { actor: 'test' });

    const poll = (panel as unknown as { pollAutonomousTask(taskId: string): Promise<void> }).pollAutonomousTask.bind(panel);
    await Promise.all([poll(pending.taskId), poll(pending.taskId), poll(pending.taskId)]);
    await vi.waitFor(() => {
      expect(posted.filter(message =>
        message.type === 'autonomousTaskStatus'
        && message.taskId === pending.taskId
        && message.state === 'completed')).toHaveLength(1);
    });
  });

  it('does not restore a terminal completed task on reload', async () => {
    const pending = await pendingDeliveryTask();
    await queue.transition(pending.taskId, 'committing', { actor: 'test' });
    await queue.transition(pending.taskId, 'completed', { actor: 'test' });

    const posted: PostedMessage[] = [];
    const { panel, receive } = attachPanel(root, posted);
    panel.attachAutonomous(queue, runtime);
    receive({ type: 'webviewReady', mode: 'autonomous' });

    await new Promise(resolve => setTimeout(resolve, 50));
    expect(posted.some(message =>
      (message.type === 'autonomousTaskStatus' || message.type === 'autonomousTaskActive')
      && message.taskId === pending.taskId
    )).toBe(false);
    expect((panel as unknown as { autonomousActiveTaskId?: string }).autonomousActiveTaskId).toBeUndefined();
  });

  // Regression coverage for the submission/projection race: a fresh
  // Hands-off submission was observed to surface an unrelated, hours-old
  // task's identity instead of the task it actually just created,
  // because reconnectAutonomousTask() (a fire-and-forget disk read triggered
  // by webviewModeChanged) could commit its restored projection after a
  // concurrent fresh submission had already established its own. See
  // AI_OS_STATE.md for the full incident.

  it('does not restore a terminal blocked task on reload', async () => {
    const blocked = await blockedTask();
    const posted: PostedMessage[] = [];
    const { panel, receive } = attachPanel(root, posted);
    panel.attachAutonomous(queue, runtime);
    receive({ type: 'webviewReady', mode: 'autonomous' });
    receive({ type: 'webviewModeChanged', mode: 'autonomous' });

    await new Promise(resolve => setTimeout(resolve, 50));
    expect(posted.some(m => m.type === 'autonomousTaskActive' && m.taskId === blocked.taskId)).toBe(false);
    expect((panel as unknown as { autonomousActiveTaskId?: string }).autonomousActiveTaskId).toBeUndefined();
  });

  it('does not restore a recovery_required blocked task on reload', async () => {
    const blocked = await resumableBlockedTask();
    const posted: PostedMessage[] = [];
    const { panel, receive } = attachPanel(root, posted);
    panel.attachAutonomous(queue, runtime);
    receive({ type: 'webviewReady', mode: 'autonomous' });
    receive({ type: 'webviewModeChanged', mode: 'autonomous' });

    await new Promise(resolve => setTimeout(resolve, 50));
    expect(posted.some(m => m.type === 'autonomousTaskActive' && m.taskId === blocked.taskId)).toBe(false);
    expect((panel as unknown as { autonomousActiveTaskId?: string }).autonomousActiveTaskId).toBeUndefined();
  });

  it('never lets a slow reconnect restoration overwrite a fresh submission that completed while it was still reading disk', async () => {
    const blocked = await blockedTask();
    const posted: PostedMessage[] = [];
    const { panel, receive } = attachPanel(root, posted);
    // Complete workspace restoration BEFORE attaching the autonomous queue:
    // replayWorkspaceHistory() itself calls reconnectAutonomousTask() (see
    // AgentPanel.ts's runWorkspaceRestoration chain), but it no-ops while
    // autonomousQueue is unset, so this does not pre-empt the race below by
    // legitimately restoring the blocked task before this test controls it.
    receive({ type: 'webviewReady', mode: 'autonomous' });
    await vi.waitFor(() => {
      if (!posted.some(m => m.type === 'workspaceRestorationResolved')) throw new Error('workspace restoration not resolved yet');
    });

    // Hold queue.list() open, THEN attach — attachAutonomous() itself fires
    // one automatic reconnectAutonomousTask() call, which is the one this
    // test races: it hits the gated list() and blocks immediately.
    let releaseList: () => void = () => undefined;
    const gate = new Promise<void>(resolve => { releaseList = resolve; });
    const originalList = queue.list.bind(queue);
    const listSpy = vi.spyOn(queue, 'list').mockImplementationOnce(async () => {
      await gate;
      return originalList();
    });

    panel.attachAutonomous(queue, runtime);
    expect(listSpy).toHaveBeenCalledTimes(1);
    receive({ type: 'startAutonomousTask', text: 'Fresh unrelated submission racing a slow reconnect.', submissionId: 'fresh-during-reconnect' });
    releaseList();

    const fresh = await vi.waitFor(() => {
      const ack = posted.find(m => m.type === 'autonomousTaskStarted' && m.submissionId === 'fresh-during-reconnect');
      if (!ack) {
        throw new Error('fresh submission not acknowledged yet');
      }
      return ack;
    });
    expect(fresh.taskId).not.toBe(blocked.taskId);
    await new Promise(resolve => setTimeout(resolve, 20));

    expect(posted.some(m => m.type === 'autonomousTaskActive' && m.taskId === blocked.taskId)).toBe(false);
    expect((panel as unknown as { autonomousActiveTaskId?: string }).autonomousActiveTaskId).toBe(fresh.taskId);
  });

  it('a fresh submission still wins even when a stale reconnect projection already committed first', async () => {
    const blocked = await blockedTask();
    const posted: PostedMessage[] = [];
    const { panel, receive } = attachPanel(root, posted);
    panel.attachAutonomous(queue, runtime);
    receive({ type: 'webviewReady', mode: 'autonomous' });

    (panel as any).autonomousActiveTaskId = blocked.taskId;
    (panel as any).projectAutonomousTask({ taskId: blocked.taskId, attemptId: blocked.taskId, state: 'blocked', goal: blocked.goal, restored: true });
    await vi.waitFor(() => {
      if (!posted.some(m => m.type === 'autonomousTaskActive' && m.taskId === blocked.taskId)) throw new Error('stale restore not posted yet');
    });

    receive({ type: 'startAutonomousTask', text: 'Fresh unrelated submission after a completed reconnect.', submissionId: 'fresh-after-reconnect' });
    const fresh = await vi.waitFor(() => {
      const ack = posted.find(m => m.type === 'autonomousTaskStarted' && m.submissionId === 'fresh-after-reconnect');
      if (!ack) throw new Error('fresh submission not acknowledged yet');
      return ack;
    });

    expect(fresh.taskId).not.toBe(blocked.taskId);
    expect((panel as unknown as { autonomousActiveTaskId?: string }).autonomousActiveTaskId).toBe(fresh.taskId);
  });

  it('never lets a reconnect that STARTS after a submission already bumped its epoch (but before enqueue) restore the stale blocked task', async () => {
    // An epoch-change check alone is insufficient for this ordering:
    // reconnectAutonomousTask() snapshots karkeDikhaSubmissionEpoch BEFORE its
    // own disk read. If the submission's epoch bump already happened before
    // that snapshot is taken, the snapshot captures the ALREADY-elevated
    // value — nothing changes relative to it once the read resolves, so a
    // pure "did epoch change since I started" check never fires. Only a
    // check of whether a submission is pending RIGHT NOW, at commit time
    // (karkeDikhaPendingSubmissionCount), catches this.
    const posted: PostedMessage[] = [];
    const { panel, receive } = attachPanel(root, posted);
    receive({ type: 'webviewReady', mode: 'autonomous' });
    await vi.waitFor(() => {
      if (!posted.some(m => m.type === 'workspaceRestorationResolved')) throw new Error('workspace restoration not resolved yet');
    });

    // Attach with no blocked task yet, so attachAutonomous()'s own automatic
    // initial reconnect (epoch 0, nothing pending) is a clean no-op — it
    // never touches the projection/dedup fields this test needs untouched.
    panel.attachAutonomous(queue, runtime);
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(posted.some(m => m.type === 'autonomousTaskActive')).toBe(false);

    // NOW create the stale active task the real incident actually involved.
    const blocked = await blockedTask();

    // 2. Hold the fresh submission's own enqueue() open — its epoch bump
    // (step 1) will already have happened, but its task will not exist on
    // disk yet.
    let releaseEnqueue: () => void = () => undefined;
    const enqueueGate = new Promise<void>(resolve => { releaseEnqueue = resolve; });
    const originalEnqueue = queue.enqueue.bind(queue);
    const enqueueSpy = vi.spyOn(queue, 'enqueue').mockImplementationOnce(async input => {
      await enqueueGate;
      return originalEnqueue(input);
    });

    // 1. Receive a fresh submission — its epoch bump (and pending-count
    // increment) happen synchronously; its own chain is now stuck before
    // enqueue().
    receive({ type: 'startAutonomousTask', text: 'Fresh submission held before enqueue.', submissionId: 'fresh-held-before-enqueue' });
    await vi.waitFor(() => expect(enqueueSpy).toHaveBeenCalledTimes(1));

    // 3. Start reconnectAutonomousTask NOW — its epoch snapshot is the
    // ALREADY-bumped value.
    const reconnect = (panel as unknown as { reconnectAutonomousTask(): Promise<void> }).reconnectAutonomousTask.bind(panel);
    // 4. Resolves queue.list() with only the old blocked task — real,
    // unmocked; enqueue() for the fresh submission has not run.
    await reconnect();

    // 5. Must not have projected the stale blocked task as the pending
    // submission's result.
    expect(posted.some(m => m.type === 'autonomousTaskActive' && m.taskId === blocked.taskId)).toBe(false);
    expect((panel as unknown as { autonomousActiveTaskId?: string }).autonomousActiveTaskId).toBeUndefined();

    // Submission-failure recovery: releasing lets the held submission
    // actually complete, and it — not the stale task — ends up authoritative.
    releaseEnqueue();
    const fresh = await vi.waitFor(() => {
      const ack = posted.find(m => m.type === 'autonomousTaskStarted' && m.submissionId === 'fresh-held-before-enqueue');
      if (!ack) throw new Error('fresh submission not acknowledged yet');
      return ack;
    });
    expect(fresh.taskId).not.toBe(blocked.taskId);
    expect((panel as unknown as { autonomousActiveTaskId?: string }).autonomousActiveTaskId).toBe(fresh.taskId);
  });

  it('recovers pending-submission tracking after a rejected submission, so a later reconnect restores normally', async () => {
    // Preserves submission-failure recovery: an oversized (rejected)
    // submission must still decrement karkeDikhaPendingSubmissionCount, or
    // reconnectAutonomousTask would be permanently blocked from ever
    // restoring anything again.
    const posted: PostedMessage[] = [];
    const { panel, receive } = attachPanel(root, posted);
    panel.attachAutonomous(queue, runtime);
    receive({ type: 'webviewReady', mode: 'autonomous' });

    const oversized = 'x'.repeat(MAX_AUTONOMOUS_TASK_INPUT_BYTES + 1);
    receive({ type: 'startAutonomousTask', text: oversized, submissionId: 'oversized-1' });
    await vi.waitFor(() => {
      if (!posted.some(m => m.type === 'autonomousTaskRejected')) throw new Error('not rejected yet');
    });
    expect((panel as unknown as { karkeDikhaPendingSubmissionCount: number }).karkeDikhaPendingSubmissionCount).toBe(0);

    const blocked = await pendingDeliveryTask();
    receive({ type: 'webviewModeChanged', mode: 'autonomous' });
    await vi.waitFor(() => {
      if (!posted.some(m => m.type === 'autonomousTaskActive' && m.taskId === blocked.taskId)) throw new Error('active task not restored yet');
    });
  });

  it('uses one actionable native fallback while the view is hidden', async () => {
    // M33: the default-surface notification is plain language — it must ask
    // for delivery approval without leaking the raw task/attempt id.
    const pending = await pendingDeliveryTask();
    const posted: PostedMessage[] = [];
    const { panel, receive } = attachPanel(root, posted, false);
    panel.attachAutonomous(queue, runtime);
    receive({ type: 'webviewReady', mode: 'autonomous' });
    await vi.waitFor(() => {
      if (!/approval is needed to deliver/.test(vscodeMock._lastInformationMessage() ?? '')) throw new Error('no notification');
    });
    receive({ type: 'webviewModeChanged', mode: 'autonomous' });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(vscodeMock._lastInformationMessage()).toContain('approval is needed to deliver');
    expect(vscodeMock._lastInformationMessage()).not.toContain(pending.taskId);
  });

  it('records delivery rejection with the delivery gate and user actor', async () => {
    const pending = await pendingDeliveryTask();
    await runtime.rejectDelivery(pending.taskId);
    expect((await queue.get(pending.taskId))?.state).toBe('cancelled');
    const phases = (await queue.events(pending.taskId)).map(event => event.payload.progress);
    expect(phases).toContain('approval_rejected gate=delivery actor=user');
  });

  async function pendingProposalTask() {
    const task = await queue.enqueue(createDefaultAutonomousTask(root, 'proposal gate test'));
    await queue.transition(task.taskId, 'preparing');
    await queue.transition(task.taskId, 'waiting_for_approval');
    const running = await queue.transition(task.taskId, 'running');
    const withProposal = await queue.update(
      { ...running, proposalVersion: 1, pendingProposal: { proposalId: 'sha256:test-proposal-1', version: 1, taskSummary: 'Test summary', operations: [{ type: 'create', path: 'src/x.ts', reason: 'r' }], validationCommands: [], warnings: [] } },
      'proposal_pending',
      {},
    );
    return queue.transition(withProposal.taskId, 'waiting_for_proposal_approval');
  }

  async function pendingMutationTask() {
    const task = await queue.enqueue(createDefaultAutonomousTask(root, 'mutation gate test'));
    await queue.transition(task.taskId, 'preparing');
    await queue.transition(task.taskId, 'waiting_for_approval');
    const running = await queue.transition(task.taskId, 'running');
    const withMutation = await queue.update(
      { ...running, pendingMutationApproval: { requestId: 'req-1', proposalId: 'sha256:test-proposal-1', operationCount: 1, targets: ['src/x.ts'], elevatedConfirmationRequired: false } },
      'mutation_pending',
      {},
    );
    return queue.transition(withMutation.taskId, 'waiting_for_mutation_approval');
  }

  it('renders a pending proposal card and routes approve/reject/revise through runtime governance bound to the exact proposal id', async () => {
    const pending = await pendingProposalTask();
    const posted: PostedMessage[] = [];
    const { panel, receive } = attachPanel(root, posted);
    panel.attachAutonomous(queue, runtime);
    receive({ type: 'webviewReady', mode: 'autonomous' });

    await vi.waitFor(() => {
      if (!posted.some(m => m.type === 'proposalApprovalRequest' && m.taskId === pending.taskId)) throw new Error('no proposal card');
    });
    const card = posted.find(m => m.type === 'proposalApprovalRequest' && m.taskId === pending.taskId)!;
    expect(card.proposalId).toBe('sha256:test-proposal-1');
    expect(card.taskSummary).toBe('Test summary');

    const approveSpy = vi.spyOn(runtime, 'approveProposal').mockResolvedValue(undefined);
    receive({ type: 'approveProposal', taskId: pending.taskId, proposalId: 'sha256:test-proposal-1' });
    await vi.waitFor(() => expect(approveSpy).toHaveBeenCalledWith(pending.taskId, 'sha256:test-proposal-1'));
    await vi.waitFor(() => {
      if (!posted.some(m => m.type === 'proposalApprovalResolved' && m.taskId === pending.taskId && m.decision === 'approved')) {
        throw new Error('not resolved yet');
      }
    });
  });

  it('rejects a mismatched proposal id as stale without throwing, and surfaces the stale result', async () => {
    const pending = await pendingProposalTask();
    const posted: PostedMessage[] = [];
    const { panel, receive } = attachPanel(root, posted);
    panel.attachAutonomous(queue, runtime);
    receive({ type: 'webviewReady', mode: 'autonomous' });
    await vi.waitFor(() => {
      if (!posted.some(m => m.type === 'proposalApprovalRequest')) throw new Error('no proposal card');
    });

    receive({ type: 'approveProposal', taskId: pending.taskId, proposalId: 'sha256:wrong-version' });
    await vi.waitFor(() => {
      const resolved = posted.find(m => m.type === 'proposalApprovalResolved' && m.proposalId === 'sha256:wrong-version');
      if (!resolved) throw new Error('not resolved yet');
      expect(resolved.decision).toBe('stale');
    });
    expect((await queue.get(pending.taskId))?.state).toBe('waiting_for_proposal_approval');
  });

  it('requires non-empty revision instructions at the message boundary', async () => {
    const pending = await pendingProposalTask();
    const posted: PostedMessage[] = [];
    const { panel, receive } = attachPanel(root, posted);
    panel.attachAutonomous(queue, runtime);
    receive({ type: 'webviewReady', mode: 'autonomous' });
    await vi.waitFor(() => {
      if (!posted.some(m => m.type === 'proposalApprovalRequest')) throw new Error('no proposal card');
    });

    receive({ type: 'requestProposalRevision', taskId: pending.taskId, proposalId: 'sha256:test-proposal-1', instructions: '   ' });
    await vi.waitFor(() => {
      if (!posted.some(m => m.type === 'authorizationDenied')) throw new Error('not denied yet');
    });
    expect((await queue.get(pending.taskId))?.state).toBe('waiting_for_proposal_approval');
  });

  it('renders a pending mutation approval card and routes approve/deny bound to the exact request id', async () => {
    const pending = await pendingMutationTask();
    const posted: PostedMessage[] = [];
    const { panel, receive } = attachPanel(root, posted);
    panel.attachAutonomous(queue, runtime);
    receive({ type: 'webviewReady', mode: 'autonomous' });

    await vi.waitFor(() => {
      if (!posted.some(m => m.type === 'mutationApprovalRequest' && m.taskId === pending.taskId)) throw new Error('no mutation card');
    });
    const card = posted.find(m => m.type === 'mutationApprovalRequest' && m.taskId === pending.taskId)!;
    expect(card.requestId).toBe('req-1');
    expect(card.operationCount).toBe(1);

    const denySpy = vi.spyOn(runtime, 'denyMutation').mockResolvedValue(undefined);
    receive({ type: 'denyMutation', taskId: pending.taskId, requestId: 'req-1' });
    await vi.waitFor(() => expect(denySpy).toHaveBeenCalledWith(pending.taskId, 'req-1'));
    await vi.waitFor(() => {
      if (!posted.some(m => m.type === 'mutationApprovalResolved' && m.decision === 'denied')) throw new Error('not resolved yet');
    });
  });

  it('duplicate mutation approval clicks do not duplicate resolution and surface stale on the second attempt', async () => {
    const pending = await pendingMutationTask();
    const posted: PostedMessage[] = [];
    const { panel, receive } = attachPanel(root, posted);
    panel.attachAutonomous(queue, runtime);
    receive({ type: 'webviewReady', mode: 'autonomous' });
    await vi.waitFor(() => {
      if (!posted.some(m => m.type === 'mutationApprovalRequest')) throw new Error('no mutation card');
    });

    // Mirrors the real runtime's own idempotency: the first resolveMutationGate
    // call consumes the pending gate, so a second call for the same request id
    // finds no gate left and throws stale_or_unknown_mutation_approval.
    vi.spyOn(runtime, 'approveMutation')
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('stale_or_unknown_mutation_approval'));

    receive({ type: 'approveMutation', taskId: pending.taskId, requestId: 'req-1' });
    await vi.waitFor(() => {
      if (!posted.some(m => m.type === 'mutationApprovalResolved' && m.decision === 'approved')) throw new Error('not resolved yet');
    });
    receive({ type: 'approveMutation', taskId: pending.taskId, requestId: 'req-1' });
    await vi.waitFor(() => {
      const stale = posted.filter(m => m.type === 'mutationApprovalResolved' && m.decision === 'stale');
      if (stale.length === 0) throw new Error('not stale yet');
    });
  });

  // PHASE 3 PHYSICAL DEFECT 2 regression: a stale/duplicate delivery-approval
  // click that loses its race with the backend (the gate already resolved,
  // or the task moved on) must be reconciled like every other approval gate
  // (see 'duplicate mutation approval clicks...' above) — never surfaced as
  // a raw `{type:'error'}` banner reading the backend's internal guard
  // message ("Task is not waiting for delivery approval."), which a
  // physical acceptance run observed on an otherwise successful, completed
  // task.
  it('a stale delivery approval click is reconciled as a resolved card, never a user-facing error banner', async () => {
    const pending = await pendingDeliveryTask();
    const posted: PostedMessage[] = [];
    const { panel, receive } = attachPanel(root, posted);
    panel.attachAutonomous(queue, runtime);
    receive({ type: 'webviewReady', mode: 'autonomous' });
    await vi.waitFor(() => {
      if (!posted.some(m => m.type === 'deliveryApprovalRequest' && m.taskId === pending.taskId)) throw new Error('no delivery card');
    });

    // Mirrors the real runtime's own idempotency: the backend already moved
    // the task out of waiting_for_delivery_approval (e.g. it auto-resolved,
    // or a first click already won the race) by the time this click's
    // approveDelivery call runs.
    vi.spyOn(runtime, 'approveDelivery').mockRejectedValueOnce(new Error('Task is not waiting for delivery approval.'));
    await queue.transition(pending.taskId, 'committing', { actor: 'test' });
    await queue.transition(pending.taskId, 'completed', { actor: 'test' });

    receive({ type: 'approveAutonomousDelivery', taskId: pending.taskId });

    await vi.waitFor(() => {
      const stale = posted.filter(m => m.type === 'deliveryApprovalResolved' && m.taskId === pending.taskId && m.decision === 'stale');
      if (stale.length === 0) throw new Error('not stale yet');
    });
    expect(posted.some(m => m.type === 'error')).toBe(false);
  });

  it('malformed proposal/mutation approval messages are rejected safely without mutating queue state', async () => {
    const pending = await pendingProposalTask();
    const posted: PostedMessage[] = [];
    const { panel, receive } = attachPanel(root, posted);
    panel.attachAutonomous(queue, runtime);

    receive({ type: 'approveProposal' });
    receive({ type: 'approveProposal', taskId: 123, proposalId: null });
    receive({ type: 'rejectProposal', taskId: pending.taskId });
    receive({ type: 'approveMutation', requestId: 'req-1' });
    receive('not-an-object');
    receive(null);

    expect((await queue.get(pending.taskId))?.state).toBe('waiting_for_proposal_approval');
    expect(posted.filter(m => m.type === 'authorizationDenied').length).toBeGreaterThan(0);
  });

  it('restores a pending proposal card and a pending mutation card on reopen without re-triggering execution', async () => {
    const pendingProposal = await pendingProposalTask();
    const posted: PostedMessage[] = [];
    const { panel, receive } = attachPanel(root, posted);
    panel.attachAutonomous(queue, runtime);
    const wakeSpy = vi.spyOn(runtime, 'wake');

    receive({ type: 'webviewReady', mode: 'autonomous' });
    await vi.waitFor(() => {
      if (!posted.some(m => m.type === 'proposalApprovalRequest' && m.taskId === pendingProposal.taskId)) {
        throw new Error('proposal card not restored yet');
      }
    });
    expect(wakeSpy).not.toHaveBeenCalled();

    const reopenedPosted: PostedMessage[] = [];
    const reopened = attachPanel(root, reopenedPosted);
    reopened.panel.attachAutonomous(queue, runtime);
    reopened.receive({ type: 'webviewReady', mode: 'autonomous' });
    await vi.waitFor(() => {
      if (!reopenedPosted.some(m => m.type === 'proposalApprovalRequest' && m.taskId === pendingProposal.taskId)) {
        throw new Error('reopened panel did not restore the proposal card');
      }
    });
    expect(wakeSpy).not.toHaveBeenCalled();
  });

  it('resolves a surfaced proposal card once task.state moves past waiting_for_proposal_approval, even if pendingProposal is still present on the persisted record', async () => {
    const pending = await pendingProposalTask();
    const posted: PostedMessage[] = [];
    const { panel, receive } = attachPanel(root, posted);
    panel.attachAutonomous(queue, runtime);
    receive({ type: 'webviewReady', mode: 'autonomous' });
    await vi.waitFor(() => {
      if (!posted.some(m => m.type === 'proposalApprovalRequest' && m.taskId === pending.taskId)) throw new Error('no proposal card');
    });

    // Simulates a stale/legacy persisted record: state moves on but pendingProposal
    // itself was never cleared (the exact defect the durable-clear fix targets).
    // Card resolution must be gated by authoritative task.state, not by the
    // presence/absence of the pending field alone.
    const current = await queue.get(pending.taskId);
    await queue.update({ ...current!, state: 'waiting_for_mutation_approval' }, 'test_simulated_stale_field', {});

    await vi.waitFor(() => {
      if (!posted.some(m => m.type === 'proposalApprovalResolved' && m.taskId === pending.taskId)) throw new Error('not resolved yet');
    }, { timeout: 5000 });
  });

  it('a task restored in waiting_for_delivery_approval never exposes proposal/mutation controls even with stale pending fields left on the record, and keeps delivery controls active', async () => {
    const pending = await pendingDeliveryTask();
    // Simulates a legacy record from before durable clearing was fixed: the
    // pendingProposal/pendingMutationApproval fields were never cleared even
    // though the task progressed all the way to delivery approval.
    const current = await queue.get(pending.taskId);
    await queue.update({
      ...current!,
      pendingProposal: { proposalId: 'sha256:stale', version: 1, taskSummary: 'stale', operations: [], validationCommands: [], warnings: [] },
      pendingMutationApproval: { requestId: 'stale-req', proposalId: 'sha256:stale', operationCount: 0, targets: [], elevatedConfirmationRequired: false },
    }, 'test_simulated_stale_fields', {});

    const posted: PostedMessage[] = [];
    const { panel, receive } = attachPanel(root, posted);
    panel.attachAutonomous(queue, runtime);
    receive({ type: 'webviewReady', mode: 'autonomous' });

    await vi.waitFor(() => {
      if (!posted.some(m => m.type === 'deliveryApprovalRequest' && m.taskId === pending.taskId)) throw new Error('no delivery card');
    });
    expect(posted.some(m => m.type === 'proposalApprovalRequest')).toBe(false);
    expect(posted.some(m => m.type === 'mutationApprovalRequest')).toBe(false);
  });

  it('reload of a task in waiting_for_delivery_approval posts a waiting-for-delivery status, never an idle/terminal default', async () => {
    const pending = await pendingDeliveryTask();
    const posted: PostedMessage[] = [];
    const { panel, receive } = attachPanel(root, posted);
    panel.attachAutonomous(queue, runtime);
    receive({ type: 'webviewReady', mode: 'autonomous' });

    const status = await vi.waitFor(() => {
      const message = posted.find(m => m.type === 'autonomousTaskStatus' && m.taskId === pending.taskId);
      if (!message) throw new Error('no status posted yet');
      return message;
    });
    expect(status.state).toBe('waiting_for_delivery_approval');
    expect(status.pandaState).not.toBe('idle');
  });

  it('reconnecting to a task in waiting_for_delivery_approval never calls wake() or auto-resolves any gate', async () => {
    const pending = await pendingDeliveryTask();
    const posted: PostedMessage[] = [];
    const wakeSpy = vi.spyOn(runtime, 'wake');
    const approveDeliverySpy = vi.spyOn(runtime, 'approveDelivery');
    const approveProposalSpy = vi.spyOn(runtime, 'approveProposal');
    const approveMutationSpy = vi.spyOn(runtime, 'approveMutation');
    const { panel, receive } = attachPanel(root, posted);
    panel.attachAutonomous(queue, runtime);
    receive({ type: 'webviewReady', mode: 'autonomous' });

    await vi.waitFor(() => {
      if (!posted.some(m => m.type === 'deliveryApprovalRequest' && m.taskId === pending.taskId)) throw new Error('no delivery card');
    });

    expect(wakeSpy).not.toHaveBeenCalled();
    expect(approveDeliverySpy).not.toHaveBeenCalled();
    expect(approveProposalSpy).not.toHaveBeenCalled();
    expect(approveMutationSpy).not.toHaveBeenCalled();
    expect((await queue.get(pending.taskId))?.state).toBe('waiting_for_delivery_approval');
  });

  it('a transiently missing (failed) poll response never resolves an active proposal gate', async () => {
    const pending = await pendingProposalTask();
    const posted: PostedMessage[] = [];
    const { panel, receive } = attachPanel(root, posted);
    panel.attachAutonomous(queue, runtime);
    receive({ type: 'webviewReady', mode: 'autonomous' });
    await vi.waitFor(() => {
      if (!posted.some(m => m.type === 'proposalApprovalRequest' && m.taskId === pending.taskId)) throw new Error('no proposal card');
    });

    // Simulates a single poll cycle whose durable-queue read comes back empty
    // (e.g. a transient disk/IO hiccup) — this must not be treated as proof
    // that the gate resolved.
    const getSpy = vi.spyOn(queue, 'get').mockResolvedValueOnce(undefined);
    await vi.waitFor(() => {
      if (getSpy.mock.calls.length === 0) throw new Error('poll has not retried yet');
    }, { timeout: 5000 });
    await new Promise(resolve => setTimeout(resolve, 50));
    getSpy.mockRestore();

    expect(posted.some(m => m.type === 'proposalApprovalResolved')).toBe(false);
    expect((await queue.get(pending.taskId))?.state).toBe('waiting_for_proposal_approval');
  });

  it('detects tracked .ollama-agent runtime state in postAutonomousComposerContext and blocks startAutonomousTask', async () => {
    const { spawn } = await import('child_process');
    const runtimeFile = path.join(root, '.ollama-agent', 'index', 'repository-intelligence.sqlite');
    await fs.mkdir(path.dirname(runtimeFile), { recursive: true });
    await fs.writeFile(runtimeFile, 'sqlite-data');
    await new Promise<void>((resolve, reject) => {
      const child = spawn('git', ['add', '.ollama-agent'], { cwd: root, shell: false, windowsHide: true });
      child.on('close', code => (code === 0 ? resolve() : reject(new Error('git add failed'))));
    });

    const posted: PostedMessage[] = [];
    const { panel } = attachPanel(root, posted);
    panel.attachAutonomous(queue, runtime);
    await (panel as any).postAutonomousComposerContext();

    const contextMessages = posted.filter(m => m.type === 'autonomousComposerContext');
    const contextMsg = contextMessages[contextMessages.length - 1];
    expect(contextMsg?.hasTrackedRuntimeState).toBe(true);
    expect(Array.isArray(contextMsg?.trackedRuntimeFiles)).toBe(true);
    expect((contextMsg?.trackedRuntimeFiles as string[])[0]).toContain('.ollama-agent');

    // Attempting to start a task must fail preflight early
    await panel.startAutonomousTask('fix this bug');
    const errorMsg = posted.find(m => m.type === 'error' && String(m.message).includes('KarkeDikha runtime files are tracked'));
    expect(errorMsg).toBeDefined();
    expect(String(errorMsg?.message)).toContain('git rm -r --cached .ollama-agent');
  });

  it('derives delivery evidence changed-file count authoritatively even after worktree is clean', async () => {
    const pending = await pendingDeliveryTask();
    pending.diffReview = {
      verdict: 'pass',
      reviewerSource: 'host',
      reviewedAt: new Date().toISOString(),
      approvedScopePaths: ['src/ordercalc/pricing.py'],
    } as any;
    await queue.enqueue(pending);

    const posted: PostedMessage[] = [];
    const { panel, receive } = attachPanel(root, posted);
    panel.attachAutonomous(queue, runtime);
    receive({ type: 'webviewReady', mode: 'autonomous' });

    const status = await vi.waitFor(() => {
      const message = posted.find(m => m.type === 'autonomousTaskStatus' && m.taskId === pending.taskId && m.deliveryEvidence);
      if (!message) throw new Error('no status with deliveryEvidence posted yet');
      return message;
    });

    expect((status.deliveryEvidence as any).changedFileCount).toBe(1);
  });

  describe('task-start repository snapshot (Branch / HEAD)', () => {
    const git = async (...args: string[]): Promise<string> => {
      const { execFile } = await import('child_process');
      return new Promise((resolve, reject) => execFile('git', args, { cwd: root, windowsHide: true }, (err, stdout) => (err ? reject(err) : resolve(String(stdout).trim()))));
    };
    const advance = async (message: string): Promise<string> => {
      await git('commit', '--allow-empty', '-m', message);
      return git('rev-parse', 'HEAD');
    };
    const snapshotFor = (posted: PostedMessage[], taskId: string) =>
      posted.filter(m => m.type === 'autonomousTaskRepositorySnapshot' && m.taskId === taskId).pop();

    it('captures a fresh HEAD at task creation instead of the previously hydrated one', async () => {
      await git('checkout', '-B', 'rc-destination-test');
      const staleHead = await git('rev-parse', 'HEAD');
      const posted: PostedMessage[] = [];
      const { panel } = attachPanel(root, posted);
      panel.attachAutonomous(queue, runtime);
      await (panel as any).postAutonomousComposerContext();
      expect(posted.find(m => m.type === 'autonomousComposerContext')?.headCommit).toBe(staleHead.slice(0, 7));

      const currentHead = await advance('workspace advances');
      expect(currentHead).not.toBe(staleHead);

      await panel.startAutonomousTask('Implement the acceptance feature.');
      const [task] = await queue.list();
      expect(task.repositoryHeadAtStart).toBe(currentHead);
      expect(task.destinationBranch).toBe('rc-destination-test');

      const snapshot = snapshotFor(posted, task.taskId);
      expect(`${snapshot?.branch} @ ${snapshot?.headCommit}`).toBe(`rc-destination-test @ ${currentHead.slice(0, 7)}`);
      expect(snapshot?.headCommit).not.toBe(staleHead.slice(0, 7));
    });

    it('takes a new snapshot for a second task after another delivery', async () => {
      await git('checkout', '-B', 'rc-destination-test');
      const posted: PostedMessage[] = [];
      const { panel } = attachPanel(root, posted);
      panel.attachAutonomous(queue, runtime);

      const firstHead = await advance('first delivery');
      await panel.startAutonomousTask('First task.');
      // The Core test double reuses one attempt id, so compare per-submission
      // projections rather than distinct task records.
      const firstSnapshots = posted.filter(m => m.type === 'autonomousTaskRepositorySnapshot');
      expect(firstSnapshots.pop()?.headCommit).toBe(firstHead.slice(0, 7));
      expect((await queue.list())[0].repositoryHeadAtStart).toBe(firstHead);

      posted.length = 0;
      const secondHead = await advance('second delivery');
      await panel.startAutonomousTask('Second task.');
      const secondSnapshots = posted.filter(m => m.type === 'autonomousTaskRepositorySnapshot');
      // (A poll still in flight for the shared-id first record may re-project
      // it; only the new submission's own snapshot is asserted.)
      expect(secondSnapshots.some(m => m.headCommit === secondHead.slice(0, 7))).toBe(true);
      expect((await queue.list())[0].repositoryHeadAtStart).toBe(secondHead);
    });
  });

  it('surfaces routed model snapshot in autonomousTaskStatus for the authoritative attempt', async () => {
    const pending = await pendingDeliveryTask();
    pending.providerModelRoutingSnapshot = {
      provider: 'ollama',
      model: 'qwen3.8:27b-mtp-q4_K_M',
      routingTier: 'normal',
      source: 'task_snapshot',
    } as any;
    await queue.enqueue(pending);

    const posted: PostedMessage[] = [];
    const { panel, receive } = attachPanel(root, posted);
    panel.attachAutonomous(queue, runtime);
    receive({ type: 'webviewReady', mode: 'autonomous' });

    const status = await vi.waitFor(() => {
      const message = posted.find(m => m.type === 'autonomousTaskStatus' && m.taskId === pending.taskId && m.model === 'qwen3.8:27b-mtp-q4_K_M');
      if (!message) throw new Error('no status with routed model posted yet');
      return message;
    });

    expect(status.provider).toBe('ollama');
    expect(status.model).toBe('qwen3.8:27b-mtp-q4_K_M');
  });
});
