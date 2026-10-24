import * as fs from 'fs/promises';
import * as path from 'path';
import { ObservationEvent, ObservabilitySnapshot } from './ObservabilityHub';
import { OperationsActivity, OperationsSnapshot, OperationsTaskSummary } from './OperationsService';

interface PersistedTaskRecord {
  taskId?: unknown;
  title?: unknown;
  userGoal?: unknown;
  status?: unknown;
  phase?: unknown;
  model?: unknown;
  updatedAt?: unknown;
  blockedReason?: unknown;
  validationPassed?: unknown;
  engineUsage?: Record<string, unknown>;
  engineBudgets?: Record<string, unknown>;
}

export class PersistentOperationsReader {
  constructor(private readonly workspaceRoot: string) {}

  async read(): Promise<OperationsSnapshot> {
    const stateRoot = path.join(this.workspaceRoot, '.ollama-agent');
    const [tasks, worktrees, observations] = await Promise.all([
      this.readTasks(path.join(stateRoot, 'tasks')),
      this.readWorktrees(path.join(stateRoot, 'tasks', '_worktrees', 'manifest.json')),
      this.readObservations(path.join(stateRoot, 'tasks', '_orchestration', 'observations.jsonl')),
    ]);
    const activity: OperationsActivity = {
      readOnlyBatchActive: false,
      writeBatchActive: false,
      integrationsActive: 0,
      sandboxesActive: 0,
      rpcServicesActive: 0,
      mcpRegistriesActive: 0,
    };
    return {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      totals: {
        tasks: tasks.length,
        running: tasks.filter(task => task.status === 'running').length,
        blocked: tasks.filter(task => task.status === 'blocked' || task.phase === 'blocked').length,
        completed: tasks.filter(task => task.status === 'completed' || task.phase === 'completed').length,
        retainedWorktrees: worktrees.length,
      },
      activity,
      tasks,
      worktrees,
      observations,
    };
  }

  private async readTasks(tasksRoot: string): Promise<OperationsTaskSummary[]> {
    let entries: Array<import('fs').Dirent>;
    try { entries = await fs.readdir(tasksRoot, { withFileTypes: true }); }
    catch { return []; }
    const summaries: OperationsTaskSummary[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('_')) continue;
      const record = await readJson(path.join(tasksRoot, entry.name, 'task.json')) as PersistedTaskRecord | undefined;
      if (!record || typeof record.taskId !== 'string') continue;
      const usage = record.engineUsage ?? {};
      const budgets = record.engineBudgets ?? {};
      summaries.push({
        taskId: record.taskId,
        title: typeof record.title === 'string'
          ? record.title
          : typeof record.userGoal === 'string'
            ? record.userGoal.slice(0, 80)
            : record.taskId,
        objective: typeof record.userGoal === 'string' ? record.userGoal : '',
        status: stringValue(record.status, 'unknown'),
        phase: stringValue(record.phase, stringValue(record.status, 'unknown')),
        model: stringValue(record.model, 'unknown'),
        updatedAt: stringValue(record.updatedAt, ''),
        validationPassed: typeof record.validationPassed === 'boolean' ? record.validationPassed : undefined,
        blockedReason: typeof record.blockedReason === 'string' ? record.blockedReason : undefined,
        usage: {
          modelCalls: numberValue(usage['modelCalls']),
          toolCalls: numberValue(usage['toolCalls']),
          repairAttempts: numberValue(usage['repairAttempts']),
          outputBytes: numberValue(usage['outputBytes']),
        },
        utilization: {
          modelCalls: ratio(usage['modelCalls'], budgets['maxModelCalls']),
          toolCalls: ratio(usage['toolCalls'], budgets['maxToolCalls']),
          repairAttempts: ratio(usage['repairAttempts'], budgets['maxRepairAttempts']),
          outputBytes: ratio(usage['outputBytes'], budgets['maxOutputBytes']),
        },
      });
    }
    return summaries.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)).slice(0, 100);
  }

  private async readWorktrees(filename: string): Promise<OperationsSnapshot['worktrees']> {
    const manifest = await readJson(filename);
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return [];
    const leases = (manifest as Record<string, unknown>)['leases'];
    if (!Array.isArray(leases)) return [];
    return leases.flatMap(value => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
      const lease = value as Record<string, unknown>;
      if (typeof lease['taskId'] !== 'string' || typeof lease['branch'] !== 'string') return [];
      return [{
        taskId: lease['taskId'],
        branch: lease['branch'],
        status: stringValue(lease['status'], 'unknown'),
        allowedPaths: Array.isArray(lease['allowedPaths'])
          ? lease['allowedPaths'].filter((item): item is string => typeof item === 'string')
          : [],
        createdAt: stringValue(lease['createdAt'], ''),
      }];
    });
  }

  private async readObservations(filename: string): Promise<ObservabilitySnapshot> {
    let content = '';
    try { content = await fs.readFile(filename, 'utf8'); } catch { /* no observations yet */ }
    const events: ObservationEvent[] = [];
    for (const line of content.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as ObservationEvent;
        if (parsed.schemaVersion === 1 && typeof parsed.sequence === 'number' && typeof parsed.name === 'string') {
          events.push(parsed);
        }
      } catch { /* malformed observation evidence is skipped */ }
    }
    const recentEvents = events.slice(-100);
    const counters: Record<string, number> = {};
    for (const event of events) {
      const key = `${event.category}.${event.name}`;
      counters[key] = (counters[key] ?? 0) + 1;
    }
    return {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      eventCount: events.length,
      counters,
      recentEvents,
    };
  }
}

async function readJson(filename: string): Promise<unknown | undefined> {
  try { return JSON.parse(await fs.readFile(filename, 'utf8')); }
  catch { return undefined; }
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function ratio(used: unknown, limit: unknown): number {
  const numerator = numberValue(used);
  const denominator = numberValue(limit);
  if (denominator <= 0) return 0;
  return Math.max(0, Math.min(1, numerator / denominator));
}