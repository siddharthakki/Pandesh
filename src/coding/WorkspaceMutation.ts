import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import { spawn } from 'child_process';
import { CodingFileOperation, CodingFileOperationType, CodingProposal, hasExplicitFileDeletionIntent, hasModifyIntent } from './CodingProposal';
import { WorkspaceInspectionTools, throwIfAborted } from './WorkspaceInspection';
import { TransactionJournal } from './TransactionJournal';
import { conformContentToExistingEol } from './EolPolicy';

/**
 * Bounded, non-sensitive evidence describing why {@link WorkspaceSnapshotBinder.bind}
 * rejected a proposal operation. Deliberately excludes proposed content, prompts, raw
 * model output and unrestricted exception detail so it is always safe to persist.
 */
export interface ProposalConflictEvidence {
  operationIndex: number;
  targetPath: string;
  operationKind: CodingFileOperationType;
  classification: 'create_target_exists' | 'file_missing_at_binding' | 'duplicate_proposal_target';
  targetExistedAtBase: boolean;
  targetExistedAtBindingTime: boolean;
  duplicateTargetIndex?: number;
  proposalOperationCount: number;
  baseCommitSha?: string;
  /** Number of bounded proposal-regeneration attempts already made for this conflict (0 or 1). */
  repairAttempts: number;
  /** Present only after a regeneration attempt. Operation count of the regenerated
   * candidate, and whether it re-validated cleanly against the bound worktree. */
  regeneratedProposalOperationCount?: number;
  regeneratedProposalValidationResult?: 'valid' | 'invalid' | 'unavailable';
}

export class ProposalConflictError extends Error {
  constructor(message: ProposalConflictEvidence['classification'], readonly proposalConflictEvidence: ProposalConflictEvidence) {
    super(message);
  }
}

export interface MutationResult {
  filesCreated: string[];
  filesModified: string[];
  filesDeleted: string[];
  filesRestored: string[];
  rollbackAttempted: boolean;
  rollbackSucceeded: boolean;
}

interface RollbackEntry {
  path: string;
  existed: boolean;
  content?: Buffer;
}

export type HostBoundSnapshot =
  | { state: 'exists'; sha256: string; bytes: number; capturedAt: string }
  | { state: 'absent'; capturedAt: string };

export interface HostBoundCodingFileOperation extends CodingFileOperation {
  canonicalPath: string;
  snapshot: HostBoundSnapshot;
}

export interface HostBoundCodingProposal extends Omit<CodingProposal, 'operations'> {
  operations: HostBoundCodingFileOperation[];
}

