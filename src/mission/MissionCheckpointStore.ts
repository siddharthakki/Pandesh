import * as fs from 'fs/promises';
import * as path from 'path';
import { MissionCheckpoint } from './MissionCheckpoint';

function validateTaskId(taskId: string): void {
  if (!taskId || !/^[a-zA-Z0-9_-]{1,100}$/.test(taskId)) {
    throw new Error(`Invalid task ID (unsafe characters or length): "${taskId}"`);
  }
}

/**
 * Durable storage for mission checkpoints. Deliberately rooted under the
 * extension's own managed storage (the caller passes
 * `ExtensionContext.globalStorageUri.fsPath` or `.workspaceStorageUri.fsPath`),
 * not the user's workspace: unlike `TaskStore`'s task directory — which the
 * user can see and is meant to be able to inspect — a mission checkpoint is
 * internal bookkeeping with no reason to appear in their folder. Atomic
 * write-rename mirrors `TaskStore`'s existing pattern.
 */
export class MissionCheckpointStore {
  private readonly root: string;

  constructor(managedStorageRoot: string) {
    this.root = path.join(managedStorageRoot, 'mission-checkpoints');
  }

  private currentPath(taskId: string): string {
    validateTaskId(taskId);
    return path.join(this.root, `${taskId}.json`);
  }

  private historyPath(taskId: string): string {
    validateTaskId(taskId);
    return path.join(this.root, `${taskId}.history.jsonl`);
  }

  async read(taskId: string): Promise<MissionCheckpoint | undefined> {
    try {
      const raw = await fs.readFile(this.currentPath(taskId), 'utf8');
      return JSON.parse(raw) as MissionCheckpoint;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  /**
   * Writes the latest checkpoint (atomic write-rename, always readable by
   * {@link read}) and appends it to a bounded append-only history file so a
   * restart can see how the mission's memory evolved, not just its latest
   * state. History append failures are logged-and-swallowed by the caller if
   * desired; this method itself still throws on the primary write failing.
   */
  async write(checkpoint: MissionCheckpoint): Promise<void> {
    await fs.mkdir(this.root, { recursive: true });
    const filePath = this.currentPath(checkpoint.taskId);
    const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    const content = `${JSON.stringify(checkpoint, null, 2)}\n`;
    await fs.writeFile(temporary, content, 'utf8');
    await fs.rename(temporary, filePath);
    await fs.appendFile(this.historyPath(checkpoint.taskId), `${JSON.stringify(checkpoint)}\n`, 'utf8').catch(() => undefined);
  }

  async delete(taskId: string): Promise<void> {
    await fs.rm(this.currentPath(taskId), { force: true });
    await fs.rm(this.historyPath(taskId), { force: true });
  }

  async listTaskIds(): Promise<string[]> {
    try {
      const entries = await fs.readdir(this.root);
      return entries.filter(name => name.endsWith('.json') && !name.endsWith('.history.jsonl')).map(name => name.slice(0, -'.json'.length));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }
}
