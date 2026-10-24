import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as http from 'http';
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

/** Minimal local HTTP server that streams pre-canned NDJSON chunks for /api/chat. */
class NdjsonServer {
  private server?: http.Server;
  private status = 200;
  private chunks: string[] = [];

  respond(status: number, chunks: string[]): void {
    this.status = status;
    this.chunks = chunks;
  }

  async start(): Promise<string> {
    this.server = http.createServer((_req, res) => {
      res.writeHead(this.status, { 'content-type': 'application/x-ndjson' });
      for (const chunk of this.chunks) {
        res.write(chunk);
      }
      res.end();
    });
    await new Promise<void>((resolve) => this.server?.listen(0, '127.0.0.1', resolve));
    const address = this.server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to bind NDJSON test server.');
    }
    return `http://127.0.0.1:${address.port}`;
  }

  async stop(): Promise<void> {
    if (!this.server) { return; }
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }
}

async function collectEvents(chunks: string[], tools: ToolDefinition[] = []): Promise<StreamEvent[]> {
  const server = new NdjsonServer();
  server.respond(200, chunks);
  const baseUrl = await server.start();
  const provider = new OllamaProvider(baseUrl);
  try {
    const events: StreamEvent[] = [];
    for await (const e of provider.chatStream([{ role: 'user', content: 'hi' }], tools, CHAT_OPTIONS)) {
      events.push(e);
    }
    return events;
  } finally {
    await provider.dispose();
    await server.stop();
  }
}

describe('OllamaProvider — NDJSON streaming', () => {
  let provider: OllamaProvider;

  beforeEach(() => {
    provider = new OllamaProvider('http://localhost:11434');
  });

  afterEach(async () => {
    await provider.dispose();
  });

  it('emits token events and a final done event for simple text', async () => {
    const events = await collectEvents([
      '{"message":{"role":"assistant","content":"He"},"done":false}\n',
      '{"message":{"role":"assistant","content":"llo"},"done":false}\n',
      '{"message":{"role":"assistant","content":""},"done":true}\n',
    ]);
    const tokens = events.filter((e) => e.type === 'token').map((e) => (e as { delta: string }).delta);
    expect(tokens).toEqual(['He', 'llo']);
    const done = events.find((e) => e.type === 'done');
    expect(done).toBeDefined();
    expect((done as { content: string }).content).toBe('Hello');
  });

  it('handles NDJSON record split across two network chunks', async () => {
    const line = '{"message":{"role":"assistant","content":"Hi"},"done":false}\n';
    const mid = Math.floor(line.length / 2);
    const events = await collectEvents([
      line.slice(0, mid),
      line.slice(mid) + '{"message":{"role":"assistant","content":""},"done":true}\n',
    ]);
    const tokens = events.filter((e) => e.type === 'token');
    expect(tokens).toHaveLength(1);
    expect((tokens[0] as { delta: string }).delta).toBe('Hi');
  });

  it('flushes a final partial NDJSON record that was buffered', async () => {
    // The last line has no trailing newline, so it ends up in the tail buffer
    const events = await collectEvents([
      '{"message":{"role":"assistant","content":"tail"},"done":true}',
    ]);
    const tokens = events.filter((e) => e.type === 'token');
    expect(tokens).toHaveLength(1);
    expect((tokens[0] as { delta: string }).delta).toBe('tail');
  });

  it('accumulated content in done event equals sum of token deltas', async () => {
    const events = await collectEvents([
      '{"message":{"role":"assistant","content":"foo"},"done":false}\n',
      '{"message":{"role":"assistant","content":"bar"},"done":false}\n',
      '{"message":{"role":"assistant","content":""},"done":true}\n',
    ]);
    const tokenContent = events
      .filter((e) => e.type === 'token')
      .map((e) => (e as { delta: string }).delta)
      .join('');
    const done = events.find((e) => e.type === 'done') as { content: string } | undefined;
    expect(done?.content).toBe(tokenContent);
  });

  it('emits tool_call events from streaming tool_calls field', async () => {
    const events = await collectEvents(
      [
        JSON.stringify({
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [{ function: { name: 'read_file', arguments: { path: '/tmp/x' } } }],
          },
          done: true,
        }) + '\n',
      ],
      [READ_FILE_DEF],
    );
    const toolEvents = events.filter((e) => e.type === 'tool_call');
    expect(toolEvents).toHaveLength(1);
    const tc = toolEvents[0] as { toolCall: { function: { name: string } } };
    expect(tc.toolCall.function.name).toBe('read_file');
  });

  it('stream error causes chatStream to throw', async () => {
    const server = new NdjsonServer();
    server.respond(500, ['boom']);
    const baseUrl = await server.start();
    const errorProvider = new OllamaProvider(baseUrl);
    try {
      const gen = errorProvider.chatStream([{ role: 'user', content: 'hi' }], [], CHAT_OPTIONS);
      await expect(async () => {
        for await (const _ of gen) { /* consume */ }
      }).rejects.toThrow();
    } finally {
      await errorProvider.dispose();
      await server.stop();
    }
  });
});
