import { spawn } from 'child_process';
import type { ChildProcessWithoutNullStreams } from 'child_process';
import { randomUUID } from 'crypto';

export type AgentAdapterKind = 'opencode' | 'codex' | 'claude' | 'karkedikha';
export type AgentRole = 'analyst' | 'planner' | 'implementer' | 'reviewer' | 'validator' | 'repairer';
export type AgentPermission =
  | 'repository:read'
  | 'worktree:write'
  | 'validation:run'
  | 'github:read'
  | 'github:comment'
  | 'github:draft-pr'
  | 'network:model';

export interface AgentModelRoute {
  model: string;
  provider: string;
  inputCostPerMillion: number;
  outputCostPerMillion: number;
  maxContextTokens: number;
}

export interface AgentWorkerDefinition {
  id: string;
  name: string;
  adapter: AgentAdapterKind;
  roles: AgentRole[];
  capabilities: string[];
  permissions: AgentPermission[];
  models: AgentModelRoute[];
  maxConcurrent: number;
  heartbeatTimeoutMs: number;
  enabled: boolean;
}

export interface AgentHeartbeat {
  workerId: string;
  at: string;
  availableSlots: number;
  metadata?: Record<string, string | number | boolean>;
}

export interface AgentTaskRequest {
  requestId: string;
  role: AgentRole;
  goal: string;
  repositoryRoot: string;
  requiredCapabilities: string[];
  requiredPermissions: AgentPermission[];
  preferredModel?: string;
  estimatedInputTokens?: number;
  estimatedOutputTokens?: number;
  maxCostUsd?: number;
  timeoutMs: number;
  payloadReference?: string;
}

export type AgentExecutionState = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'timed-out';

export interface AgentExecutionHandle {
  executionId: string;
  workerId: string;
  requestId: string;
  adapter: AgentAdapterKind;
  model: string;
  provider: string;
  estimatedCostUsd: number;
  state: AgentExecutionState;
  startedAt: string;
  deadlineAt: string;
}

export interface AgentExecutionStatus extends AgentExecutionHandle {
  finishedAt?: string;
  exitCode?: number;
  outputSummary?: string;
  errorSummary?: string;
}

export interface AgentAdapter {
  readonly kind: AgentAdapterKind;
  start(worker: AgentWorkerDefinition, request: AgentTaskRequest, route: AgentModelRoute): Promise<AgentExecutionHandle>;
  status(executionId: string): Promise<AgentExecutionStatus | undefined>;
  cancel(executionId: string, reason: string): Promise<boolean>;
}

interface RegisteredWorker {
  definition: AgentWorkerDefinition;
  heartbeat?: AgentHeartbeat;
  activeExecutionIds: Set<string>;
}

export interface AgentRoutingDecision {
  worker: AgentWorkerDefinition;
  route: AgentModelRoute;
  estimatedCostUsd: number;
  reason: 'preferred-model' | 'lowest-cost-compatible';
}

export class AgentRegistry {
  private readonly adapters = new Map<AgentAdapterKind, AgentAdapter>();
  private readonly workers = new Map<string, RegisteredWorker>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  registerAdapter(adapter: AgentAdapter): void {
    this.adapters.set(adapter.kind, adapter);
  }

  registerWorker(definition: AgentWorkerDefinition): void {
    if (!this.adapters.has(definition.adapter)) throw new Error(`Adapter ${definition.adapter} is not registered.`);
    if (definition.maxConcurrent < 1) throw new Error('Worker maxConcurrent must be at least 1.');
    if (definition.models.length === 0) throw new Error('Worker requires at least one model route.');
    this.workers.set(definition.id, {
      definition: structuredClone(definition),
      activeExecutionIds: new Set<string>(),
    });
  }

  heartbeat(value: AgentHeartbeat): void {
    const worker = this.workers.get(value.workerId);
    if (!worker) throw new Error(`Unknown worker ${value.workerId}.`);
    worker.heartbeat = { ...value };
  }

  listWorkers(): Array<{ definition: AgentWorkerDefinition; heartbeat?: AgentHeartbeat; active: number; available: boolean }> {
    return [...this.workers.values()].map(worker => ({
      definition: structuredClone(worker.definition),
      heartbeat: worker.heartbeat ? { ...worker.heartbeat } : undefined,
      active: worker.activeExecutionIds.size,
      available: this.isAvailable(worker),
    }));
  }

