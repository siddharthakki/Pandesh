import {
  DEFAULT_TASK_BUDGETS,
  TaskBudgets,
  TaskUsage,
  createInitialUsage,
} from './AgentEngineTypes';

export type BudgetKind =
  | 'wall_clock'
  | 'model_calls'
  | 'tool_calls'
  | 'repair_attempts'
  | 'iterations'
  | 'command_duration'
  | 'output_bytes'
  | 'no_progress';

export interface BudgetCheck {
  ok: boolean;
  kind?: BudgetKind;
  message?: string;
}

export function normalizeBudgets(input?: Partial<TaskBudgets>): TaskBudgets {
  const merged: TaskBudgets = { ...DEFAULT_TASK_BUDGETS, ...input };
  for (const [key, value] of Object.entries(merged)) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`Invalid task budget ${key}: ${value}`);
    }
  }
  return merged;
}

export class BudgetTracker {
  readonly budgets: TaskBudgets;
  private usage: TaskUsage;

  constructor(budgets?: Partial<TaskBudgets>, usage?: Partial<TaskUsage>) {
    this.budgets = normalizeBudgets(budgets);
    this.usage = { ...createInitialUsage(), ...usage };
  }

  snapshot(now = Date.now()): TaskUsage {
    return {
      ...this.usage,
      elapsedActiveMs: this.currentElapsedActiveMs(now),
    };
  }

  resume(now = new Date().toISOString()): void {
    if (!this.usage.activeSince) {
      this.usage.activeSince = now;
    }
    this.usage.pausedAt = undefined;
  }

  pause(now = new Date().toISOString()): void {
    this.usage.elapsedActiveMs = this.currentElapsedActiveMs(new Date(now).getTime());
    this.usage.activeSince = undefined;
    this.usage.pausedAt = now;
  }

  enterApprovalWait(now = new Date().toISOString()): void {
    this.pause(now);
  }

  leaveApprovalWait(startedAt: string, now = new Date().toISOString()): void {
    const delta = Math.max(0, new Date(now).getTime() - new Date(startedAt).getTime());
    this.usage.waitingApprovalMs += delta;
    this.resume(now);
  }

  consumeModelCall(): BudgetCheck {
    this.usage.modelCalls += 1;
    return this.check();
  }

  consumeToolCall(): BudgetCheck {
    this.usage.toolCalls += 1;
    return this.check();
  }

  consumeRepairAttempt(): BudgetCheck {
    this.usage.repairAttempts += 1;
    return this.check();
  }

  consumeIteration(): BudgetCheck {
    this.usage.iterations += 1;
    return this.check();
  }

  consumeOutput(bytes: number): BudgetCheck {
    this.usage.outputBytes += Math.max(0, bytes);
    return this.check();
  }

  recordProgress(fingerprint: string, now = new Date().toISOString()): BudgetCheck {
    if (this.usage.lastProgressFingerprint === fingerprint) {
      this.usage.noProgressSteps += 1;
    } else {
      this.usage.noProgressSteps = 0;
      this.usage.lastProgressFingerprint = fingerprint;
      this.usage.lastProgressAt = now;
    }
    return this.check();
  }

  recordValidationFingerprint(fingerprint: string): BudgetCheck {
    if (this.usage.lastValidationFingerprint === fingerprint) {
      this.usage.repeatedValidationFailures += 1;
    } else {
      this.usage.lastValidationFingerprint = fingerprint;
      this.usage.repeatedValidationFailures = 0;
    }
    return this.check();
  }

  check(commandDurationMs?: number, now = Date.now()): BudgetCheck {
    const elapsed = this.currentElapsedActiveMs(now);
    if (elapsed >= this.budgets.maxWallClockMs) {
      return { ok: false, kind: 'wall_clock', message: 'Task wall-clock budget exhausted.' };
    }
    if (this.usage.modelCalls > this.budgets.maxModelCalls) {
      return { ok: false, kind: 'model_calls', message: 'Task model-call budget exhausted.' };
    }
    if (this.usage.toolCalls > this.budgets.maxToolCalls) {
      return { ok: false, kind: 'tool_calls', message: 'Task tool-call budget exhausted.' };
    }
    if (this.usage.repairAttempts > this.budgets.maxRepairAttempts) {
      return { ok: false, kind: 'repair_attempts', message: 'Task repair budget exhausted.' };
    }
    if (this.usage.iterations > this.budgets.maxIterations) {
      return { ok: false, kind: 'iterations', message: 'Task iteration budget exhausted.' };
    }
    if (this.usage.outputBytes > this.budgets.maxOutputBytes) {
      return { ok: false, kind: 'output_bytes', message: 'Task output-size budget exhausted.' };
    }
    if (this.usage.noProgressSteps >= this.budgets.maxNoProgressSteps) {
      return { ok: false, kind: 'no_progress', message: 'Task made no measurable progress.' };
    }
    if (commandDurationMs !== undefined && commandDurationMs > this.budgets.maxCommandDurationMs) {
      return { ok: false, kind: 'command_duration', message: 'Command-duration budget exhausted.' };
    }
    return { ok: true };
  }

  private currentElapsedActiveMs(now: number): number {
    const activeDelta = this.usage.activeSince
      ? Math.max(0, now - new Date(this.usage.activeSince).getTime())
      : 0;
    return this.usage.elapsedActiveMs + activeDelta;
  }
}
