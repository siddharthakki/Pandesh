import { afterEach, describe, expect, it, vi } from 'vitest';
import * as http from 'http';
import { OllamaProvider } from '../../providers/OllamaProvider';
import { OpenAICompatibleProvider } from '../../providers/OpenAICompatibleProvider';
import { ProviderChatOptions } from '../../providers/ProviderTypes';

/**
 * Ollama chat() now uses direct undici.request, not fetch, so request bodies
 * must be captured via a real local HTTP server rather than stubbing fetch.
 */
async function withOllamaCaptureServer(
  run: (baseUrl: string, bodies: Array<Record<string, unknown>>) => Promise<void>,
): Promise<Array<Record<string, unknown>>> {
  const bodies: Array<Record<string, unknown>> = [];
  const server = http.createServer((req, res) => {
    // Only /api/chat is under test; anything else (the provider's /api/ps residency lookup) is a plain 404.
    if (req.url !== '/api/chat') {
      res.writeHead(404);
      res.end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      bodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: { role: 'assistant', content: 'ok' }, done: true }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to bind Ollama capture test server.');
  }
  try {
    await run(`http://127.0.0.1:${address.port}`, bodies);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  return bodies;
}

function captureOpenAI(bodies: Array<Record<string, unknown>>): void {
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }), { status: 200 });
  }));
}

const options: ProviderChatOptions = {
  model: 'qwen2.5vl:7b',
  contextWindow: 16384,
  maxOutputTokens: 2048,
  temperature: 0,
  timeoutMs: 30_000,
};

describe('M11 provider request bodies match the preflight-approved options exactly', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('Ollama sends num_ctx exactly as approved — even for image requests — and num_predict equal to the reserve', async () => {
    const bodies = await withOllamaCaptureServer(async (baseUrl) => {
      const provider = new OllamaProvider(baseUrl);
      try {
        await provider.chat([{ role: 'user', content: 'describe', images: ['aGk='] }], [], options);
        await provider.chat([{ role: 'user', content: 'describe' }], [], { ...options, contextWindow: 4096 });
      } finally {
        await provider.dispose();
      }
    });

    const withImages = bodies[0]['options'] as Record<string, unknown>;
    expect(withImages['num_ctx']).toBe(16384);
    expect(withImages['num_predict']).toBe(2048);
    // No hidden provider-side minimum: a smaller approved window is sent verbatim.
    const smallWindow = bodies[1]['options'] as Record<string, unknown>;
    expect(smallWindow['num_ctx']).toBe(4096);
  });

  it('Ollama sends an explicit temperature of 0 verbatim', async () => {
    const bodies = await withOllamaCaptureServer(async (baseUrl) => {
      const provider = new OllamaProvider(baseUrl);
      try {
        await provider.chat([{ role: 'user', content: 'hi' }], [], options);
      } finally {
        await provider.dispose();
      }
    });
    expect((bodies[0]['options'] as Record<string, unknown>)['temperature']).toBe(0);
  });

  it('OpenAI-compatible sends max_tokens equal to the reserved output allowance', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    captureOpenAI(bodies);
    await new OpenAICompatibleProvider('http://localhost:1234', '').chat([{ role: 'user', content: 'hi' }], [], options);
    expect(bodies[0]['max_tokens']).toBe(2048);
    expect(bodies[0]['response_format']).toBeUndefined();
  });
});
