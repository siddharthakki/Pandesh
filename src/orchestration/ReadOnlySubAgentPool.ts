export interface ReadOnlySubAgentTask {
  id: string;
  role: string;
  objective: string;
  context: string[];
  maxModelCalls: number;
  maxOutputBytes: number;
  provider?: string;
  model?: string;
}

export interface ReadOnlyFinding {
  severity: 'info' | 'warning' | 'blocking';
  file?: string;
  message: string;
  evidence?: string;
}

export interface ReadOnlySubAgentOutput {
  summary: string;
  findings: ReadOnlyFinding[];
  modelCalls: number;
  outputBytes: number;
}

export interface ReadOnlySubAgentResult extends ReadOnlySubAgentOutput {
  taskId: string;
  role: string;
  startedAt: string;
  completedAt: string;
}

export interface ReadOnlySubAgentContext {
  signal: AbortSignal;
  assertToolAllowed(toolName: string, args?: Record<string, unknown>): void;
  withModelSlot<T>(operation: () => Promise<T>): Promise<T>;
}

export interface ReadOnlySubAgentExecutor {
  execute(task: Readonly<ReadOnlySubAgentTask>, context: ReadOnlySubAgentContext): Promise<ReadOnlySubAgentOutput>;
}

export interface ReadOnlySubAgentPoolOptions {
  concurrency?: number;
  modelConcurrency?: number;
}

export interface ReadOnlySubAgentBatchResult {
  results: ReadOnlySubAgentResult[];
  findings: ReadOnlyFinding[];
  cancelled: boolean;
}

const READ_ONLY_TOOLS = new Set([
  'read_file',
  'list_files',
  'search_files',
  'get_diagnostics',
  'git_status',
  'git_diff',
  'git_log',
  'git_show',
  'run_command',
]);

const READ_ONLY_COMMANDS: RegExp[] = [
  /^git\s+(?:status|diff|log|show|grep|rev-parse|branch\s+--show-current)(?:\s|$)/i,
  /^(?:rg|grep|findstr)(?:\s|$)/i,
  /^(?:cat|type|head|tail|pwd)(?:\s|$)/i,
  /^(?:Get-Content|Get-ChildItem|Get-Location|Select-String)(?:\s|$)/i,
];

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
}

function commandText(args: Record<string, unknown> | undefined): string {
  const value = args?.['command'];
  return typeof value === 'string' ? value.trim() : '';
}

export function isReadOnlyCommand(command: string): boolean {
  const normalized = command.trim();
  if (!normalized || /[\r\n;&|><`]/.test(normalized) || normalized.includes('$(')) {
    return false;
  }
  return READ_ONLY_COMMANDS.some(pattern => pattern.test(normalized));
}

export function assertReadOnlyTool(toolName: string, args?: Record<string, unknown>): void {
  if (!READ_ONLY_TOOLS.has(toolName)) {
    throw new Error(`Read-only sub-agent cannot use mutating or unknown tool ${toolName}.`);
  }
  if (toolName === 'run_command') {
    const command = commandText(args);
    if (!isReadOnlyCommand(command)) {
      throw new Error(`Read-only sub-agent command is not allowed: ${command || '<missing>'}`);
    }
  }
}

class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {
    assertPositiveInteger('Semaphore limit', limit);
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await operation();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise(resolve => {
      this.waiters.push(() => {
        this.active += 1;
        resolve();
      });
    });
  }

  private release(): void {
    this.active -= 1;
    const next = this.waiters.shift();
    next?.();
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function findingKey(finding: ReadOnlyFinding): string {
  return [finding.severity, finding.file ?? '', finding.message.trim().toLowerCase()].join('|');
}

export function consolidateFindings(results: readonly ReadOnlySubAgentResult[]): ReadOnlyFinding[] {
  const unique = new Map<string, ReadOnlyFinding>();
  for (const result of results) {
    for (const finding of result.findings) {
      const key = findingKey(finding);
      const current = unique.get(key);
      if (!current || (!current.evidence && finding.evidence)) {
        unique.set(key, { ...finding });
      }
    }
  }
  const severityOrder: Record<ReadOnlyFinding['severity'], number> = {
    blocking: 0,
    warning: 1,
    info: 2,
  };
  return [...unique.values()].sort((left, right) => {
    return severityOrder[left.severity] - severityOrder[right.severity]
      || (left.file ?? '').localeCompare(right.file ?? '')
      || left.message.localeCompare(right.message);
  });
}

export class ReadOnlySubAgentPool {
  private readonly taskSemaphore: Semaphore;
  private readonly modelSemaphore: Semaphore;
  private controller: AbortController | null = null;

  constructor(options: ReadOnlySubAgentPoolOptions = {}) {
    const concurrency = options.concurrency ?? 3;
    const modelConcurrency = options.modelConcurrency ?? 1;
    assertPositiveInteger('concurrency', concurrency);
    assertPositiveInteger('modelConcurrency', modelConcurrency);
    this.taskSemaphore = new Semaphore(concurrency);
    this.modelSemaphore = new Semaphore(modelConcurrency);
  }

  async run(tasks: readonly ReadOnlySubAgentTask[], executor: ReadOnlySubAgentExecutor): Promise<ReadOnlySubAgentBatchResult> {
    if (this.controller) {
      throw new Error('Read-only sub-agent pool is already running.');
    }
    const ids = new Set<string>();
    for (const task of tasks) {
      if (!/^[a-zA-Z0-9_-]{1,100}$/.test(task.id)) {
        throw new Error(`Invalid read-only sub-agent id: ${task.id}`);
      }
      if (ids.has(task.id)) {
        throw new Error(`Duplicate read-only sub-agent id: ${task.id}`);
      }
      ids.add(task.id);
      assertPositiveInteger(`Task ${task.id} maxModelCalls`, task.maxModelCalls);
      assertPositiveInteger(`Task ${task.id} maxOutputBytes`, task.maxOutputBytes);
    }

    this.controller = new AbortController();
    const signal = this.controller.signal;
    try {
      const executions = tasks.map((task, index) => this.taskSemaphore.run(async () => {
        if (signal.aborted) {
          throw new DOMException('Sub-agent batch cancelled.', 'AbortError');
        }
        const startedAt = nowIso();
        const output = await executor.execute(task, {
          signal,
          assertToolAllowed: assertReadOnlyTool,
          withModelSlot: operation => this.modelSemaphore.run(async () => {
            if (signal.aborted) {
              throw new DOMException('Sub-agent batch cancelled.', 'AbortError');
            }
            return operation();
          }),
        });
        if (output.modelCalls > task.maxModelCalls) {
          throw new Error(`Read-only sub-agent ${task.id} exceeded its model-call budget.`);
        }
        if (output.outputBytes > task.maxOutputBytes) {
          throw new Error(`Read-only sub-agent ${task.id} exceeded its output budget.`);
        }
        return {
          index,
          result: {
            ...output,
            taskId: task.id,
            role: task.role,
            startedAt,
            completedAt: nowIso(),
          } satisfies ReadOnlySubAgentResult,
        };
      }));

      const settled = await Promise.allSettled(executions);
      const failures = settled.filter((entry): entry is PromiseRejectedResult => entry.status === 'rejected');
      if (failures.length > 0 && !signal.aborted) {
        throw failures[0].reason;
      }
      const results = settled
        .filter((entry): entry is PromiseFulfilledResult<{ index: number; result: ReadOnlySubAgentResult }> => entry.status === 'fulfilled')
        .map(entry => entry.value)
        .sort((left, right) => left.index - right.index)
        .map(entry => entry.result);
      return {
        results,
        findings: consolidateFindings(results),
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
}
