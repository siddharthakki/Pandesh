import { randomUUID } from 'crypto';

export type ComputeDeviceKind = 'cpu' | 'gpu';

export interface ComputeDevice {
  id: string;
  kind: ComputeDeviceKind;
  name: string;
  totalMemoryMb: number;
  reservedMemoryMb: number;
  activeModel?: string;
  utilization: number;
  maxConcurrent: number;
  activeJobs: number;
  supportsBatching: boolean;
  online: boolean;
}

export interface ModelProfile {
  id: string;
  memoryMb: number;
  contextWindow: number;
  qualityScore: number;
  tokensPerSecond: number;
  loadTimeMs: number;
  energyWatts?: number;
  cloudCostPerMillionTokens?: number;
  deviceKinds: ComputeDeviceKind[];
}

export interface ComputeRequest {
  requestId: string;
  candidateModels: string[];
  inputTokens: number;
  expectedOutputTokens: number;
  minimumQuality: number;
  maximumLatencyMs?: number;
  maximumCost?: number;
  preferLocal: boolean;
  batchable: boolean;
  privacy: 'local-only' | 'private' | 'public';
}

export interface ComputePlan {
  planId: string;
  requestId: string;
  modelId: string;
  deviceId: string;
  requiresModelLoad: boolean;
  estimatedLatencyMs: number;
  estimatedCost: number;
  estimatedEnergyWh?: number;
  score: number;
  reasons: string[];
}

export interface ComputeLease {
  leaseId: string;
  plan: ComputePlan;
  acquiredAt: string;
}

export interface BenchmarkObservation {
  modelId: string;
  deviceId: string;
  inputTokens: number;
  outputTokens: number;
  elapsedMs: number;
  qualityScore?: number;
  success: boolean;
}

export class ComputeScheduler {
  private readonly devices = new Map<string, ComputeDevice>();
  private readonly models = new Map<string, ModelProfile>();
  private readonly leases = new Map<string, ComputeLease>();
  private readonly benchmarkRates = new Map<string, number>();

  registerDevice(device: ComputeDevice): void {
    validateDevice(device);
    if (this.devices.has(device.id)) throw new Error(`Compute device already registered: ${device.id}`);
    this.devices.set(device.id, clone(device));
  }

  updateDevice(id: string, changes: Partial<Omit<ComputeDevice, 'id'>>): ComputeDevice {
    const device = this.requireDevice(id);
    Object.assign(device, clone(changes));
    validateDevice(device);
    return clone(device);
  }

  registerModel(profile: ModelProfile): void {
    validateModel(profile);
    if (this.models.has(profile.id)) throw new Error(`Model profile already registered: ${profile.id}`);
    this.models.set(profile.id, clone(profile));
  }

  plan(request: ComputeRequest): ComputePlan {
    validateRequest(request);
    const candidates: ComputePlan[] = [];
    for (const modelId of request.candidateModels) {
      const model = this.models.get(modelId);
      if (!model || model.qualityScore < request.minimumQuality) continue;
      for (const device of this.devices.values()) {
        if (!device.online || !model.deviceKinds.includes(device.kind)) continue;
        if (device.activeJobs >= device.maxConcurrent) continue;
        const availableMemory = device.totalMemoryMb - device.reservedMemoryMb;
        if (model.memoryMb > availableMemory) continue;
        if (request.privacy === 'local-only' && device.kind !== 'cpu' && device.kind !== 'gpu') continue;
        const plan = buildPlan(request, model, device, this.benchmarkRates.get(rateKey(model.id, device.id)));
        if (request.maximumLatencyMs !== undefined && plan.estimatedLatencyMs > request.maximumLatencyMs) continue;
        if (request.maximumCost !== undefined && plan.estimatedCost > request.maximumCost) continue;
        candidates.push(plan);
      }
    }
    if (candidates.length === 0) throw new Error(`No compute plan satisfies request ${request.requestId}.`);
    return candidates.sort((left, right) => right.score - left.score || left.estimatedLatencyMs - right.estimatedLatencyMs || left.modelId.localeCompare(right.modelId))[0];
  }

  acquire(plan: ComputePlan): ComputeLease {
    const device = this.requireDevice(plan.deviceId);
    const model = this.models.get(plan.modelId);
    if (!model) throw new Error(`Unknown model profile: ${plan.modelId}`);
    if (!device.online || device.activeJobs >= device.maxConcurrent) {
      throw new Error(`Compute device is no longer available: ${device.id}`);
    }
    const availableMemory = device.totalMemoryMb - device.reservedMemoryMb;
    if (model.memoryMb > availableMemory) throw new Error(`Model no longer fits device ${device.id}.`);
    device.activeJobs += 1;
    device.utilization = Math.min(1, device.activeJobs / device.maxConcurrent);
    device.activeModel = model.id;
    const lease: ComputeLease = {
      leaseId: randomUUID(),
      plan: clone(plan),
      acquiredAt: new Date().toISOString(),
    };
    this.leases.set(lease.leaseId, lease);
    return clone(lease);
  }

  release(leaseId: string, observation?: BenchmarkObservation): boolean {
    const lease = this.leases.get(leaseId);
    if (!lease) return false;
    const device = this.requireDevice(lease.plan.deviceId);
    device.activeJobs = Math.max(0, device.activeJobs - 1);
    device.utilization = device.maxConcurrent > 0 ? device.activeJobs / device.maxConcurrent : 0;
    this.leases.delete(leaseId);
    if (observation) this.recordBenchmark(observation);
    return true;
  }

