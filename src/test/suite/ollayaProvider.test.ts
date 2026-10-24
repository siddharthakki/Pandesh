import { describe, expect, it } from 'vitest';
import { OllayaProvider } from '../../systemOne/OllayaProvider';
import { DECISION_CONTRACTS } from '../../systemOne/decisionContracts';
import type { SystemOneDecisionRequest } from '../../systemOne/types';

const request = (overrides: Partial<SystemOneDecisionRequest> = {}): SystemOneDecisionRequest => ({
  context: 'Latest user message: hello',
  questions: { intent: DECISION_CONTRACTS.intent, follow_up: DECISION_CONTRACTS.follow_up },
  timeoutMs: 500,
  ...overrides,
});

const okFetch = (intent: string) => (async () => ({
  ok: true,
  json: async () => ({ answers: { intent: { choice: intent, probabilities: { [intent]: 0.9 } }, follow_up: { choice: 'mutation' } } }),
})) as unknown as typeof fetch;

describe('OllayaProvider (M43.1/M43.2/M43.3/M43.10)', () => {
  it('normalizes a wire response into provider-independent decisions', async () => {
    const provider = new OllayaProvider('http://127.0.0.1:8771', okFetch('bounded_edit'));
    const response = await provider.decide(request());
    expect(response.error).toBeUndefined();
    expect(response.decisions.intent).toEqual({ value: 'bounded_edit', confidence: 0.9 });
    expect(response.decisions.follow_up).toEqual({ value: 'mutation', confidence: null });
    expect(response.provider).toBe('ollaya');
  });

  it('passes an arbitrary configured model id through on the wire without hardcoding any model name', async () => {
    let sentBody: string | undefined;
    const fetchSpy = (async (_url: string, init: { body: string }) => {
      sentBody = init.body;
      return { ok: true, json: async () => ({ answers: {} }) };
    }) as unknown as typeof fetch;
    const provider = new OllayaProvider('http://127.0.0.1:8771', fetchSpy);
    await provider.decide(request({ model: 'decider:2b' }));
    expect(JSON.parse(sentBody!).model).toBe('decider:2b');
  });

  it('refuses a non-loopback endpoint without ever calling fetch (M43.6)', async () => {
    let calls = 0;
    const fetchSpy = (async () => { calls += 1; return { ok: true, json: async () => ({}) }; }) as unknown as typeof fetch;
    const provider = new OllayaProvider('http://10.0.0.5:8771', fetchSpy);
    const response = await provider.decide(request());
    expect(response.error).toMatch(/loopback/);
    expect(calls).toBe(0);
  });

  it.each([
    ['connection refused', (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch],
    ['HTTP 500', (async () => ({ ok: false, status: 500, json: async () => ({}) })) as unknown as typeof fetch],
    ['malformed JSON', (async () => ({ ok: true, json: async () => { throw new Error('bad json'); } })) as unknown as typeof fetch],
    ['timeout', ((_url: string, init: { signal: AbortSignal }) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))))) as unknown as typeof fetch],
  ])('never throws on %s — returns a diagnostic error instead', async (_label, fetchImpl) => {
    const provider = new OllayaProvider('http://127.0.0.1:8771', fetchImpl);
    const response = await provider.decide(request({ timeoutMs: 60 }));
    expect(response.error).toBeTruthy();
    expect(response.decisions).toEqual({});
  });

  it('drops an answer with neither a choice nor a numeric value instead of guessing', async () => {
    const fetchSpy = (async () => ({ ok: true, json: async () => ({ answers: { intent: {}, follow_up: { choice: 'mutation' } } }) })) as unknown as typeof fetch;
    const provider = new OllayaProvider('http://127.0.0.1:8771', fetchSpy);
    const response = await provider.decide(request());
    expect(response.decisions.intent).toBeUndefined();
    expect(response.decisions.follow_up).toEqual({ value: 'mutation', confidence: null });
  });
});
