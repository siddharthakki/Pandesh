/**
 * Tests never load a model on the real Ollama (see realModelGuard.ts for the incident and the rules).
 *
 * Core reaches Ollama two ways, and both are covered:
 *  - the global fetch (model residency, the chat engine's native transport, OpenAI-compatible backends), wrapped here
 *    before any test module is imported;
 *  - undici.request with its own Agent (ollamaStreamTransport.ts, streaming chat), which the global fetch never sees.
 *    Its Agent is guarded when a module first imports undici, never here: importing undici makes its Agent the default
 *    dispatcher of Node's built-in fetch, and that Agent's stricter header check broke 14 upload tests (the
 *    Content-Length a test sets plus the one fetch adds arrive as "N, N").
 * A refused request fails the way an unreachable Ollama does on CI. Child processes a test starts are not covered.
 */
import { vi } from 'vitest';
import { isRealModelCall, liveModelsAllowed, refusedConnection } from './realModelGuard';

vi.mock('undici', async (importOriginal) => {
  const undici = await importOriginal<typeof import('undici')>();
  const { guardUndiciAgent } = await import('./realModelGuard');
  guardUndiciAgent(undici.Agent);
  return undici;
});

const GUARD = Symbol.for('pandesh.tests.noRealModels');

if (!liveModelsAllowed() && !(globalThis as Record<symbol, unknown>)[GUARD]) {
  (globalThis as Record<symbol, unknown>)[GUARD] = true;

  const realFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
    if (isRealModelCall(url)) {
      const target = new URL(url);
      throw Object.assign(new TypeError('fetch failed'), { cause: refusedConnection(`${target.hostname}:${target.port}`) });
    }
    return realFetch(input, init);
  }) as typeof fetch;
}
