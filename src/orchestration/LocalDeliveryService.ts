import * as fs from 'fs/promises';
import * as path from 'path';
import { execFile } from 'child_process';
import { hardenedGitArgs, hardenedGitEnv } from '../../core/security/hardenedGit';
import { promisify } from 'util';
import { sha256Hex } from './TrustedDirtyProvenance';
import { UNBORN_HEAD_COMMIT } from './WorktreeManager';

const execFileAsync = promisify(execFile);

export interface GitCommandResult {
  stdout: string;
  stderr: string;
}

export interface GitCommandRunner {
  run(cwd: string, args: readonly string[]): Promise<GitCommandResult>;
}

class DefaultGitCommandRunner implements GitCommandRunner {
  constructor(private readonly gitBinary: string) {}

  async run(cwd: string, args: readonly string[]): Promise<GitCommandResult> {
    const result = await execFileAsync(this.gitBinary, hardenedGitArgs([...args]), {
      cwd,
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
      env: hardenedGitEnv(),
    });
    return { stdout: result.stdout, stderr: result.stderr };
  }
}

/**
 * Reasons a local-delivery attempt refuses to touch the workspace. Each maps
 * 1:1 to one of the numbered preconditions in the M40 local-delivery spec.
 */
export type LocalDeliveryBlockReason =
  | 'workspace_root_mismatch'
  | 'branch_mismatch'
  | 'head_mismatch'
  | 'workspace_dirty'
  | 'untracked_collision'
  | 'not_descendant'
  | 'commit_mismatch'
  | 'fast_forward_failed'
  | 'verification_failed'
  /**
   * The single most severe outcome this module can report: a trusted-dirty
   * path was temporarily cleared to attempt delivery, delivery then failed,
   * and restoring that path's exact pre-delivery approved bytes ALSO failed.
   * Never claim the workspace is untouched when this is returned.
   */
  | 'trusted_bytes_restoration_failed';

export interface LocalDeliveryInput {
  /** The currently-open VS Code workspace root (not the task's isolated worktree). */
  workspaceRoot: string;
  /** The repository root recorded on the task when it started. */
  taskRepositoryRoot: string;
  /** The branch recorded on the task when it started (the branch the workspace must be on). */
  taskBranch: string;
  /** HEAD of the workspace's branch at the moment the task's worktree was created. */
  worktreeBaseCommit: string;
  /** The commit produced by the task's delivery commit, to be fast-forwarded into the workspace. */
  taskCommitSha: string;
  /** The commit SHA that was actually shown to the user at delivery-approval time. */
  approvedCommitSha: string;
  /** Workspace-relative paths the user approved as the task's change scope. */
  approvedChangedPaths: string[];
  /**
   * Unified Conversation V1 — the narrow, cryptographically-verified
   * exception to precondition 4 (see src/orchestration/TrustedDirtyProvenance.ts's
   * header for the full rationale). Each entry names a workspace-relative
   * path and the sha256 it was verified against when Karke Dikha's task
   * started — NOT trusted blindly: every entry is re-verified against the
   * CURRENT on-disk bytes immediately below, so a manual edit made after the
   * task started (Step 4.F) still blocks. Omit entirely for the unchanged,
   * default-strict behavior.
   */
  trustedDirtyBaseline?: Array<{ path: string; sha256: string }>;
  gitBinary?: string;
  /** Injectable for tests; defaults to a real `git` process runner. */
  runner?: GitCommandRunner;
}

export interface LocalDeliveryOutcome {
  delivered: boolean;
  blockedReason?: LocalDeliveryBlockReason;
  /** Human-readable, non-sensitive explanation suitable for a blocker card. */
  detail?: string;
  workspaceHead?: string;
  /**
   * Present only when trusted-dirty paths were temporarily cleared for this
   * delivery attempt. `true` once every one of them was restored to its
   * exact pre-delivery bytes and re-verified by hash (whether delivery
   * itself then succeeded or failed) — `false` only alongside
   * `blockedReason: 'trusted_bytes_restoration_failed'`.
   */
  trustedBytesRestored?: boolean;
}

