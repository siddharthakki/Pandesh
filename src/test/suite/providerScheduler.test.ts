import { describe, expect, it } from 'vitest';
import { ProviderEndpoint, ProviderScheduler } from '../../orchestration/ProviderScheduler';

function localEndpoint(id: string, maxConcurrency = 1): ProviderEndpoint {
  return {
    id,
    kind: 'ollama',
    privacy: 'local',
    capabilities: ['chat', 'tools', 'code'],
    models: ['local-code-model'],
    maxContextTokens: 65_536,
    maxConcurrency,
    costTier: 0,
    enabled: true,
    health: 'healthy',
  };
}

describe('Phase 16 provider scheduler', () => {
  it('selects an eligible endpoint deterministically', async () => {
    const scheduler = new ProviderScheduler();
    scheduler.register(localEndpoint('b'));
    scheduler.register(localEndpoint('a'));

    const selected = await scheduler.select({
      role: 'implementer',
      requiredCapabilities: ['code', 'tools'],
      minimumContextTokens: 32_000,
    });

    expect(selected.endpoint.id).toBe('a');
    expect(selected.model).toBe('local-code-model');
  });

  it('serializes work when an endpoint has one slot', async () => {
    const scheduler = new ProviderScheduler();
    scheduler.register(localEndpoint('single'));
    let active = 0;
    let maximum = 0;

    const run = () => scheduler.execute({
      role: 'implementer',
      requiredCapabilities: ['code'],
    }, async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise(resolve => setTimeout(resolve, 10));
      active -= 1;
      return 'done';
    });

    await Promise.all([run(), run()]);
    expect(maximum).toBe(1);
  });
});
