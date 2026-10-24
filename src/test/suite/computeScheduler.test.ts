import { describe, expect, it } from 'vitest';
import { ComputeScheduler } from '../../performance/ComputeScheduler';

describe('compute scheduler', () => {
  it('selects a fitting local model and reuses the loaded model', () => {
    const scheduler = new ComputeScheduler();
    scheduler.registerDevice({
      id: 'device-one', kind: 'gpu', name: 'local accelerator', totalMemoryMb: 24576,
      reservedMemoryMb: 1024, utilization: 0, maxConcurrent: 1, activeJobs: 0,
      supportsBatching: true, online: true,
    });
    scheduler.registerModel({
      id: 'coder-model', memoryMb: 18000, contextWindow: 65536, qualityScore: 0.85,
      tokensPerSecond: 20, loadTimeMs: 1000, deviceKinds: ['gpu'],
    });
    const request = {
      requestId: 'request-one', candidateModels: ['coder-model'], inputTokens: 2000,
      expectedOutputTokens: 200, minimumQuality: 0.8, preferLocal: true,
      batchable: true, privacy: 'local-only' as const,
    };
    const first = scheduler.plan(request);
    const lease = scheduler.acquire(first);
    scheduler.release(lease.leaseId);
    const second = scheduler.plan(request);

    expect(first.deviceId).toBe('device-one');
    expect(first.requiresModelLoad).toBe(true);
    expect(second.requiresModelLoad).toBe(false);
  });
});
