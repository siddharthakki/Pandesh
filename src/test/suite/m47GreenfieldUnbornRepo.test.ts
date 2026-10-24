import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as vscode from 'vscode';
import * as vscodeMock from '../mocks/vscode';
import {
  AutonomousTask,
  DurableTaskQueue,
  IsolatedWorktreeManager,
  TaskResourceScheduler,
  createDefaultAutonomousTask,
} from '../../autonomous/M15AutonomousWork';
import { AutonomousTaskRuntime } from '../../activation/M15AutonomousRuntime';
import { WorktreeManager, UNBORN_HEAD_COMMIT } from '../../orchestration/WorktreeManager';
import { GitWorktreeHost, PlainFolderHost } from '../../workspace/WorkspaceHost';
import { deliverLocally } from '../../orchestration/LocalDeliveryService';
import { ProviderGateway } from '../../providers/ProviderGateway';
import { InferenceProvider, ModelInfo, ProviderChatOptions } from '../../providers/ProviderTypes';
import { ChatMessage, ChatResponse, ToolDefinition } from '../../tools/ToolTypes';

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync('git', args, {
    cwd,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  return result.stdout.trim();
}

async function isUnborn(cwd: string): Promise<boolean> {
  try {
    const out = await execFileAsync('git', ['rev-parse', '--verify', '-q', 'HEAD'], { cwd, windowsHide: true });
    return !String(out.stdout ?? '').trim();
  } catch {
    return true;
  }
}

async function initGit(root: string, commit = true): Promise<void> {
  for (const args of [
    ['init'],
    ['config', 'user.email', 'test@example.com'],
    ['config', 'user.name', 'Test'],
  ]) {
    await git(root, args);
  }
  if (commit) {
    await fs.writeFile(path.join(root, 'README.md'), '# M47 greenfield test\n', 'utf8');
    await git(root, ['add', '.']);
    await git(root, ['commit', '-m', 'init']);
  }
}

describe('M47 greenfield (unborn HEAD) governed workspaces', () => {
  let root: string;
  let queue: DurableTaskQueue;
  let manager: WorktreeManager;
  let worktrees: IsolatedWorktreeManager;
  const boundTaskIds: string[] = [];

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-m47-greenfield-'));
    await initGit(root, false);
    queue = new DurableTaskQueue(root);
    manager = new WorktreeManager(root);
    worktrees = new IsolatedWorktreeManager(root, async () => new GitWorktreeHost(root));
  });

  afterEach(async () => {
    for (const taskId of boundTaskIds) {
      await manager.cleanup(taskId).catch(() => undefined);
    }
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  async function bindFresh(goal = 'create a greenfield task'): Promise<AutonomousTask> {
    const queued = await queue.enqueue(createDefaultAutonomousTask(root, goal));
    const bound = await worktrees.bind(queued);
    boundTaskIds.push(bound.task.taskId);
    return bound.task;
  }

  it('A: a normal repository with HEAD keeps the existing binding behaviour', async () => {
    await fs.writeFile(path.join(root, 'README.md'), '# committed\n', 'utf8');
    await git(root, ['add', '.']);
    await git(root, ['commit', '-m', 'init']);
    const base = await manager.getBaseCommit();
    expect(base).toMatch(/^[0-9a-f]{40}$/);
    expect(base).not.toBe(UNBORN_HEAD_COMMIT);

    const task = await bindFresh();
    expect(task.worktreeBaseCommit).toBe(base);
    expect(task.branchName).toMatch(/^forge\//);
    await expect(worktrees.assertBinding(task)).resolves.toBeUndefined();
  });

  it('B: a git init repository with zero commits prepares a governed workspace without a rev-parse HEAD runtime_error', async () => {
    expect(await isUnborn(root)).toBe(true);
    expect(await manager.getBaseCommit()).toBe(UNBORN_HEAD_COMMIT);

    const task = await bindFresh();
    expect(task.worktreeLocation).toBeTruthy();
    expect(task.worktreeBaseCommit).toBe(UNBORN_HEAD_COMMIT);
    expect(task.branchName).toMatch(/^forge\//);
    await expect(worktrees.assertBinding(task)).resolves.toBeUndefined();
  });

  it('C: exactly one governed isolated workspace is established and the binding is durable', async () => {
    const task = await bindFresh();
    const leases = await worktrees.listLeases();
    expect(leases).toHaveLength(1);
    expect(leases[0].baseCommit).toBe(UNBORN_HEAD_COMMIT);
    expect(path.resolve(leases[0].worktreePath)).not.toBe(path.resolve(root));

    const persisted = await queue.update({ ...task }, 'worktree_bound', { branchName: task.branchName });
    const reloaded = await queue.get(task.taskId);
    expect(reloaded?.worktreeLocation).toBe(persisted.worktreeLocation);
    expect(reloaded?.worktreeBaseCommit).toBe(UNBORN_HEAD_COMMIT);
    expect(reloaded?.branchName).toBe(persisted.branchName);
    await expect(worktrees.assertBinding(reloaded!)).resolves.toBeUndefined();
  });

  it('D: retry/restart before first mutation reuses the same worktree and continues safely', async () => {
    const bound = await bindFresh();
    // Mirror the runtime: the bound worktree identity is durably persisted.
    const task = (await queue.update(bound, 'worktree_bound', { branchName: bound.branchName }))!;
    // A blocked task keeps its worktree but its lease is marked failed.
    await worktrees.finalize(task, 'failed', { dispose: false });
    await expect(worktrees.assertBinding(task)).rejects.toThrow('worktree_identity_mismatch:lease_unavailable');

    // A brand-new runtime instance over the same durable manifest (restart).
    const restarted = new IsolatedWorktreeManager(root, async () => new GitWorktreeHost(root));
    const persisted = (await queue.get(task.taskId))!;
    expect(await restarted.reactivateRetryableLease(persisted)).toBe(true);
    await expect(restarted.assertBinding(persisted)).resolves.toBeUndefined();

    const leases = await restarted.listLeases();
    expect(leases).toHaveLength(1);
    const worktreeList = await git(root, ['worktree', 'list']);
    expect(worktreeList.split(/\r?\n/).filter(Boolean)).toHaveLength(2);
  });

  it('E: no silent mutation or commit is made to the user\'s original repository', async () => {
    const task = await bindFresh();
    expect(await isUnborn(root)).toBe(true);
    const log = await execFileAsync('git', ['log', '--oneline'], { cwd: root, windowsHide: true }).then(() => 'has-commit', () => 'unborn');
    expect(log).toBe('unborn');
    expect(await isUnborn(task.worktreeLocation!)).toBe(true);
    const branch = await git(root, ['branch', '--show-current']);
    expect(branch).toBe('master');
  });

  it('F: an ambiguous or foreign worktree still safe-stops; a committed task branch is rejected', async () => {
    const task = await bindFresh();
    await expect(worktrees.assertBinding({ ...task, worktreeLocation: root }))
      .rejects.toThrow('worktree_identity_mismatch:worktree_path');
    await expect(worktrees.assertBinding({ ...task, branchName: 'forge/foreign' }))
      .rejects.toThrow('worktree_identity_mismatch:branch_metadata');

    // A foreign commit landing on the task branch before execution must fail
    // closed rather than be adopted.
    await fs.writeFile(path.join(task.worktreeLocation!, 'foreign.txt'), 'x\n', 'utf8');
    await git(task.worktreeLocation!, ['add', '--all']);
    await git(task.worktreeLocation!, ['commit', '-m', 'foreign commit']);
    await expect(worktrees.assertBinding(task)).rejects.toThrow('worktree_identity_mismatch:head_commit');
  });

  it('G: cancellation and a missing binding remain unchanged', async () => {
    const task = await bindFresh();
    await worktrees.finalize(task, 'cancelled');
    await expect(worktrees.assertBinding(task)).rejects.toThrow('worktree_identity_mismatch:lease_unavailable');

    const unbound = await queue.enqueue(createDefaultAutonomousTask(root, 'unbound'));
    await expect(worktrees.assertBinding(unbound)).rejects.toThrow('worktree_identity_mismatch:missing_binding');
  });

  it('B2: a plain-scope-lock host (no Git branch) is now identity-verifiable instead of missing_binding', async () => {
    const plainRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-m47-plain-'));
    try {
      const plainQueue = new DurableTaskQueue(plainRoot);
      const plain = new IsolatedWorktreeManager(plainRoot, async () => new PlainFolderHost(plainRoot));
      const queued = await plainQueue.enqueue(createDefaultAutonomousTask(plainRoot, 'plain scope lock task'));
      const bound = await plain.bind(queued);
      expect(bound.task.branchName).toBeUndefined();
      await expect(plain.assertBinding(bound.task)).resolves.toBeUndefined();
    } finally {
      await fs.rm(plainRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});

describe('M47 greenfield local delivery to an unborn destination', () => {
  let root: string;
  let worktrees: IsolatedWorktreeManager;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-m47-delivery-'));
    await initGit(root, false);
    worktrees = new IsolatedWorktreeManager(root, async () => new GitWorktreeHost(root));
  });

  afterEach(async () => {
    await worktrees.listLeases().then(leases => Promise.all(
      leases.map(lease => new WorktreeManager(root).cleanup(lease.taskId).catch(() => undefined)),
    ));
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('delivers a governed root commit into an unborn destination branch', async () => {
    const queued = await new DurableTaskQueue(root).enqueue(createDefaultAutonomousTask(root, 'write hello.txt'));
    const bound = await worktrees.bind(queued);
    const wt = bound.task.worktreeLocation!;
    await fs.writeFile(path.join(wt, 'hello.txt'), 'hello\n', 'utf8');
    await git(wt, ['add', '--all']);
    await git(wt, ['commit', '-m', 'greenfield delivery']);
    const taskCommit = await git(wt, ['rev-parse', 'HEAD']);

    const outcome = await deliverLocally({
      workspaceRoot: root,
      taskRepositoryRoot: root,
      taskBranch: 'master',
      worktreeBaseCommit: UNBORN_HEAD_COMMIT,
      taskCommitSha: taskCommit,
      approvedCommitSha: taskCommit,
      approvedChangedPaths: ['hello.txt'],
    });

    expect(outcome.delivered).toBe(true);
    expect(outcome.workspaceHead).toBe(taskCommit);
    expect(await git(root, ['rev-parse', 'HEAD'])).toBe(taskCommit);
    expect((await fs.readFile(path.join(root, 'hello.txt'), 'utf8')).replace(/\r\n/g, '\n')).toBe('hello\n');
  });

  it('blocks when the unborn workspace has since gained commits', async () => {
    const queued = await new DurableTaskQueue(root).enqueue(createDefaultAutonomousTask(root, 'write hello.txt'));
    const bound = await worktrees.bind(queued);
    const wt = bound.task.worktreeLocation!;
    await fs.writeFile(path.join(wt, 'hello.txt'), 'hello\n', 'utf8');
    await git(wt, ['add', '--all']);
    await git(wt, ['commit', '-m', 'greenfield delivery']);
    const taskCommit = await git(wt, ['rev-parse', 'HEAD']);

    // Workspace already has the first commit (no longer unborn).
    await git(root, ['merge', '--ff-only', taskCommit]);

    const outcome = await deliverLocally({
      workspaceRoot: root,
      taskRepositoryRoot: root,
      taskBranch: 'master',
      worktreeBaseCommit: UNBORN_HEAD_COMMIT,
      taskCommitSha: taskCommit,
      approvedCommitSha: taskCommit,
      approvedChangedPaths: ['hello.txt'],
    });
    expect(outcome.delivered).toBe(false);
    expect(outcome.blockedReason).toBe('head_mismatch');
  });

  it('blocks a non-root (descendant) commit against a greenfield base', async () => {
    const queued = await new DurableTaskQueue(root).enqueue(createDefaultAutonomousTask(root, 'two commits'));
    const bound = await worktrees.bind(queued);
    const wt = bound.task.worktreeLocation!;
    await fs.writeFile(path.join(wt, 'a.txt'), 'a\n', 'utf8');
    await git(wt, ['add', '--all']);
    await git(wt, ['commit', '-m', 'first']);
    await fs.writeFile(path.join(wt, 'b.txt'), 'b\n', 'utf8');
    await git(wt, ['add', '--all']);
    await git(wt, ['commit', '-m', 'second']);
    const taskCommit = await git(wt, ['rev-parse', 'HEAD']);

    const outcome = await deliverLocally({
      workspaceRoot: root,
      taskRepositoryRoot: root,
      taskBranch: 'master',
      worktreeBaseCommit: UNBORN_HEAD_COMMIT,
      taskCommitSha: taskCommit,
      approvedCommitSha: taskCommit,
      approvedChangedPaths: ['b.txt'],
    });
    expect(outcome.delivered).toBe(false);
    expect(outcome.blockedReason).toBe('not_descendant');
  });
});

class GreenfieldCodingProvider implements InferenceProvider {
  readonly providerType = 'ollama' as const;
  readonly prompts: string[] = [];
  completion: string = JSON.stringify({
    version: 1,
    taskSummary: 'Create hello world',
    operations: [{ type: 'create', path: 'hello.txt', reason: 'hello world', content: 'hello world\n' }],
    validationCommands: [],
    warnings: [],
    status: 'proposed',
  });
  async healthCheck(): Promise<void> {}
  async listModels(): Promise<ModelInfo[]> { return []; }
  async chat(messages: ChatMessage[], _tools: ToolDefinition[], _options: ProviderChatOptions): Promise<ChatResponse> {
    const prompt = messages.map(message => message.content).join('\n');
    this.prompts.push(prompt);
    const proposal = JSON.parse(this.completion) as Record<string, unknown>;
    const content = prompt.includes('Investigation turn')
      ? JSON.stringify({ action: 'submit_proposal', proposal })
      : this.completion;
    return { message: { role: 'assistant', content }, done: true };
  }
}

describe('M47 greenfield runtime end-to-end mission on an unborn repository', () => {
  let root: string;
  let provider: GreenfieldCodingProvider;
  let queue: DurableTaskQueue;
  let resources: TaskResourceScheduler;
  let worktrees: IsolatedWorktreeManager;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-m47-runtime-'));
    await initGit(root, false);
    await fs.writeFile(path.join(root, '.gitignore'), '.ollama-agent/\n', 'utf8');
    provider = new GreenfieldCodingProvider();
    vscodeMock._resetConfig();
    vscodeMock._resetCommands();
    vscodeMock._resetWindowState();
    vscodeMock._setConfig('ollama-agent.providerType', 'ollama');
    vscodeMock._setConfig('ollama-agent.codingModel', 'fake-coder');
    vi.spyOn(ProviderGateway, 'create').mockResolvedValue(provider);
    queue = new DurableTaskQueue(root);
    resources = new TaskResourceScheduler({ maxActiveTasks: 2, maxActiveMutatingTasks: 1, modelConcurrency: { '*': 2 } });
    worktrees = new IsolatedWorktreeManager(root);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vscodeMock._resetConfig();
    vscodeMock._resetCommands();
    vscodeMock._resetWindowState();
    await worktrees.listLeases().then(leases => Promise.all(
      leases.map(lease => new WorktreeManager(root).cleanup(lease.taskId).catch(() => undefined)),
    ));
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('runs fresh task -> governed orphan worktree -> proposal/mutation/validation -> governed first delivery into the unborn branch', async () => {
    const task = await queue.enqueue(createDefaultAutonomousTask(root, 'create hello world'));
    const runtime = new AutonomousTaskRuntime(
      {
        subscriptions: [],
        secrets: { get: async () => undefined, store: async () => undefined, delete: async () => undefined, onDidChange: () => ({ dispose: () => undefined }) },
        extension: {
          packageJSON: {
            scripts: { 'test:live:m16': 'node scripts/live-m16-acceptance.mjs' },
            contributes: {
              commands: [
                { command: 'ollama-agent.runEvaluationSuite' },
                { command: 'ollama-agent.showQualityGateDecision' },
              ],
            },
          },
        },
      } as unknown as vscode.ExtensionContext,
      root,
      queue,
      resources,
      worktrees,
    );
    runtime.onProposalApprovalRequired(async pending => {
      if (!pending.pendingProposal) return;
      await runtime.approveProposal(pending.taskId, pending.pendingProposal.proposalId).catch(() => undefined);
    });
    runtime.onMutationApprovalRequired(async pending => {
      if (!pending.pendingMutationApproval) return;
      await runtime.approveMutation(pending.taskId, pending.pendingMutationApproval.requestId).catch(() => undefined);
    });
    vscodeMock._setQuickPickSelection({ label: 'Summary: Create hello world' });
    vscodeMock._setWarningMessageSelection('Approve Execution');

    runtime.wake();
    await runtime.waitForIdle();

    const pending = await queue.get(task.taskId);
    expect(pending?.state).toBe('waiting_for_delivery_approval');
    expect(pending?.worktreeLocation).toBeTruthy();
    expect(pending?.worktreeBaseCommit).toBe(UNBORN_HEAD_COMMIT);
    expect(path.resolve(pending!.worktreeLocation!)).not.toBe(path.resolve(root));
    await expect(worktrees.assertBinding(pending!)).resolves.toBeUndefined();
    // The primary repository is untouched up to this point (no silent commit).
    expect(await isUnborn(root)).toBe(true);

    await runtime.approveDelivery(task.taskId);

    const completed = await queue.get(task.taskId);
    expect(completed?.state).toBe('completed');
    expect(await git(root, ['rev-parse', 'HEAD'])).toBe(completed?.githubDelivery.commitSha);
    expect((await fs.readFile(path.join(root, 'hello.txt'), 'utf8')).replace(/\r\n/g, '\n')).toBe('hello world\n');
    expect(await git(root, ['branch', '--show-current'])).toBe('master');
    runtime.dispose();
  });
});
