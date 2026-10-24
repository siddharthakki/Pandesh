import { describe, expect, it } from 'vitest';
import { InMemoryRemoteTaskStorage, RemoteTaskService } from '../../remote/RemoteTaskService';

describe('resumable remote task service', () => {
  it('places tasks, preserves idempotency, and resumes streams', async () => {
    const service = new RemoteTaskService(new InMemoryRemoteTaskStorage());
    await service.initialize();
    await service.registerDevice({
      id: 'controller', name: 'controller', publicKeyFingerprint: 'aa11bb22cc33dd44',
      capabilities: ['submit'], labels: {}, privacy: 'local', maxConcurrent: 2, status: 'online',
    });
    await service.registerDevice({
      id: 'worker', name: 'worker', publicKeyFingerprint: 'ee11ff22aa33bb44',
      capabilities: ['typescript'], labels: { gpu: 'true' }, privacy: 'local', maxConcurrent: 1, status: 'online',
    });
    const request = {
      taskId: 'task-one', requiredCapabilities: ['typescript'], requiredLabels: { gpu: 'true' },
      privacy: 'local' as const, idempotencyKey: 'task-one-submit', payload: { goal: 'compile' },
    };
    const first = await service.submit(request, 'controller');
    const replay = await service.submit(request, 'controller');

    expect(first.id).toBe(replay.id);
    expect(first.targetDeviceId).toBe('worker');
    expect(service.pendingFor('worker')).toHaveLength(1);
    expect(service.resume('task-one', 0, 'worker')[0].id).toBe(first.id);
  });
});
