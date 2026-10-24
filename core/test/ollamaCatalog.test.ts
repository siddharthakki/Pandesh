import { describe, expect, it } from 'vitest';
import { afterEach } from 'vitest';
import {
  clearOllamaContextLengthCache,
  fetchOllamaCatalog,
  getOllamaContextLength,
  withContextWindows,
} from '../runtime/ollamaCatalog';

describe('Ollama installed-model catalog', () => {
  it('returns normalized model names from a successful tags response', async () => {
    const fetchFn = async () => new Response(JSON.stringify({
      models: [{ name: 'alpha:latest' }, { name: 'beta:7b' }, { name: 'alpha:latest' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
    await expect(fetchOllamaCatalog({ fetchFn: fetchFn as typeof fetch })).resolves.toEqual({
      reachable: true,
      models: ['alpha:latest', 'beta:7b'],
    });
  });

  it('returns unreachable for a network error', async () => {
    const fetchFn = async () => { throw new Error('offline'); };
    await expect(fetchOllamaCatalog({ fetchFn: fetchFn as typeof fetch })).resolves.toEqual({ models: [], reachable: false });
  });

  it('returns unreachable for non-success and malformed responses', async () => {
    const badStatus = async () => new Response('no', { status: 503 });
    const malformed = async () => new Response(JSON.stringify({ models: 'wrong' }), { status: 200 });
    await expect(fetchOllamaCatalog({ fetchFn: badStatus as typeof fetch })).resolves.toEqual({ models: [], reachable: false });
    await expect(fetchOllamaCatalog({ fetchFn: malformed as typeof fetch })).resolves.toEqual({ models: [], reachable: false });
  });

  it('bounds discovery with an aborting timeout', async () => {
    const fetchFn = (_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    });
    await expect(fetchOllamaCatalog({ fetchFn: fetchFn as typeof fetch, timeoutMs: 5 })).resolves.toEqual({ models: [], reachable: false });
  });
});

describe('Ollama context-length introspection (/api/show)', () => {
  afterEach(() => clearOllamaContextLengthCache());
  const show = (info: unknown, status = 200) => async () => new Response(JSON.stringify({ model_info: info }), { status });

  it('reads the first *.context_length and caches it per model', async () => {
    let calls = 0;
    const fetchFn = async (url: string | URL | Request, init?: RequestInit) => {
      calls += 1;
      expect(String(url)).toMatch(/\/api\/show$/);
      expect(JSON.parse(String(init?.body))).toEqual({ model: 'alpha:latest' });
      return new Response(JSON.stringify({ model_info: { 'general.architecture': 'qwen3', 'qwen3.context_length': 40_960 } }), { status: 200 });
    };
    await expect(getOllamaContextLength('alpha:latest', { fetchFn: fetchFn as typeof fetch })).resolves.toBe(40_960);
    await expect(getOllamaContextLength('alpha:latest', { fetchFn: fetchFn as typeof fetch })).resolves.toBe(40_960);
    expect(calls).toBe(1);
  });

  it('returns undefined — and does not cache — on failure, non-success or no usable key', async () => {
    const offline = async () => { throw new Error('offline'); };
    await expect(getOllamaContextLength('m', { fetchFn: offline as typeof fetch })).resolves.toBeUndefined();
    await expect(getOllamaContextLength('m', { fetchFn: show({ x: 1 }, 503) as typeof fetch })).resolves.toBeUndefined();
    await expect(getOllamaContextLength('m', { fetchFn: show({ 'a.context_length': 'big' }) as typeof fetch })).resolves.toBeUndefined();
    await expect(getOllamaContextLength('m', { fetchFn: show(undefined) as typeof fetch })).resolves.toBeUndefined();
    // A later success is not shadowed by the earlier failures.
    await expect(getOllamaContextLength('m', { fetchFn: show({ 'a.context_length': 8192 }) as typeof fetch })).resolves.toBe(8192);
  });

  it('bounds the lookup with an aborting timeout', async () => {
    const fetchFn = (_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    });
    await expect(getOllamaContextLength('slow', { fetchFn: fetchFn as typeof fetch, timeoutMs: 5 })).resolves.toBeUndefined();
  });

  it('adds windows only for installed models among the requested ones', async () => {
    const fetchFn = async (_url: string | URL | Request, init?: RequestInit) => {
      const { model } = JSON.parse(String(init?.body)) as { model: string };
      return new Response(JSON.stringify({ model_info: model === 'a' ? { 'x.context_length': 4096 } : {} }), { status: 200 });
    };
    const enriched = await withContextWindows({ reachable: true, models: ['a', 'b'] }, ['a', 'b', 'not-installed'], { fetchFn: fetchFn as typeof fetch });
    expect(enriched).toEqual({ reachable: true, models: ['a', 'b'], contextWindows: { a: 4096 } });
    const unreachable = { reachable: false, models: [] };
    await expect(withContextWindows(unreachable, ['a'])).resolves.toBe(unreachable);
  });
});
