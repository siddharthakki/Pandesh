import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { AutonomousTaskRuntime } from '../../activation/M15AutonomousRuntime';
import {
  DurableTaskQueue,
  IsolatedWorktreeManager,
  TaskResourceScheduler,
  TaskRuntimeCoordinator,
  createDefaultAutonomousTask,
} from '../../autonomous/M15AutonomousWork';

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
  await fs.writeFile(path.join(root, 'README.md'), '# Automatic M17 delivery fixture\n', 'utf8');
  await fs.writeFile(path.join(root, '.gitignore'), '.ollama-agent/\n.forge/\n', 'utf8');
  for (const args of [
    ['init'],
    ['config', 'user.email', 'm17-e2e@example.invalid'],
    ['config', 'user.name', 'M17 Automatic Delivery'],
    ['add', '.'],
    ['commit', '-m', 'initial fixture'],
  ]) {
    await git(root, args);
  }
}

describe('M17 automatic delivery end-to-end', () => {
  let root: string;
  let worktreePath: string | undefined;
  let worktreeBranch: string | undefined;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-m17-auto-delivery-'));
    await initGit(root);
  });

  afterEach(async () => {
    if (worktreePath) {
      await git(root, ['worktree', 'remove', '--force', worktreePath]).catch(() => undefined);
    }
    if (worktreeBranch) {
      await git(root, ['branch', '-D', worktreeBranch]).catch(() => undefined);
    }
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('automatically approves delivery, commits the reviewed diff, completes the task, and performs no external delivery', async () => {
    const sourceHeadBefore = await git(root, ['rev-parse', 'HEAD']);
    const sourceStatusBefore = await git(root, ['status', '--short']);

    const queue = new DurableTaskQueue(root);
    const resources = new TaskResourceScheduler({
      maxActiveTasks: 1,
      maxActiveMutatingTasks: 1,
      modelConcurrency: { '*': 1 },
    });
    const worktrees = new IsolatedWorktreeManager(root);
    const coordinator = new TaskRuntimeCoordinator(queue, resources, worktrees);
    await coordinator.activateRecovery();

    const enqueued = await queue.enqueue({
      ...createDefaultAutonomousTask(root, 'Create the bounded M17 automatic delivery marker.'),
      providerModelRoutingSnapshot: { provider: 'fake-local', model: 'm17-e2e' },
      githubDelivery: { transport: 'fake' },
    });

    const claimed = await coordinator.processOne();
    expect(claimed?.taskId).toBe(enqueued.taskId);

    let task = await queue.get(enqueued.taskId);
    expect(task?.state).toBe('waiting_for_approval');
    expect(task?.worktreeLocation).toBeTruthy();
    expect(task?.branchName).toBeTruthy();

    worktreePath = task!.worktreeLocation!;
    worktreeBranch = task!.branchName!;
    const baseCommit = task!.worktreeBaseCommit!;

    task = await queue.transition(task!.taskId, 'running', { reason: 'automatic_e2e_test' });
    const changedPath = 'm17-automatic-delivery.txt';
    await fs.writeFile(
      path.join(worktreePath, changedPath),
      'M17 automatic delivery end-to-end marker\n',
      'utf8',
    );

    task = await queue.transition(task.taskId, 'validating', { reason: 'synthetic_change_applied' });
    task = await queue.update(
      {
        ...task,
        instructionRevision: task.instructionRevision ?? 0,
        evidence: [...task.evidence, 'validation:passed'],
        qualityGate: {
          gateId: 'm15-autonomous-delivery-quality-gate',
          runId: 'm17-auto-delivery-e2e',
          status: 'passed',
          findingsCount: 0,
          decidedAt: new Date().toISOString(),
        },
        mutationEvidence: {
          instructionRevision: task.instructionRevision ?? 0,
          expectedPaths: [changedPath],
          changedPaths: [changedPath],
          contentVerified: true,
          gitDiffPresent: true,
          alreadySatisfied: false,
          verifiedAt: new Date().toISOString(),
        },
        diffReview: {
          instructionRevision: task.instructionRevision ?? 0,
          verdict: 'pass',
          requirementFindings: [],
          changedFileFindings: [],
          validationFindings: [],
          securityFindings: [],
          explanation: 'Deterministic end-to-end fixture diff approved.',
          reviewerProvider: 'deterministic-host',
          reviewerModel: 'deterministic',
          decidedAt: new Date().toISOString(),
          approvedScopePaths: [changedPath],
        },
      },
      'm17_automatic_delivery_ready',
      { approvedScopePaths: [changedPath] },
    );
    await queue.transition(task.taskId, 'waiting_for_delivery_approval', { reason: 'quality_and_diff_review_passed' });

    const runtime = new AutonomousTaskRuntime(
      {} as never,
      root,
      queue,
      resources,
      worktrees,
    );
    try {
      await runtime.approveDelivery(task.taskId);
    } finally {
      runtime.dispose();
    }

    const completed = await queue.get(task.taskId);
    expect(completed?.state).toBe('completed');
    expect(completed?.githubDelivery.transport).toBe('fake');
    expect(completed?.githubDelivery.pullRequestNumber).toBeUndefined();
    expect(completed?.githubDelivery.pullRequestUrl).toBeUndefined();
    expect(completed?.githubDelivery.branchPushed).not.toBe(true);
    expect(completed?.githubDelivery.commitSha).toMatch(/^[0-9a-f]{40}$/);

    const committedHead = await git(worktreePath, ['rev-parse', 'HEAD']);
    expect(committedHead).toBe(completed?.githubDelivery.commitSha);
    expect(await git(worktreePath, ['rev-parse', 'HEAD^'])).toBe(baseCommit);
    expect(await git(worktreePath, ['show', '--format=', '--name-only', 'HEAD'])).toContain(changedPath);
    expect(await git(worktreePath, ['status', '--short'])).toBe('');

    // M40: local (non-GitHub-issue) delivery now fast-forwards the
    // currently-open workspace (`root`) to the delivered commit as part of
    // the delivery-approval gate — see src/orchestration/LocalDeliveryService.ts.
    // `root` is clean and on the same branch it started on (no branch
    // switch), but its HEAD now advances past `sourceHeadBefore`.
    expect(await git(root, ['rev-parse', 'HEAD'])).toBe(completed?.githubDelivery.commitSha);
    expect(await git(root, ['rev-parse', 'HEAD'])).not.toBe(sourceHeadBefore);
    expect(await git(root, ['status', '--short'])).toBe(sourceStatusBefore);
    // The delivered file now legitimately exists in the open workspace too.
    const deliveredInWorkspace = await fs.readFile(path.join(root, changedPath), 'utf8');
    expect(deliveredInWorkspace).toContain('M17 automatic delivery end-to-end marker');
  });
});
