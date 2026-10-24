import { afterEach, describe, expect, it, vi } from 'vitest';
import * as http from 'http';
import { buildCodingProposalJsonSchema } from '../../coding/CodingProposal';
import { OllamaProvider } from '../../providers/OllamaProvider';
import { OpenAICompatibleProvider } from '../../providers/OpenAICompatibleProvider';
import { ProviderChatOptions } from '../../providers/ProviderTypes';

const baseOptions: ProviderChatOptions = {
  model: 'qwen3-coder:30b',
  contextWindow: 8192,
  maxOutputTokens: 0,
  temperature: 0,
  timeoutMs: 30_000,
};

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
      res.end(JSON.stringify({ message: { role: 'assistant', content: '{}' }, done: true }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to bind structured-output test server.');
  }
  try {
    await run(`http://127.0.0.1:${address.port}`, bodies);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  return bodies;
}

describe('provider structured output transport', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends the canonical schema to Ollama format only when requested', async () => {
    const schema = buildCodingProposalJsonSchema();
    const bodies = await withOllamaCaptureServer(async (baseUrl) => {
      const provider = new OllamaProvider(baseUrl);
      try {
        await provider.chat([{ role: 'user', content: 'plan' }], [], {
          ...baseOptions,
          responseFormat: { type: 'json_schema', name: 'forge_coding_proposal', schema },
        });
        await provider.chat([{ role: 'user', content: 'chat' }], [], baseOptions);
      } finally {
        await provider.dispose();
      }
    });

    expect(bodies).toHaveLength(2);
    expect(bodies[0].format).toEqual(schema);
    expect(bodies[1].format).toBeUndefined();
  });

  it('maps JSON Schema constraints for OpenAI-compatible chat completions', async () => {
    let body: Record<string, unknown> | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '{}' }, finish_reason: 'stop' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }));

    const schema = buildCodingProposalJsonSchema();
    await new OpenAICompatibleProvider('http://localhost:1234', '').chat([{ role: 'user', content: 'plan' }], [], {
      ...baseOptions,
      responseFormat: { type: 'json_schema', name: 'forge_coding_proposal', schema },
    });

    expect(body?.response_format).toEqual({
      type: 'json_schema',
      json_schema: { name: 'forge_coding_proposal', strict: true, schema },
    });
  });

  it('keeps cancellation functional without leaking raw response text', async () => {
    const server = http.createServer((_req, _res) => {
      // Never respond — the client-side AbortController must cancel this.
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to bind cancellation test server.');
    }
    const provider = new OllamaProvider(`http://127.0.0.1:${address.port}`);
    try {
      const controller = new AbortController();
      const promise = provider.chat([{ role: 'user', content: 'plan' }], [], baseOptions, controller.signal);
      // Give undici a moment to establish the connection before aborting.
      await new Promise((resolve) => setTimeout(resolve, 20));
      controller.abort();
      await expect(promise).rejects.toThrow('Request was cancelled.');
    } finally {
      await provider.dispose();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
