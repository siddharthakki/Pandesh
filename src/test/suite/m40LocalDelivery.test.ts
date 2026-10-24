import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { deliverLocally, buildManualApplyCommand } from '../../orchestration/LocalDeliveryService';
import { sha256Hex } from '../../orchestration/TrustedDirtyProvenance';

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync('git', args, { cwd, windowsHide: true, maxBuffer: 1024 * 1024 });
  return result.stdout.trim();
}

/** Runs real git for every command except the ones `failOn` names, which
 * throw instead — used to prove the trusted-bytes rollback fires on a
 * genuine mid-delivery failure, not just a precondition returning early. */
class FaultInjectingRunner {
  constructor(private readonly failOn: (args: readonly string[]) => boolean) {}
  async run(cwd: string, args: readonly string[]): Promise<{ stdout: string; stderr: string }> {
    if (this.failOn(args)) throw new Error('INJECTED FAILURE for test');
    const result = await execFileAsync('git', [...args], { cwd, windowsHide: true, maxBuffer: 10 * 1024 * 1024 });
    return { stdout: result.stdout, stderr: result.stderr };
  }
}

async function initGit(root: string): Promise<void> {
  await fs.writeFile(path.join(root, 'README.md'), '# M40 local delivery test\n', 'utf8');
  for (const args of [
    ['init', '-b', 'main'],
    ['config', 'user.email', 'test@example.com'],
    ['config', 'user.name', 'Test'],
    ['add', '.'],
    ['commit', '-m', 'init'],
  ]) {
    await git(root, args);
  }
}

