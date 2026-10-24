import { randomUUID } from 'crypto';
import {
  AutomationDefinition,
  AutomationExecutor,
  AutomationState,
  AutomationStatus,
  ConditionEvaluator,
  PublishApproval,
  computeNextRun,
  createMutationKey,
  initialNextRun,
  triggerDue,
  validateAutomationDefinition,
} from './AutomationTypes';
import { AutomationStorage } from './AutomationStorage';

export interface JobCoordinatorOptions {
  storage: AutomationStorage;
  conditionEvaluator?: ConditionEvaluator;
  publishApproval?: PublishApproval;
  leaseMs?: number;
}

export class JobCoordinator {
  private readonly states = new Map<string, AutomationState>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly leaseMs: number;

  constructor(private readonly options: JobCoordinatorOptions) {
    this.leaseMs = options.leaseMs ?? 15 * 60 * 1000;
  }

  async initialize(): Promise<void> {
    this.states.clear();
    for (const loaded of await this.options.storage.loadAll()) {
      const state = clone(loaded);
      if (state.lease && Date.parse(state.lease.expiresAt) <= Date.now()) {
        state.lease = undefined;
        if (state.status === 'running') state.status = 'enabled';
      }
      this.states.set(state.id, state);
    }
  }

  async register(definition: AutomationDefinition): Promise<AutomationState> {
    validateAutomationDefinition(definition);
    if (this.states.has(definition.id)) throw new Error(`Automation already exists: ${definition.id}`);
    const now = new Date().toISOString();
    const state: AutomationState = {
      ...clone(definition),
      status: 'enabled',
      createdAt: now,
      updatedAt: now,
      runCount: 0,
      nextRunAt: initialNextRun(definition.trigger),
      completedMutationKeys: [],
    };
    this.states.set(state.id, state);
    await this.options.storage.save(state);
    return clone(state);
  }

  list(): AutomationState[] {
    return [...this.states.values()].map(clone).sort((left, right) => left.id.localeCompare(right.id));
  }

  eligible(now = new Date(), event?: string): AutomationState[] {
    return [...this.states.values()]
      .filter(state => state.status === 'enabled' || state.status === 'waiting-approval')
      .filter(state => !state.expiresAt || Date.parse(state.expiresAt) > now.getTime())
      .filter(state => state.runCount < state.budget.maxRuns)
      .filter(state => !state.lease || Date.parse(state.lease.expiresAt) <= now.getTime())
      .filter(state => triggerDue(state, now, event))
      .sort((left, right) => (left.nextRunAt ?? '').localeCompare(right.nextRunAt ?? '') || left.id.localeCompare(right.id))
      .map(clone);
  }

  async executeEligible(executor: AutomationExecutor, now = new Date(), event?: string): Promise<AutomationState[]> {
    const output: AutomationState[] = [];
    for (const candidate of this.eligible(now, event)) {
      if (candidate.trigger.type === 'condition') {
        if (!this.options.conditionEvaluator || !await this.options.conditionEvaluator(candidate)) continue;
      }
      output.push(await this.execute(candidate.id, executor));
    }
    return output;
  }

  async execute(id: string, executor: AutomationExecutor): Promise<AutomationState> {
    const state = this.require(id);
    this.assertRunnable(state);
    const runId = randomUUID();
    const controller = new AbortController();
    this.controllers.set(id, controller);
    state.lease = {
      id: runId,
      acquiredAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + this.leaseMs).toISOString(),
    };
    state.status = 'running';
    await this.persist(state);

    let mutations = 0;
    let timer: NodeJS.Timeout | undefined;
    try {
      const execution = executor({
        automation: clone(state),
        runId,
        signal: controller.signal,
        mutationKey: (name, payload) => createMutationKey(state.id, name, payload),
        hasCompletedMutation: key => state.completedMutationKeys.includes(key),
        markMutationCompleted: async key => {
          if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('Invalid mutation key.');
          if (state.completedMutationKeys.includes(key)) return;
          if (mutations >= state.budget.maxMutations) throw new Error(`Mutation budget exhausted: ${id}`);
          mutations += 1;
          state.completedMutationKeys.push(key);
          await this.persist(state);
        },
        requirePublishApproval: async summary => {
          if (!state.approvalBeforePublish) return true;
          return this.options.publishApproval ? this.options.publishApproval(clone(state), summary) : false;
        },
      });
      const cancellation = new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener('abort', () => reject(abortError()), { once: true });
      });
      timer = setTimeout(() => controller.abort(), state.budget.maxWallClockMs);
      const result = await Promise.race([execution, cancellation]);
      if ((result.mutations ?? mutations) > state.budget.maxMutations) throw new Error(`Mutation budget exceeded: ${id}`);
      state.runCount += 1;
      state.lastRunAt = new Date().toISOString();
      state.lastError = undefined;
      state.status = result.status === 'waiting-approval'
        ? 'waiting-approval'
        : result.status === 'failed'
          ? 'failed'
          : nextStatus(state);
      state.nextRunAt = result.nextRunAt ?? computeNextRun(state);
    } catch (error) {
      state.lastError = error instanceof Error ? error.message : String(error);
      state.status = 'failed';
      state.nextRunAt = computeNextRun(state);
    } finally {
      if (timer) clearTimeout(timer);
      state.lease = undefined;
      this.controllers.delete(id);
      await this.persist(state);
    }
    return clone(state);
  }

  cancel(id: string): boolean {
    const controller = this.controllers.get(id);
    if (!controller || controller.signal.aborted) return false;
    controller.abort();
    return true;
  }

  async setEnabled(id: string, enabled: boolean): Promise<AutomationState> {
    const state = this.require(id);
    state.status = enabled ? 'enabled' : 'disabled';
    await this.persist(state);
    return clone(state);
  }

  private async persist(state: AutomationState): Promise<void> {
    state.updatedAt = new Date().toISOString();
    await this.options.storage.save(state);
  }

  private assertRunnable(state: AutomationState): void {
    if (state.status === 'disabled') throw new Error(`Automation is disabled: ${state.id}`);
    if (state.expiresAt && Date.parse(state.expiresAt) <= Date.now()) throw new Error(`Automation expired: ${state.id}`);
    if (state.runCount >= state.budget.maxRuns) throw new Error(`Run budget exhausted: ${state.id}`);
    if (state.lease && Date.parse(state.lease.expiresAt) > Date.now()) throw new Error(`Automation already leased: ${state.id}`);
  }

  private require(id: string): AutomationState {
    const state = this.states.get(id);
    if (!state) throw new Error(`Unknown automation: ${id}`);
    return state;
  }
}

function nextStatus(state: AutomationState): AutomationStatus {
  if (state.trigger.type === 'schedule' && !state.trigger.recurrenceMs) return 'completed';
  if (state.runCount >= state.budget.maxRuns) return 'completed';
  return 'enabled';
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function abortError(): Error {
  const error = new Error('Job execution cancelled or timed out.');
  error.name = 'AbortError';
  return error;
}
