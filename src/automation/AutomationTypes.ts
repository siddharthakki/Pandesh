import { createHash } from 'crypto';

export type AutomationTrigger =
  | { type: 'schedule'; runAt: string; recurrenceMs?: number }
  | { type: 'event'; event: string }
  | { type: 'condition'; key: string; pollIntervalMs: number };

export type AutomationStatus = 'enabled' | 'disabled' | 'running' | 'waiting-approval' | 'failed' | 'completed';

export interface AutomationDefinition {
  id: string;
  title: string;
  trigger: AutomationTrigger;
  task: Record<string, unknown>;
  isolatedExecution: 'worktree' | 'container';
  budget: {
    maxRuns: number;
    maxWallClockMs: number;
    maxMutations: number;
  };
  approvalBeforePublish: boolean;
  expiresAt?: string;
}

export interface AutomationState extends AutomationDefinition {
  status: AutomationStatus;
  createdAt: string;
  updatedAt: string;
  runCount: number;
  lastRunAt?: string;
  nextRunAt?: string;
  lease?: { id: string; acquiredAt: string; expiresAt: string };
  lastError?: string;
  completedMutationKeys: string[];
}

export interface AutomationRunContext {
  automation: AutomationState;
  runId: string;
  signal: AbortSignal;
  mutationKey(name: string, payload?: unknown): string;
  hasCompletedMutation(key: string): boolean;
  markMutationCompleted(key: string): Promise<void>;
  requirePublishApproval(summary: string): Promise<boolean>;
}

export interface AutomationExecutionResult {
  status: 'completed' | 'waiting-approval' | 'failed';
  summary?: string;
  mutations?: number;
  nextRunAt?: string;
}

export type AutomationExecutor = (context: AutomationRunContext) => Promise<AutomationExecutionResult>;
export type ConditionEvaluator = (automation: AutomationState) => Promise<boolean>;
export type PublishApproval = (automation: AutomationState, summary: string) => Promise<boolean>;

export function createMutationKey(automationId: string, name: string, payload?: unknown): string {
  return createHash('sha256')
    .update(`${automationId}\0${name}\0${stableStringify(payload ?? null)}`)
    .digest('hex');
}

export function validateAutomationDefinition(definition: AutomationDefinition): void {
  if (!/^[a-zA-Z0-9._:-]{1,160}$/.test(definition.id)) throw new Error(`Invalid automation id: ${definition.id}`);
  if (!definition.title.trim()) throw new Error(`Automation title is required: ${definition.id}`);
  if (!['worktree', 'container'].includes(definition.isolatedExecution)) throw new Error('Automation must use isolated execution.');
  if (definition.budget.maxRuns < 1 || definition.budget.maxWallClockMs < 100 || definition.budget.maxMutations < 0) {
    throw new Error(`Invalid automation budget: ${definition.id}`);
  }
  validateTrigger(definition.trigger);
  if (definition.expiresAt && !Number.isFinite(Date.parse(definition.expiresAt))) {
    throw new Error(`Invalid automation expiry: ${definition.id}`);
  }
}

export function initialNextRun(trigger: AutomationTrigger): string | undefined {
  if (trigger.type === 'schedule') return new Date(trigger.runAt).toISOString();
  if (trigger.type === 'condition') return new Date().toISOString();
  return undefined;
}

export function computeNextRun(state: AutomationState): string | undefined {
  if (state.trigger.type === 'schedule' && state.trigger.recurrenceMs) {
    const base = state.lastRunAt ? Date.parse(state.lastRunAt) : Date.now();
    return new Date(base + state.trigger.recurrenceMs).toISOString();
  }
  if (state.trigger.type === 'condition') {
    return new Date(Date.now() + state.trigger.pollIntervalMs).toISOString();
  }
  return undefined;
}

export function triggerDue(state: AutomationState, now: Date, event?: string): boolean {
  if (state.trigger.type === 'schedule') return Boolean(state.nextRunAt && Date.parse(state.nextRunAt) <= now.getTime());
  if (state.trigger.type === 'event') return state.trigger.event === event;
  return Boolean(!state.nextRunAt || Date.parse(state.nextRunAt) <= now.getTime());
}

function validateTrigger(trigger: AutomationTrigger): void {
  if (trigger.type === 'schedule') {
    if (!Number.isFinite(Date.parse(trigger.runAt))) throw new Error('Invalid scheduled runAt.');
    if (trigger.recurrenceMs !== undefined && (!Number.isInteger(trigger.recurrenceMs) || trigger.recurrenceMs < 60_000)) {
      throw new Error('Automation recurrence must be at least one minute.');
    }
  } else if (trigger.type === 'event') {
    if (!/^[a-zA-Z0-9._:-]{1,160}$/.test(trigger.event)) throw new Error('Invalid automation event.');
  } else if (!Number.isInteger(trigger.pollIntervalMs) || trigger.pollIntervalMs < 60_000) {
    throw new Error('Condition polling must be at least one minute.');
  }
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
