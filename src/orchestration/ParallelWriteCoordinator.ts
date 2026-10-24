import * as fs from 'fs/promises';
import * as path from 'path';
import {
  WorktreeLease,
  WorktreeManager,
  scopesOverlap,
} from './WorktreeManager';

export interface ParallelWriteTask {
  id: string;
  role: string;
  objective: string;
  allowedPaths: string[];
  validationCommands: string[];
  provider?: string;
  model?: string;
}

export interface ParallelWriteExecutionOutput {
  summary: string;
  evidence?: Record<string, unknown>;
}

export interface ParallelWriteExecutionContext {
  signal: AbortSignal;
  lease: Readonly<WorktreeLease>;
}

export interface ParallelWriteExecutor {
  execute(task: Readonly<ParallelWriteTask>, context: ParallelWriteExecutionContext): Promise<ParallelWriteExecutionOutput>;
}

export interface ParallelWriteValidationResult {
  passed: boolean;
  commandsRun: string[];
  output?: string;
}

export interface ParallelWriteValidator {
  validate(task: Readonly<ParallelWriteTask>, lease: Readonly<WorktreeLease>, signal: AbortSignal): Promise<ParallelWriteValidationResult>;
}

export interface ParallelWriteAgentResult {
  taskId: string;
  status: 'completed' | 'failed' | 'cancelled';
  lease?: WorktreeLease;
  changedFiles: string[];
  execution?: ParallelWriteExecutionOutput;
  validation?: ParallelWriteValidationResult;
  error?: string;
  checkpointPath?: string;
}

export interface ParallelWriteBatchResult {
  results: ParallelWriteAgentResult[];
  cancelled: boolean;
}

export interface ParallelWriteCoordinatorOptions {
  concurrency?: number;
  cleanupFailed?: boolean;
}

class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error('Parallel write concurrency must be a positive integer.');
    }
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>(resolve => this.waiters.push(resolve));
    }
    this.active += 1;
    try {
      return await operation();
    } finally {
      this.active -= 1;
      this.waiters.shift()?.();
    }
  }
}

function abortError(): Error {
  const error = new Error('Parallel write batch cancelled.');
  error.name = 'AbortError';
  return error;
}

export class ParallelWriteCoordinator {
  private readonly semaphore: Semaphore;
  private readonly cleanupFailed: boolean;
  private controller: AbortController | null = null;

  constructor(
    private readonly workspaceRoot: string,
    private readonly worktrees: WorktreeManager,
    options: ParallelWriteCoordinatorOptions = {},
  ) {
    this.semaphore = new Semaphore(options.concurrency ?? 2);
    this.cleanupFailed = options.cleanupFailed ?? true;
  }

  async run(
    tasks: readonly ParallelWriteTask[],
    executor: ParallelWriteExecutor,
    validator: ParallelWriteValidator,
  ): Promise<ParallelWriteBatchResult> {
    if (this.controller) {
      throw new Error('Parallel write coordinator is already running.');
    }
    this.validateTasks(tasks);
    this.controller = new AbortController();
    const signal = this.controller.signal;
    const leases = new Map<string, WorktreeLease>();

    try {
      try {
        // Git worktrees share administrative metadata in the main repository.
        // Provision every lease before releasing any agent so a worktree-local
        // git command cannot race another `git worktree add` on Windows.
        for (const task of tasks) {
          if (signal.aborted) {
            throw abortError();
          }
          leases.set(task.id, await this.worktrees.createLease(task.id, task.allowedPaths));
        }
      } catch (error) {
        await this.cleanupLeases(leases.values());
        const cancelled = signal.aborted || (error instanceof Error && error.name === 'AbortError');
        const message = error instanceof Error ? error.message : String(error);
        return {
          results: tasks.map(task => ({
            taskId: task.id,
            status: cancelled ? 'cancelled' : 'failed',
            changedFiles: [],
            error: `Worktree provisioning failed: ${message}`,
          })),
          cancelled,
        };
      }

      const executions = tasks.map((task, index) => this.semaphore.run(async () => {
        const lease = leases.get(task.id);
        if (!lease) {
          throw new Error(`Missing prepared worktree lease for ${task.id}.`);
        }
        const result = await this.runOne(task, lease, executor, validator, signal);
        return { index, result };
      }));
      const settled = await Promise.all(executions);
      return {
        results: settled.sort((left, right) => left.index - right.index).map(entry => entry.result),
        cancelled: signal.aborted,
      };
    } finally {
      this.controller = null;
    }
  }

