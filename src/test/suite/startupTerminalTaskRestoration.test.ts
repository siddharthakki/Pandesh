import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { AgentPanel } from '../../ui/AgentPanel';
import { AutonomousTaskRuntime } from '../../activation/M15AutonomousRuntime';
import {
  DurableTaskQueue,
  IsolatedWorktreeManager,
  TaskResourceScheduler,
  createDefaultAutonomousTask,
} from '../../autonomous/M15AutonomousWork';
import * as extensionModule from '../../extension';
import type { AttemptRehydrationRecord } from '../../../core/shared/wireTypes';

interface PostedMessage {
  type: string;
  [key: string]: unknown;
}

function context(): vscode.ExtensionContext {
  return {
    subscriptions: [],
    extensionUri: vscode.Uri.file(process.cwd()),
    secrets: {
      get: async () => undefined,
      store: async () => undefined,
      delete: async () => undefined,
      onDidChange: () => ({ dispose: () => undefined }),
    },
    extension: { packageJSON: { scripts: {}, contributes: { commands: [] } } },
  } as unknown as vscode.ExtensionContext;
}

function attachPanel(root: string, posted: PostedMessage[]) {
  const panel = new AgentPanel(context(), root);
  let messageHandler: ((msg: unknown) => void) | undefined;
  const webview = {
    options: {},
    html: '',
    cspSource: 'vscode-webview://restart-test',
    asWebviewUri: (uri: vscode.Uri) => uri,
    postMessage: (message: PostedMessage) => {
      posted.push(message);
      return Promise.resolve(true);
    },
    onDidReceiveMessage: (handler: (msg: unknown) => void) => {
      messageHandler = handler;
      return { dispose: () => undefined };
    },
  };
  panel.resolveWebviewView(
    {
      webview,
      show: () => undefined,
      onDidDispose: () => ({ dispose: () => undefined }),
      visible: true,
    } as unknown as vscode.WebviewView,
    {} as never,
    {} as never,
  );
  return {
    panel,
    receive: (msg: unknown) => messageHandler?.(msg),
  };
}

function fakeClient(records: AttemptRehydrationRecord[] = [], historyTasks: unknown[] = []) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  return {
    calls,
    async getWorkspaceConversationLedger(identity: string) {
      calls.push({ method: 'getWorkspaceConversationLedger', args: [identity] });
      return {
        schemaVersion: 1,
        workspaceIdentity: identity,
        currentConversationId: null,
        currentCoreConversationId: null,
        conversations: [],
        turns: [],
        migrationMetadata: {},
      };
    },
    async getWorkspaceAttemptRehydration(...args: unknown[]) {
      return { workspaceRoot: args[0], attempts: records };
    },
    async listTaskHistory(...args: unknown[]) {
      calls.push({ method: 'listTaskHistory', args });
      return { tasks: historyTasks };
    },
    async getTaskHistoryDetail(attemptId: string) {
      return { attemptId, timeline: [] };
    },
    async listRecentWorkspaceCapabilityActions() {
      return { actions: [] };
    },
    async heartbeatKarkeDikhaAttempt() {},
    async requestKarkeDikhaApproval() {},
    async resolveKarkeDikhaApproval() {},
    async beginKarkeDikhaValidation() {},
    async reportKarkeDikhaValidation() {},
    async completeKarkeDikhaAttempt() {},
    async failKarkeDikhaAttempt() {},
    async cancelKarkeDikhaAttempt() {},
  };
}

