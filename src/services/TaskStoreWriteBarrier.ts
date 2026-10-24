import { TaskStore } from '../agent/TaskStore';

const INSTALLED = Symbol.for('ollama-agent.task-store-write-barrier');
const activeOperations = new Set<Promise<unknown>>();
const TRANSIENT_WRITE_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

export interface TransientWriteRetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  sleep?: (delayMs: number) => Promise<void>;
}

export async function retryTransientTaskStoreWrite<T>(
  operation: () => Promise<T>,
  options: TransientWriteRetryOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 6;
  const baseDelayMs = options.baseDelayMs ?? 8;
  const sleep = options.sleep ?? (delayMs => new Promise<void>(resolve => setTimeout(resolve, delayMs)));

  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 20) {
    throw new Error('Task-store retry attempts must be an integer between 1 and 20.');
  }
  if (!Number.isFinite(baseDelayMs) || baseDelayMs < 0 || baseDelayMs > 5_000) {
    throw new Error('Task-store retry base delay must be between 0 and 5000ms.');
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!code || !TRANSIENT_WRITE_CODES.has(code) || attempt === maxAttempts) {
        throw error;
      }
      const delayMs = Math.min(baseDelayMs * (2 ** (attempt - 1)), 250);
      await sleep(delayMs);
    }
  }

  throw new Error('Task-store write retry exhausted unexpectedly.');
}

function track<T>(operation: Promise<T>): Promise<T> {
  let tracked!: Promise<T>;
  tracked = operation.finally(() => {
    activeOperations.delete(tracked);
  });
  activeOperations.add(tracked);

  // Attach an immediate rejection observer so a detached durability callback
  // cannot surface as an unhandled rejection before its owner awaits it.
  // The original promise is still returned and still rejects for the caller.
  void tracked.catch(() => undefined);
  return tracked;
}

function install(): void {
  const prototype = TaskStore.prototype as unknown as Record<PropertyKey, unknown>;
  if (prototype[INSTALLED] === true) { return; }

  const originalPersistApproval = TaskStore.prototype.persistApproval;
  TaskStore.prototype.persistApproval = function(
    ...args: Parameters<TaskStore['persistApproval']>
  ): ReturnType<TaskStore['persistApproval']> {
    return track(retryTransientTaskStoreWrite(() => originalPersistApproval.apply(this, args)));
  };

  const originalUpdateApproval = TaskStore.prototype.updateApproval;
  TaskStore.prototype.updateApproval = function(
    ...args: Parameters<TaskStore['updateApproval']>
  ): ReturnType<TaskStore['updateApproval']> {
    return track(retryTransientTaskStoreWrite(() => originalUpdateApproval.apply(this, args)));
  };

  const originalUpdateTask = TaskStore.prototype.updateTask;
  TaskStore.prototype.updateTask = function(
    ...args: Parameters<TaskStore['updateTask']>
  ): ReturnType<TaskStore['updateTask']> {
    return track(retryTransientTaskStoreWrite(() => originalUpdateTask.apply(this, args)));
  };

  const originalGetTask = TaskStore.prototype.getTask;
  TaskStore.prototype.getTask = function(
    ...args: Parameters<TaskStore['getTask']>
  ): ReturnType<TaskStore['getTask']> {
    return track(originalGetTask.apply(this, args));
  };

  const originalAppendEvent = TaskStore.prototype.appendEvent;
  TaskStore.prototype.appendEvent = function(
    ...args: Parameters<TaskStore['appendEvent']>
  ): ReturnType<TaskStore['appendEvent']> {
    return track(originalAppendEvent.apply(this, args));
  };

  Object.defineProperty(prototype, INSTALLED, {
    value: true,
    configurable: false,
    enumerable: false,
    writable: false,
  });
}

install();

export class TaskStoreWriteBarrier {
  static async drain(): Promise<void> {
    while (activeOperations.size > 0) {
      const current = [...activeOperations];
      await Promise.allSettled(current);
      // Detached async callback continuations enqueue the next public TaskStore
      // operation in the following microtask.
      await Promise.resolve();
    }
  }

  static pendingCount(): number {
    return activeOperations.size;
  }
}
