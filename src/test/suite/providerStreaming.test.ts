import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as http from 'http';
import { OpenAICompatibleProvider } from '../../providers/OpenAICompatibleProvider';
import { OllamaProvider } from '../../providers/OllamaProvider';
import type { StreamEvent } from '../../providers/ProviderTypes';
import type { ToolDefinition } from '../../tools/ToolTypes';

const READ_FILE_DEF: ToolDefinition = {
  type: 'function',
  function: {
    name: 'read_file',
    description: 'Read a file',
    parameters: { type: 'object', properties: { path: { type: 'string' } } },
  },
};

const CHAT_OPTIONS = {
  model: 'test-model',
  contextWindow: 4096,
  maxOutputTokens: 0,
  temperature: 0,
  timeoutMs: 30_000,
};

// ---------------------------------------------------------------------------
// SSE stream helpers for OpenAI-compatible provider
// ---------------------------------------------------------------------------

function sseStream(lines: string[]): Response {
  let idx = 0;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (idx < lines.length) {
        controller.enqueue(encoder.encode(lines[idx++] + '\n'));
      } else {
        controller.close();
      }
    },
  });
  return new Response(stream, { status: 200 });
}

function sseChunk(delta: Record<string, unknown>, finishReason?: string): string {
  return `data: ${JSON.stringify({
    choices: [{ delta, finish_reason: finishReason ?? null }],
  })}`;
}

async function collectOAIStream(
  provider: OpenAICompatibleProvider,
  sseLines: string[],
  tools: ToolDefinition[] = [],
): Promise<StreamEvent[]> {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseStream(sseLines)));
  const events: StreamEvent[] = [];
  for await (const e of provider.chatStream([{ role: 'user', content: 'hi' }], tools, CHAT_OPTIONS)) {
    events.push(e);
  }
  return events;
}

// ---------------------------------------------------------------------------
// NDJSON stream helpers for Ollama provider
// ---------------------------------------------------------------------------

/**
 * Ollama chatStream now uses direct undici.request, not fetch, so it cannot
 * be exercised via vi.stubGlobal('fetch', ...). Spin up a real local HTTP
 * server that streams the given NDJSON chunks instead.
 */
async function collectOllamaStream(
  _provider: OllamaProvider,
  chunks: string[],
  tools: ToolDefinition[] = [],
): Promise<StreamEvent[]> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    for (const chunk of chunks) { res.write(chunk); }
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to bind Ollama stream test server.');
  }
  const liveProvider = new OllamaProvider(`http://127.0.0.1:${address.port}`);
  try {
    const events: StreamEvent[] = [];
    for await (const e of liveProvider.chatStream!([{ role: 'user', content: 'hi' }], tools, CHAT_OPTIONS)) {
      events.push(e);
    }
    return events;
  } finally {
    await liveProvider.dispose();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

// ---------------------------------------------------------------------------
// OpenAI-compatible provider — streaming
// ---------------------------------------------------------------------------

describe('OpenAICompatibleProvider — chatStream SSE', () => {
  let provider: OpenAICompatibleProvider;

  beforeEach(() => {
    provider = new OpenAICompatibleProvider('http://localhost:1234', '');
  });
  afterEach(() => vi.unstubAllGlobals());

  it('emits token events from SSE content deltas', async () => {
    const events = await collectOAIStream(provider, [
      sseChunk({ content: 'Hello' }),
      sseChunk({ content: ' world' }),
      sseChunk({}, 'stop'),
      'data: [DONE]',
    ]);
    const tokens = events.filter((e) => e.type === 'token').map((e) => (e as { delta: string }).delta);
    expect(tokens).toEqual(['Hello', ' world']);
    const done = events.find((e) => e.type === 'done');
    expect((done as { content: string })?.content).toBe('Hello world');
  });

  it('accumulated done content equals joined token deltas', async () => {
    const events = await collectOAIStream(provider, [
      sseChunk({ content: 'foo' }),
      sseChunk({ content: 'bar' }),
      'data: [DONE]',
    ]);
    const tokenSum = events.filter((e) => e.type === 'token').map((e) => (e as { delta: string }).delta).join('');
    const done = events.find((e) => e.type === 'done') as { content: string } | undefined;
    expect(done?.content).toBe(tokenSum);
  });

  it('accumulates streaming tool call fragments into one tool_call event', async () => {
    const events = await collectOAIStream(
      provider,
      [
        sseChunk({ tool_calls: [{ index: 0, id: 'call_abc', type: 'function', function: { name: 'read_file', arguments: '' } }] }),
        sseChunk({ tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] }),
        sseChunk({ tool_calls: [{ index: 0, function: { arguments: '"/tmp/x"}' } }] }),
        sseChunk({}, 'tool_calls'),
        'data: [DONE]',
      ],
      [READ_FILE_DEF],
    );
    const toolEvents = events.filter((e) => e.type === 'tool_call');
    expect(toolEvents).toHaveLength(1);
    const tc = toolEvents[0] as { toolCall: { id?: string; function: { name: string; arguments: Record<string, unknown> } } };
    expect(tc.toolCall.function.name).toBe('read_file');
    expect(tc.toolCall.function.arguments).toEqual({ path: '/tmp/x' });
    expect(tc.toolCall.id).toBe('call_abc');
  });

  it('tool call ID from first fragment survives accumulation', async () => {
    const events = await collectOAIStream(provider, [
      sseChunk({ tool_calls: [{ index: 0, id: 'call_xyz', function: { name: 'read_file', arguments: '{}' } }] }),
      'data: [DONE]',
    ], [READ_FILE_DEF]);
    const tc = events.find((e) => e.type === 'tool_call') as { toolCall: { id?: string } } | undefined;
    expect(tc?.toolCall.id).toBe('call_xyz');
  });

  it('stream error (HTTP 500) causes chatStream to throw', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 500 })));
    await expect(async () => {
      for await (const _ of provider.chatStream([{ role: 'user', content: 'hi' }], [], CHAT_OPTIONS)) { /* consume */ }
    }).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Streaming parity — both Ollama and OpenAI-compatible emit the same event shapes
