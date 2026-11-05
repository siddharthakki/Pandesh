/**
 * The governed Ollama management surface.
 *
 * These tests pin the refusals that matter: a pull never starts when the disk
 * cannot hold the model, and a new model whose size is only known once the
 * pull begins is stopped as soon as Ollama reports a size that does not fit.
 * They also pin the delete guards.
 */
import { describe, expect, it } from 'vitest';
import { createOllamaManagementAdapter, defaultFreeDiskBytes } from '../runtime/ollamaManagementCapability';

const GB = 1024 ** 3;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

function streamResponse(lines: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(`${line}\n`));
      controller.close();
    },
  }), { status: 200 });
}

interface FakeFetch {
  impl: typeof fetch;
  calls: Array<{ url: string; method: string; body: Record<string, unknown> | null }>;
}

function fakeFetch(handler: (url: string, init?: RequestInit) => Response): FakeFetch {
  const calls: FakeFetch['calls'] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : null;
    calls.push({ url, method: init?.method ?? 'GET', body });
    return handler(url, init);
  }) as typeof fetch;
  return { impl, calls };
}

describe('ollama management — disk guards', () => {
  it('refuses a new model when the models volume has too little free space', async () => {
    const { impl, calls } = fakeFetch((url) => {
      if (url.endsWith('/api/tags')) return jsonResponse({ models: [] });
      if (url.endsWith('/api/ps')) return jsonResponse({ models: [] });
      throw new Error(`unexpected ${url}`);
    });
    const adapter = createOllamaManagementAdapter({ fetchImpl: impl, freeDiskBytes: () => 1 * GB });
    const result = await adapter.run({ name: 'ollama_pull_model', arguments: { model: 'new:7b' } }, {});
    expect(result.status).toBe('failed');
    expect(result.resultCategory).toBe('ollama_insufficient_disk');
    expect(result.output).toContain('not know');
    expect(calls.some((call) => call.url.endsWith('/api/pull'))).toBe(false);
  });

  it('refuses a known model family when its size does not fit', async () => {
    const { impl, calls } = fakeFetch((url) => {
      if (url.endsWith('/api/tags')) return jsonResponse({ models: [{ name: 'family:70b', size: 20 * GB }] });
      if (url.endsWith('/api/ps')) return jsonResponse({ models: [] });
      throw new Error(`unexpected ${url}`);
    });
    const adapter = createOllamaManagementAdapter({ fetchImpl: impl, freeDiskBytes: () => 5 * GB });
    const result = await adapter.run({ name: 'ollama_pull_model', arguments: { model: 'family:7b' } }, {});
    expect(result.status).toBe('failed');
    expect(result.resultCategory).toBe('ollama_insufficient_disk');
    expect(calls.some((call) => call.url.endsWith('/api/pull'))).toBe(false);
  });

  it('stops a new model pull as soon as the real layer size does not fit', async () => {
    const { impl, calls } = fakeFetch((url) => {
      if (url.endsWith('/api/tags')) return jsonResponse({ models: [] });
      if (url.endsWith('/api/ps')) return jsonResponse({ models: [] });
      if (url.endsWith('/api/pull')) {
        return streamResponse([
          '{"status":"pulling manifest"}',
          '{"status":"pulling layer","digest":"sha256:aaa","total":10000000000,"completed":0}',
        ]);
      }
      throw new Error(`unexpected ${url}`);
    });
    const adapter = createOllamaManagementAdapter({ fetchImpl: impl, freeDiskBytes: () => 4 * GB });
    const result = await adapter.run({ name: 'ollama_pull_model', arguments: { model: 'big:70b' } }, {});
    expect(result.status).toBe('failed');
    expect(result.resultCategory).toBe('ollama_insufficient_disk');
    expect(result.output).toContain('stopped');
    expect(calls.find((call) => call.url.endsWith('/api/pull'))?.body?.stream).toBe(true);
  });

  it('pulls a model that fits and verifies that it is installed', async () => {
    let tagCalls = 0;
    const { impl } = fakeFetch((url) => {
      if (url.endsWith('/api/tags')) {
        tagCalls += 1;
        return jsonResponse({ models: tagCalls === 1 ? [] : [{ name: 'small:1b', size: GB }] });
      }
      if (url.endsWith('/api/ps')) return jsonResponse({ models: [] });
      if (url.endsWith('/api/pull')) {
        return streamResponse([
          '{"status":"pulling layer","digest":"sha256:bbb","total":900000000,"completed":900000000}',
          '{"status":"success"}',
        ]);
      }
      throw new Error(`unexpected ${url}`);
    });
    const adapter = createOllamaManagementAdapter({ fetchImpl: impl, freeDiskBytes: () => 8 * GB });
    const result = await adapter.run({ name: 'ollama_pull_model', arguments: { model: 'small:1b' } }, {});
    expect(result.status).toBe('succeeded');
    expect(result.resultCategory).toBe('ollama_model_pulled');
    expect(result.output).toContain('small:1b');
  });

  it('measures the volume specified by OLLAMA_MODELS when set', () => {
    const original = process.env.OLLAMA_MODELS;
    try {
      process.env.OLLAMA_MODELS = process.cwd();
      const free = defaultFreeDiskBytes();
      expect(typeof free).toBe('number');
      expect(free).toBeGreaterThan(0);
    } finally {
      if (original === undefined) delete process.env.OLLAMA_MODELS;
      else process.env.OLLAMA_MODELS = original;
    }
  });
});

