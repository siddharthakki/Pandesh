import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { hardenedGitArgs, hardenedGitEnv } from '../../core/security/hardenedGit';
import { promisify } from 'util';
import * as crypto from 'crypto';

const execFileAsync = promisify(execFile);
const MANIFEST_SCHEMA_VERSION = 1 as const;

/**
 * Deterministic identity for a repository whose HEAD is unborn (a fresh
 * `git init` with no first commit yet). This is the all-zeros SHA Git itself
 * reports for an unborn branch (`git worktree list`, `git rev-parse --verify
 * -q HEAD`), chosen so a greenfield binding is stable, durably persisted, and
 * never confusable with a real commit hash. `IsolatedWorktreeManager.
 * assertBinding` re-derives the live unborn state before trusting the record.
 */
export const UNBORN_HEAD_COMMIT = '0000000000000000000000000000000000000000';

export interface WorktreeLease {
  schemaVersion: typeof MANIFEST_SCHEMA_VERSION;
  taskId: string;
  branch: string;
  worktreePath: string;
  repositoryRoot: string;
  baseCommit: string;
  allowedPaths: string[];
  dirtyWorkspacePaths: string[];
  createdAt: string;
  status: 'active' | 'completed' | 'failed' | 'cancelled';
}

interface WorktreeManifest {
  schemaVersion: typeof MANIFEST_SCHEMA_VERSION;
  repositoryRoot: string;
  updatedAt: string;
  leases: WorktreeLease[];
}

export interface WorktreeManagerOptions {
  worktreeRoot?: string;
  maxWorktrees?: number;
  maxDiskBytes?: number;
  gitBinary?: string;
}

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
    try {
      // Git's ownership check rejects a legitimate workspace when the host
      // runs under a sandbox identity different from the Windows file owner.
      // Trust only the exact cwd for this invocation; repository identity and
      // worktree isolation are still verified by the callers.
      const trustedCwd = path.resolve(cwd).replace(/\\/g, '/');
      const result = await execFileAsync(this.gitBinary, hardenedGitArgs(['-c', `safe.directory=${trustedCwd}`, ...args]), {
        cwd,
        windowsHide: true,
        maxBuffer: 10 * 1024 * 1024,
        env: hardenedGitEnv(),
      });
      return { stdout: result.stdout, stderr: result.stderr };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code === 'EACCES') {
        const unavailable = new Error(`Git executable is unavailable or not executable: ${this.gitBinary}`) as NodeJS.ErrnoException;
        unavailable.code = 'ENOENT';
        throw unavailable;
      }
      throw error;
    }
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function sanitizeId(taskId: string): string {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(taskId)) {
    throw new Error(`Invalid worktree task id: ${taskId}`);
  }
  return taskId;
}

export function normalizeWriteScope(scope: string): string {
  const normalized = scope.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  if (!normalized || normalized === '.') {
    throw new Error('Write-agent scopes must be explicit workspace-relative paths.');
  }
  if (normalized === '**/*' || normalized === '*') {
    return '**/*';
  }
  if (path.posix.isAbsolute(normalized) || normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) {
    throw new Error(`Write-agent scope must be workspace-relative: ${scope}`);
  }
  return normalized;
}

function scopePrefix(scope: string): string {
  if (scope === '**/*') {
    return '';
  }
  return scope.replace(/\/\*\*\/\*$/, '').replace(/\/\*$/, '');
}

export function scopesOverlap(left: readonly string[], right: readonly string[]): boolean {
  for (const leftScope of left.map(normalizeWriteScope)) {
    for (const rightScope of right.map(normalizeWriteScope)) {
      if (leftScope === '**/*' || rightScope === '**/*') {
        return true;
      }
      const leftPrefix = scopePrefix(leftScope);
      const rightPrefix = scopePrefix(rightScope);
      if (leftPrefix === rightPrefix || leftPrefix.startsWith(`${rightPrefix}/`) || rightPrefix.startsWith(`${leftPrefix}/`)) {
        return true;
      }
    }
  }
  return false;
}

