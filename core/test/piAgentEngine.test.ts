import { describe, it, expect } from 'vitest';
import { PiAgentEngine, piAgentEngine } from '../runtime/piAgentEngine';
import { EngineRegistry } from '../runtime/adapters/EngineAdapter';

describe('PiAgentEngine and Unified Architecture in KKD', () => {
  it('registers Pi Agent Core in EngineRegistry with role general', () => {
    const registered = EngineRegistry.get('pi');
    expect(registered).toBeDefined();
    expect(registered?.id).toBe('pi');
    expect(registered?.role).toBe('general');
    expect(registered?.name).toBe('Pi Agent Core');
  });

  it('exposes OpenCode alongside Pi in EngineRegistry', () => {
    const opencode = EngineRegistry.get('opencode');
    expect(opencode).toBeDefined();
    expect(opencode?.id).toBe('opencode');
    expect(opencode?.role).toBe('coding');
  });

  it('instantiates PiAgentEngine and reports availability check', async () => {
    const engine = new PiAgentEngine();
    expect(engine.id).toBe('pi');
    const isAvail = await engine.isAvailable();
    expect(typeof isAvail).toBe('boolean');
  });
});
