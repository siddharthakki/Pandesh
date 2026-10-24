import {
  ProviderEndpoint,
  ProviderExecutionContext,
  ProviderRouteRequest,
  ProviderScheduler,
} from '../orchestration/ProviderScheduler';
import {
  BenchmarkObservation,
  ComputePlan,
  ComputeRequest,
  ComputeScheduler,
} from './ComputeScheduler';

export interface ComputeAwareRouteRequest {
  provider: ProviderRouteRequest;
  compute: Omit<ComputeRequest, 'requestId' | 'candidateModels'> & {
    requestId?: string;
    candidateModels?: string[];
  };
}

export interface ComputeAwareExecutionContext extends ProviderExecutionContext {
  computePlan: Readonly<ComputePlan>;
  reportBenchmark(observation: Omit<BenchmarkObservation, 'modelId' | 'deviceId'>): void;
}

export class ComputeAwareProviderRouter {
  private readonly endpoints = new Map<string, ProviderEndpoint>();

  constructor(
    private readonly providers: ProviderScheduler,
    private readonly compute: ComputeScheduler,
  ) {}

  registerEndpoint(endpoint: ProviderEndpoint): void {
    this.providers.register(endpoint);
    this.endpoints.set(endpoint.id, {
      ...endpoint,
      capabilities: [...endpoint.capabilities],
      models: [...endpoint.models],
    });
  }

  unregisterEndpoint(endpointId: string): boolean {
    this.endpoints.delete(endpointId);
    return this.providers.unregister(endpointId);
  }

  async execute<T>(
    request: ComputeAwareRouteRequest,
    operation: (context: ComputeAwareExecutionContext) => Promise<T>,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<T> {
    const candidateModels = request.compute.candidateModels?.length
      ? request.compute.candidateModels
      : collectCandidateModels(this.endpoints, request.provider);
    const initialPlan = this.compute.plan({
      ...request.compute,
      requestId: request.compute.requestId ?? request.provider.taskId ?? createRequestId(),
      candidateModels,
    });
    const preferredEndpoint = [...this.endpoints.values()].find(endpoint =>
      endpoint.models.includes(initialPlan.modelId) &&
      (!endpoint.gpuId || endpoint.gpuId === initialPlan.deviceId),
    );
    const providerRequest: ProviderRouteRequest = {
      ...request.provider,
      preferredModels: unique([
        initialPlan.modelId,
        ...(request.provider.preferredModels ?? []),
      ]),
      preferredKinds: preferredEndpoint
        ? unique([preferredEndpoint.kind, ...(request.provider.preferredKinds ?? [])])
        : request.provider.preferredKinds,
    };

    return this.providers.execute(providerRequest, async providerContext => {
      if (signal.aborted) throw cancellationError();
      const endpoint = this.endpoints.get(providerContext.endpoint.id);
      if (!endpoint) throw new Error(`Compute-aware endpoint is not registered: ${providerContext.endpoint.id}`);
      const computePlan = this.compute.plan({
        ...request.compute,
        requestId: request.compute.requestId ?? providerRequest.taskId ?? createRequestId(),
        candidateModels: [providerContext.model],
      });
      if (endpoint.gpuId && computePlan.deviceId !== endpoint.gpuId) {
        throw new Error(
          `Provider ${endpoint.id} is bound to device ${endpoint.gpuId}, but compute selected ${computePlan.deviceId}.`,
        );
      }
      const lease = this.compute.acquire(computePlan);
      let observation: BenchmarkObservation | undefined;
      try {
        return await operation({
          ...providerContext,
          computePlan: { ...computePlan, reasons: [...computePlan.reasons] },
          reportBenchmark: value => {
            observation = {
              ...value,
              modelId: providerContext.model,
              deviceId: computePlan.deviceId,
            };
          },
        });
      } finally {
        this.compute.release(lease.leaseId, observation);
      }
    }, signal);
  }
}

function collectCandidateModels(
  endpoints: Map<string, ProviderEndpoint>,
  request: ProviderRouteRequest,
): string[] {
  const preferred = request.preferredModels ?? [];
  const eligible = [...endpoints.values()]
    .filter(endpoint => endpoint.enabled && endpoint.health !== 'offline')
    .filter(endpoint => request.requiredCapabilities.every(capability => endpoint.capabilities.includes(capability)))
    .flatMap(endpoint => endpoint.models);
  return unique([...preferred, ...eligible]);
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function createRequestId(): string {
  return `compute-route-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function cancellationError(): Error {
  const error = new Error('Compute-aware provider execution cancelled.');
  error.name = 'AbortError';
  return error;
}