// ---------------------------------------------------------------------------

describe('Streaming parity — Ollama vs OpenAI-compatible', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('Ollama streaming emits token + done events (parity baseline)', async () => {
    const ollama = new OllamaProvider('http://localhost:11434');
    const events = await collectOllamaStream(ollama, [
      '{"message":{"content":"Hi"},"done":false}\n',
      '{"message":{"content":""},"done":true}\n',
    ]);
    expect(events.some((e) => e.type === 'token')).toBe(true);
    expect(events.some((e) => e.type === 'done')).toBe(true);
  });

  it('OpenAI-compatible streaming emits token + done events (parity)', async () => {
    const oai = new OpenAICompatibleProvider('http://localhost:1234', '');
    const events = await collectOAIStream(oai, [
      sseChunk({ content: 'Hi' }),
      'data: [DONE]',
    ]);
    expect(events.some((e) => e.type === 'token')).toBe(true);
    expect(events.some((e) => e.type === 'done')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Provider health checks and model discovery
// ---------------------------------------------------------------------------

describe('OllamaProvider — health check and model discovery', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('healthCheck resolves when /api/tags returns 200', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));
    const p = new OllamaProvider('http://localhost:11434');
    await expect(p.healthCheck()).resolves.toBeUndefined();
  });

  it('healthCheck throws ProviderApiError on non-200', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 503 })));
    const p = new OllamaProvider('http://localhost:11434');
    await expect(p.healthCheck()).rejects.toThrow();
  });

  it('listModels returns parsed model names', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ models: [{ name: 'qwen3-coder:30b', modified_at: '2025-01-01' }] }), { status: 200 }),
    ));
    const p = new OllamaProvider('http://localhost:11434');
    const models = await p.listModels();
    expect(models).toHaveLength(1);
    expect(models[0].name).toBe('qwen3-coder:30b');
  });
});