  route(request: AgentTaskRequest): AgentRoutingDecision {
    const candidates: AgentRoutingDecision[] = [];
    for (const worker of this.workers.values()) {
      if (!worker.definition.enabled || !this.isAvailable(worker)) continue;
      if (!worker.definition.roles.includes(request.role)) continue;
      if (!request.requiredCapabilities.every(capability => worker.definition.capabilities.includes(capability))) continue;
      if (!request.requiredPermissions.every(permission => worker.definition.permissions.includes(permission))) continue;
      for (const route of worker.definition.models) {
        if (request.estimatedInputTokens && request.estimatedInputTokens > route.maxContextTokens) continue;
        const estimatedCostUsd = estimateCost(route, request.estimatedInputTokens ?? 0, request.estimatedOutputTokens ?? 0);
        if (request.maxCostUsd !== undefined && estimatedCostUsd > request.maxCostUsd) continue;
        candidates.push({
          worker: structuredClone(worker.definition),
          route: { ...route },
          estimatedCostUsd,
          reason: request.preferredModel === route.model ? 'preferred-model' : 'lowest-cost-compatible',
        });
      }
    }
    candidates.sort((left, right) => {
      const preferred = Number(right.reason === 'preferred-model') - Number(left.reason === 'preferred-model');
      if (preferred !== 0) return preferred;
      if (left.estimatedCostUsd !== right.estimatedCostUsd) return left.estimatedCostUsd - right.estimatedCostUsd;
      return left.worker.id.localeCompare(right.worker.id);
    });
    const decision = candidates[0];
    if (!decision) throw new Error(`No available worker can satisfy ${request.role} request ${request.requestId}.`);
    return decision;
  }

  adapter(kind: AgentAdapterKind): AgentAdapter {
    const adapter = this.adapters.get(kind);
    if (!adapter) throw new Error(`Adapter ${kind} is not registered.`);
    return adapter;
  }

  markStarted(workerId: string, executionId: string): void {
    const worker = this.workers.get(workerId);
    if (!worker) throw new Error(`Unknown worker ${workerId}.`);
    if (worker.activeExecutionIds.size >= worker.definition.maxConcurrent) throw new Error(`Worker ${workerId} is at capacity.`);
    worker.activeExecutionIds.add(executionId);
  }

  markFinished(workerId: string, executionId: string): void {
    this.workers.get(workerId)?.activeExecutionIds.delete(executionId);
  }

  private isAvailable(worker: RegisteredWorker): boolean {
    if (!worker.heartbeat) return false;
    const age = this.now().getTime() - Date.parse(worker.heartbeat.at);
    if (age > worker.definition.heartbeatTimeoutMs) return false;
    const heartbeatSlots = Math.max(0, worker.heartbeat.availableSlots);
    return heartbeatSlots > 0 && worker.activeExecutionIds.size < worker.definition.maxConcurrent;
  }
}

export interface HermesCoordinatorOptions {
  maxGlobalConcurrent: number;
  now?: () => Date;
}

export class HermesWorkforceCoordinator {
  private readonly now: () => Date;
  private readonly executions = new Map<string, AgentExecutionStatus>();

