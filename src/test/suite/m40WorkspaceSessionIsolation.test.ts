import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { AgentPanel } from '../../ui/AgentPanel';
import { DurableTaskQueue, createDefaultAutonomousTask } from '../../autonomous/M15AutonomousWork';
import type { AutonomousTaskRuntime } from '../../activation/M15AutonomousRuntime';
import { MockMemento, MockSecretStorage } from '../mocks/vscode';

interface PostedMessage {
  type: string;
  [key: string]: unknown;
}

function context(globalState: MockMemento, workspaceState: MockMemento): vscode.ExtensionContext {
  return {
    subscriptions: [],
    extensionUri: vscode.Uri.file(process.cwd()),
    globalState,
    workspaceState,
    secrets: new MockSecretStorage(),
    extension: { packageJSON: { scripts: {}, contributes: { commands: [] } } },
  } as unknown as vscode.ExtensionContext;
}

function attach(
  root: string,
  globalState: MockMemento,
  workspaceState: MockMemento,
  queue: DurableTaskQueue,
  sendSteering: ReturnType<typeof vi.fn>,
): { posted: PostedMessage[]; receive(message: unknown): void } {
  const posted: PostedMessage[] = [];
  const panel = new AgentPanel(context(globalState, workspaceState), root);
  const runtime = {
    onDeliveryApprovalRequired: () => undefined,
    onProposalApprovalRequired: () => undefined,
    onMutationApprovalRequired: () => undefined,
    hasCoreAuthority: () => true,
    isCoreAuthorityRequired: () => false,
    sendSteering,
  } as unknown as AutonomousTaskRuntime;
  panel.attachAutonomous(queue, runtime);
  let handler: (message: unknown) => void = () => undefined;
  const webview = {
    options: {}, html: '', cspSource: 'vscode-webview://workspace-isolation',
    asWebviewUri: (uri: vscode.Uri) => uri,
    postMessage: (message: PostedMessage) => { posted.push(message); return Promise.resolve(true); },
    onDidReceiveMessage: (callback: (message: unknown) => void) => {
      handler = callback;
      return { dispose: () => undefined };
    },
  };
  panel.resolveWebviewView({
    webview,
    visible: true,
    show: () => undefined,
    onDidDispose: () => ({ dispose: () => undefined }),
  } as unknown as vscode.WebviewView, {} as vscode.WebviewViewResolveContext, {} as vscode.CancellationToken);
  return { posted, receive: message => handler(message) };
}

async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 30));
}