export class WorkspaceSnapshotBinder {
  constructor(
    private readonly workspaceRoot: string,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async bind(proposal: CodingProposal, signal?: AbortSignal, baseCommitSha?: string): Promise<HostBoundCodingProposal> {
    const inspection = new WorkspaceInspectionTools(this.workspaceRoot);
    const operations: HostBoundCodingFileOperation[] = [];
    const seenTargets = new Map<string, number>();
    for (let index = 0; index < proposal.operations.length; index += 1) {
      const operation = proposal.operations[index];
      throwIfAborted(signal);
      const normalizedTarget = operation.path.toLowerCase();
      const duplicateOfIndex = seenTargets.get(normalizedTarget);
      if (duplicateOfIndex !== undefined) {
        throw new ProposalConflictError('duplicate_proposal_target', {
          operationIndex: index,
          targetPath: operation.path,
          operationKind: operation.type,
          classification: 'duplicate_proposal_target',
          targetExistedAtBase: false,
          targetExistedAtBindingTime: false,
          duplicateTargetIndex: duplicateOfIndex,
          proposalOperationCount: proposal.operations.length,
          baseCommitSha,
          repairAttempts: 0,
        });
      }
      seenTargets.set(normalizedTarget, index);
      const canonicalPath = await inspection.resolveInsideWorkspace(operation.path);
      throwIfAborted(signal);
      const { snapshot, existing } = await this.snapshotOperation(operation, canonicalPath, index, proposal.operations.length, baseCommitSha, signal);
      // An anchored edit was expanded from specific on-disk bytes; if the file moved since, fail closed.
      if (operation.editBaseSha256 && (snapshot.state !== 'exists' || snapshot.sha256 !== operation.editBaseSha256)) {
        throw new Error('workspace_changed_after_review');
      }
      // Replacing a CRLF file with LF-only text would flip the whole file. Conform once, here, before anything is
      // approved or hashed, so every later stage sees the same bytes. See EolPolicy.conformContentToExistingEol.
      const conformed = operation.type === 'replace' && existing && typeof operation.content === 'string'
        && await repositoryStoresCrlf(this.workspaceRoot, operation.path)
        ? conformContentToExistingEol(operation.content, existing, `${proposal.taskSummary} ${operation.reason ?? ''}`)
        : undefined;
      operations.push({ ...operation, ...(conformed?.conformed ? { content: conformed.content } : {}), canonicalPath, snapshot });
    }
    return { ...proposal, operations };
  }

  private async snapshotOperation(
    operation: CodingFileOperation,
    canonicalPath: string,
    operationIndex: number,
    proposalOperationCount: number,
    baseCommitSha: string | undefined,
    signal?: AbortSignal,
  ): Promise<{ snapshot: HostBoundSnapshot; existing?: Buffer }> {
    if (operation.type === 'create') {
      const exists = await existsPath(canonicalPath);
      throwIfAborted(signal);
      if (exists) {
        const existedAtBase = baseCommitSha
          ? await gitPathExistsAtCommit(this.workspaceRoot, baseCommitSha, operation.path)
          : exists;
        throw new ProposalConflictError('create_target_exists', {
          operationIndex,
          targetPath: operation.path,
          operationKind: operation.type,
          classification: 'create_target_exists',
          targetExistedAtBase: existedAtBase,
          targetExistedAtBindingTime: exists,
          proposalOperationCount,
          baseCommitSha,
          repairAttempts: 0,
        });
      }
      return { snapshot: { state: 'absent', capturedAt: this.now() } };
    }
    let bytes: Buffer;
    try {
      await assertExistingTargetInside(this.workspaceRoot, canonicalPath);
      bytes = await readExistingBytes(canonicalPath, 'snapshot_read_failed');
    } catch (error) {
      if (error instanceof Error && error.message === 'file_missing_at_binding') {
        const existedAtBase = baseCommitSha
          ? await gitPathExistsAtCommit(this.workspaceRoot, baseCommitSha, operation.path)
          : false;
        throw new ProposalConflictError('file_missing_at_binding', {
          operationIndex,
          targetPath: operation.path,
          operationKind: operation.type,
          classification: 'file_missing_at_binding',
          targetExistedAtBase: existedAtBase,
          targetExistedAtBindingTime: false,
          proposalOperationCount,
          baseCommitSha,
          repairAttempts: 0,
        });
      }
      throw error;
    }
    throwIfAborted(signal);
    return { snapshot: { state: 'exists', sha256: sha256(bytes), bytes: bytes.length, capturedAt: this.now() }, existing: bytes };
  }
}

/**
 * True only when the file's committed (index) bytes are themselves CRLF and the working copy is CRLF too
 * (`git ls-files --eol` reports `i/crlf w/crlf`). Under `core.autocrlf=true` the repository stores LF and CRLF is
 * only how Git renders the checkout; Git normalises either spelling at commit, so nothing needs preserving and the
 * content is left exactly as approved. Any git failure answers false: never conform on a guess.
 */
async function repositoryStoresCrlf(workspaceRoot: string, relativePath: string): Promise<boolean> {
  return new Promise(resolve => {
    try {
      const child = spawn('git', ['ls-files', '--eol', '--', relativePath.split('\\').join('/')], {
        cwd: workspaceRoot,
        shell: false,
        windowsHide: true,
      });
      let stdout = '';
      const timer = setTimeout(() => {
        child.kill();
        resolve(false);
      }, 5_000);
      child.stdout.on('data', data => { stdout += String(data); });
      child.on('error', () => {
        clearTimeout(timer);
        resolve(false);
      });
      child.on('close', code => {
        clearTimeout(timer);
        resolve(code === 0 && /^i\/crlf\s+w\/crlf/.test(stdout.trim()));
      });
    } catch {
      resolve(false);
    }
  });
}

async function gitPathExistsAtCommit(workspaceRoot: string, sha: string, relativePath: string): Promise<boolean> {
  return new Promise(resolve => {
    try {
      const child = spawn('git', ['cat-file', '-e', `${sha}:${relativePath.replace(/\\/g, '/')}`], {
        cwd: workspaceRoot,
        shell: false,
        windowsHide: true,
      });
      const timer = setTimeout(() => {
        child.kill();
        resolve(false);
      }, 5_000);
      child.on('error', () => {
        clearTimeout(timer);
        resolve(false);
      });
      child.on('close', code => {
        clearTimeout(timer);
        resolve(code === 0);
      });
    } catch {
      resolve(false);
    }
  });
}

export function assertExplicitDeleteIntent(
  operation: CodingFileOperation,
  taskSummary?: string,
): void {
  if (operation.type !== 'delete') {
    return;
  }
  if (operation.content !== undefined && operation.content.trim().length > 0) {
    throw new Error(`delete_intent_mismatch: delete operation on "${operation.path}" carries non-empty content`);
  }
  if (!hasExplicitFileDeletionIntent(operation.reason, taskSummary, operation.path)) {
    throw new Error(
      `delete_intent_mismatch: operation on existing path "${operation.path}" was classified as delete without explicit whole-file deletion intent ("${operation.reason || taskSummary || ''}")`,
    );
  }
}

export class WorkspaceMutationEngine {
  private disposed = false;

