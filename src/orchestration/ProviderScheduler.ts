import * as fs from 'fs/promises';
import * as path from 'path';

export type ProviderKind =
  | 'ollama'
  | 'lm-studio'
  | 'openai-compatible'
  | 'claude'
  | 'codex'
  | 'copilot'
  | 'custom';

export type ProviderPrivacy = 'local' | 'cloud';
export type ProviderHealth = 'healthy' | 'degraded' | 'offline';
export type ProviderCostTier = 0 | 1 | 2 | 3;

export interface ProviderEndpoint {
  id: string;
  kind: ProviderKind;
  baseUrl?: string;
  privacy: ProviderPrivacy;
  capabilities: string[];
  models: string[];
  maxContextTokens: number;
  maxConcurrency: number;
  costTier: ProviderCostTier;
  gpuId?: string;
  enabled: boolean;
  health: ProviderHealth;
  priority?: number;
}

export interface ProviderRouteRequest {
  taskId?: string;
  role: string;
  requiredCapabilities: string[];
  preferredKinds?: ProviderKind[];
  preferredModels?: string[];
  minimumContextTokens?: number;
  maximumCostTier?: ProviderCostTier;
  containsPrivateCode?: boolean;
  allowCloud?: boolean;
}

export interface ProviderRouteEvidence {
  schemaVersion: 1;
  requestId: string;
  taskId?: string;
  endpointId?: string;
  model?: string;
  considered: Array<{
    endpointId: string;
    accepted: boolean;
    reason: string;
    score?: number;
  }>;
  selectedAt: string;
  completedAt?: string;
  outcome: 'selected' | 'completed' | 'failed' | 'denied' | 'unavailable';
  error?: string;
}

export interface ProviderSelection {
  endpoint: ProviderEndpoint;
  model: string;
  evidence: ProviderRouteEvidence;
}

export interface ProviderExecutionContext {
  endpoint: Readonly<ProviderEndpoint>;
  model: string;
  signal: AbortSignal;
}

export interface ProviderRouteStorage {
  append(evidence: ProviderRouteEvidence): Promise<void>;
}

export interface CloudApprovalRequest {
  taskId?: string;
  endpointId: string;
  providerKind: ProviderKind;
  model: string;
  reason: string;
}

export type CloudApproval = (request: CloudApprovalRequest) => Promise<boolean>;

export interface ProviderSchedulerOptions {
  auditStorage?: ProviderRouteStorage;
  cloudApproval?: CloudApproval;
}

