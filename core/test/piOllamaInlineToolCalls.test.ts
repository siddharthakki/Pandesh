/**
 * P1 (Build 161 audit, orchestration benchmark): small models' tool calls were lost in parsing, not in reasoning.
 *
 * qwen2.5-coder:3b chose the right tool with valid arguments in 8 of 9 benchmark tasks, but wrote the call as JSON
 * text in its reply ({"name": "list_directory", "arguments": {...}}) instead of Ollama's native tool_calls. The native
 * transport passed it through as prose, so nothing ran and the user was shown raw JSON. The older executor already
 * recovered such inline calls; the Pi transport now does too — only for tools that were offered, only when the whole
 * reply is the call, and never for ordinary prose.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createPiOllamaFetch } from '../runtime/piOllamaNativeFetch';

const servers: http.Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(() => r(undefined))))); });

/** A fake Ollama that streams `content` in small pieces, like a model writing it token by token. */
async function replying(content: string): Promise<string> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    for (let i = 0; i < content.length; i += 7) res.write(`${JSON.stringify({ message: { role: 'assistant', content: content.slice(i, i + 7) }, done: false })}\n`);
    res.end(`${JSON.stringify({ message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', eval_count: 9 })}\n`);
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const tools = [
  { type: 'function', function: { name: 'list_directory', description: 'List a folder', parameters: { type: 'object', properties: { dirPath: { type: 'string' } } } } },
  { type: 'function', function: { name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { filePath: { type: 'string' } }, required: ['filePath'] } } },
];

async function run(content: string, withTools = true) {
  const pf = createPiOllamaFetch({ baseUrl: await replying(content), numCtx: () => 8192, think: false });
  const res = await pf('http://x/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'qwen2.5-coder:3b', messages: [{ role: 'user', content: 'go' }], ...(withTools ? { tools } : {}), stream: true }) });
  const text = await res.text();
  const chunks = text.split('\n\n').filter((l) => l.startsWith('data: {')).map((l) => JSON.parse(l.slice(6)));
  const deltas = chunks.map((c) => c.choices[0].delta);
  return {
    content: deltas.map((d) => d.content ?? '').join(''),
    calls: deltas.flatMap((d) => d.tool_calls ?? []).map((c: { function: { name: string; arguments: string } }) => ({ name: c.function.name, args: JSON.parse(c.function.arguments) })),
    finish: chunks.map((c) => c.choices[0].finish_reason).filter(Boolean).pop(),
  };
}

describe('inline tool calls on the native Ollama transport', () => {
  it('turns a reply that is a tool call written as JSON into a real tool call', async () => {
    const out = await run('{"name": "list_directory", "arguments": {"dirPath": "C:\\\\work"}}');
    expect(out.calls).toEqual([{ name: 'list_directory', args: { dirPath: 'C:\\work' } }]);
    expect(out.content).toBe('');
    expect(out.finish).toBe('tool_calls');
  });

  it('also inside a ```json fence', async () => {
    const out = await run('```json\n{ "name": "read_file", "arguments": { "filePath": "notes.md" } }\n```');
    expect(out.calls).toEqual([{ name: 'read_file', args: { filePath: 'notes.md' } }]);
  });

  it('leaves prose, JSON that names no offered tool, and replies without offered tools untouched', async () => {
    expect((await run('The folder has four files.')).calls).toEqual([]);
    expect((await run('The folder has four files.')).content).toBe('The folder has four files.');
    const json = '{"name": "Café Lumen", "city": "Bonn"}';
    expect(await run(json)).toMatchObject({ calls: [], content: json });
    const noTools = '{"name": "list_directory", "arguments": {}}';
    expect(await run(noTools, false)).toMatchObject({ calls: [], content: noTools });
  });
});
