/**
 * The test setup never lets a test load a model on the real Ollama of the PC it runs on (2026-11-11: four local Core
 * runs loaded qwen3-coder:swift-27b at 21 GB and stalled a live Pandesh run). Reading what is installed stays allowed;
 * anything that could load, run, download or delete a model fails as if Ollama were not running, as on CI.
 */
import { describe, expect, it } from 'vitest';
import { guardUndiciAgent, isRealModelCall, liveModelsAllowed, refusedConnection } from '../../src/test/setup/realModelGuard';
import { streamOllamaChatNdjson } from '../runtime/ollamaStreamTransport';

describe('what counts as reaching a real model', () => {
  it('refuses every request that could load or change a model on the local Ollama ports', () => {
    for (const url of [
      'http://127.0.0.1:11434/api/chat',
      'http://127.0.0.1:11434/api/generate',
      'http://localhost:11434/api/embed',
      'http://127.0.0.1:11434/api/embeddings',
      'http://127.0.0.1:11434/api/pull',
      'http://127.0.0.1:11434/api/delete',
      'http://127.0.0.1:11434/api/create',
      'http://0.0.0.0:11434/v1/chat/completions',
      'http://[::1]:11434/api/chat',
      'http://127.0.0.1:11435/api/chat', // the Ollaya decision models
    ]) expect(isRealModelCall(url)).toBe(true);
  });

  it('lets a test read what is installed, and never touches other servers', () => {
    for (const url of [
      'http://127.0.0.1:11434/',
      'http://127.0.0.1:11434/api/version',
      'http://127.0.0.1:11434/api/tags',
      'http://127.0.0.1:11434/api/ps',
      'http://127.0.0.1:11434/api/show',
      'http://127.0.0.1:54321/api/chat', // a scripted stand-in on its own port
      'http://192.0.2.20:11434/api/chat', // not this PC (a documentation-only address)
      'https://example.com/api/chat',
      'not a url',
    ]) expect(isRealModelCall(url)).toBe(false);
  });

  it('a live run opts in with any *_LIVE_* flag or PANDESH_TESTS_ALLOW_REAL_OLLAMA=1', () => {
    expect(liveModelsAllowed({})).toBe(false);
    expect(liveModelsAllowed({ KKD_LIVE_VISION: '1' })).toBe(true);
    expect(liveModelsAllowed({ RUN_LIVE_AGENT_TESTS: 'true' })).toBe(true);
    expect(liveModelsAllowed({ PANDESH_OLLAYA_LIVE: '1' })).toBe(true);
    expect(liveModelsAllowed({ PANDESH_TESTS_ALLOW_REAL_OLLAMA: '1' })).toBe(true);
    expect(liveModelsAllowed({ KKD_LIVE_VISION: '0', RUN_LIVE_AGENT_TESTS: 'false' })).toBe(false);
    expect(liveModelsAllowed({ DELIVERY_MODE: '1', PANDESH_REAL_LOCALAPPDATA: 'C:\\Users\\x' })).toBe(false);
  });

  it('guards an undici Agent class once, refusing only a dispatch that could reach a real model', () => {
    class FakeAgent { dispatch(options: { origin?: string; path?: string }) { return Boolean(options); } }
    expect(guardUndiciAgent(FakeAgent, {})).toBe(true);
    expect(guardUndiciAgent(FakeAgent, {})).toBe(false); // already guarded: never wrapped twice
    const agent = new FakeAgent();
    expect(() => agent.dispatch({ origin: 'http://127.0.0.1:11434', path: '/api/chat' })).toThrow(/^connect ECONNREFUSED 127\.0\.0\.1:11434 \(refused by the test setup/);
    expect(agent.dispatch({ origin: 'http://127.0.0.1:11434', path: '/api/tags' })).toBe(true);
    expect(agent.dispatch({ origin: 'http://127.0.0.1:54321', path: '/api/chat' })).toBe(true);
    class LiveRunAgent { dispatch() { return true; } }
    expect(guardUndiciAgent(LiveRunAgent, { KKD_LIVE_VISION: '1' })).toBe(false);
  });

  it('a refusal looks like Ollama not running', () => {
    expect(refusedConnection('127.0.0.1:11434')).toMatchObject({ code: 'ECONNREFUSED', syscall: 'connect' });
    expect(refusedConnection('127.0.0.1:11434').message).toMatch(/^connect ECONNREFUSED 127\.0\.0\.1:11434 \(refused by the test setup/);
  });
});

describe.skipIf(liveModelsAllowed())('the guard is on in every test worker', () => {
  it('the global fetch refuses a chat request to the real Ollama before anything is sent', async () => {
    const error = await fetch('http://127.0.0.1:11434/api/chat', { method: 'POST', body: '{"model":"qwen3-coder:swift-27b","messages":[]}' }).then(() => null, (e: unknown) => e as Error & { cause?: { code?: string; message?: string } });
    expect(error).toBeInstanceOf(TypeError);
    expect(error?.message).toBe('fetch failed');
    expect(error?.cause?.code).toBe('ECONNREFUSED');
    expect(error?.cause?.message).toMatch(/refused by the test setup/);
  });

  it('the streaming transport (undici with its own Agent) is refused too', async () => {
    const error = await streamOllamaChatNdjson({ baseUrl: 'http://127.0.0.1:11434', body: { model: 'qwen3-coder:swift-27b', messages: [] } })
      .then(() => null, (e: unknown) => e as Error & { code?: string });
    expect(error?.code).toBe('ECONNREFUSED');
    expect(error?.message).toMatch(/refused by the test setup/);
  });
});