  recordBenchmark(observation: BenchmarkObservation): void {
    if (!this.models.has(observation.modelId)) throw new Error(`Unknown benchmark model: ${observation.modelId}`);
    this.requireDevice(observation.deviceId);
    if (!observation.success || observation.elapsedMs <= 0) return;
    const rate = observation.outputTokens / (observation.elapsedMs / 1000);
    if (!Number.isFinite(rate) || rate <= 0) return;
    const key = rateKey(observation.modelId, observation.deviceId);
    const current = this.benchmarkRates.get(key);
    this.benchmarkRates.set(key, current === undefined ? rate : current * 0.7 + rate * 0.3);
    if (observation.qualityScore !== undefined) {
      const model = this.models.get(observation.modelId)!;
      model.qualityScore = Math.max(0, Math.min(1, model.qualityScore * 0.8 + observation.qualityScore * 0.2));
    }
  }

  snapshot(): { devices: ComputeDevice[]; models: ModelProfile[]; leases: ComputeLease[] } {
    return {
      devices: [...this.devices.values()].map(clone).sort((left, right) => left.id.localeCompare(right.id)),
      models: [...this.models.values()].map(clone).sort((left, right) => left.id.localeCompare(right.id)),
      leases: [...this.leases.values()].map(clone).sort((left, right) => left.acquiredAt.localeCompare(right.acquiredAt)),
    };
  }

  private requireDevice(id: string): ComputeDevice {
    const device = this.devices.get(id);
    if (!device) throw new Error(`Unknown compute device: ${id}`);
    return device;
  }
}

function buildPlan(
  request: ComputeRequest,
  model: ModelProfile,
  device: ComputeDevice,
  observedRate?: number,
): ComputePlan {
  const rate = observedRate ?? model.tokensPerSecond;
  const generationMs = (request.expectedOutputTokens / Math.max(rate, 0.1)) * 1000;
  const requiresModelLoad = device.activeModel !== model.id;
  const queuePenalty = device.activeJobs * 250;
  const loadMs = requiresModelLoad ? model.loadTimeMs : 0;
  const estimatedLatencyMs = Math.ceil(loadMs + generationMs + queuePenalty);
  const totalTokens = request.inputTokens + request.expectedOutputTokens;
  const estimatedCost = (model.cloudCostPerMillionTokens ?? 0) * totalTokens / 1_000_000;
  const estimatedEnergyWh = model.energyWatts
    ? model.energyWatts * estimatedLatencyMs / 3_600_000
    : undefined;
  let score = model.qualityScore * 100;
  score -= estimatedLatencyMs / 1000;
  score -= estimatedCost * 100;
  score -= device.utilization * 20;
  const reasons = [
    `quality=${model.qualityScore.toFixed(3)}`,
    `latency=${estimatedLatencyMs}ms`,
    `device=${device.name}`,
  ];
  if (request.preferLocal && (device.kind === 'gpu' || device.kind === 'cpu')) {
    score += 15;
    reasons.push('local preference');
  }
  if (request.batchable && device.supportsBatching) {
    score += 5;
    reasons.push('batching supported');
  }
  if (!requiresModelLoad) {
    score += 8;
    reasons.push('model already loaded');
  }
  return {
    planId: randomUUID(),
    requestId: request.requestId,
    modelId: model.id,
    deviceId: device.id,
    requiresModelLoad,
    estimatedLatencyMs,
    estimatedCost,
    estimatedEnergyWh,
    score,
    reasons,
  };
}

function validateDevice(device: ComputeDevice): void {
  if (!/^[a-zA-Z0-9._:-]{1,160}$/.test(device.id)) throw new Error(`Invalid compute device id: ${device.id}`);
  if (device.totalMemoryMb <= 0 || device.reservedMemoryMb < 0 || device.reservedMemoryMb >= device.totalMemoryMb) {
    throw new Error(`Invalid memory limits for device ${device.id}.`);
  }
  if (!Number.isInteger(device.maxConcurrent) || device.maxConcurrent < 1) throw new Error(`Invalid concurrency for device ${device.id}.`);
  if (!Number.isInteger(device.activeJobs) || device.activeJobs < 0 || device.activeJobs > device.maxConcurrent) throw new Error(`Invalid active job count for device ${device.id}.`);
  if (!Number.isFinite(device.utilization) || device.utilization < 0 || device.utilization > 1) throw new Error(`Invalid utilization for device ${device.id}.`);
}

function validateModel(model: ModelProfile): void {
  if (!/^[a-zA-Z0-9._:/-]{1,200}$/.test(model.id)) throw new Error(`Invalid model id: ${model.id}`);
  if (model.memoryMb <= 0 || model.contextWindow <= 0 || model.tokensPerSecond <= 0 || model.loadTimeMs < 0) throw new Error(`Invalid model profile: ${model.id}`);
  if (model.qualityScore < 0 || model.qualityScore > 1) throw new Error(`Invalid model quality: ${model.id}`);
}

function validateRequest(request: ComputeRequest): void {
  if (!/^[a-zA-Z0-9._:-]{1,200}$/.test(request.requestId)) throw new Error(`Invalid compute request id: ${request.requestId}`);
  if (request.candidateModels.length === 0) throw new Error('Compute request requires candidate models.');
  if (request.minimumQuality < 0 || request.minimumQuality > 1) throw new Error('Minimum quality must be between 0 and 1.');
  if (request.inputTokens < 0 || request.expectedOutputTokens < 1) throw new Error('Token estimates are invalid.');
}

function rateKey(modelId: string, deviceId: string): string {
  return `${modelId}\0${deviceId}`;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