describe('ollama management — delete guards', () => {
  it('refuses to delete a model that is loaded in VRAM', async () => {
    const { impl, calls } = fakeFetch((url) => {
      if (url.endsWith('/api/tags')) return jsonResponse({ models: [{ name: 'busy:7b', size: 5 * GB }] });
      if (url.endsWith('/api/ps')) return jsonResponse({ models: [{ name: 'busy:7b', size_vram: 5 * GB }] });
      throw new Error(`unexpected ${url}`);
    });
    const adapter = createOllamaManagementAdapter({ fetchImpl: impl, freeDiskBytes: () => 100 * GB });
    const result = await adapter.run({ name: 'ollama_delete_model', arguments: { model: 'busy:7b', confirm: 'busy:7b' } }, {});
    expect(result.status).toBe('failed');
    expect(result.resultCategory).toBe('ollama_model_in_use');
    expect(calls.some((call) => call.method === 'DELETE')).toBe(false);
  });

  it('refuses to delete a model selected for an active Pandesh session', async () => {
    const { impl, calls } = fakeFetch((url) => {
      if (url.endsWith('/api/tags')) return jsonResponse({ models: [{ name: 'active:7b', size: 5 * GB }] });
      if (url.endsWith('/api/ps')) return jsonResponse({ models: [] });
      throw new Error(`unexpected ${url}`);
    });
    const adapter = createOllamaManagementAdapter({
      fetchImpl: impl,
      freeDiskBytes: () => 100 * GB,
      selectedModels: ['active:7b'],
    });
    const result = await adapter.run({ name: 'ollama_delete_model', arguments: { model: 'active:7b', confirm: 'active:7b' } }, {});
    expect(result.status).toBe('failed');
    expect(result.resultCategory).toBe('ollama_model_selected');
    expect(result.output).toContain('selected for an active Pandesh session');
    expect(calls.some((call) => call.method === 'DELETE')).toBe(false);
  });

  it('fails safely when Ollama reports delete but model is still listed', async () => {
    const { impl, calls } = fakeFetch((url, init) => {
      if (url.endsWith('/api/tags')) return jsonResponse({ models: [{ name: 'stubborn:7b', size: 5 * GB }] });
      if (url.endsWith('/api/ps')) return jsonResponse({ models: [] });
      if (url.endsWith('/api/delete') && init?.method === 'DELETE') return jsonResponse({ status: 'success' });
      throw new Error(`unexpected ${url}`);
    });
    const adapter = createOllamaManagementAdapter({ fetchImpl: impl, freeDiskBytes: () => 100 * GB });
    const result = await adapter.run({ name: 'ollama_delete_model', arguments: { model: 'stubborn:7b', confirm: 'stubborn:7b' } }, {});
    expect(result.status).toBe('failed');
    expect(result.resultCategory).toBe('ollama_delete_unverified');
    expect(calls.some((call) => call.method === 'DELETE')).toBe(true);
  });

  it('requires the exact model id as the second confirmation', async () => {
    const { impl, calls } = fakeFetch((url) => {
      if (url.endsWith('/api/tags')) return jsonResponse({ models: [{ name: 'idle:7b', size: 5 * GB }] });
      if (url.endsWith('/api/ps')) return jsonResponse({ models: [] });
      throw new Error(`unexpected ${url}`);
    });
    const adapter = createOllamaManagementAdapter({ fetchImpl: impl, freeDiskBytes: () => 100 * GB });
    const result = await adapter.run({ name: 'ollama_delete_model', arguments: { model: 'idle:7b', confirm: 'idle' } }, {});
    expect(result.status).toBe('failed');
    expect(result.resultCategory).toBe('ollama_delete_not_confirmed');
    expect(calls.some((call) => call.method === 'DELETE')).toBe(false);
  });
});
