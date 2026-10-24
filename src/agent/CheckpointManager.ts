import * as path from 'path';
import * as fs from 'fs/promises';
import { FileService } from '../services/FileService';
import { Config } from '../config/Config';
import { CommandService } from '../services/CommandService';
import { WorkspaceSecurity } from '../services/WorkspaceSecurity';

export type CheckpointOperation = 'create' | 'modify' | 'delete' | 'rename' | 'batch_patch' | 'unknown';

export interface CheckpointFile {
  path: string;
  existed: boolean;
  contentPath: string;
  sha256Before: string;
  operation: CheckpointOperation;
}

export interface GitState {
  branch: string;
  head: string;
  isDirty: boolean;
}

export interface CheckpointMeta {
  id: string;
  timestamp: string;
  reason: string;
  files: CheckpointFile[];
  model: string;
  sessionId: string;
  turnId: string;
  toolName: string;
  toolCallId?: string;
  args?: Record<string, unknown>;
  iterationId?: string;
  taskId?: string;
  gitState?: GitState | null;
}

export interface CheckpointCreateMeta {
  reason: string;
  model: string;
  sessionId: string;
  turnId: string;
  toolName: string;
  toolCallId?: string;
  args?: Record<string, unknown>;
  iterationId?: string;
  taskId?: string;
}

function deriveOperation(toolName: string, existed: boolean): CheckpointOperation {
  switch (toolName) {
    case 'delete_file': return 'delete';
    case 'rename_file':
    case 'move_file': return 'rename';
    case 'replace_in_file':
    case 'apply_patch': return 'batch_patch';
    case 'edit_file':
    case 'write_file':
    case 'create_directory': return existed ? 'modify' : 'create';
    default: return existed ? 'modify' : 'unknown';
  }
}

export class CheckpointManager {
  private readonly checkpointDir: string;

  constructor(private readonly workspaceRoot: string) {
    this.checkpointDir = path.join(workspaceRoot, '.ollama-agent', 'checkpoints');
  }

