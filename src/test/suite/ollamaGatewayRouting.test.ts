import { afterEach, describe, expect, it, vi } from 'vitest';
import * as http from 'http';
import * as vscodeMock from '../mocks/vscode';
import { ProviderGateway } from '../../providers/ProviderGateway';
import { ToolDefinition } from '../../tools/ToolTypes';

const tool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'read_file',
    description: 'Read a workspace file',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
      },
      required: ['path'],
    },
  },
};

const options = {
  model: 'qwen3-coder:30b',
  contextWindow: 8192,
  maxOutputTokens: 0,
  temperature: 0.2,
  timeoutMs: 300_000,
};

const secrets = {
  get: async () => undefined,
  store: async () => undefined,
  delete: async () => undefined,
  onDidChange: () => ({ dispose: () => undefined }),
};

describe('Ollama gateway tool-call routing', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vscodeMock._resetConfig();
  });

  it('uses a complete non-streaming response when tools are exposed', async () => {
    // OllamaProvider.chat now uses direct undici.request, not fetch, so the
    // /api/chat call must be served by a real local HTTP server rather than
    // a fetch stub.
    let requestBody: Record<string, unknown> | undefined;
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        requestBody = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          model: 'qwen3-coder:30b',
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [{
              id: 'call-read',
              function: {
                index: 0,
                name: 'read_file',
                arguments: { path: 'package.json' },
              },
            }],
          },
          done: true,
        }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to bind gateway routing test server.');
    }
    vscodeMock._setConfig('ollama-agent.apiBase', `http://127.0.0.1:${address.port}`);

    try {
      const provider = await ProviderGateway.create(secrets as never);
      const events = [];
      for await (const event of provider.chatStream!(
        [{ role: 'user', content: 'Read package.json' }],
        [tool],
        options,
      )) {
        events.push(event);
      }

      expect(requestBody?.['stream']).toBe(false);
      expect(events).toEqual([
        {
          type: 'tool_call',
          index: 0,
          toolCall: {
            function: {
              name: 'read_file',
              arguments: { path: 'package.json' },
            },
          },
        },
        { type: 'done', content: '' },
      ]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
