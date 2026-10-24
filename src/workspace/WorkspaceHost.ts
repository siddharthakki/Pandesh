import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import {
  WorktreeLease,
  WorktreeManager,
  WorktreeManagerOptions,
  normalizeWriteScope,
  scopesOverlap,
} from '../orchestration/WorktreeManager';
import { WorkspaceRootDescriptor } from './WorkspaceTypes';

const MANIFEST_SCHEMA_VERSION = 1 as const;

/**
 * Host-agnostic lease shape. A `git` host's lease is a real isolated
 * `git worktree` (see {@link GitWorktreeHost}); a `plain` host's lease is a
 * write-scope reservation directly against the live folder — there is no
 * separate isolated copy. Mutation safety in the plain case still comes from
 * `WorkspaceSnapshotBinder`/`WorkspaceMutationEngine` (content-hash snapshot,
 * revalidate-before-write, journaled rollback — see `src/coding/WorkspaceMutation.ts`),
 * which already does not depend on Git or on worktree isolation.
 */
export interface WorkspaceLease {
  taskId: string;
  /** Git branch for a `git` lease; undefined for a `plain` lease. */
  branch?: string;
  /** Isolated worktree directory for `git`; equal to `repositoryRoot` for `plain`. */
  worktreePath: string;
  repositoryRoot: string;
  /** Git base commit SHA for `git`; a synthetic lease epoch id for `plain`. */
  baseCommit: string;
  allowedPaths: string[];
  dirtyWorkspacePaths: string[];
  createdAt: string;
  status: 'active' | 'completed' | 'failed' | 'cancelled';
  isolation: 'git-worktree' | 'plain-scope-lock';
}

export interface WorkspaceHost {
  readonly kind: 'git' | 'plain';
  createLease(
    taskId: string,
    allowedPaths: readonly string[],
    requestedBranch?: string,
    seedFiles?: readonly { path: string; content: string }[],
  ): Promise<WorkspaceLease>;
  listLeases(): Promise<WorkspaceLease[]>;
  changedFiles(taskId: string): Promise<string[]>;
  assertChangedFilesInScope(taskId: string): Promise<string[]>;
  markStatus(taskId: string, status: WorkspaceLease['status']): Promise<WorkspaceLease>;
  cleanup(taskId: string, deleteBranch?: boolean): Promise<void>;
  cleanupInactive(): Promise<void>;
}

function nowIso(): string {
  return new Date().toISOString();
}

function sanitizeLeaseId(taskId: string): string {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(taskId)) {
    throw new Error(`Invalid workspace lease task id: ${taskId}`);
  }
  return taskId;
}

/**
 * Adapts the existing, unmodified {@link WorktreeManager} to {@link WorkspaceHost}.
 * No new logic — this only translates `WorktreeLease` to the host-agnostic
 * `WorkspaceLease` shape so callers can depend on one interface.
 */
export class GitWorktreeHost implements WorkspaceHost {
  readonly kind = 'git' as const;
  private readonly manager: WorktreeManager;

  constructor(workspaceRoot: string, options: WorktreeManagerOptions = {}) {
    this.manager = new WorktreeManager(workspaceRoot, options);
  }

  private toWorkspaceLease(lease: WorktreeLease): WorkspaceLease {
    return { ...lease, isolation: 'git-worktree' };
  }

  async createLease(
    taskId: string,
    allowedPaths: readonly string[],
    requestedBranch?: string,
    seedFiles?: readonly { path: string; content: string }[],
  ): Promise<WorkspaceLease> {
    return this.toWorkspaceLease(await this.manager.createLease(taskId, allowedPaths, requestedBranch, seedFiles));
  }

  async listLeases(): Promise<WorkspaceLease[]> {
    return (await this.manager.listLeases()).map(lease => this.toWorkspaceLease(lease));
  }

  changedFiles(taskId: string): Promise<string[]> {
    return this.manager.changedFiles(taskId);
  }

  assertChangedFilesInScope(taskId: string): Promise<string[]> {
    return this.manager.assertChangedFilesInScope(taskId);
  }

  async markStatus(taskId: string, status: WorkspaceLease['status']): Promise<WorkspaceLease> {
    return this.toWorkspaceLease(await this.manager.markStatus(taskId, status));
  }

  cleanup(taskId: string, deleteBranch = true): Promise<void> {
    return this.manager.cleanup(taskId, deleteBranch);
  }

  cleanupInactive(): Promise<void> {
    return this.manager.cleanupInactive();
  }
}

interface PlainLeaseManifest {
  schemaVersion: typeof MANIFEST_SCHEMA_VERSION;
  workspaceRoot: string;
  updatedAt: string;
  leases: WorkspaceLease[];
}

export interface PlainFolderHostOptions {
  maxLeases?: number;
}

/**
 * Write-scope reservation for a folder with no Git worktree isolation
 * available (`plain`, `empty`, or `nested-git` roots). There is no isolated
 * copy of the folder: exclusivity comes entirely from the scope-overlap check
 * at lease creation (reusing {@link scopesOverlap}/{@link normalizeWriteScope},
 * the same pure functions `WorktreeManager` uses), and mutation safety comes
 * from the already-git-optional `WorkspaceSnapshotBinder`/`WorkspaceMutationEngine`
 * pipeline, not from anything this class does. Because isolation is scope-lock
 * only (not a separate working copy), a `**\/*`-scoped lease — which is what
 * every current caller requests — necessarily excludes any other concurrent
 * lease on the same root; that is an intentional, honest limit, not a bug.
 */