  cancel(): boolean {
    if (!this.controller || this.controller.signal.aborted) {
      return false;
    }
    this.controller.abort();
    return true;
  }

  async discard(taskId: string): Promise<void> {
    await this.worktrees.cleanup(taskId);
  }

  private async runOne(
    task: ParallelWriteTask,
    lease: WorktreeLease,
    executor: ParallelWriteExecutor,
    validator: ParallelWriteValidator,
    signal: AbortSignal,
  ): Promise<ParallelWriteAgentResult> {
    try {
      if (signal.aborted) {
        throw abortError();
      }
      const execution = await executor.execute(task, { signal, lease });
      if (signal.aborted) {
        throw abortError();
      }
      const changedFiles = await this.worktrees.assertChangedFilesInScope(task.id);
      const validation = await validator.validate(task, lease, signal);
      if (!validation.passed) {
        throw new Error(`Validation failed for write-agent ${task.id}.`);
      }
      const checkpointPath = await this.persistCheckpoint(task, lease, changedFiles, validation);
      const completedLease = await this.worktrees.markStatus(task.id, 'completed');
      return {
        taskId: task.id,
        status: 'completed',
        lease: completedLease,
        changedFiles,
        execution,
        validation,
        checkpointPath,
      };
    } catch (error) {
      const cancelled = signal.aborted || (error instanceof Error && error.name === 'AbortError');
      await this.worktrees.markStatus(task.id, cancelled ? 'cancelled' : 'failed').catch(() => undefined);
      if (cancelled || this.cleanupFailed) {
        await this.worktrees.cleanup(task.id).catch(() => undefined);
      }
      return {
        taskId: task.id,
        status: cancelled ? 'cancelled' : 'failed',
        lease: cancelled || this.cleanupFailed ? undefined : lease,
        changedFiles: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private validateTasks(tasks: readonly ParallelWriteTask[]): void {
    const ids = new Set<string>();
    for (const task of tasks) {
      if (!/^[a-zA-Z0-9_-]{1,100}$/.test(task.id)) {
        throw new Error(`Invalid parallel write task id: ${task.id}`);
      }
      if (ids.has(task.id)) {
        throw new Error(`Duplicate parallel write task id: ${task.id}`);
      }
      ids.add(task.id);
      if (!task.objective.trim()) {
        throw new Error(`Parallel write task ${task.id} has no objective.`);
      }
      if (task.allowedPaths.length === 0) {
        throw new Error(`Parallel write task ${task.id} has no allowed paths.`);
      }
    }
    for (let left = 0; left < tasks.length; left += 1) {
      for (let right = left + 1; right < tasks.length; right += 1) {
        if (scopesOverlap(tasks[left].allowedPaths, tasks[right].allowedPaths)) {
          throw new Error(`Parallel write task scopes overlap: ${tasks[left].id} and ${tasks[right].id}.`);
        }
      }
    }
  }

  private async cleanupLeases(leases: Iterable<WorktreeLease>): Promise<void> {
    for (const lease of leases) {
      await this.worktrees.cleanup(lease.taskId).catch(() => undefined);
    }
  }

  private async persistCheckpoint(
    task: ParallelWriteTask,
    lease: WorktreeLease,
    changedFiles: string[],
    validation: ParallelWriteValidationResult,
  ): Promise<string> {
    const directory = path.join(this.workspaceRoot, '.ollama-agent', 'tasks', '_worktrees', 'checkpoints');
    const filename = path.join(directory, `${task.id}.json`);
    await fs.mkdir(directory, { recursive: true });
    const record = {
      schemaVersion: 1,
      taskId: task.id,
      baseCommit: lease.baseCommit,
      branch: lease.branch,
      worktreePath: lease.worktreePath,
      allowedPaths: lease.allowedPaths,
      changedFiles,
      validation,
      createdAt: new Date().toISOString(),
    };
    const temporary = `${filename}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    await fs.rename(temporary, filename);
    return filename;
  }
}