describe('KarkeDikha startup restoration policy regression tests', () => {
  let root: string;
  let queue: DurableTaskQueue;
  let runtime: AutonomousTaskRuntime;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'startup-restoration-test-'));
    queue = new DurableTaskQueue(root);
    runtime = new AutonomousTaskRuntime(
      context(),
      root,
      queue,
      new TaskResourceScheduler({
        maxActiveTasks: 1,
        maxActiveMutatingTasks: 1,
        modelConcurrency: { '*': 1 },
      }),
      new IsolatedWorktreeManager(root),
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
  });

  it('completed → fresh canvas', async () => {
    const task = await queue.enqueue(createDefaultAutonomousTask(root, 'completed goal'));
    await queue.transition(task.taskId, 'preparing');
    await queue.transition(task.taskId, 'running');
    await queue.transition(task.taskId, 'validating');
    await queue.transition(task.taskId, 'waiting_for_delivery_approval');
    await queue.transition(task.taskId, 'committing', { actor: 'test' });
    await queue.transition(task.taskId, 'completed', { actor: 'test' });

    const historyTasks = [{
      attemptId: task.attemptId,
      taskId: task.taskId,
      kind: 'karke_dikha',
      status: 'completed',
      currentMessage: 'completed goal',
      createdAt: task.createdAt,
      completedAt: new Date().toISOString(),
    }];

    const client = fakeClient([], historyTasks);
    vi.spyOn(extensionModule, 'getCoreManager').mockReturnValue({ getClient: () => client as never } as never);

    const posted: PostedMessage[] = [];
    const { panel, receive } = attachPanel(root, posted);
    panel.attachAutonomous(queue, runtime);
    receive({ type: 'webviewReady', mode: 'autonomous' });

    await vi.waitFor(() => {
      if (!posted.some(m => m.type === 'workspaceRestorationResolved')) throw new Error('restoration not resolved');
    });

    // Main canvas remains fresh: no terminal task projection or polling
    expect(posted.some(m => m.type === 'autonomousTaskActive')).toBe(false);
    expect(posted.some(m => m.type === 'autonomousTaskStatus')).toBe(false);
    expect(posted.some(m => m.type === 'newConversation')).toBe(true);
    expect((panel as unknown as { autonomousActiveTaskId?: string }).autonomousActiveTaskId).toBeUndefined();

    const recoverable = await panel.hasActiveRecoverableWork();
    expect(recoverable.hasActiveWork).toBe(false);

    // Task remains durably available in History
    receive({ type: 'getEverydayHistory' });
    await vi.waitFor(() => {
      const historyMsg = posted.find(m => m.type === 'everydayHistory') as { available: boolean; tasks: Array<{ attemptId: string }> } | undefined;
      if (!historyMsg) throw new Error('no everydayHistory received');
      expect(historyMsg.available).toBe(true);
      expect(historyMsg.tasks.some(t => t.attemptId === task.attemptId)).toBe(true);
    });
  });

  it('failed → fresh canvas', async () => {
    const task = await queue.enqueue(createDefaultAutonomousTask(root, 'failed goal'));
    await queue.transition(task.taskId, 'preparing');
    await queue.transition(task.taskId, 'running');
    await queue.transition(task.taskId, 'failed', { failure: { classification: 'execution_failed', message: 'Test execution failed' } });

    const historyTasks = [{
      attemptId: task.attemptId,
      taskId: task.taskId,
      kind: 'karke_dikha',
      status: 'failed',
      currentMessage: 'failed goal',
      createdAt: task.createdAt,
      completedAt: new Date().toISOString(),
    }];

    const client = fakeClient([], historyTasks);
    vi.spyOn(extensionModule, 'getCoreManager').mockReturnValue({ getClient: () => client as never } as never);

    const posted: PostedMessage[] = [];
    const { panel, receive } = attachPanel(root, posted);
    panel.attachAutonomous(queue, runtime);
    receive({ type: 'webviewReady', mode: 'autonomous' });

    await vi.waitFor(() => {
      if (!posted.some(m => m.type === 'workspaceRestorationResolved')) throw new Error('restoration not resolved');
    });

    // Fresh canvas
    expect(posted.some(m => m.type === 'autonomousTaskActive')).toBe(false);
    expect(posted.some(m => m.type === 'autonomousTaskStatus')).toBe(false);
    expect(posted.some(m => m.type === 'newConversation')).toBe(true);
    expect((panel as unknown as { autonomousActiveTaskId?: string }).autonomousActiveTaskId).toBeUndefined();

    const recoverable = await panel.hasActiveRecoverableWork();
    expect(recoverable.hasActiveWork).toBe(false);

    // Task remains durably available in History
    receive({ type: 'getEverydayHistory' });
    await vi.waitFor(() => {
      const historyMsg = posted.find(m => m.type === 'everydayHistory') as { available: boolean; tasks: Array<{ attemptId: string }> } | undefined;
      if (!historyMsg) throw new Error('no everydayHistory received');
      expect(historyMsg.available).toBe(true);
      expect(historyMsg.tasks.some(t => t.attemptId === task.attemptId)).toBe(true);
    });
  });

  it('cancelled → fresh canvas', async () => {
    const task = await queue.enqueue(createDefaultAutonomousTask(root, 'cancelled goal'));
    await queue.transition(task.taskId, 'preparing');
    await queue.transition(task.taskId, 'cancelling', { reason: 'user_cancelled' });
    await queue.transition(task.taskId, 'cancelled', { reason: 'user_cancelled' });

    const client = fakeClient([]);
    vi.spyOn(extensionModule, 'getCoreManager').mockReturnValue({ getClient: () => client as never } as never);

    const posted: PostedMessage[] = [];
    const { panel, receive } = attachPanel(root, posted);
    panel.attachAutonomous(queue, runtime);
    receive({ type: 'webviewReady', mode: 'autonomous' });

    await vi.waitFor(() => {
      if (!posted.some(m => m.type === 'workspaceRestorationResolved')) throw new Error('restoration not resolved');
    });

    // Fresh canvas: cancelled task is not projected
    expect(posted.some(m => m.type === 'autonomousTaskActive')).toBe(false);
    expect(posted.some(m => m.type === 'autonomousTaskStatus')).toBe(false);
    expect(posted.some(m => m.type === 'newConversation')).toBe(true);
    expect((panel as unknown as { autonomousActiveTaskId?: string }).autonomousActiveTaskId).toBeUndefined();

    const recoverable = await panel.hasActiveRecoverableWork();
    expect(recoverable.hasActiveWork).toBe(false);
  });

  it('ordinary blocked → fresh canvas', async () => {
    const task = await queue.enqueue(createDefaultAutonomousTask(root, 'blocked terminal goal'));
    await queue.transition(task.taskId, 'preparing');
    await queue.transition(task.taskId, 'waiting_for_approval');
    await queue.transition(task.taskId, 'running');
    await queue.transition(task.taskId, 'blocked', {
      failure: {
        classification: 'invalid_proposal',
        message: 'validation_command_test_path_missing',
      },
    });

    const client = fakeClient([]);
    vi.spyOn(extensionModule, 'getCoreManager').mockReturnValue({ getClient: () => client as never } as never);

    const posted: PostedMessage[] = [];
    const { panel, receive } = attachPanel(root, posted);
    panel.attachAutonomous(queue, runtime);
    receive({ type: 'webviewReady', mode: 'autonomous' });

    await vi.waitFor(() => {
      if (!posted.some(m => m.type === 'workspaceRestorationResolved')) throw new Error('restoration not resolved');
    });

    // Fresh canvas: terminal blocked task is not projected
    expect(posted.some(m => m.type === 'autonomousTaskActive')).toBe(false);
    expect(posted.some(m => m.type === 'autonomousTaskStatus')).toBe(false);
    expect(posted.some(m => m.type === 'newConversation')).toBe(true);
    expect((panel as unknown as { autonomousActiveTaskId?: string }).autonomousActiveTaskId).toBeUndefined();

    const recoverable = await panel.hasActiveRecoverableWork();
    expect(recoverable.hasActiveWork).toBe(false);
  });

  it('recovery_required blocked → fresh canvas', async () => {
    const base = await queue.enqueue(createDefaultAutonomousTask(root, 'interrupted recovery_required goal'));
    await queue.transition(base.taskId, 'preparing');
    await queue.transition(base.taskId, 'running');
    const task = await queue.update(
      {
        ...base,
        state: 'blocked',
        failure: {
          classification: 'recovery_required',
          message: 'Interrupted state requires explicit resume.',
          at: new Date().toISOString(),
        },
      },
      'task_blocked',
    );

    const historyTasks = [{
      attemptId: task.attemptId,
      taskId: task.taskId,
      kind: 'karke_dikha',
      status: 'blocked',
      currentMessage: 'interrupted recovery_required goal',
      createdAt: task.createdAt,
    }];

    const client = fakeClient([], historyTasks);
    vi.spyOn(extensionModule, 'getCoreManager').mockReturnValue({ getClient: () => client as never } as never);

    const posted: PostedMessage[] = [];
    const { panel, receive } = attachPanel(root, posted);
    panel.attachAutonomous(queue, runtime);
    receive({ type: 'webviewReady', mode: 'autonomous' });

    await vi.waitFor(() => {
      if (!posted.some(m => m.type === 'workspaceRestorationResolved')) throw new Error('restoration not resolved');
    });

    // Fresh canvas: blocked recovery_required task must NOT auto-project into main canvas
    expect(posted.some(m => m.type === 'autonomousTaskActive')).toBe(false);
    expect(posted.some(m => m.type === 'autonomousTaskStatus')).toBe(false);
    expect(posted.some(m => m.type === 'newConversation')).toBe(true);
    expect((panel as unknown as { autonomousActiveTaskId?: string }).autonomousActiveTaskId).toBeUndefined();

    const recoverable = await panel.hasActiveRecoverableWork();
    expect(recoverable.hasActiveWork).toBe(false);

    // Remains in durable queue and History
    expect(await queue.get(task.taskId)).toBeDefined();
    receive({ type: 'getEverydayHistory' });
    await vi.waitFor(() => {
      const historyMsg = posted.find(m => m.type === 'everydayHistory') as { available: boolean; tasks: Array<{ attemptId: string }> } | undefined;
      if (!historyMsg) throw new Error('no everydayHistory received');
      expect(historyMsg.available).toBe(true);
      expect(historyMsg.tasks.some(t => t.attemptId === task.attemptId)).toBe(true);
    });
  });

  it('proposal approval pending → restored', async () => {
    const base = await queue.enqueue(createDefaultAutonomousTask(root, 'proposal pending goal'));
    await queue.transition(base.taskId, 'preparing');
    const task = await queue.update(
      {
        ...base,
        state: 'waiting_for_proposal_approval',
        pendingProposal: {
          proposalId: 'prop-restart-1',
          summary: 'Proposed plan',
          operations: [{ type: 'write_file', path: 'src/main.ts', content: 'code' }],
        },
      },
      'proposal_pending',
      { proposalId: 'prop-restart-1' },
    );

    const client = fakeClient([]);
    vi.spyOn(extensionModule, 'getCoreManager').mockReturnValue({ getClient: () => client as never } as never);

    const posted: PostedMessage[] = [];
    const { panel, receive } = attachPanel(root, posted);
    panel.attachAutonomous(queue, runtime);
    receive({ type: 'webviewReady', mode: 'autonomous' });

    // Active task is projected and proposal approval is restored
    await vi.waitFor(() => {
      const active = posted.find(m => m.type === 'autonomousTaskActive' && m.taskId === task.taskId);
      if (!active) throw new Error('active task not projected yet');
      expect(active.restored).toBe(true);
    });

    await vi.waitFor(() => {
      const proposal = posted.find(m => m.type === 'proposalApprovalRequest' && m.taskId === task.taskId);
      if (!proposal) throw new Error('proposal approval not restored yet');
      expect(proposal.proposalId).toBe('prop-restart-1');
    });

    expect((panel as unknown as { autonomousActiveTaskId?: string }).autonomousActiveTaskId).toBe(task.taskId);

    const recoverable = await panel.hasActiveRecoverableWork();
    expect(recoverable.hasActiveWork).toBe(true);
    expect(recoverable.activeTaskId).toBe(task.taskId);
  });

  it('mutation approval pending → restored', async () => {
    const base = await queue.enqueue(createDefaultAutonomousTask(root, 'mutation pending goal'));
    await queue.transition(base.taskId, 'preparing');
    const task = await queue.update(
      {
        ...base,
        state: 'waiting_for_mutation_approval',
        pendingMutationApproval: {
          requestId: 'mut-restart-1',
          proposalId: 'prop-restart-1',
          operationCount: 1,
          targets: ['src/main.ts'],
          elevatedConfirmationRequired: false,
        },
      },
      'mutation_pending',
      { requestId: 'mut-restart-1' },
    );

    const client = fakeClient([]);
    vi.spyOn(extensionModule, 'getCoreManager').mockReturnValue({ getClient: () => client as never } as never);

    const posted: PostedMessage[] = [];
    const { panel, receive } = attachPanel(root, posted);
    panel.attachAutonomous(queue, runtime);
    receive({ type: 'webviewReady', mode: 'autonomous' });

    // Active task is projected and mutation approval is restored
    await vi.waitFor(() => {
      const active = posted.find(m => m.type === 'autonomousTaskActive' && m.taskId === task.taskId);
      if (!active) throw new Error('active task not projected yet');
      expect(active.restored).toBe(true);
    });

    await vi.waitFor(() => {
      const mutation = posted.find(m => m.type === 'mutationApprovalRequest' && m.taskId === task.taskId);
      if (!mutation) throw new Error('mutation approval not restored yet');
      expect(mutation.requestId).toBe('mut-restart-1');
    });

    expect((panel as unknown as { autonomousActiveTaskId?: string }).autonomousActiveTaskId).toBe(task.taskId);

    const recoverable = await panel.hasActiveRecoverableWork();
    expect(recoverable.hasActiveWork).toBe(true);
    expect(recoverable.activeTaskId).toBe(task.taskId);
  });

  it('running → restored', async () => {
    const task = await queue.enqueue(createDefaultAutonomousTask(root, 'running goal'));
    await queue.transition(task.taskId, 'preparing');
    await queue.transition(task.taskId, 'waiting_for_approval');
    await queue.transition(task.taskId, 'running');

    const client = fakeClient([]);
    vi.spyOn(extensionModule, 'getCoreManager').mockReturnValue({ getClient: () => client as never } as never);

    const posted: PostedMessage[] = [];
    const { panel, receive } = attachPanel(root, posted);
    panel.attachAutonomous(queue, runtime);
    receive({ type: 'webviewReady', mode: 'autonomous' });

    // Running task is active and auto-restores to canvas
    await vi.waitFor(() => {
      const active = posted.find(m => m.type === 'autonomousTaskActive' && m.taskId === task.taskId);
      if (!active) throw new Error('running task not projected yet');
      expect(active.restored).toBe(true);
    });

    expect((panel as unknown as { autonomousActiveTaskId?: string }).autonomousActiveTaskId).toBe(task.taskId);

    const recoverable = await panel.hasActiveRecoverableWork();
    expect(recoverable.hasActiveWork).toBe(true);
    expect(recoverable.activeTaskId).toBe(task.taskId);
  });

  it('validating → restored', async () => {
    const task = await queue.enqueue(createDefaultAutonomousTask(root, 'validating goal'));
    await queue.transition(task.taskId, 'preparing');
    await queue.transition(task.taskId, 'waiting_for_approval');
    await queue.transition(task.taskId, 'running');
    await queue.transition(task.taskId, 'validating');

    const client = fakeClient([]);
    vi.spyOn(extensionModule, 'getCoreManager').mockReturnValue({ getClient: () => client as never } as never);

    const posted: PostedMessage[] = [];
    const { panel, receive } = attachPanel(root, posted);
    panel.attachAutonomous(queue, runtime);
    receive({ type: 'webviewReady', mode: 'autonomous' });

    // Validating task is active and auto-restores to canvas
    await vi.waitFor(() => {
      const active = posted.find(m => m.type === 'autonomousTaskActive' && m.taskId === task.taskId);
      if (!active) throw new Error('validating task not projected yet');
      expect(active.restored).toBe(true);
    });

    expect((panel as unknown as { autonomousActiveTaskId?: string }).autonomousActiveTaskId).toBe(task.taskId);

    const recoverable = await panel.hasActiveRecoverableWork();
    expect(recoverable.hasActiveWork).toBe(true);
    expect(recoverable.activeTaskId).toBe(task.taskId);
  });

  it('delivery approval pending → restored', async () => {
    const task = await queue.enqueue(createDefaultAutonomousTask(root, 'delivery pending goal'));
    await queue.transition(task.taskId, 'preparing');
    await queue.transition(task.taskId, 'running');
    await queue.transition(task.taskId, 'validating');
    await queue.transition(task.taskId, 'waiting_for_delivery_approval');

    const client = fakeClient([]);
    vi.spyOn(extensionModule, 'getCoreManager').mockReturnValue({ getClient: () => client as never } as never);

    const posted: PostedMessage[] = [];
    const { panel, receive } = attachPanel(root, posted);
    panel.attachAutonomous(queue, runtime);
    receive({ type: 'webviewReady', mode: 'autonomous' });

    // Active task is projected and delivery approval is restored
    await vi.waitFor(() => {
      const active = posted.find(m => m.type === 'autonomousTaskActive' && m.taskId === task.taskId);
      if (!active) throw new Error('active task not projected yet');
      expect(active.restored).toBe(true);
    });

    await vi.waitFor(() => {
      const delivery = posted.find(m => m.type === 'deliveryApprovalRequest' && m.taskId === task.taskId);
      if (!delivery) throw new Error('delivery approval not restored yet');
    });

    expect((panel as unknown as { autonomousActiveTaskId?: string }).autonomousActiveTaskId).toBe(task.taskId);

    const recoverable = await panel.hasActiveRecoverableWork();
    expect(recoverable.hasActiveWork).toBe(true);
    expect(recoverable.activeTaskId).toBe(task.taskId);
  });
});
