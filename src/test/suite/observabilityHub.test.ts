import { describe, expect, it } from 'vitest';
import { ObservabilityHub } from '../../observability/ObservabilityHub';

describe('Phase 21 observability hub', () => {
  it('keeps bounded recent events and deterministic counters', async () => {
    const hub = new ObservabilityHub({ capacity: 10 });
    for (let index = 0; index < 12; index += 1) {
      await hub.record({ category: 'task', name: 'step', data: { index } });
    }
    const snapshot = hub.snapshot();
    expect(snapshot.eventCount).toBe(12);
    expect(snapshot.recentEvents).toHaveLength(10);
    expect(snapshot.recentEvents[0].sequence).toBe(3);
    expect(snapshot.counters['task.step']).toBe(12);
  });

  it('redacts nested and array secrets while isolating listener failures', async () => {
    const hub = new ObservabilityHub();
    let received = 0;
    hub.subscribe(() => { throw new Error('observer failure'); });
    hub.subscribe(() => { received += 1; });

    const event = await hub.record({
      category: 'provider',
      name: 'request',
      data: {
        apiKey: 'secret-value',
        nested: { authorization: 'Bearer token', safe: 'value' },
        array: [{ password: 'hidden', visible: 'yes' }],
      },
    });

    expect(received).toBe(1);
    expect(event.data?.['apiKey']).toBe('[REDACTED]');
    expect((event.data?.['nested'] as Record<string, unknown>)['authorization']).toBe('[REDACTED]');
    expect((event.data?.['nested'] as Record<string, unknown>)['safe']).toBe('value');
    const array = event.data?.['array'] as Array<Record<string, unknown>>;
    expect(array[0]['password']).toBe('[REDACTED]');
    expect(array[0]['visible']).toBe('yes');
  });

  it('continues when observation storage reports an error', async () => {
    const hub = new ObservabilityHub({
      storage: { append: async () => Promise.reject(new Error('storage error')) },
    });
    const event = await hub.record({ category: 'system', name: 'still-running' });
    expect(event.name).toBe('still-running');
    expect(hub.snapshot().counters['system.observation-storage-failed']).toBe(1);
  });
});