  constructor(
    private readonly registry: AgentRegistry,
    private readonly options: HermesCoordinatorOptions,
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async dispatch(request: AgentTaskRequest): Promise<AgentExecutionHandle> {
    const active = [...this.executions.values()].filter(value => value.state === 'queued' || value.state === 'running').length;
    if (active >= this.options.maxGlobalConcurrent) throw new Error('Global workforce concurrency limit reached.');
    const decision = this.registry.route(request);
    const adapter = this.registry.adapter(decision.worker.adapter);
    const started = await adapter.start(decision.worker, request, decision.route);
    const normalized: AgentExecutionStatus = {
      ...started,
      workerId: decision.worker.id,
      adapter: decision.worker.adapter,
      model: decision.route.model,
      provider: decision.route.provider,
      estimatedCostUsd: decision.estimatedCostUsd,
      startedAt: started.startedAt || this.now().toISOString(),
      deadlineAt: started.deadlineAt || new Date(this.now().getTime() + request.timeoutMs).toISOString(),
    };
    this.registry.markStarted(decision.worker.id, normalized.executionId);
    this.executions.set(normalized.executionId, normalized);
    return { ...normalized };
  }

  async reconcile(): Promise<AgentExecutionStatus[]> {
    const changed: AgentExecutionStatus[] = [];
    for (const current of [...this.executions.values()]) {
      if (isTerminal(current.state)) continue;
      if (Date.parse(current.deadlineAt) <= this.now().getTime()) {
        const adapter = this.registry.adapter(current.adapter);
        await adapter.cancel(current.executionId, 'timeout');
        const timedOut: AgentExecutionStatus = { ...current, state: 'timed-out', finishedAt: this.now().toISOString(), errorSummary: 'Execution deadline exceeded.' };
        this.executions.set(current.executionId, timedOut);
        this.registry.markFinished(current.workerId, current.executionId);
        changed.push(timedOut);
        continue;
      }
      const observed = await this.registry.adapter(current.adapter).status(current.executionId);
      if (!observed) continue;
      this.executions.set(current.executionId, observed);
      if (isTerminal(observed.state)) this.registry.markFinished(observed.workerId, observed.executionId);
      if (observed.state !== current.state || observed.finishedAt !== current.finishedAt) changed.push({ ...observed });
    }
    return changed;
  }

  async cancel(executionId: string, reason = 'cancelled-by-coordinator'): Promise<boolean> {
    const current = this.executions.get(executionId);
    if (!current || isTerminal(current.state)) return false;
    const cancelled = await this.registry.adapter(current.adapter).cancel(executionId, reason);
    if (!cancelled) return false;
    const updated: AgentExecutionStatus = { ...current, state: 'cancelled', finishedAt: this.now().toISOString(), errorSummary: reason };
    this.executions.set(executionId, updated);
    this.registry.markFinished(current.workerId, executionId);
    return true;
  }

  status(executionId: string): AgentExecutionStatus | undefined {
    const value = this.executions.get(executionId);
    return value ? { ...value } : undefined;
  }

  list(): AgentExecutionStatus[] {
    return [...this.executions.values()].map(value => ({ ...value }));
  }
}

export interface CommandAgentAdapterOptions {
  kind: Exclude<AgentAdapterKind, 'karkedikha'>;
  command: string;
  buildArgs(request: AgentTaskRequest, route: AgentModelRoute): string[];
  maxOutputBytes?: number;
}

export class CommandAgentAdapter implements AgentAdapter {
  readonly kind: Exclude<AgentAdapterKind, 'karkedikha'>;
  private readonly executions = new Map<string, AgentExecutionStatus>();
  private readonly processes = new Map<string, ChildProcessWithoutNullStreams>();
  private readonly maxOutputBytes: number;

  constructor(private readonly options: CommandAgentAdapterOptions) {
    this.kind = options.kind;
    this.maxOutputBytes = options.maxOutputBytes ?? 64 * 1024;
  }

  async start(worker: AgentWorkerDefinition, request: AgentTaskRequest, route: AgentModelRoute): Promise<AgentExecutionHandle> {
    const executionId = `${this.kind}-${randomUUID()}`;
    const startedAt = new Date().toISOString();
    const handle: AgentExecutionStatus = {
      executionId,
      workerId: worker.id,
      requestId: request.requestId,
      adapter: this.kind,
      model: route.model,
      provider: route.provider,
      estimatedCostUsd: estimateCost(route, request.estimatedInputTokens ?? 0, request.estimatedOutputTokens ?? 0),
      state: 'running',
      startedAt,
      deadlineAt: new Date(Date.parse(startedAt) + request.timeoutMs).toISOString(),
    };
    const child = spawn(this.options.command, this.options.buildArgs(request, route), {
      cwd: request.repositoryRoot,
      windowsHide: true,
      stdio: 'pipe',
      env: { ...process.env, KARKE_DIKHA_WORKER_ID: worker.id, KARKE_DIKHA_REQUEST_ID: request.requestId },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout = appendBounded(stdout, String(chunk), this.maxOutputBytes); });
    child.stderr.on('data', chunk => { stderr = appendBounded(stderr, String(chunk), this.maxOutputBytes); });
    child.on('error', error => {
      this.executions.set(executionId, { ...handle, state: 'failed', finishedAt: new Date().toISOString(), errorSummary: sanitize(error.message) });
      this.processes.delete(executionId);
    });
    child.on('exit', code => {
      const state: AgentExecutionState = code === 0 ? 'completed' : 'failed';
      this.executions.set(executionId, {
        ...handle,
        state,
        exitCode: code ?? -1,
        finishedAt: new Date().toISOString(),
        outputSummary: sanitize(stdout),
        errorSummary: stderr ? sanitize(stderr) : undefined,
      });
      this.processes.delete(executionId);
    });
    this.executions.set(executionId, handle);
    this.processes.set(executionId, child);
    return { ...handle };
  }