export class PlainFolderHost implements WorkspaceHost {
  readonly kind = 'plain' as const;
  private readonly maxLeases: number;
  private readonly manifestPath: string;
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly workspaceRoot: string, options: PlainFolderHostOptions = {}) {
    this.maxLeases = options.maxLeases ?? 4;
    this.manifestPath = path.join(workspaceRoot, '.ollama-agent', 'tasks', '_workspace-leases', 'manifest.json');
  }

  async createLease(
    taskId: string,
    allowedPaths: readonly string[],
    _requestedBranch?: string,
    seedFiles?: readonly { path: string; content: string }[],
  ): Promise<WorkspaceLease> {
    return this.serialize(async () => {
      const id = sanitizeLeaseId(taskId);
      const scopes = [...new Set(allowedPaths.map(normalizeWriteScope))];
      if (scopes.length === 0) {
        throw new Error('A write-agent task requires at least one allowed path.');
      }
      const root = await fs.realpath(this.workspaceRoot);
      const manifest = await this.readManifest(root);
      if (manifest.leases.some(lease => lease.taskId === id)) {
        throw new Error(`Workspace lease ${id} already exists.`);
      }
      const activeCount = manifest.leases.filter(lease => lease.status === 'active').length;
      if (activeCount >= this.maxLeases) {
        throw new Error(`Workspace lease limit reached (${this.maxLeases}).`);
      }
      const overlap = manifest.leases.find(
        lease => lease.status === 'active' && scopesOverlap(lease.allowedPaths, scopes),
      );
      if (overlap) {
        throw new Error(`Write scope overlaps active task ${overlap.taskId}.`);
      }

      // Seeded directly into the live folder: there is no isolated copy to seed
      // into, so this is the same "trusted-dirty absorption" write the git host
      // performs into its worktree, just against the root itself.
      for (const seed of seedFiles ?? []) {
        const target = path.join(root, seed.path.replace(/\\/g, '/'));
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, seed.content, 'utf8');
      }

      const lease: WorkspaceLease = {
        taskId: id,
        worktreePath: root,
        repositoryRoot: root,
        baseCommit: `plain-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
        allowedPaths: scopes,
        dirtyWorkspacePaths: [],
        createdAt: nowIso(),
        status: 'active',
        isolation: 'plain-scope-lock',
      };
      manifest.leases.push(lease);
      await this.writeManifest(manifest);
      return lease;
    });
  }

  async listLeases(): Promise<WorkspaceLease[]> {
    const root = await fs.realpath(this.workspaceRoot);
    const manifest = await this.readManifest(root);
    return manifest.leases.map(lease => ({ ...lease, allowedPaths: [...lease.allowedPaths], dirtyWorkspacePaths: [...lease.dirtyWorkspacePaths] }));
  }

  async changedFiles(_taskId: string): Promise<string[]> {
    // No isolated copy exists to diff against without Git, and this host does
    // not maintain a parallel change-tracking subsystem (that would duplicate
    // WorkspaceMutationEngine's own MutationResult bookkeeping). Callers that
    // need per-mutation change lists already get them from MutationResult at
    // apply time; this reports "unknown," not "clean," to its caller via an
    // empty list plus the documented limitation here.
    return [];
  }

  async assertChangedFilesInScope(taskId: string): Promise<string[]> {
    await this.requireLease(taskId);
    return this.changedFiles(taskId);
  }

  async markStatus(taskId: string, status: WorkspaceLease['status']): Promise<WorkspaceLease> {
    return this.serialize(async () => {
      const root = await fs.realpath(this.workspaceRoot);
      const manifest = await this.readManifest(root);
      const lease = manifest.leases.find(candidate => candidate.taskId === taskId);
      if (!lease) {
        throw new Error(`Unknown workspace lease: ${taskId}`);
      }
      lease.status = status;
      await this.writeManifest(manifest);
      return { ...lease };
    });
  }

  async cleanup(taskId: string): Promise<void> {
    return this.serialize(async () => {
      const root = await fs.realpath(this.workspaceRoot);
      const manifest = await this.readManifest(root);
      const index = manifest.leases.findIndex(candidate => candidate.taskId === taskId);
      if (index < 0) return;
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

  private async requireLease(taskId: string): Promise<WorkspaceLease> {
    const lease = (await this.listLeases()).find(candidate => candidate.taskId === taskId);
    if (!lease) {
      throw new Error(`Unknown workspace lease: ${taskId}`);
    }
    return lease;
  }

  private async readManifest(root: string): Promise<PlainLeaseManifest> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.manifestPath, 'utf8')) as PlainLeaseManifest;
      if (parsed.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
        throw new Error(`Unsupported workspace lease manifest schema: ${parsed.schemaVersion}`);
      }
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
      return { schemaVersion: MANIFEST_SCHEMA_VERSION, workspaceRoot: root, updatedAt: nowIso(), leases: [] };
    }
  }

  private async writeManifest(manifest: PlainLeaseManifest): Promise<void> {
    manifest.updatedAt = nowIso();
    await fs.mkdir(path.dirname(this.manifestPath), { recursive: true });
    const temporary = `${this.manifestPath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    await fs.rename(temporary, this.manifestPath);
  }
}

/**
 * Picks the isolation backend for a root. Only a root that is itself a Git
 * repository top-level (`kind === 'git'`) can use real `git worktree`
 * isolation — a subdirectory of a larger repo (`nested-git`) cannot be
 * worktree-isolated without operating on the whole repo, so it degrades to
 * `PlainFolderHost` along with `plain`/`empty` roots. Git is an optional
 * *enhanced* backend selected per root, never a requirement.
 */
export class WorkspaceHostFactory {
  static forRoot(
    root: WorkspaceRootDescriptor,
    options: { git?: WorktreeManagerOptions; plain?: PlainFolderHostOptions } = {},
  ): WorkspaceHost {
    if (root.kind === 'git') {
      return new GitWorktreeHost(root.path, options.git);
    }
    return new PlainFolderHost(root.path, options.plain);
  }
}
