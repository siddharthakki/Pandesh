import { describe, expect, it } from 'vitest';
import { HookEngine } from '../../extensibility/HookEngine';

describe('lifecycle hook engine', () => {
  it('applies ordered transformations and context injection', async () => {
    const hooks = new HookEngine();
    hooks.register({
      id: 'transform',
      stage: 'prompt',
      priority: 10,
      trusted: true,
      timeoutMs: 1000,
      run: async context => ({ type: 'transform', transformedInput: `${String(context.input)} updated` }),
    });
    hooks.register({
      id: 'context',
      stage: 'prompt',
      priority: 20,
      trusted: true,
      timeoutMs: 1000,
      run: async () => ({ type: 'inject', injectedContext: ['additional context'] }),
    });

    const result = await hooks.execute('prompt', 'request');

    expect(result.status).toBe('allowed');
    expect(result.input).toBe('request updated');
    expect(result.injectedContext).toEqual(['additional context']);
  });
});