  async status(executionId: string): Promise<AgentExecutionStatus | undefined> {
    const value = this.executions.get(executionId);
    return value ? { ...value } : undefined;
  }

  async cancel(executionId: string, reason: string): Promise<boolean> {
    const current = this.executions.get(executionId);
    if (!current || isTerminal(current.state)) return false;
    this.processes.get(executionId)?.kill();
    this.processes.delete(executionId);
    this.executions.set(executionId, { ...current, state: 'cancelled', finishedAt: new Date().toISOString(), errorSummary: sanitize(reason) });
    return true;
  }
}

export interface KarkeDikhaAdapterCallbacks {
  queue(request: AgentTaskRequest, route: AgentModelRoute, worker: AgentWorkerDefinition): Promise<{ taskId: string }>;
  status(taskId: string): Promise<{ state: AgentExecutionState; outputSummary?: string; errorSummary?: string } | undefined>;
  cancel(taskId: string, reason: string): Promise<boolean>;
}

export class KarkeDikhaAgentAdapter implements AgentAdapter {
  readonly kind = 'karkedikha' as const;
  private readonly mappings = new Map<string, { taskId: string; handle: AgentExecutionStatus }>();

  constructor(private readonly callbacks: KarkeDikhaAdapterCallbacks) {}

  async start(worker: AgentWorkerDefinition, request: AgentTaskRequest, route: AgentModelRoute): Promise<AgentExecutionHandle> {
    const executionId = `karkedikha-${randomUUID()}`;
    const queued = await this.callbacks.queue(request, route, worker);
    const startedAt = new Date().toISOString();
    const handle: AgentExecutionStatus = {
      executionId,
      workerId: worker.id,
      requestId: request.requestId,
      adapter: this.kind,
      model: route.model,
      provider: route.provider,
      estimatedCostUsd: estimateCost(route, request.estimatedInputTokens ?? 0, request.estimatedOutputTokens ?? 0),
      state: 'queued',
      startedAt,
      deadlineAt: new Date(Date.parse(startedAt) + request.timeoutMs).toISOString(),
    };
    this.mappings.set(executionId, { taskId: queued.taskId, handle });
    return { ...handle };
  }

  async status(executionId: string): Promise<AgentExecutionStatus | undefined> {
    const mapping = this.mappings.get(executionId);
    if (!mapping) return undefined;
    const observed = await this.callbacks.status(mapping.taskId);
    if (!observed) return { ...mapping.handle };
    const updated: AgentExecutionStatus = {
      ...mapping.handle,
      ...observed,
      finishedAt: isTerminal(observed.state) ? new Date().toISOString() : undefined,
    };
    mapping.handle = updated;
    return { ...updated };
  }

  async cancel(executionId: string, reason: string): Promise<boolean> {
    const mapping = this.mappings.get(executionId);
    if (!mapping) return false;
    const cancelled = await this.callbacks.cancel(mapping.taskId, reason);
    if (cancelled) mapping.handle = { ...mapping.handle, state: 'cancelled', finishedAt: new Date().toISOString(), errorSummary: sanitize(reason) };
    return cancelled;
  }
}

export function defaultCommandAdapters(): CommandAgentAdapter[] {
  return [
    new CommandAgentAdapter({ kind: 'opencode', command: 'opencode', buildArgs: (request, route) => ['run', '--model', route.model, request.goal] }),
    new CommandAgentAdapter({ kind: 'codex', command: 'codex', buildArgs: (request, route) => ['exec', '--model', route.model, request.goal] }),
    new CommandAgentAdapter({ kind: 'claude', command: 'claude', buildArgs: request => ['--print', request.goal] }),
  ];
}

function estimateCost(route: AgentModelRoute, inputTokens: number, outputTokens: number): number {
  return (inputTokens / 1_000_000) * route.inputCostPerMillion + (outputTokens / 1_000_000) * route.outputCostPerMillion;
}

function isTerminal(state: AgentExecutionState): boolean {
  return state === 'completed' || state === 'failed' || state === 'cancelled' || state === 'timed-out';
}

function appendBounded(current: string, next: string, maxBytes: number): string {
  const combined = current + next;
  if (Buffer.byteLength(combined, 'utf8') <= maxBytes) return combined;
  return Buffer.from(combined, 'utf8').subarray(-maxBytes).toString('utf8');
}

function sanitize(value: string): string {
  return value.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 4_000);
}
