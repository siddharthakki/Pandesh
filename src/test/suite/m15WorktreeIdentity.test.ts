import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import {
  AutonomousTask,
  DurableTaskQueue,
  IsolatedWorktreeManager,
  createDefaultAutonomousTask,
} from '../../autonomous/M15AutonomousWork';
import { WorktreeManager } from '../../orchestration/WorktreeManager';
import { GitWorktreeHost } from '../../workspace/WorkspaceHost';

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync('git', args, {
    cwd,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  return result.stdout.trim();
}

async function initGit(root: string): Promise<void> {
  await fs.writeFile(path.join(root, 'README.md'), '# M15 worktree identity test\n', 'utf8');
  for (const args of [
    ['init'],
    ['config', 'user.email', 'test@example.com'],
    ['config', 'user.name', 'Test'],
    ['add', '.'],
    ['commit', '-m', 'init'],
  ]) {
    await git(root, args);
  }
}

describe('M15 worktree identity binding', () => {
  let root: string;
  let queue: DurableTaskQueue;
  let manager: WorktreeManager;
  let worktrees: IsolatedWorktreeManager;
  let boundTask: AutonomousTask | undefined;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-m15-identity-'));
    await initGit(root);
    queue = new DurableTaskQueue(root);
    manager = new WorktreeManager(root);
    worktrees = new IsolatedWorktreeManager(root, async () => new GitWorktreeHost(root));
  });

  afterEach(async () => {
    if (boundTask) {
      await manager.cleanup(boundTask.taskId).catch(() => undefined);
    }
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  async function bind(goal = 'verify worktree identity'): Promise<AutonomousTask> {
    const queued = await queue.enqueue(createDefaultAutonomousTask(root, goal));
    const bound = await worktrees.bind(queued);
    boundTask = bound.task;
    return bound.task;
  }

  it('stores the exact branch that is actually checked out in the isolated worktree', async () => {
    const task = await bind();
    await expect(worktrees.assertBinding(task)).resolves.toBeUndefined();

    const actualBranch = await git(task.worktreeLocation!, ['branch', '--show-current']);
    expect(task.branchName).toBe(actualBranch);
    expect(task.branchName).toMatch(/^forge\//);
    expect(path.resolve(task.worktreeLocation!)).not.toBe(path.resolve(root));
  });

  it('rejects a persisted task record redirected to the original checkout', async () => {
    const task = await bind();
    await expect(worktrees.assertBinding({ ...task, worktreeLocation: root }))
      .rejects.toThrow('worktree_identity_mismatch:worktree_path');
  });

  it('rejects branch metadata that does not match the lease and checked-out branch', async () => {
    const task = await bind();
    await expect(worktrees.assertBinding({ ...task, branchName: 'forge/tampered' }))
      .rejects.toThrow('worktree_identity_mismatch:branch_metadata');
  });

  it('rejects a persisted base commit that does not match the worktree lease', async () => {
    const task = await bind();
    await expect(worktrees.assertBinding({ ...task, worktreeBaseCommit: '0'.repeat(40) }))
      .rejects.toThrow('worktree_identity_mismatch:base_commit_metadata');
  });

  it('rejects a missing or finalized lease instead of trusting stale task metadata', async () => {
    const task = await bind();
    await worktrees.finalize(task, 'failed');
    await expect(worktrees.assertBinding(task))
      .rejects.toThrow('worktree_identity_mismatch:lease_unavailable');
  });

  describe('resumed retained lease (M42 same-task resume)', () => {
    it('reactivating a retained failed lease confers nothing: tampered identity is still rejected afterwards', async () => {
      const task = await bind();
      await worktrees.finalize(task, 'failed', { dispose: false });
      await expect(worktrees.assertBinding(task)).rejects.toThrow('worktree_identity_mismatch:lease_unavailable');

      expect(await worktrees.reactivateRetryableLease(task)).toBe(true);
      await expect(worktrees.assertBinding(task)).resolves.toBeUndefined();
      await expect(worktrees.assertBinding({ ...task, branchName: 'forge/tampered' }))
        .rejects.toThrow('worktree_identity_mismatch:branch_metadata');
      await expect(worktrees.assertBinding({ ...task, worktreeLocation: root }))
        .rejects.toThrow('worktree_identity_mismatch:worktree_path');
      await expect(worktrees.assertBinding({ ...task, worktreeBaseCommit: '0'.repeat(40) }))
        .rejects.toThrow('worktree_identity_mismatch:base_commit_metadata');
    });

    it('only a failed lease is reactivated; completed and unknown leases are not', async () => {
      const task = await bind();
      expect(await worktrees.reactivateRetryableLease(task)).toBe(false); // already active
      await worktrees.finalize(task, 'completed');
      expect(await worktrees.reactivateRetryableLease(task)).toBe(false);
      expect(await worktrees.reactivateRetryableLease({ ...task, taskId: 'no-such-task' })).toBe(false);
      await expect(worktrees.assertBinding(task)).rejects.toThrow('worktree_identity_mismatch:lease_unavailable');
    });

    it('the runtime revalidates identity before the task can run: reactivate -> assertBinding -> running -> recovery/executor', async () => {
      const source = await fs.readFile(path.resolve(__dirname, '../../activation/M15AutonomousRuntime.ts'), 'utf8');
      const reactivate = source.indexOf('this.worktrees.reactivateRetryableLease(current)');
      const assertBinding = source.indexOf('await this.worktrees.assertBinding(current);');
      const running = source.indexOf("this.queue.transition(current.taskId, 'running', { reason: 'graph_dispatch' })");
      const openRecovery = source.indexOf('await this.openRecovery(current, workspaceRoot');
      const execute = source.indexOf('this.executor.execute({', openRecovery);
      expect(reactivate).toBeGreaterThan(-1);
      expect(assertBinding).toBeGreaterThan(reactivate);
      expect(running).toBeGreaterThan(assertBinding);
      expect(openRecovery).toBeGreaterThan(running);
      expect(execute).toBeGreaterThan(openRecovery);
    });
  });
});