class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error('Provider concurrency must be a positive integer.');
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

  get load(): number {
    return this.active;
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function requestId(): string {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function normalizeEndpoint(endpoint: ProviderEndpoint): ProviderEndpoint {
  if (!/^[a-zA-Z0-9._-]{1,100}$/.test(endpoint.id)) {
    throw new Error(`Invalid provider endpoint id: ${endpoint.id}`);
  }
  if (!Number.isInteger(endpoint.maxContextTokens) || endpoint.maxContextTokens < 1) {
    throw new Error(`Endpoint ${endpoint.id} has an invalid context limit.`);
  }
  if (!Number.isInteger(endpoint.maxConcurrency) || endpoint.maxConcurrency < 1) {
    throw new Error(`Endpoint ${endpoint.id} has invalid concurrency.`);
  }
  if (endpoint.models.length === 0) {
    throw new Error(`Endpoint ${endpoint.id} must expose at least one model.`);
  }
  return {
    ...endpoint,
    capabilities: [...new Set(endpoint.capabilities.map(value => value.trim()).filter(Boolean))].sort(),
    models: [...new Set(endpoint.models.map(value => value.trim()).filter(Boolean))],
    priority: endpoint.priority ?? 0,
  };
}

function hasCapabilities(endpoint: ProviderEndpoint, required: readonly string[]): boolean {
  const available = new Set(endpoint.capabilities);
  return required.every(capability => available.has(capability));
}

function selectModel(endpoint: ProviderEndpoint, preferred: readonly string[]): string {
  return preferred.find(model => endpoint.models.includes(model)) ?? endpoint.models[0];
}

export class FileProviderRouteStorage implements ProviderRouteStorage {
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly filename: string) {}

  append(evidence: ProviderRouteEvidence): Promise<void> {
    const write = this.queue.then(async () => {
      await fs.mkdir(path.dirname(this.filename), { recursive: true });
      await fs.appendFile(this.filename, `${JSON.stringify(evidence)}\n`, 'utf8');
    });
    this.queue = write.catch(() => undefined);
    return write;
  }
}

export class ProviderScheduler {
  private readonly endpoints = new Map<string, ProviderEndpoint>();
  private readonly semaphores = new Map<string, Semaphore>();
  private readonly auditStorage?: ProviderRouteStorage;
  private readonly cloudApproval?: CloudApproval;

  constructor(options: ProviderSchedulerOptions = {}) {
    this.auditStorage = options.auditStorage;
    this.cloudApproval = options.cloudApproval;
  }

  register(endpoint: ProviderEndpoint): void {
    const normalized = normalizeEndpoint(endpoint);
    this.endpoints.set(normalized.id, normalized);
    this.semaphores.set(normalized.id, new Semaphore(normalized.maxConcurrency));
  }

  unregister(endpointId: string): boolean {
    this.semaphores.delete(endpointId);
    return this.endpoints.delete(endpointId);
  }

  updateHealth(endpointId: string, health: ProviderHealth): void {
    const endpoint = this.requireEndpoint(endpointId);
    this.endpoints.set(endpointId, { ...endpoint, health });
  }

  list(): ProviderEndpoint[] {
    return [...this.endpoints.values()].map(endpoint => ({
      ...endpoint,
      capabilities: [...endpoint.capabilities],
      models: [...endpoint.models],
    }));
  }

  async select(request: ProviderRouteRequest): Promise<ProviderSelection> {
    const evidence: ProviderRouteEvidence = {
      schemaVersion: 1,
      requestId: requestId(),
      taskId: request.taskId,
      considered: [],
      selectedAt: nowIso(),
      outcome: 'unavailable',
    };
    const candidates: Array<{ endpoint: ProviderEndpoint; model: string; score: number }> = [];

    for (const endpoint of this.endpoints.values()) {
      const rejection = this.rejectionReason(endpoint, request);
      if (rejection) {
        evidence.considered.push({ endpointId: endpoint.id, accepted: false, reason: rejection });
        continue;
      }
      const model = selectModel(endpoint, request.preferredModels ?? []);
      const score = this.score(endpoint, model, request);
      evidence.considered.push({ endpointId: endpoint.id, accepted: true, reason: 'Eligible.', score });
      candidates.push({ endpoint, model, score });
    }

    candidates.sort((left, right) => right.score - left.score || left.endpoint.id.localeCompare(right.endpoint.id));
    const selected = candidates[0];
    if (!selected) {
      await this.persist(evidence);
      throw new Error('No provider endpoint satisfies the route requirements.');
    }

    if (selected.endpoint.privacy === 'cloud' && request.containsPrivateCode) {
      if (!request.allowCloud) {
        evidence.outcome = 'denied';
        evidence.error = 'Private repository context cannot leave the machine without explicit cloud permission.';
        await this.persist(evidence);
        throw new Error(evidence.error);
      }
      const approved = await this.cloudApproval?.({
        taskId: request.taskId,
        endpointId: selected.endpoint.id,
        providerKind: selected.endpoint.kind,
        model: selected.model,
        reason: 'The request contains private repository context and targets a cloud provider.',
      });
      if (!approved) {
        evidence.outcome = 'denied';
        evidence.error = 'Cloud provider use was not approved.';
        await this.persist(evidence);
        throw new Error(evidence.error);
      }
    }

    evidence.endpointId = selected.endpoint.id;
    evidence.model = selected.model;
    evidence.outcome = 'selected';
    await this.persist(evidence);
    return { endpoint: { ...selected.endpoint }, model: selected.model, evidence };
  }

  async execute<T>(
    request: ProviderRouteRequest,
    operation: (context: ProviderExecutionContext) => Promise<T>,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<T> {
    const selection = await this.select(request);
    const semaphore = this.semaphores.get(selection.endpoint.id);
    if (!semaphore) {
      throw new Error(`Provider endpoint disappeared before execution: ${selection.endpoint.id}`);
    }
    try {
      const result = await semaphore.run(async () => {
        if (signal.aborted) {
          const error = new Error('Provider execution cancelled.');
          error.name = 'AbortError';
          throw error;
        }
        return operation({ endpoint: selection.endpoint, model: selection.model, signal });
      });
      selection.evidence.outcome = 'completed';
      selection.evidence.completedAt = nowIso();
      await this.persist(selection.evidence);
      return result;
    } catch (error) {
      selection.evidence.outcome = 'failed';
      selection.evidence.completedAt = nowIso();
      selection.evidence.error = error instanceof Error ? error.message : String(error);
      await this.persist(selection.evidence);
      throw error;
    }
  }

  getLoad(endpointId: string): number {
    return this.semaphores.get(endpointId)?.load ?? 0;
  }

  private rejectionReason(endpoint: ProviderEndpoint, request: ProviderRouteRequest): string | undefined {
    if (!endpoint.enabled) { return 'Endpoint is disabled.'; }
    if (endpoint.health === 'offline') { return 'Endpoint is offline.'; }
    if (!hasCapabilities(endpoint, request.requiredCapabilities)) { return 'Missing required capabilities.'; }
    if (endpoint.maxContextTokens < (request.minimumContextTokens ?? 0)) { return 'Context window is too small.'; }
    if (endpoint.costTier > (request.maximumCostTier ?? 3)) { return 'Cost tier exceeds the request limit.'; }
    if (endpoint.privacy === 'cloud' && request.allowCloud === false) { return 'Cloud providers are disabled for this request.'; }
    return undefined;
  }

  private score(endpoint: ProviderEndpoint, model: string, request: ProviderRouteRequest): number {
    let score = endpoint.priority ?? 0;
    if (endpoint.privacy === 'local') { score += 100; }
    if (endpoint.health === 'healthy') { score += 30; }
    if (endpoint.health === 'degraded') { score -= 20; }
    const kindIndex = request.preferredKinds?.indexOf(endpoint.kind) ?? -1;
    if (kindIndex >= 0) { score += 50 - kindIndex; }
    const modelIndex = request.preferredModels?.indexOf(model) ?? -1;
    if (modelIndex >= 0) { score += 40 - modelIndex; }
    score -= endpoint.costTier * 10;
    score -= this.getLoad(endpoint.id) * 15;
    score += Math.min(20, Math.floor(endpoint.maxContextTokens / 8192));
    return score;
  }

  private requireEndpoint(endpointId: string): ProviderEndpoint {
    const endpoint = this.endpoints.get(endpointId);
    if (!endpoint) {
      throw new Error(`Unknown provider endpoint: ${endpointId}`);
    }
    return endpoint;
  }

  private async persist(evidence: ProviderRouteEvidence): Promise<void> {
    await this.auditStorage?.append({
      ...evidence,
      considered: evidence.considered.map(entry => ({ ...entry })),
    });
  }
}