describe('OpenAICompatibleProvider — health check and model discovery', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('healthCheck resolves when /v1/models returns 200', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));
    const p = new OpenAICompatibleProvider('http://localhost:1234', '');
    await expect(p.healthCheck()).resolves.toBeUndefined();
  });

  it('healthCheck throws ProviderAuthError on 401', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 401 })));
    const p = new OpenAICompatibleProvider('http://localhost:1234', 'bad-key');
    const { ProviderAuthError } = await import('../../providers/ProviderTypes');
    await expect(p.healthCheck()).rejects.toThrow(ProviderAuthError);
  });

  it('listModels returns parsed model ids', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: 'lmstudio-model', object: 'model' }] }), { status: 200 }),
    ));
    const p = new OpenAICompatibleProvider('http://localhost:1234', '');
    const models = await p.listModels();
    expect(models[0].name).toBe('lmstudio-model');
  });

  // Regression coverage for a real dogfood bug: a configured base URL that
  // already ends in /v1 (OpenAI convention, e.g. OrcaRouter's
  // https://api.orcarouter.ai/v1) was probed at `${baseUrl}/v1/models`,
  // double-appending /v1 and yielding a false 404 against a provider that
  // was in fact reachable and correctly authenticated.
  it('healthCheck probes {base}/models (not {base}/v1/models) when the base URL already ends in /v1', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    const p = new OpenAICompatibleProvider('https://api.orcarouter.ai/v1', 'sk-test');
    await expect(p.healthCheck()).resolves.toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://api.orcarouter.ai/v1/models',
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer sk-test' }) }),
    );
  });

  it('healthCheck still probes {base}/v1/models when the base URL is a bare host root', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    const p = new OpenAICompatibleProvider('http://localhost:1234', '');
    await expect(p.healthCheck()).resolves.toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledWith('http://localhost:1234/v1/models', expect.anything());
  });

  // The same double-/v1 defect existed identically in listModels(), chat(), and
  // chatStream() — all four call sites appended `/v1/...` unconditionally. All
  // four now go through the single OpenAICompatibleProvider.apiUrl() helper, so
  // this asserts the fix generalizes past healthCheck() rather than being
  // healthCheck-only.
  it('listModels resolves {base}/models (not {base}/v1/models) when the base URL already ends in /v1', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: 'orca-model', object: 'model' }] }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchSpy);
    const p = new OpenAICompatibleProvider('https://api.orcarouter.ai/v1', 'sk-test');
    const models = await p.listModels();
    expect(models[0].name).toBe('orca-model');
    expect(fetchSpy).toHaveBeenCalledWith('https://api.orcarouter.ai/v1/models', expect.anything());
  });

  it('chat resolves {base}/chat/completions (not {base}/v1/chat/completions) when the base URL already ends in /v1', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }] }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchSpy);
    const p = new OpenAICompatibleProvider('https://api.orcarouter.ai/v1', 'sk-test');
    await p.chat([{ role: 'user', content: 'hi' }], [], {
      model: 'qwen/qwen3.8-flash', contextWindow: 8192, maxOutputTokens: 256, temperature: 0, timeoutMs: 5_000,
    });
    expect(fetchSpy).toHaveBeenCalledWith('https://api.orcarouter.ai/v1/chat/completions', expect.anything());
  });

  it('chatStream resolves {base}/chat/completions (not {base}/v1/chat/completions) when the base URL already ends in /v1', async () => {
    const sse = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n';
    const fetchSpy = vi.fn().mockResolvedValue(new Response(sse, { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    const p = new OpenAICompatibleProvider('https://api.orcarouter.ai/v1', 'sk-test');
    const events = [];
    for await (const event of p.chatStream([{ role: 'user', content: 'hi' }], [], {
      model: 'qwen/qwen3.8-flash', contextWindow: 8192, maxOutputTokens: 256, temperature: 0, timeoutMs: 5_000,
    })) {
      events.push(event);
    }
    expect(events.some(e => e.type === 'done')).toBe(true);
    expect(fetchSpy).toHaveBeenCalledWith('https://api.orcarouter.ai/v1/chat/completions', expect.anything());
  });

  it('healthCheck reports a truthful incompatible-endpoint error on a genuine 404, without spending a generation call', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response('not found', { status: 404 }));
    vi.stubGlobal('fetch', fetchSpy);
    const p = new OpenAICompatibleProvider('https://not-openai-compatible.example.invalid', 'sk-test');
    await expect(p.healthCheck()).rejects.toMatchObject({ name: 'ProviderApiError', statusCode: 404 });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