function errMsg(error: unknown): string {
  if (error && typeof error === 'object' && 'stderr' in error && typeof (error as { stderr?: unknown }).stderr === 'string' && (error as { stderr: string }).stderr.trim()) {
    return (error as { stderr: string }).stderr.trim();
  }
  return error instanceof Error ? error.message : String(error);
}

function normalizePath(value: string): string {
  return value.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

async function safeRealpath(target: string): Promise<string | null> {
  try {
    return await fs.realpath(target);
  } catch {
    return null;
  }
}

function pathsEqual(left: string, right: string): boolean {
  const normalize = (value: string): string => {
    const resolved = path.resolve(value).replace(/[\\/]+$/, '');
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

/**
 * Applies a completed, approved local (non-GitHub-issue) task's delivery
 * commit to the currently-open workspace, but ONLY if every precondition
 * below holds. Runs git plumbing against the WORKSPACE root, never the
 * task's isolated worktree. On any precondition failure, the workspace is
 * left completely untouched and a typed, human-readable reason is returned
 * so the caller can classify the task as blocked (`workspace_delivery_conflict`)
 * without losing the task's worktree/branch.
 *
 * Preconditions (all must hold, in this order):
 *  1. workspace root === task's recorded repository root
 *  2. workspace's currently checked-out branch === task's recorded branch
 *  3. workspace HEAD === task.worktreeBaseCommit
 *  4. no staged or unstaged TRACKED changes in the workspace
 *  5. no untracked file collides with an approved changed path
 *  6. the task's commit is a descendant of worktreeBaseCommit
 *  7. the commit being applied is exactly the reviewed/approved commit SHA
 *
 * If all hold: fast-forwards the workspace's checked-out branch to the task
 * commit via `git merge --ff-only` (never a merge commit, never a branch
 * switch), then verifies workspace HEAD now equals the task commit and that
 * every approved path exists on disk under the workspace root.
 */
export async function deliverLocally(input: LocalDeliveryInput): Promise<LocalDeliveryOutcome> {
  const runner: GitCommandRunner = input.runner ?? new DefaultGitCommandRunner(input.gitBinary || 'git');
  const workspaceRoot = input.workspaceRoot;

  // 7. approved commit must be exactly the commit being applied.
  if (input.approvedCommitSha !== input.taskCommitSha) {
    return {
      delivered: false,
      blockedReason: 'commit_mismatch',
      detail: `The commit being applied (${input.taskCommitSha}) does not match the commit that was shown for approval (${input.approvedCommitSha}).`,
    };
  }

  // 1. workspace root matches the task's recorded repository root.
  const realWorkspaceRoot = await safeRealpath(workspaceRoot);
  const realTaskRoot = await safeRealpath(input.taskRepositoryRoot);
  if (!realWorkspaceRoot || !realTaskRoot || !pathsEqual(realWorkspaceRoot, realTaskRoot)) {
    return {
      delivered: false,
      blockedReason: 'workspace_root_mismatch',
      detail: `The open workspace (${workspaceRoot}) is not the repository this task started in (${input.taskRepositoryRoot}).`,
    };
  }

  // 2. current checked-out branch equals the branch recorded when the task started.
  let currentBranch = '';
  try {
    const result = await runner.run(workspaceRoot, ['branch', '--show-current']);
    currentBranch = result.stdout.trim();
  } catch (error) {
    return { delivered: false, blockedReason: 'branch_mismatch', detail: `Could not determine the workspace's checked-out branch: ${errMsg(error)}` };
  }
  if (!currentBranch || currentBranch !== input.taskBranch) {
    return {
      delivered: false,
      blockedReason: 'branch_mismatch',
      detail: `The workspace is on branch "${currentBranch || '(detached)'}", but the task started on "${input.taskBranch}".`,
    };
  }

  // 3. workspace HEAD equals task.worktreeBaseCommit. A greenfield task
  //    (recorded base is the unborn marker) requires the workspace to STILL be
  //    unborn — no commit may have appeared since the task started.
  let workspaceHead = '';
  let workspaceUnborn = false;
  try {
    const result = await runner.run(workspaceRoot, ['rev-parse', '--verify', '-q', 'HEAD']);
    workspaceHead = result.stdout.trim();
    workspaceUnborn = !workspaceHead;
  } catch (error) {
    const exitCode = (error as NodeJS.ErrnoException & { code?: string | number }).code;
    // Exit 1 is Git's unborn-HEAD response ("needed a single revision"); a
    // genuinely greenfield workspace is valid. Any other failure is a real
    // unavailability and fails closed.
    if (typeof exitCode === 'number' && exitCode === 1) {
      workspaceUnborn = true;
    } else {
      return { delivered: false, blockedReason: 'head_mismatch', detail: `Could not read the workspace's HEAD commit: ${errMsg(error)}` };
    }
  }
  if (input.worktreeBaseCommit === UNBORN_HEAD_COMMIT) {
    if (!workspaceUnborn) {
      return {
        delivered: false,
        blockedReason: 'head_mismatch',
        detail: `The workspace now has commits (${workspaceHead}); the task's greenfield work started from an empty repository.`,
      };
    }
  } else if (workspaceHead !== input.worktreeBaseCommit) {
    return {
      delivered: false,
      blockedReason: 'head_mismatch',
      detail: `The workspace has moved to ${workspaceHead}; the task's isolated work started from ${input.worktreeBaseCommit}.`,
    };
  }

  // 4/5. no staged/unstaged tracked changes, and no untracked collision with approved paths.
  let statusLines: string[] = [];
  try {
    const result = await runner.run(workspaceRoot, ['status', '--porcelain']);
    statusLines = result.stdout.split(/\r?\n/).filter((line) => line.length > 0);
  } catch (error) {
    return { delivered: false, blockedReason: 'workspace_dirty', detail: `git status failed in the workspace: ${errMsg(error)}` };
  }
  const trackedDirty = statusLines.filter((line) => !line.startsWith('??'));
  /** Exact pre-checkout bytes of every trusted path, captured BEFORE the
   * `git checkout` below ever runs — the only way a later failure can
   * restore them. `null` when no trusted checkout happened this call (the
   * overwhelmingly common case), so nothing downstream attempts a restore. */
  let trustedBackups: Map<string, Buffer> | null = null;
  if (trackedDirty.length > 0) {
    const baseline = new Map((input.trustedDirtyBaseline ?? []).map((entry) => [normalizePath(entry.path), entry.sha256]));
    const untrustedPaths: string[] = [];
    const trustedPaths: string[] = [];
    for (const line of trackedDirty) {
      const trackedPath = normalizePath(line.slice(3));
      // Required safety property: a path staged in the index (index status
      // column — the first porcelain character — anything but a space) must
      // NEVER be treated as trusted-dirty, regardless of byte content. The
      // trusted-dirty mechanism exists for an unstaged working-tree edit
      // Saath already produced; a staged change means something else
      // (possibly the user themselves) explicitly `git add`ed it, which is
      // outside anything Core's approval record can attest to.
      const indexStatus = line[0];
      const worktreeStatus = line[1];
      if (indexStatus !== ' ' || worktreeStatus !== 'M') { untrustedPaths.push(trackedPath); continue; }
      const expectedSha256 = baseline.get(trackedPath);
      if (!expectedSha256) { untrustedPaths.push(trackedPath); continue; }
      // Step 3 revalidation: re-read CURRENT bytes and re-hash them now, at
      // delivery time — never trust the baseline captured when the task
      // started (which may predate a restart). If the user (or anything
      // else) touched a "trusted" path again since then, its hash will no
      // longer match and this blocks, same as any other unrecognized dirty
      // path (Step 4.F).
      let currentSha256: string;
      try {
        currentSha256 = sha256Hex((await fs.readFile(path.join(workspaceRoot, trackedPath))).toString('utf8'));
      } catch {
        untrustedPaths.push(trackedPath);
        continue;
      }
      if (currentSha256 !== expectedSha256) { untrustedPaths.push(trackedPath); continue; }
      trustedPaths.push(trackedPath);
    }
    if (untrustedPaths.length > 0) {
      // Nothing was ever checked out — no restoration to perform.
      return {
        delivered: false,
        blockedReason: 'workspace_dirty',
        detail: `The workspace has ${trackedDirty.length} tracked change(s) that must be committed, stashed, or discarded first: ${trackedDirty.slice(0, 5).join('; ')}${trackedDirty.length > 5 ? ', …' : ''}`,
      };
    }
    // Every tracked-dirty path re-verified as exactly the bytes this same
    // conversation's Saath Kar turn already had approved, unstaged — never a
    // foreign, staged, or since-modified change. Capture their exact bytes
    // durably (in memory, hash already verified above) BEFORE clearing them,
    // so ANY failure between here and a successful fast-forward can restore
    // them byte-for-byte — see the try/finally around `attemptDelivery` below.
    trustedBackups = new Map();
    for (const trustedPath of trustedPaths) {
      trustedBackups.set(trustedPath, await fs.readFile(path.join(workspaceRoot, trustedPath)));
    }
    // Clear them so the fast-forward below can proceed; nothing is lost even
    // on success, since Karke Dikha's own commit (about to be fast-forwarded
    // in) already contains this exact content, seeded into its isolated
    // worktree at task start (see WorktreeManager.createLease's
    // `seedFiles`), plus whatever Karke Dikha itself additionally changed.
    // A plain `checkout --` touches only the working tree, never the index.
    await runner.run(workspaceRoot, ['checkout', '--', ...trustedPaths]);
  }

  /** Everything from here through a successful delivery — precondition 5/6,
   * the fast-forward itself, and post-merge verification — unchanged from
   * the original implementation, just isolated so the trusted-bytes
   * rollback below can wrap it uniformly regardless of which of its many
   * return points is hit, or whether it throws. */
  async function attemptDeliveryAfterDirtyCheck(): Promise<LocalDeliveryOutcome> {
    const untracked = statusLines
      .filter((line) => line.startsWith('??'))
      .map((line) => normalizePath(line.slice(3)));
    const approvedSet = new Set(input.approvedChangedPaths.map(normalizePath));
    const collisions = untracked.filter((candidate) => approvedSet.has(candidate));
    if (collisions.length > 0) {
      return {
        delivered: false,
        blockedReason: 'untracked_collision',
        detail: `Untracked file(s) already at these approved paths would be overwritten: ${collisions.join(', ')}`,
      };
    }

    // 6. the task's commit is a descendant of worktreeBaseCommit. For a
    //    greenfield base (the unborn marker) there is no prior commit to
    //    descend from — the delivered commit must instead be the repository's
    //    first commit (a root commit with no parents), which is exactly the
    //    governed first commit this flow produces.
    if (input.worktreeBaseCommit === UNBORN_HEAD_COMMIT) {
      try {
        const roots = await runner.run(workspaceRoot, ['rev-list', '--max-parents=0', input.taskCommitSha]);
        if (roots.stdout.trim() !== input.taskCommitSha) {
          return {
            delivered: false,
            blockedReason: 'not_descendant',
            detail: `The task's commit (${input.taskCommitSha}) is not a root commit, so it cannot be applied to a greenfield repository.`,
          };
        }
      } catch (error) {
        return {
          delivered: false,
          blockedReason: 'not_descendant',
          detail: `The task's commit (${input.taskCommitSha}) is not a valid commit in this repository: ${errMsg(error)}`,
        };
      }
    } else {
      try {
        await runner.run(workspaceRoot, ['merge-base', '--is-ancestor', input.worktreeBaseCommit, input.taskCommitSha]);
      } catch (error) {
        return {
          delivered: false,
          blockedReason: 'not_descendant',
          detail: `The task's commit (${input.taskCommitSha}) is not a descendant of the workspace's base commit (${input.worktreeBaseCommit}): ${errMsg(error)}`,
        };
      }
    }

    // All preconditions hold — fast-forward only, never a merge commit and
    // never a branch switch (the workspace is already on taskBranch).
    try {
      await runner.run(workspaceRoot, ['merge', '--ff-only', input.taskCommitSha]);
    } catch (error) {
      return { delivered: false, blockedReason: 'fast_forward_failed', detail: `git merge --ff-only failed: ${errMsg(error)}` };
    }

    let newHead = '';
    try {
      const result = await runner.run(workspaceRoot, ['rev-parse', 'HEAD']);
      newHead = result.stdout.trim();
    } catch (error) {
      return { delivered: false, blockedReason: 'verification_failed', detail: `Could not verify the workspace HEAD after fast-forward: ${errMsg(error)}` };
    }
    if (newHead !== input.taskCommitSha) {
      return {
        delivered: false,
        blockedReason: 'verification_failed',
        detail: `After fast-forward the workspace HEAD is ${newHead}, not the expected delivered commit ${input.taskCommitSha}.`,
      };
    }

    for (const relPath of input.approvedChangedPaths) {
      const exists = await fs.stat(path.join(workspaceRoot, relPath)).then(() => true, () => false);
      if (!exists) {
        // A missing approved path after a verified fast-forward almost always
        // means the change was a deletion, which is legitimate. Confirm via
        // git that the path is genuinely absent from the new HEAD tree (i.e.
        // git agrees it's gone) rather than silently trusting the filesystem.
        try {
          await runner.run(workspaceRoot, ['cat-file', '-e', `HEAD:${relPath.replace(/\\/g, '/')}`]);
          // Path exists in the tree per git but not on disk — a genuine
          // verification failure (e.g. blocked by another process).
          return {
            delivered: false,
            blockedReason: 'verification_failed',
            detail: `Approved path "${relPath}" is present in the delivered commit but missing on disk after fast-forward.`,
          };
        } catch {
          // git also reports it absent from HEAD — a legitimate deletion.
          continue;
        }
      }
    }

    return { delivered: true, workspaceHead: newHead };
  }

  if (!trustedBackups) {
    return attemptDeliveryAfterDirtyCheck();
  }

  // Trusted-dirty bytes were cleared above — every exit from here (a normal
  // blocked return, a successful delivery, or an unexpected throw) must be
  // accounted for: restore on anything but a genuine success.
  const backups = trustedBackups;
  let outcome: LocalDeliveryOutcome;
  try {
    outcome = await attemptDeliveryAfterDirtyCheck();
  } catch (error) {
    outcome = { delivered: false, blockedReason: 'fast_forward_failed', detail: `Unexpected error during delivery: ${errMsg(error)}` };
  }
  if (outcome.delivered) {
    // The fast-forward genuinely landed the new commit — the trusted paths
    // now correctly hold Karke Dikha's delivered content (which already
    // includes the trusted bytes plus its own changes). Restoring the OLD
    // bytes here would be actively wrong.
    return outcome;
  }
  const restoreFailures: string[] = [];
  for (const [trustedPath, originalBytes] of backups) {
    try {
      await fs.writeFile(path.join(workspaceRoot, trustedPath), originalBytes);
      const restoredHash = sha256Hex((await fs.readFile(path.join(workspaceRoot, trustedPath))).toString('utf8'));
      if (restoredHash !== sha256Hex(originalBytes.toString('utf8'))) restoreFailures.push(trustedPath);
    } catch {
      restoreFailures.push(trustedPath);
    }
  }
  if (restoreFailures.length > 0) {
    return {
      delivered: false,
      blockedReason: 'trusted_bytes_restoration_failed',
      detail: `Delivery failed (${outcome.blockedReason}: ${outcome.detail}) AND restoring the previously-approved bytes for ${restoreFailures.join(', ')} also failed. The workspace may be missing previously-approved content for ${restoreFailures.join(', ')} — inspect immediately; do not assume it matches the approved Saath Kar change.`,
      trustedBytesRestored: false,
    };
  }
  return { ...outcome, trustedBytesRestored: true };
}

/**
 * Builds the exact recovery command string surfaced on a
 * `workspace_delivery_conflict` blocker card so the user can manually apply
 * the task's result without KarkeDikha touching their workspace again.
 */
export function buildManualApplyCommand(input: { taskWorktreeLocation: string; taskBranch: string; taskCommitSha: string }): string {
  const remote = input.taskWorktreeLocation.replace(/'/g, "'\\''");
  return `git fetch '${remote}' ${input.taskBranch} && git cherry-pick ${input.taskCommitSha}`;
}
