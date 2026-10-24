import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import {
  assertAllM17Invariants,
  assertNoAutomaticDelivery,
  assertSnapshotsIdentical,
  assertWorktreeIsolated,
  buildEvidenceArtifact,
  captureRepoSnapshot,
  fingerprintText,
  resolveGitRepoRoot,
  runBoundedM17Task,
  type M17RunResult,
  type RepoSnapshot,
} from '../../acceptance/M17DogfoodAcceptance';

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync('git', args, { cwd, windowsHide: true, maxBuffer: 1024 * 1024 });
  return result.stdout.trim();
}

async function initGit(root: string): Promise<void> {
  await fs.writeFile(path.join(root, 'README.md'), '# M17 dogfood acceptance test fixture\n', 'utf8');
  // Real target repositories (e.g. khakedikha) gitignore .ollama-agent/, so the
  // durable task queue's bookkeeping never shows up as working-tree dirt. Mirror
  // that here so the before/after dirty-state snapshot is a fair comparison.
  await fs.writeFile(path.join(root, '.gitignore'), '.ollama-agent/\n', 'utf8');
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

function fakeRun(overrides: Partial<M17RunResult> = {}): M17RunResult {
  return {
    taskId: 'm17_fake_task',
    attemptId: 'attempt_fake',
    worktreePath: 'C:\\temp\\worktree',
    worktreeBranch: 'forge/m17_fake_task-goal',
    worktreeBaseCommit: '0'.repeat(40),
    providerModelRouting: { provider: 'fake-local', model: 'm17-dogfood-synthetic' },
    approvals: { proposalReviewApprovedAt: new Date().toISOString(), executionApprovalApprovedAt: new Date().toISOString() },
    mutatedFiles: ['synthetic-change.txt'],
    validation: [{ command: 'node -e process.exit(0)', exitCode: 0, timedOut: false, summary: '(no output)' }],
    qualityGate: { gateId: 'm15-autonomous-delivery-quality-gate', runId: 'm16run_fake', status: 'passed', findingsCount: 0 },
    finalState: 'waiting_for_delivery_approval',
    deliveryTransport: 'fake',
    ...overrides,
  };
}

function fakeSnapshot(overrides: Partial<RepoSnapshot> = {}): RepoSnapshot {
  return { branch: 'master', head: 'a'.repeat(40), dirty: false, dirtyLines: [], ...overrides };
}

describe('M17 dogfood acceptance harness', () => {
  describe('resolveGitRepoRoot', () => {
    it('rejects a non-git target root', async () => {
      const nonGitRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-m17-nongit-'));
      try {
        await expect(resolveGitRepoRoot(nonGitRoot)).rejects.toThrow('m17_target_not_a_git_repository');
      } finally {
        await fs.rm(nonGitRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      }
    });

    it('resolves a real git repository root', async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-m17-git-'));
      try {
        await initGit(root);
        const resolved = await resolveGitRepoRoot(root);
        expect(resolved.toLowerCase()).toBe((await fs.realpath(root)).toLowerCase());
      } finally {
        await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      }
    });

    it('rejects a subdirectory that is not itself the repository root', async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-m17-subdir-'));
      try {
        await initGit(root);
        const sub = path.join(root, 'src');
        await fs.mkdir(sub, { recursive: true });
        await expect(resolveGitRepoRoot(sub)).rejects.toThrow('m17_target_not_repository_root');
      } finally {
        await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      }
    });
  });

  describe('a fully successful synthetic run', () => {
    let root: string;

    beforeEach(async () => {
      root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-m17-run-'));
      await initGit(root);
    });

    afterEach(async () => {
      await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    });

    it('binds an isolated worktree distinct from the target repo root, and the worktree branch/HEAD match the lease', async () => {
      const before = await captureRepoSnapshot(root);
      const run = await runBoundedM17Task(root, { goal: 'add a bounded synthetic slice', goalFingerprint: fingerprintText('goal') });
      expect(path.resolve(run.worktreePath).toLowerCase()).not.toBe(path.resolve(root).toLowerCase());
      const actualBranch = await git(run.worktreePath, ['branch', '--show-current']);
      const actualHead = await git(run.worktreePath, ['rev-parse', 'HEAD']);
      expect(actualBranch).toBe(run.worktreeBranch);
      expect(actualHead).toBe(run.worktreeBaseCommit);
      const after = await captureRepoSnapshot(root);
      expect(() => assertSnapshotsIdentical(before, after)).not.toThrow();
    });

    it('reaches waiting_for_delivery_approval and produces a passing evidence artifact', async () => {
      const before = await captureRepoSnapshot(root);
      const run = await runBoundedM17Task(root, { goal: 'add a bounded synthetic slice', goalFingerprint: fingerprintText('goal') });
      const after = await captureRepoSnapshot(root);

      expect(run.finalState).toBe('waiting_for_delivery_approval');
      expect(run.qualityGate.status).toBe('passed');
      expect(() => assertAllM17Invariants({ before, after, run })).not.toThrow();

      const evidence = buildEvidenceArtifact({ repoRoot: root, goalFingerprint: fingerprintText('goal'), before, after, run, invariantsPassed: true });
      expect((evidence.task as Record<string, unknown>).finalState).toBe('waiting_for_delivery_approval');
    });

    it('never records a commit sha or pull request (no automatic delivery)', async () => {
      const run = await runBoundedM17Task(root, { goal: 'add a bounded synthetic slice', goalFingerprint: fingerprintText('goal') });
      expect(run.commitSha).toBeUndefined();
      expect(run.pullRequestNumber).toBeUndefined();
      expect(run.deliveryTransport).toBe('fake');
    });

    it('fails the harness when a validation command exits non-zero', async () => {
      const before = await captureRepoSnapshot(root);
      const run = await runBoundedM17Task(root, {
        goal: 'add a bounded synthetic slice that fails validation',
        goalFingerprint: fingerprintText('goal'),
        validationCommands: [{ command: process.execPath, args: ['-e', 'process.exit(1)'] }],
      });
      const after = await captureRepoSnapshot(root);
      expect(run.finalState).toBe('blocked');
      expect(run.qualityGate.status).toBe('failed');
      expect(() => assertAllM17Invariants({ before, after, run })).toThrow('m17_quality_gate_not_passed');
      // the source checkout itself is still untouched even though the task is blocked
      expect(() => assertSnapshotsIdentical(before, after)).not.toThrow();
    });
  });

  describe('composable assertion helpers', () => {
    it('detects source-checkout mutation after the run', () => {
      const before = fakeSnapshot({ head: 'a'.repeat(40) });
      const after = fakeSnapshot({ head: 'b'.repeat(40) });
      expect(() => assertSnapshotsIdentical(before, after)).toThrow('m17_source_checkout_mutated');
    });

    it('detects a dirty-state change even when HEAD/branch are unchanged', () => {
      const before = fakeSnapshot({ dirty: false, dirtyLines: [] });
      const after = fakeSnapshot({ dirty: true, dirtyLines: [' M foo.py'] });
      expect(() => assertSnapshotsIdentical(before, after)).toThrow('m17_source_checkout_mutated');
    });

    it('rejects a worktree path equal to the target repo root', () => {
      expect(() => assertWorktreeIsolated('C:\\repo', 'C:\\repo')).toThrow('m17_worktree_not_isolated');
      expect(() => assertWorktreeIsolated('C:\\repo', 'C:\\repo\\worktree')).not.toThrow();
    });

    it('fails on missing approval evidence', () => {
      const before = fakeSnapshot();
      const after = fakeSnapshot();
      const run = fakeRun({ approvals: { proposalReviewApprovedAt: '', executionApprovalApprovedAt: '' } });
      expect(() => assertAllM17Invariants({ before, after, run })).toThrow('m17_missing_approval_evidence');
    });

    it('fails on missing validation evidence', () => {
      const before = fakeSnapshot();
      const after = fakeSnapshot();
      const run = fakeRun({ validation: [] });
      expect(() => assertAllM17Invariants({ before, after, run })).toThrow('m17_missing_validation_evidence');
    });

    it('fails when the M16 quality gate did not pass', () => {
      const before = fakeSnapshot();
      const after = fakeSnapshot();
      const run = fakeRun({ qualityGate: { gateId: 'g', runId: 'r', status: 'failed', findingsCount: 2 }, finalState: 'blocked' });
      expect(() => assertAllM17Invariants({ before, after, run })).toThrow('m17_quality_gate_not_passed');
    });

    it('rejects an unexpected commit/push/merge state', () => {
      const before = fakeSnapshot({ head: 'a'.repeat(40) });
      const after = fakeSnapshot({ head: 'a'.repeat(40) });
      const runWithCommit = fakeRun({ commitSha: 'deadbeef' });
      expect(() => assertNoAutomaticDelivery(before, after, runWithCommit)).toThrow('m17_unexpected_commit');

      const runWithPr = fakeRun({ pullRequestNumber: 1 });
      expect(() => assertNoAutomaticDelivery(before, after, runWithPr)).toThrow('m17_unexpected_pull_request');

      const runWithRealTransport = fakeRun({ deliveryTransport: 'gh-cli' });
      expect(() => assertNoAutomaticDelivery(before, after, runWithRealTransport)).toThrow('m17_unexpected_delivery_transport');

      const headMovedAfter = fakeSnapshot({ head: 'b'.repeat(40) });
      expect(() => assertNoAutomaticDelivery(before, headMovedAfter, fakeRun())).toThrow('m17_unexpected_head_change');
    });
  });

  describe('evidence redaction', () => {
    it('never contains literal goal/prompt text, secret-shaped strings, or raw file contents', async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-m17-redact-'));
      try {
        await initGit(root);
        const secretSentinel = 'ghp-SENTINEL0123456789ABCDEF'; // gitleaks:allow
        const goal = `Implement sales ledger. Do not leak ${secretSentinel} anywhere.`;
        const before = await captureRepoSnapshot(root);
        const run = await runBoundedM17Task(root, {
          goal,
          goalFingerprint: fingerprintText(goal),
          mutationContent: `raw file content sentinel RAW_CONTENT_SENTINEL and ${secretSentinel}\n`,
        });
        const after = await captureRepoSnapshot(root);
        const evidence = buildEvidenceArtifact({ repoRoot: root, goalFingerprint: fingerprintText(goal), before, after, run, invariantsPassed: true });
        const serialized = JSON.stringify(evidence);
        expect(serialized).not.toContain(goal);
        expect(serialized).not.toContain(secretSentinel);
        expect(serialized).not.toContain('RAW_CONTENT_SENTINEL');
        expect(serialized).not.toContain('Implement sales ledger');
      } finally {
        await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      }
    });
  });
});