  async createCheckpoint(
    files: string[],
    meta: CheckpointCreateMeta,
  ): Promise<string | null> {
    if (!Config.getEnableCheckpoints()) {
      return null;
    }

    const id = `cp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const cpDir = path.join(this.checkpointDir, id);
    await fs.mkdir(cpDir, { recursive: true });

    const checkpointFiles: CheckpointFile[] = [];

    for (const requestedPath of files) {
      const filePath = await WorkspaceSecurity.resolveInsideWorkspace(
        requestedPath,
        this.workspaceRoot,
        Config.getAllowOutsideWorkspace(),
      );
      const existed = await FileService.exists(filePath);
      let sha256Before = '';
      let contentPath = '';

      if (existed) {
        sha256Before = await FileService.sha256(filePath);
        const rel = path.relative(this.workspaceRoot, filePath).replace(/[/\\:]/g, '_');
        contentPath = path.join(cpDir, rel);
        await FileService.copyFile(filePath, contentPath);
      }

      checkpointFiles.push({
        path: filePath,
        existed,
        contentPath,
        sha256Before,
        operation: deriveOperation(meta.toolName, existed),
      });
    }

    const gitState = await this.captureGitState();

    const checkpoint: CheckpointMeta = {
      id,
      timestamp: new Date().toISOString(),
      reason: meta.reason,
      files: checkpointFiles,
      model: meta.model,
      sessionId: meta.sessionId,
      turnId: meta.turnId,
      toolName: meta.toolName,
      toolCallId: meta.toolCallId,
      args: meta.args,
      iterationId: meta.iterationId,
      taskId: meta.taskId,
      gitState,
    };

    await FileService.atomicWriteText(
      path.join(cpDir, 'meta.json'),
      JSON.stringify(checkpoint, null, 2),
    );

    return id;
  }

  async rewindCheckpoint(id: string): Promise<{ restored: string[]; skipped: string[] } | null> {
    const cpDir = path.join(this.checkpointDir, id);
    const metaPath = path.join(cpDir, 'meta.json');

    let meta: CheckpointMeta;
    try {
      const metaText = await FileService.readText(metaPath);
      meta = JSON.parse(metaText);
    } catch {
      return null;
    }

    const restored: string[] = [];
    const skipped: string[] = [];

    for (const file of meta.files) {
      let resolvedPath: string;
      try {
        resolvedPath = await WorkspaceSecurity.resolveInsideWorkspace(
          file.path,
          this.workspaceRoot,
          Config.getAllowOutsideWorkspace(),
        );
      } catch {
        skipped.push(`traversal-blocked: ${file.path}`);
        continue;
      }

      if (!file.existed) {
        try { await fs.unlink(resolvedPath); } catch { /* already gone */ }
        restored.push(`deleted: ${resolvedPath}`);
      } else if (file.contentPath) {
        if (!(await FileService.exists(file.contentPath))) {
          skipped.push(`missing-backup: ${resolvedPath}`);
          continue;
        }
        await FileService.copyFile(file.contentPath, resolvedPath);
        restored.push(`restored: ${resolvedPath}`);
      }
    }

    await fs.rm(cpDir, { recursive: true, force: true });

    return { restored, skipped };
  }

  async rewindLastCheckpoint(): Promise<{ id: string; restored: string[]; skipped: string[] } | null> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.checkpointDir);
    } catch {
      return null;
    }

    const sorted = entries
      .filter((e) => e.startsWith('cp_'))
      .sort()
      .reverse();

    if (sorted.length === 0) return null;

    const lastId = sorted[0];
    const result = await this.rewindCheckpoint(lastId);
    if (!result) return null;

    return { id: lastId, ...result };
  }

  async rewindIteration(iterationId: string): Promise<{ count: number; restored: string[]; skipped: string[] }> {
    const all = await this.listCheckpoints();
    const forIteration = all.filter((cp) => cp.iterationId === iterationId);
    forIteration.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

    const allRestored: string[] = [];
    const allSkipped: string[] = [];
    for (const cp of forIteration) {
      const result = await this.rewindCheckpoint(cp.id);
      if (result) {
        allRestored.push(...result.restored);
        allSkipped.push(...result.skipped);
      }
    }

    return { count: forIteration.length, restored: allRestored, skipped: allSkipped };
  }

  async rewindAll(opts: { confirm: true }): Promise<{ checkpointsRemoved: number; restored: string[]; skipped: string[] }> {
    const all = await this.listCheckpoints();
    const allRestored: string[] = [];
    const allSkipped: string[] = [];

    for (const cp of all) {
      const result = await this.rewindCheckpoint(cp.id);
      if (result) {
        allRestored.push(...result.restored);
        allSkipped.push(...result.skipped);
      }
    }

    return { checkpointsRemoved: all.length, restored: allRestored, skipped: allSkipped };
  }

  async listCheckpoints(): Promise<CheckpointMeta[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.checkpointDir);
    } catch {
      return [];
    }

    const checkpoints: CheckpointMeta[] = [];
    for (const entry of entries.filter((e) => e.startsWith('cp_'))) {
      try {
        const meta = JSON.parse(
          await FileService.readText(path.join(this.checkpointDir, entry, 'meta.json')),
        ) as CheckpointMeta;
        checkpoints.push(meta);
      } catch {
        // Ignore malformed checkpoint entries.
      }
    }

    return checkpoints.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  }

  async pruneOldCheckpoints(maxCount: number): Promise<number> {
    const all = await this.listCheckpoints();
    const remove = all.slice(Math.max(0, maxCount));
    for (const checkpoint of remove) {
      await fs.rm(path.join(this.checkpointDir, checkpoint.id), { recursive: true, force: true });
    }
    return remove.length;
  }

  async pruneBySessionId(sessionId: string): Promise<number> {
    const all = await this.listCheckpoints();
    const remove = all.filter(checkpoint => checkpoint.sessionId === sessionId);
    for (const checkpoint of remove) {
      await fs.rm(path.join(this.checkpointDir, checkpoint.id), { recursive: true, force: true });
    }
    return remove.length;
  }

  private async captureGitState(): Promise<GitState | null> {
    try {
      const inside = await CommandService.run('git rev-parse --is-inside-work-tree', this.workspaceRoot, 5_000);
      if (inside.exitCode !== 0 || inside.stdout.trim() !== 'true') { return null; }
      const [branchResult, headResult, statusResult] = await Promise.all([
        CommandService.run('git branch --show-current', this.workspaceRoot, 5_000),
        CommandService.run('git rev-parse HEAD', this.workspaceRoot, 5_000),
        CommandService.run('git status --porcelain', this.workspaceRoot, 5_000),
      ]);
      return {
        branch: branchResult.stdout.trim(),
        head: headResult.stdout.trim(),
        isDirty: Boolean(statusResult.stdout.trim()),
      };
    } catch {
      return null;
    }
  }
}