describe('M40 workspace-bound session restoration', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map(root =>
      fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
  });

  async function workspace(name: string): Promise<string> {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'kd-workspace-isolation-'));
    const root = path.join(parent, name);
    await fs.mkdir(root);
    roots.push(parent);
    return root;
  }

  it('does not activate workspace A conversation or task state in workspace B', async () => {
    const rootA = await workspace('workspace-a');
    const rootB = await workspace('workspace-b');
    const globalState = new MockMemento();
    const workspaceBState = new MockMemento();
    await globalState.update('ollama-agent.baatKarCoreConversationId', { default: 'core-conversation-a' });
    await workspaceBState.update('ollama-agent.workspaceConversationState.v1', {
      schemaVersion: 1,
      workspaceIdentity: 'deliberately-wrong-identity',
      currentConversationId: 'conversation-a',
      coreConversationIds: { 'conversation-a': 'core-conversation-a' },
    });

    const queueA = new DurableTaskQueue(rootA);
    const taskA = await queueA.enqueue(createDefaultAutonomousTask(rootA, 'create note.txt containing Hello'));
    const steerB = vi.fn(async () => undefined);
    const b = attach(rootB, globalState, workspaceBState, new DurableTaskQueue(rootB), steerB);
    b.receive({ type: 'webviewReady', mode: 'chat' });
    await settle();

    expect(b.posted.some(message => message.type === 'autonomousTaskActive' && message.taskId === taskA.taskId)).toBe(false);
    expect(b.posted.some(message => message.type === 'restoreTranscript')).toBe(false);
    expect(globalState.get('ollama-agent.baatKarCoreConversationId')).toBeUndefined();
    expect(workspaceBState.get<{ workspaceIdentity: string; currentConversationId: string }>(
      'ollama-agent.workspaceConversationState.v1',
    )).toEqual(expect.objectContaining({
      currentConversationId: 'default',
      workspaceIdentity: expect.not.stringContaining('deliberately-wrong-identity'),
    }));
    b.receive({ type: 'sendMessage', mode: 'chat', text: 'Workspace B question', conversationId: 'default' });
    await settle();
    expect(steerB).not.toHaveBeenCalled();
  });

  // Release contract (cross-mode isolation): an explicit Baat Kar submission
  // never silently captures a live autonomous task. The task stays alive and
  // owned by this workspace, and the chat turn routes to Baat Kar instead of
  // being reinterpreted as steering. Karke Dikha submissions still steer; that
  // path is covered where autonomous submissions are exercised.
  it('routes an explicit Baat Kar submission as chat and leaves the restored workspace task alive', async () => {
    const rootA = await workspace('workspace-a');
    const queueA = new DurableTaskQueue(rootA);
    const queued = await queueA.enqueue(createDefaultAutonomousTask(rootA, 'create note.txt containing Hello'));
    await queueA.transition(queued.taskId, 'preparing');
    await queueA.transition(queued.taskId, 'waiting_for_approval');
    const task = await queueA.transition(queued.taskId, 'running');
    const sendSteering = vi.fn(async () => undefined);
    const a = attach(rootA, new MockMemento(), new MockMemento(), queueA, sendSteering);

    a.receive({ type: 'webviewReady', mode: 'chat' });
    a.receive({
      type: 'sendMessage',
      mode: 'chat',
      text: 'Use greeting.txt instead',
      conversationId: 'default',
    });
    await settle();

    expect(sendSteering).not.toHaveBeenCalled();
    expect(a.posted.some(message => message.type === 'taskSteered')).toBe(false);
    // The task itself is untouched and still projected as the active one.
    expect((await queueA.get(task.taskId))?.state).toBe('running');
    expect(a.posted.filter(message => message.type === 'autonomousTaskActive' && message.taskId === task.taskId))
      .toHaveLength(1);
  });

  it('does not let an unprojected queued task silently capture the visible composer after restoration', async () => {
    const rootA = await workspace('workspace-a');
    const queueA = new DurableTaskQueue(rootA);
    const queued = await queueA.enqueue(createDefaultAutonomousTask(rootA, 'create note.txt containing Hello'));
    const sendSteering = vi.fn(async () => undefined);
    const a = attach(rootA, new MockMemento(), new MockMemento(), queueA, sendSteering);

    a.receive({ type: 'webviewReady', mode: 'chat' });
    await settle();
    expect(a.posted.some(message => message.type === 'autonomousTaskActive' && message.taskId === queued.taskId)).toBe(false);

    a.receive({ type: 'sendMessage', mode: 'chat', text: 'Use greeting.txt instead', conversationId: 'default' });
    await settle();
    expect(sendSteering).not.toHaveBeenCalled();
    expect(a.posted.some(message => message.type === 'taskSteered')).toBe(false);
  });

  it('rejects a durable task record copied from workspace A into workspace B storage', async () => {
    const rootA = await workspace('workspace-a');
    const rootB = await workspace('workspace-b');
    const queueB = new DurableTaskQueue(rootB);
    const copied = await queueB.enqueue(createDefaultAutonomousTask(rootA, 'create note.txt containing Hello'));
    const sendSteering = vi.fn(async () => undefined);
    const b = attach(rootB, new MockMemento(), new MockMemento(), queueB, sendSteering);

    b.receive({ type: 'webviewReady', mode: 'chat' });
    await settle();
    expect(b.posted.some(message => message.type === 'autonomousTaskActive' && message.taskId === copied.taskId)).toBe(false);
    b.receive({ type: 'sendMessage', mode: 'chat', text: 'Use greeting.txt instead', conversationId: 'default' });
    await settle();
    expect(sendSteering).not.toHaveBeenCalled();
  });
});