  constructor(private readonly workspaceRoot: string) {}

  dispose(): void {
    this.disposed = true;
  }

  async apply(proposal: HostBoundCodingProposal, signal?: AbortSignal): Promise<MutationResult> {
    // Deterministic pre-mutation invariant: fail closed if delete operation lacks explicit delete intent
    for (const operation of proposal.operations) {
      if (operation.type === 'delete') {
        assertExplicitDeleteIntent(operation, proposal.taskSummary);
      }
    }

    const inspection = new WorkspaceInspectionTools(this.workspaceRoot);
    const transactionId = `tx_${process.pid}_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
    const journalPath = await TransactionJournal.writePrepared(this.workspaceRoot, transactionId, {
      operations: proposal.operations.map(operation => ({
        type: operation.type,
        path: operation.path,
        snapshot: operation.snapshot,
        intendedHash: operation.content === undefined ? undefined : sha256(Buffer.from(operation.content, 'utf8')),
      })),
    });
    const result: MutationResult = {
      filesCreated: [],
      filesModified: [],
      filesDeleted: [],
      filesRestored: [],
      rollbackAttempted: false,
      rollbackSucceeded: true,
    };
    const rollback: RollbackEntry[] = [];
    try {
      for (const operation of proposal.operations) {
        this.assertActive(signal);
        const absolute = await inspection.resolveInsideWorkspace(operation.path);
        this.assertActive(signal);
        const before = await this.revalidateSnapshot(operation, absolute, signal);
        rollback.push({ path: absolute, existed: before !== undefined, content: before });
        if (operation.type === 'delete') {
          await fs.rm(absolute, { force: false });
          result.filesDeleted.push(operation.path);
        } else {
          if (operation.content === undefined || operation.content.includes('\u0000')) {
            throw new Error('binary_content_rejected');
          }
          await fs.mkdir(path.dirname(absolute), { recursive: true });
          const temporary = path.join(path.dirname(absolute), `.tmp-${process.pid}-${Date.now()}-${path.basename(absolute)}`);
          await fs.writeFile(temporary, operation.content, 'utf8');
          await fs.rename(temporary, absolute);
          if (before === undefined) {
            result.filesCreated.push(operation.path);
          } else {
            result.filesModified.push(operation.path);
          }
        }
      }
      await TransactionJournal.complete(journalPath);
      return result;
    } catch (error) {
      result.rollbackAttempted = rollback.length > 0;
      result.rollbackSucceeded = await this.rollback(rollback.reverse(), result);
      await TransactionJournal.complete(journalPath).catch(() => undefined);
      throw Object.assign(error instanceof Error ? error : new Error('mutation_failed'), { mutationResult: result });
    }
  }

  private async revalidateSnapshot(
    operation: HostBoundCodingFileOperation,
    absolute: string,
    signal?: AbortSignal,
  ): Promise<Buffer | undefined> {
    if (operation.snapshot.state === 'absent') {
      const exists = await existsPath(absolute);
      this.assertActive(signal);
      if (exists) {
        throw new Error('workspace_changed_after_review');
      }
      return undefined;
    }
    let before: Buffer;
    try {
      await assertExistingTargetInside(this.workspaceRoot, absolute);
      before = await fs.readFile(absolute);
    } catch (error) {
      if (isNotFound(error) || (error instanceof Error && error.message === 'file_missing_at_binding')) {
        throw new Error('workspace_changed_after_review');
      }
      if (error instanceof Error && error.message === 'path_outside_workspace') {
        throw error;
      }
      throw new Error('snapshot_read_failed');
    }
    this.assertActive(signal);
    if (sha256(before) !== operation.snapshot.sha256) {
      throw new Error('workspace_changed_after_review');
    }
    return before;
  }

  private async rollback(entries: RollbackEntry[], result: MutationResult): Promise<boolean> {
    let ok = true;
    for (const entry of entries) {
      try {
        if (entry.existed) {
          await fs.mkdir(path.dirname(entry.path), { recursive: true });
          await fs.writeFile(entry.path, entry.content ?? Buffer.alloc(0));
        } else {
          await fs.rm(entry.path, { force: true });
        }
        result.filesRestored.push(path.relative(this.workspaceRoot, entry.path).replace(/\\/g, '/'));
      } catch {
        ok = false;
      }
    }
    return ok;
  }

  private assertActive(signal?: AbortSignal): void {
    if (this.disposed) {
      throw new Error('controller_disposed');
    }
    throwIfAborted(signal);
  }
}

async function readExistingBytes(absolute: string, failureCode: string): Promise<Buffer> {
  try {
    return await fs.readFile(absolute);
  } catch (error) {
    if (isNotFound(error)) {
      throw new Error('file_missing_at_binding');
    }
    throw new Error(failureCode);
  }
}

async function existsPath(absolute: string): Promise<boolean> {
  try {
    await fs.lstat(absolute);
    return true;
  } catch (error) {
    if (isNotFound(error)) {
      return false;
    }
    throw new Error('snapshot_read_failed');
  }
}

export function sha256(buffer: Buffer): string {
  return `sha256:${crypto.createHash('sha256').update(buffer).digest('hex')}`;
}

async function assertExistingTargetInside(workspaceRoot: string, absolute: string): Promise<void> {
  try {
    const root = await fs.realpath(workspaceRoot);
    const target = await fs.realpath(absolute);
    const relative = path.relative(root, target);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('path_outside_workspace');
    }
  } catch (error) {
    if (error instanceof Error && error.message === 'path_outside_workspace') {
      throw error;
    }
    if (isNotFound(error)) {
      throw new Error('file_missing_at_binding');
    }
    throw new Error('snapshot_read_failed');
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT';
}
