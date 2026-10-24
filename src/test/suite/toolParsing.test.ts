import { describe, it, expect } from 'vitest';
import * as http from 'http';
import { OllamaProvider } from '../../providers/OllamaProvider';
import type { ChatMessage, ChatResponse, ToolDefinition } from '../../tools/ToolTypes';

const TOOL_DEF: ToolDefinition = {
  type: 'function',
  function: {
    name: 'read_file',
    description: 'Read a file',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
};

const CHAT_OPTIONS = {
  model: 'test-model',
  contextWindow: 4096,
  maxOutputTokens: 0,
  temperature: 0,
  timeoutMs: 30_000,
};

/** Starts a one-shot local HTTP server that returns `body` for any /api/chat POST. */
async function chatWithResponse(
  body: unknown,
  messages: ChatMessage[],
  tools: ToolDefinition[],
  status = 200,
): Promise<ChatResponse> {
  const server = http.createServer((_req, res) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to bind tool-parsing test server.');
  }
  const provider = new OllamaProvider(`http://127.0.0.1:${address.port}`);
  try {
    return await provider.chat(messages, tools, CHAT_OPTIONS);
  } finally {
    await provider.dispose();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('OllamaProvider — tool call parsing', () => {
  it('returns text response when model returns content only', async () => {
    const resp = await chatWithResponse(
      { message: { role: 'assistant', content: 'Hello world' }, done: true },
      [{ role: 'user', content: 'hi' }],
      [],
    );
    expect(resp.message.content).toBe('Hello world');
    expect(resp.message.tool_calls).toBeUndefined();
  });

  it('parses native tool calls from tool_calls field', async () => {
    const resp = await chatWithResponse(
      {
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{ function: { name: 'read_file', arguments: { path: '/tmp/test' } } }],
        },
        done: true,
      },
      [{ role: 'user', content: 'read it' }],
      [TOOL_DEF],
    );
    expect(resp.message.tool_calls).toHaveLength(1);
    expect(resp.message.tool_calls![0].function.name).toBe('read_file');
  });

  it('extracts tool call from JSON-in-content when tool_calls is absent', async () => {
    const resp = await chatWithResponse(
      {
        message: {
          role: 'assistant',
          content: '{"name":"read_file","arguments":{"path":"/tmp/test"}}',
        },
        done: true,
      },
      [{ role: 'user', content: 'read it' }],
      [TOOL_DEF],
    );
    expect(resp.message.tool_calls).toHaveLength(1);
    expect(resp.message.tool_calls![0].function.name).toBe('read_file');
  });

  it('does not extract unknown tool names from JSON-in-content', async () => {
    const resp = await chatWithResponse(
      {
        message: {
          role: 'assistant',
          content: '{"name":"dangerous_unknown_tool","arguments":{}}',
        },
        done: true,
      },
      [{ role: 'user', content: 'do it' }],
      [TOOL_DEF],
    );
    // unknown name not in validNames — must not produce a tool_call
    expect(resp.message.tool_calls).toBeUndefined();
    expect(resp.message.content).toContain('dangerous_unknown_tool');
  });

  it('handles malformed JSON in content without throwing', async () => {
    const resp = await chatWithResponse(
      { message: { role: 'assistant', content: '{ this is not valid JSON }}' }, done: true },
      [{ role: 'user', content: 'hi' }],
      [TOOL_DEF],
    );
    expect(resp.message.tool_calls).toBeUndefined();
    expect(resp.message.content).toBeTruthy();
  });

  it('normalises string-encoded arguments object', async () => {
    const resp = await chatWithResponse(
      {
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{
            function: {
              name: 'read_file',
              arguments: '{"path":"/tmp/encoded"}',
            },
          }],
        },
        done: true,
      },
      [{ role: 'user', content: 'read' }],
      [TOOL_DEF],
    );
    expect(resp.message.tool_calls).toHaveLength(1);
    expect(resp.message.tool_calls![0].function.arguments).toEqual({ path: '/tmp/encoded' });
  });

  it('tool call arguments that are not an object normalise to empty object', async () => {
    const resp = await chatWithResponse(
      {
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{ function: { name: 'read_file', arguments: ['not', 'an', 'object'] } }],
        },
        done: true,
      },
      [{ role: 'user', content: 'read' }],
      [TOOL_DEF],
    );
    expect(resp.message.tool_calls).toHaveLength(1);
    expect(resp.message.tool_calls![0].function.arguments).toEqual({});
  });
});