export function pathWithinScopes(relativePath: string, scopes: readonly string[]): boolean {
  const normalized = relativePath.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!normalized || normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) {
    return false;
  }
  return scopes.map(normalizeWriteScope).some(scope => {
    if (scope === '**/*') {
      return true;
    }
    const prefix = scopePrefix(scope);
    return normalized === prefix || normalized.startsWith(`${prefix}/`);
  });
}

function parsePorcelain(output: string): string[] {
  return output
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => line.slice(3).trim())
    .map(file => file.includes(' -> ') ? file.split(' -> ')[1] : file)
    .map(file => file.replace(/\\/g, '/'))
    .sort();
}

async function directorySize(root: string): Promise<number> {
  let total = 0;
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop()!;
    let entries: Array<import('fs').Dirent>;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        continue;
      }
      throw error;
    }
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(entryPath);
      } else if (entry.isFile()) {
        total += (await fs.stat(entryPath)).size;
      }
    }
  }
  return total;
}

export class WorktreeManager {
  private readonly maxWorktrees: number;
  private readonly maxDiskBytes: number;
  private readonly worktreeRoot: string;
  private readonly manifestPath: string;
  private readonly git: GitCommandRunner;
  private repositoryRoot: string | null = null;
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly workspaceRoot: string,
    options: WorktreeManagerOptions = {},
    runner?: GitCommandRunner,
  ) {
    this.maxWorktrees = options.maxWorktrees ?? 4;
    this.maxDiskBytes = options.maxDiskBytes ?? 20 * 1024 * 1024 * 1024;
    if (!Number.isInteger(this.maxWorktrees) || this.maxWorktrees < 1) {
      throw new Error('maxWorktrees must be a positive integer.');
    }
    if (!Number.isFinite(this.maxDiskBytes) || this.maxDiskBytes < 1) {
      throw new Error('maxDiskBytes must be positive.');
    }
    const repoKey = crypto.createHash('sha256').update(path.resolve(workspaceRoot)).digest('hex').slice(0, 12);
    this.worktreeRoot = options.worktreeRoot
      ?? path.join(os.tmpdir(), 'ollama-agent-worktrees', `${path.basename(workspaceRoot)}-${repoKey}`);
    this.manifestPath = path.join(workspaceRoot, '.ollama-agent', 'tasks', '_worktrees', 'manifest.json');
    this.git = runner ?? new DefaultGitCommandRunner(options.gitBinary ?? 'git');
  }

  async verifyRepository(): Promise<string> {
    const requested = await fs.realpath(this.workspaceRoot);
    const result = await this.git.run(requested, ['rev-parse', '--show-toplevel']);
    const root = await fs.realpath(result.stdout.trim());
    const equal = process.platform === 'win32'
      ? root.toLowerCase() === requested.toLowerCase()
      : root === requested;
    if (!equal) {
      throw new Error(`Workspace root must be the Git repository root: ${root}`);
    }
    this.repositoryRoot = root;
    return root;
  }

  async getBaseCommit(): Promise<string> {
    const root = await this.ensureRepository();
    // `rev-parse --verify -q HEAD` prints the commit SHA for a normal repository
    // and exits non-zero with no output when HEAD is unborn (a fresh `git init`
    // with no first commit). An unborn HEAD is a supported governed greenfield
    // base, never an error here: the task's own first commit is created later,
    // governed, on its dedicated isolated branch.
    const head = await this.git.run(root, ['rev-parse', '--verify', '-q', 'HEAD']).catch(() => undefined);
    return head?.stdout.trim() || UNBORN_HEAD_COMMIT;
  }

  async getDirtyWorkspacePaths(): Promise<string[]> {
    const root = await this.ensureRepository();
    const output = (await this.git.run(root, ['status', '--porcelain=v1', '--untracked-files=all'])).stdout;
    return parsePorcelain(output);
  }

  async listLeases(): Promise<WorktreeLease[]> {
    const manifest = await this.readManifest();
    return manifest.leases.map(lease => ({ ...lease, allowedPaths: [...lease.allowedPaths], dirtyWorkspacePaths: [...lease.dirtyWorkspacePaths] }));
  }

  async createLease(
    taskId: string,
    allowedPaths: readonly string[],
    requestedBranch?: string,
    /**
     * Unified Conversation V1 — trusted-dirty absorption. Written directly
     * into the freshly created isolated worktree's working directory (plain
     * filesystem writes, never a git operation on the open workspace) so
     * Karke Dikha's own subsequent commit naturally includes this exact,
     * already-verified content plus whatever it itself changes. The open
     * workspace's repository/branch/HEAD are never touched here.
     */
    seedFiles?: readonly { path: string; content: string }[],
  ): Promise<WorktreeLease> {
    return this.serialize(async () => {
      const id = sanitizeId(taskId);
      const scopes = [...new Set(allowedPaths.map(normalizeWriteScope))];
      if (scopes.length === 0) {
        throw new Error('A write-agent task requires at least one allowed path.');
      }
      const root = await this.ensureRepository();
      if (requestedBranch) {
        await this.git.run(root, ['check-ref-format', '--branch', requestedBranch]);
      }
      const manifest = await this.readManifest();
      const retained = manifest.leases;
      if (retained.some(lease => lease.taskId === id)) {
        throw new Error(`Worktree lease ${id} already exists.`);
      }
      const activeCount = retained.filter(lease => lease.status === 'active').length;
      if (activeCount >= this.maxWorktrees) {
        throw new Error(`Worktree limit reached (${this.maxWorktrees}).`);
      }
      const overlap = retained.find(lease => lease.status === 'active' && scopesOverlap(lease.allowedPaths, scopes));
      if (overlap) {
        throw new Error(`Write scope overlaps active task ${overlap.taskId}.`);
      }
      const diskBytes = await directorySize(this.worktreeRoot);
      if (diskBytes >= this.maxDiskBytes) {
        throw new Error(`Worktree storage limit reached (${this.maxDiskBytes} bytes).`);
      }

      const baseCommit = await this.getBaseCommit();
      const dirtyWorkspacePaths = await this.getDirtyWorkspacePaths();
      const suffix = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
      const branch = requestedBranch ?? `ollama-agent/${id}-${suffix}`;
      const worktreePath = path.join(this.worktreeRoot, `${id}-${suffix}`);
      await fs.mkdir(this.worktreeRoot, { recursive: true });

      try {
        if (baseCommit === UNBORN_HEAD_COMMIT) {
          // Greenfield repository (no first commit yet): there is no commit to
          // branch from, so create an orphan worktree whose dedicated task
          // branch starts with no commits. Git infers `--orphan` automatically
          // when HEAD is unborn; an explicit `--orphan -b` retry covers Git
          // versions that need it spelled out. The task's first commit is
          // created later, governed, on this isolated branch — the user's
          // original branch is never touched and no empty commit is
          // manufactured in it.
          try {
            await this.git.run(root, ['worktree', 'add', '-b', branch, worktreePath]);
          } catch (orphanError) {
            try {
              await this.git.run(root, ['worktree', 'add', '--orphan', '-b', branch, worktreePath]);
            } catch {
              throw orphanError;
            }
          }
        } else {
          await this.git.run(root, ['worktree', 'add', '--detach', worktreePath, baseCommit]);
          await this.git.run(worktreePath, ['switch', '-c', branch]);
        }
        for (const seed of seedFiles ?? []) {
          const target = path.join(worktreePath, seed.path.replace(/\\/g, '/'));
          await fs.mkdir(path.dirname(target), { recursive: true });
          await fs.writeFile(target, seed.content, 'utf8');
        }
        const totalDiskBytes = await directorySize(this.worktreeRoot);
        if (totalDiskBytes > this.maxDiskBytes) {
          throw new Error(`Worktree storage limit exceeded (${totalDiskBytes} > ${this.maxDiskBytes} bytes).`);
        }
      } catch (error) {
        await this.git.run(root, ['worktree', 'remove', '--force', worktreePath]).catch(async () => {
          await fs.rm(worktreePath, { recursive: true, force: true });
          await this.git.run(root, ['worktree', 'prune']).catch(() => undefined);
        });
        await this.git.run(root, ['branch', '-D', branch]).catch(() => undefined);
        throw error;
      }

      const lease: WorktreeLease = {
        schemaVersion: MANIFEST_SCHEMA_VERSION,
        taskId: id,
        branch,
        worktreePath,
        repositoryRoot: root,
        baseCommit,
        allowedPaths: scopes,
        dirtyWorkspacePaths,
        createdAt: nowIso(),
        status: 'active',
      };
      manifest.leases.push(lease);
      await this.writeManifest(manifest);
      return lease;
    });
  }

  async changedFiles(taskId: string): Promise<string[]> {
    const lease = await this.requireLease(taskId);
    const output = (await this.git.run(lease.worktreePath, ['status', '--porcelain=v1', '--untracked-files=all'])).stdout;
    return parsePorcelain(output);
  }

  async assertChangedFilesInScope(taskId: string): Promise<string[]> {
    const lease = await this.requireLease(taskId);
    const changed = await this.changedFiles(taskId);
    const outside = changed.filter(file => !pathWithinScopes(file, lease.allowedPaths));
    if (outside.length > 0) {
      throw new Error(`Write-agent ${taskId} changed out-of-scope files: ${outside.join(', ')}`);
    }
    return changed;
  }

  async markStatus(taskId: string, status: WorktreeLease['status']): Promise<WorktreeLease> {
    return this.serialize(async () => {
      const manifest = await this.readManifest();
      const lease = manifest.leases.find(candidate => candidate.taskId === taskId);
      if (!lease) {
        throw new Error(`Unknown worktree lease: ${taskId}`);
      }
      lease.status = status;
      await this.writeManifest(manifest);
      return { ...lease };
    });
  }

  async cleanup(taskId: string, deleteBranch = true): Promise<void> {
    return this.serialize(async () => {
      const manifest = await this.readManifest();
      const index = manifest.leases.findIndex(candidate => candidate.taskId === taskId);
      if (index < 0) {
        return;
      }
      const lease = manifest.leases[index];
      const root = await this.ensureRepository();
      await this.git.run(root, ['worktree', 'remove', '--force', lease.worktreePath]).catch(async () => {
        await fs.rm(lease.worktreePath, { recursive: true, force: true });
        await this.git.run(root, ['worktree', 'prune']);
      });
      if (deleteBranch) {
        await this.git.run(root, ['branch', '-D', lease.branch]).catch(() => undefined);
      }
      manifest.leases.splice(index, 1);
      await this.writeManifest(manifest);
    });
  }

  async cleanupInactive(): Promise<void> {
    const leases = await this.listLeases();
    for (const lease of leases) {
      if (lease.status !== 'active') {
        await this.cleanup(lease.taskId);
      }
    }
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.operationQueue.then(operation, operation);
    this.operationQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  private async requireLease(taskId: string): Promise<WorktreeLease> {
    const lease = (await this.readManifest()).leases.find(candidate => candidate.taskId === taskId);
    if (!lease) {
      throw new Error(`Unknown worktree lease: ${taskId}`);
    }
    return lease;
  }

  private async ensureRepository(): Promise<string> {
    return this.repositoryRoot ?? this.verifyRepository();
  }

  private async readManifest(): Promise<WorktreeManifest> {
    const root = await this.ensureRepository();
    try {
      const parsed = JSON.parse(await fs.readFile(this.manifestPath, 'utf8')) as WorktreeManifest;
      if (parsed.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
        throw new Error(`Unsupported worktree manifest schema: ${parsed.schemaVersion}`);
      }
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
      return {
        schemaVersion: MANIFEST_SCHEMA_VERSION,
        repositoryRoot: root,
        updatedAt: nowIso(),
        leases: [],
      };
    }
  }

  private async writeManifest(manifest: WorktreeManifest): Promise<void> {
    manifest.updatedAt = nowIso();
    await fs.mkdir(path.dirname(this.manifestPath), { recursive: true });
    const temporary = `${this.manifestPath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    await fs.rename(temporary, this.manifestPath);
  }
}