describe('M40 LocalDeliveryService', () => {
  let root: string;
  let baseCommit: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-m40-delivery-'));
    await initGit(root);
    baseCommit = await git(root, ['rev-parse', 'HEAD']);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  /** Simulates what IsolatedWorktreeManager does: create a task commit ahead
   * of baseCommit on the SAME branch the workspace root is on (git worktrees
   * share one object database with their origin repo, so a plain commit on
   * the workspace's own branch is representative of what a real worktree
   * commit looks like once merged back in spirit — these tests exercise the
   * precondition/fast-forward logic against the workspace root directly). */
  async function makeTaskCommit(relPath: string, content: string): Promise<string> {
    await fs.writeFile(path.join(root, relPath), content, 'utf8');
    await git(root, ['add', '--all']);
    await git(root, ['commit', '-m', `deliver ${relPath}`]);
    return git(root, ['rev-parse', 'HEAD']);
  }

  it('fast-forwards a clean workspace and the file/HEAD/branch all match afterward', async () => {
    // Simulate: workspace currently at baseCommit; task committed ahead of it
    // (e.g. produced in an isolated worktree sharing this object store).
    const taskCommit = await makeTaskCommit('feature.txt', 'hello\n');
    await git(root, ['reset', '--hard', baseCommit]);

    const outcome = await deliverLocally({
      workspaceRoot: root,
      taskRepositoryRoot: root,
      taskBranch: 'main',
      worktreeBaseCommit: baseCommit,
      taskCommitSha: taskCommit,
      approvedCommitSha: taskCommit,
      approvedChangedPaths: ['feature.txt'],
    });

    expect(outcome.delivered).toBe(true);
    expect(outcome.workspaceHead).toBe(taskCommit);
    const head = await git(root, ['rev-parse', 'HEAD']);
    expect(head).toBe(taskCommit);
    const branch = await git(root, ['branch', '--show-current']);
    expect(branch).toBe('main');
    const content = await fs.readFile(path.join(root, 'feature.txt'), 'utf8');
    expect(content.replace(/\r\n/g, '\n')).toBe('hello\n');
  });

  it('blocks with workspace_delivery_conflict-style reason when workspace HEAD has diverged, and does not mutate anything', async () => {
    const taskCommit = await makeTaskCommit('feature.txt', 'hello\n');
    await git(root, ['reset', '--hard', baseCommit]);
    // Diverge: an unrelated commit lands on the workspace after the task
    // started (workspace HEAD no longer equals worktreeBaseCommit).
    await fs.writeFile(path.join(root, 'unrelated.txt'), 'drift\n', 'utf8');
    await git(root, ['add', '--all']);
    await git(root, ['commit', '-m', 'unrelated drift']);
    const divergedHead = await git(root, ['rev-parse', 'HEAD']);

    const outcome = await deliverLocally({
      workspaceRoot: root,
      taskRepositoryRoot: root,
      taskBranch: 'main',
      worktreeBaseCommit: baseCommit,
      taskCommitSha: taskCommit,
      approvedCommitSha: taskCommit,
      approvedChangedPaths: ['feature.txt'],
    });

    expect(outcome.delivered).toBe(false);
    expect(outcome.blockedReason).toBe('head_mismatch');
    const headAfter = await git(root, ['rev-parse', 'HEAD']);
    expect(headAfter).toBe(divergedHead);
    const exists = await fs.stat(path.join(root, 'feature.txt')).then(() => true, () => false);
    expect(exists).toBe(false);
  });

  it('blocks when the workspace has tracked dirty changes', async () => {
    const taskCommit = await makeTaskCommit('feature.txt', 'hello\n');
    await git(root, ['reset', '--hard', baseCommit]);
    await fs.writeFile(path.join(root, 'README.md'), '# modified\n', 'utf8');

    const outcome = await deliverLocally({
      workspaceRoot: root,
      taskRepositoryRoot: root,
      taskBranch: 'main',
      worktreeBaseCommit: baseCommit,
      taskCommitSha: taskCommit,
      approvedCommitSha: taskCommit,
      approvedChangedPaths: ['feature.txt'],
    });

    expect(outcome.delivered).toBe(false);
    expect(outcome.blockedReason).toBe('workspace_dirty');
    const head = await git(root, ['rev-parse', 'HEAD']);
    expect(head).toBe(baseCommit);
  });

  describe('Unified Conversation V1 — trusted-dirty absorption (Step 4)', () => {
    it('ROLLBACK. a failure injected during the fast-forward restores the trusted bytes exactly, with matching hashes and an untouched index', async () => {
      const trustedReadme = '# trusted content that must never be lost\n';
      await fs.writeFile(path.join(root, 'README.md'), trustedReadme, 'utf8');
      await git(root, ['add', '--all']);
      await git(root, ['commit', '-m', 'karke change']);
      const taskCommit = await git(root, ['rev-parse', 'HEAD']);
      await git(root, ['reset', '--hard', baseCommit]);
      await fs.writeFile(path.join(root, 'README.md'), trustedReadme, 'utf8');
      const preDeliveryIndexStatus = await git(root, ['status', '--porcelain']);

      const outcome = await deliverLocally({
        workspaceRoot: root,
        taskRepositoryRoot: root,
        taskBranch: 'main',
        worktreeBaseCommit: baseCommit,
        taskCommitSha: taskCommit,
        approvedCommitSha: taskCommit,
        approvedChangedPaths: ['README.md'],
        trustedDirtyBaseline: [{ path: 'README.md', sha256: sha256Hex(trustedReadme) }],
        // Injected failure happens AFTER the trusted-path checkout (which
        // this module must run before it can attempt the fast-forward at
        // all) — exactly the window this safety gate exists for.
        runner: new FaultInjectingRunner((args) => args[0] === 'merge' && args[1] === '--ff-only'),
      });

      expect(outcome.delivered).toBe(false);
      expect(outcome.blockedReason).toBe('fast_forward_failed');
      expect(outcome.trustedBytesRestored).toBe(true);
      // The exact pre-delivery bytes, verified by content AND hash.
      const restored = await fs.readFile(path.join(root, 'README.md'), 'utf8');
      expect(restored).toBe(trustedReadme);
      expect(sha256Hex(restored)).toBe(sha256Hex(trustedReadme));
      // Never delivered: HEAD did not move.
      expect(await git(root, ['rev-parse', 'HEAD'])).toBe(baseCommit);
      // The index itself was never altered by the checkout or the restore.
      expect(await git(root, ['status', '--porcelain'])).toBe(preDeliveryIndexStatus);
    });

    it('ROLLBACK. a not_descendant failure (after checkout, before the merge attempt) also restores the trusted bytes', async () => {
      const trustedReadme = '# trusted content\n';
      await fs.writeFile(path.join(root, 'README.md'), trustedReadme, 'utf8');

      const outcome = await deliverLocally({
        workspaceRoot: root,
        taskRepositoryRoot: root,
        taskBranch: 'main',
        // HEAD already equals baseCommit, so precondition 3 passes and the
        // trusted-path checkout runs — but this commit SHA does not exist in
        // the repository at all, so precondition 6 (merge-base --is-ancestor)
        // fails AFTER that checkout, exactly the window under test.
        worktreeBaseCommit: baseCommit,
        taskCommitSha: 'f'.repeat(40),
        approvedCommitSha: 'f'.repeat(40),
        approvedChangedPaths: ['README.md'],
        trustedDirtyBaseline: [{ path: 'README.md', sha256: sha256Hex(trustedReadme) }],
      });

      expect(outcome.delivered).toBe(false);
      expect(outcome.blockedReason).toBe('not_descendant');
      expect(outcome.trustedBytesRestored).toBe(true);
      const readme = await fs.readFile(path.join(root, 'README.md'), 'utf8');
      expect(readme).toBe(trustedReadme);
      expect(await git(root, ['rev-parse', 'HEAD'])).toBe(baseCommit);
    });

    it('STAGED. an approved-Saath-looking change that is STAGED (git add, not committed) never enters the trusted carve-out: blocks workspace_dirty, index and worktree untouched', async () => {
      const trustedLookingContent = '# staged content byte-identical to an approved mutation\n';
      const taskCommit = await makeTaskCommit('feature.txt', 'hello\n');
      await git(root, ['reset', '--hard', baseCommit]);
      await fs.writeFile(path.join(root, 'README.md'), trustedLookingContent, 'utf8');
      // The critical difference from every other trusted-dirty test: staged.
      await git(root, ['add', 'README.md']);
      const statusBefore = await git(root, ['status', '--porcelain']);
      expect(statusBefore).toMatch(/^M {2}README\.md/); // index modified, worktree clean relative to index

      const outcome = await deliverLocally({
        workspaceRoot: root,
        taskRepositoryRoot: root,
        taskBranch: 'main',
        worktreeBaseCommit: baseCommit,
        taskCommitSha: taskCommit,
        approvedCommitSha: taskCommit,
        approvedChangedPaths: ['feature.txt'],
        trustedDirtyBaseline: [{ path: 'README.md', sha256: sha256Hex(trustedLookingContent) }],
      });

      expect(outcome.delivered).toBe(false);
      expect(outcome.blockedReason).toBe('workspace_dirty');
      expect(outcome.trustedBytesRestored).toBeUndefined();
      expect(await git(root, ['status', '--porcelain'])).toBe(statusBefore);
      expect(await git(root, ['rev-parse', 'HEAD'])).toBe(baseCommit);
      const readme = await fs.readFile(path.join(root, 'README.md'), 'utf8');
      expect(readme).toBe(trustedLookingContent);
    });

    it('RESTART. a trustedDirtyBaseline round-tripped through JSON (simulating a durable-task reload after restart) still delivers, re-verified fresh', async () => {
      const trustedReadme = '# trusted, surviving a simulated restart\n';
      await fs.writeFile(path.join(root, 'README.md'), trustedReadme, 'utf8');
      await git(root, ['add', '--all']);
      await git(root, ['commit', '-m', 'karke change']);
      const taskCommit = await git(root, ['rev-parse', 'HEAD']);
      await git(root, ['reset', '--hard', baseCommit]);
      await fs.writeFile(path.join(root, 'README.md'), trustedReadme, 'utf8');

      // The exact shape persisted on AutonomousTask.trustedDirtyBaseline,
      // serialized and re-parsed exactly as a real restart reload of the
      // durable task JSON file would produce — proving durability requires
      // no new schema/version work: it is already a plain, JSON-safe field.
      const persisted = JSON.stringify([{ path: 'README.md', sha256: sha256Hex(trustedReadme), approvalId: 'appr-1', content: trustedReadme }]);
      const reloadedAfterRestart: Array<{ path: string; sha256: string }> = JSON.parse(persisted);

      const outcome = await deliverLocally({
        workspaceRoot: root,
        taskRepositoryRoot: root,
        taskBranch: 'main',
        worktreeBaseCommit: baseCommit,
        taskCommitSha: taskCommit,
        approvedCommitSha: taskCommit,
        approvedChangedPaths: ['README.md'],
        trustedDirtyBaseline: reloadedAfterRestart,
      });

      expect(outcome.delivered).toBe(true);
      expect(outcome.trustedBytesRestored).toBeUndefined();
    });

    it('A. delivers on top of a same-conversation trusted-dirty change: both the prior Saath edit and Karke\'s new change survive', async () => {
      // Simulate: Saath's approved edit already landed on disk in the open
      // workspace (uncommitted — exactly what a real approved capability
      // card produces), and was seeded into Karke's isolated worktree at
      // task start (WorktreeManager.createLease's seedFiles), so Karke's own
      // commit contains BOTH that trusted content AND its own new file.
      const trustedReadme = '# M40 local delivery test\nSaath already approved this line.\n';
      await fs.writeFile(path.join(root, 'README.md'), trustedReadme, 'utf8');
      await fs.writeFile(path.join(root, 'feature.txt'), 'karke wrote this\n', 'utf8');
      await git(root, ['add', '--all']);
      await git(root, ['commit', '-m', 'karke: absorb trusted Saath edit + own change']);
      const taskCommit = await git(root, ['rev-parse', 'HEAD']);
      await git(root, ['reset', '--hard', baseCommit]);
      // The open workspace still has the trusted Saath edit sitting
      // uncommitted (never touched by Karke's own commit above).
      await fs.writeFile(path.join(root, 'README.md'), trustedReadme, 'utf8');

      const outcome = await deliverLocally({
        workspaceRoot: root,
        taskRepositoryRoot: root,
        taskBranch: 'main',
        worktreeBaseCommit: baseCommit,
        taskCommitSha: taskCommit,
        approvedCommitSha: taskCommit,
        approvedChangedPaths: ['feature.txt'],
        trustedDirtyBaseline: [{ path: 'README.md', sha256: sha256Hex(trustedReadme) }],
      });

      expect(outcome.delivered).toBe(true);
      const readme = await fs.readFile(path.join(root, 'README.md'), 'utf8');
      expect(readme.replace(/\r\n/g, '\n')).toBe(trustedReadme);
      const feature = await fs.readFile(path.join(root, 'feature.txt'), 'utf8');
      expect(feature.replace(/\r\n/g, '\n')).toBe('karke wrote this\n');
    });

    it('A2. Karke Dikha further modifying the SAME trusted file (the real Turn 4 shape) still delivers both layers of change', async () => {
      // Exactly the shape the real installed acceptance hit: Saath's
      // approved edit already landed on users.js (an EXISTING tracked file)
      // in the open workspace, and Karke Dikha's own task ALSO edits
      // users.js further (registerUser), on top of the seeded trusted
      // content.
      const original = "function registerUser(username) {\n  return { username };\n}\nfunction getDisplayName(user) {\n  return user.username;\n}\n";
      await fs.writeFile(path.join(root, 'users.js'), original, 'utf8');
      await git(root, ['add', '--all']);
      await git(root, ['commit', '-m', 'initial users.js']);
      const localBaseCommit = await git(root, ['rev-parse', 'HEAD']);

      const afterSaath = "function registerUser(username) {\n  return { username };\n}\nfunction getDisplayName(user) {\n  return user.username || 'Unknown';\n}\n";
      const afterKarkeToo = "function registerUser(username) {\n  if (!username) throw new Error('username is required');\n  return { username };\n}\nfunction getDisplayName(user) {\n  return user.username || 'Unknown';\n}\n";
      await fs.writeFile(path.join(root, 'users.js'), afterKarkeToo, 'utf8');
      await git(root, ['add', '--all']);
      await git(root, ['commit', '-m', 'karke: build on the trusted Saath edit and add its own fix']);
      const taskCommit = await git(root, ['rev-parse', 'HEAD']);
      await git(root, ['reset', '--hard', localBaseCommit]);
      // The open workspace only ever saw Saath's layer, uncommitted.
      await fs.writeFile(path.join(root, 'users.js'), afterSaath, 'utf8');

      const outcome = await deliverLocally({
        workspaceRoot: root,
        taskRepositoryRoot: root,
        taskBranch: 'main',
        worktreeBaseCommit: localBaseCommit,
        taskCommitSha: taskCommit,
        approvedCommitSha: taskCommit,
        approvedChangedPaths: ['users.js'],
        trustedDirtyBaseline: [{ path: 'users.js', sha256: sha256Hex(afterSaath) }],
      });

      expect(outcome.delivered).toBe(true);
      const usersJs = await fs.readFile(path.join(root, 'users.js'), 'utf8');
      expect(usersJs.replace(/\r\n/g, '\n')).toBe(afterKarkeToo);
    });

    it('B. a foreign dirty file alongside a trusted one still blocks workspace_dirty', async () => {
      const trustedReadme = '# trusted\n';
      await fs.writeFile(path.join(root, 'README.md'), trustedReadme, 'utf8');
      await git(root, ['add', '--all']);
      await git(root, ['commit', '-m', 'karke change']);
      const taskCommit = await git(root, ['rev-parse', 'HEAD']);
      await git(root, ['reset', '--hard', baseCommit]);
      await fs.writeFile(path.join(root, 'README.md'), trustedReadme, 'utf8');
      // An unrelated manual edit the user never approved via Saath.
      await fs.writeFile(path.join(root, 'unrelated.txt'), 'nobody approved this\n', 'utf8');
      await git(root, ['add', 'unrelated.txt']);

      const outcome = await deliverLocally({
        workspaceRoot: root,
        taskRepositoryRoot: root,
        taskBranch: 'main',
        worktreeBaseCommit: baseCommit,
        taskCommitSha: taskCommit,
        approvedCommitSha: taskCommit,
        approvedChangedPaths: ['README.md'],
        trustedDirtyBaseline: [{ path: 'README.md', sha256: sha256Hex(trustedReadme) }],
      });

      expect(outcome.delivered).toBe(false);
      expect(outcome.blockedReason).toBe('workspace_dirty');
    });

    it('F. a workspace edit made after the trusted baseline was captured (but before delivery) blocks, not silently overwritten', async () => {
      const originallyTrusted = '# trusted at task start\n';
      await fs.writeFile(path.join(root, 'README.md'), originallyTrusted, 'utf8');
      await git(root, ['add', '--all']);
      await git(root, ['commit', '-m', 'karke change']);
      const taskCommit = await git(root, ['rev-parse', 'HEAD']);
      await git(root, ['reset', '--hard', baseCommit]);
      // The frozen baseline says README.md should still be `originallyTrusted`,
      // but between task start and delivery the file was modified again.
      await fs.writeFile(path.join(root, 'README.md'), '# modified after task started\n', 'utf8');

      const outcome = await deliverLocally({
        workspaceRoot: root,
        taskRepositoryRoot: root,
        taskBranch: 'main',
        worktreeBaseCommit: baseCommit,
        taskCommitSha: taskCommit,
        approvedCommitSha: taskCommit,
        approvedChangedPaths: ['README.md'],
        trustedDirtyBaseline: [{ path: 'README.md', sha256: sha256Hex(originallyTrusted) }],
      });

      expect(outcome.delivered).toBe(false);
      expect(outcome.blockedReason).toBe('workspace_dirty');
      const head = await git(root, ['rev-parse', 'HEAD']);
      expect(head).toBe(baseCommit);
      const readme = await fs.readFile(path.join(root, 'README.md'), 'utf8');
      expect(readme.replace(/\r\n/g, '\n')).toBe('# modified after task started\n');
    });
  });

  it('blocks when an untracked workspace file collides with an approved changed path', async () => {
    const taskCommit = await makeTaskCommit('feature.txt', 'hello\n');
    await git(root, ['reset', '--hard', baseCommit]);
    // An untracked file already sits at the exact path the task approved.
    await fs.writeFile(path.join(root, 'feature.txt'), 'local draft, not committed\n', 'utf8');

    const outcome = await deliverLocally({
      workspaceRoot: root,
      taskRepositoryRoot: root,
      taskBranch: 'main',
      worktreeBaseCommit: baseCommit,
      taskCommitSha: taskCommit,
      approvedCommitSha: taskCommit,
      approvedChangedPaths: ['feature.txt'],
    });

    expect(outcome.delivered).toBe(false);
    expect(outcome.blockedReason).toBe('untracked_collision');
    const content = await fs.readFile(path.join(root, 'feature.txt'), 'utf8');
    expect(content).toBe('local draft, not committed\n');
  });

  it('does NOT block on an unrelated untracked file (only a collision with an approved path blocks)', async () => {
    const taskCommit = await makeTaskCommit('feature.txt', 'hello\n');
    await git(root, ['reset', '--hard', baseCommit]);
    await fs.writeFile(path.join(root, 'scratch-notes.txt'), 'my own unrelated notes\n', 'utf8');

    const outcome = await deliverLocally({
      workspaceRoot: root,
      taskRepositoryRoot: root,
      taskBranch: 'main',
      worktreeBaseCommit: baseCommit,
      taskCommitSha: taskCommit,
      approvedCommitSha: taskCommit,
      approvedChangedPaths: ['feature.txt'],
    });

    expect(outcome.delivered).toBe(true);
    const scratchStillThere = await fs.readFile(path.join(root, 'scratch-notes.txt'), 'utf8');
    expect(scratchStillThere).toBe('my own unrelated notes\n');
    const feature = await fs.readFile(path.join(root, 'feature.txt'), 'utf8');
    expect(feature.replace(/\r\n/g, '\n')).toBe('hello\n');
  });

  it('blocks when the approved commit SHA does not match the commit being applied', async () => {
    const taskCommit = await makeTaskCommit('feature.txt', 'hello\n');
    await git(root, ['reset', '--hard', baseCommit]);

    const outcome = await deliverLocally({
      workspaceRoot: root,
      taskRepositoryRoot: root,
      taskBranch: 'main',
      worktreeBaseCommit: baseCommit,
      taskCommitSha: taskCommit,
      approvedCommitSha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      approvedChangedPaths: ['feature.txt'],
    });

    expect(outcome.delivered).toBe(false);
    expect(outcome.blockedReason).toBe('commit_mismatch');
    const head = await git(root, ['rev-parse', 'HEAD']);
    expect(head).toBe(baseCommit);
  });

  it('blocks when the workspace is on a different branch than the task started on', async () => {
    const taskCommit = await makeTaskCommit('feature.txt', 'hello\n');
    await git(root, ['reset', '--hard', baseCommit]);
    await git(root, ['checkout', '-b', 'some-other-branch']);

    const outcome = await deliverLocally({
      workspaceRoot: root,
      taskRepositoryRoot: root,
      taskBranch: 'main',
      worktreeBaseCommit: baseCommit,
      taskCommitSha: taskCommit,
      approvedCommitSha: taskCommit,
      approvedChangedPaths: ['feature.txt'],
    });

    expect(outcome.delivered).toBe(false);
    expect(outcome.blockedReason).toBe('branch_mismatch');
  });

  it('blocks when the workspace root is not the task repository root', async () => {
    const otherRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-m40-delivery-other-'));
    try {
      await initGit(otherRoot);
      const taskCommit = await makeTaskCommit('feature.txt', 'hello\n');
      await git(root, ['reset', '--hard', baseCommit]);

      const outcome = await deliverLocally({
        workspaceRoot: otherRoot,
        taskRepositoryRoot: root,
        taskBranch: 'main',
        worktreeBaseCommit: baseCommit,
        taskCommitSha: taskCommit,
        approvedCommitSha: taskCommit,
        approvedChangedPaths: ['feature.txt'],
      });

      expect(outcome.delivered).toBe(false);
      expect(outcome.blockedReason).toBe('workspace_root_mismatch');
    } finally {
      await fs.rm(otherRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('buildManualApplyCommand produces a fetch+cherry-pick command from the task data', () => {
    const command = buildManualApplyCommand({
      taskWorktreeLocation: '/tmp/kd-worktree-task-1',
      taskBranch: 'forge/task-1-fix',
      taskCommitSha: 'abc1234',
    });
    expect(command).toContain('git fetch');
    expect(command).toContain('forge/task-1-fix');
    expect(command).toContain('git cherry-pick abc1234');
  });
});
