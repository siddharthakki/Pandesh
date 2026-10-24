import { afterEach, describe, expect, it } from 'vitest';
import * as http from 'node:http';
import { OllamaModelBackend } from '../runtime/modelBackend';
import { adoptLoadedContext, ensureModelResident, resolveKeepAlive } from '../runtime/ollamaResidency';

let server: http.Server | undefined;
afterEach(() => { server?.close(); server = undefined; delete process.env.KARKEDIKHA_OLLAMA_KEEP_ALIVE; });

async function fakeOllama(loadedContext?: number) {
  const chatBodies: any[] = [];
  const generateBodies: any[] = [];
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      if (req.url === '/api/ps') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ models: loadedContext ? [{ name: 'm1', context_length: loadedContext }] : [] }));
      } else if (req.url === '/api/generate') {
        generateBodies.push(JSON.parse(raw));
        res.end('{"done":true}');
      } else {
        chatBodies.push(JSON.parse(raw));
        res.setHeader('content-type', 'application/x-ndjson');
        res.write(JSON.stringify({ message: { role: 'assistant', content: 'ok' }, done: false }) + '\n');
        res.end(JSON.stringify({ message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', eval_count: 1 }) + '\n');
      }
    });
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server!.address() as { port: number }).port}`, chatBodies, generateBodies };
}

describe('Ollama residency', () => {
  it('resolves a positive keep-alive and never zero', () => {
    expect(resolveKeepAlive(undefined)).toBe('30m');
    expect(resolveKeepAlive('2h')).toBe('2h');
    expect(resolveKeepAlive('90')).toBe('90s');
    expect(resolveKeepAlive('0')).toBe('30m');
    expect(resolveKeepAlive('0s')).toBe('30m');
    expect(resolveKeepAlive('-1')).toBe('30m');
    expect(resolveKeepAlive('soon')).toBe('30m');
  });

  it('adopts the loaded window only when it already covers the request', () => {
    expect(adoptLoadedContext(undefined, 4096, undefined)).toBeUndefined();
    expect(adoptLoadedContext(8192, 4096, 65536)).toBe(65536);
    expect(adoptLoadedContext(undefined, 4096, 8192)).toBe(8192);
    expect(adoptLoadedContext(16384, 4096, 8192)).toBe(16384);
    expect(adoptLoadedContext(8192, 4096, 65536, 32768)).toBe(8192);
  });

  it('the native chat payload carries keep_alive and reuses the loaded num_ctx', async () => {
    const fake = await fakeOllama(65536);
    const backend = new OllamaModelBackend(fake.url);
    await backend.streamChat({ model: 'm1', messages: [{ role: 'user', content: 'hi' }] }, () => {});
    expect(fake.chatBodies[0].keep_alive).toBe('30m');
    expect(fake.chatBodies[0].options?.num_ctx).toBe(65536);
  });

  it('keeps its own sizing when nothing is loaded', async () => {
    const fake = await fakeOllama();
    process.env.KARKEDIKHA_OLLAMA_KEEP_ALIVE = '45m';
    await new OllamaModelBackend(fake.url).streamChat({ model: 'm1', messages: [{ role: 'user', content: 'hi' }] }, () => {});
    expect(fake.chatBodies[0].keep_alive).toBe('45m');
    expect(fake.chatBodies[0].options).toBeUndefined();
  });

  it('preload is a prompt-less native generate with a positive keep_alive', async () => {
    const fake = await fakeOllama();
    const result = await ensureModelResident('m1', { baseUrl: `${fake.url}/v1` });
    expect(result.ok).toBe(true);
    expect(fake.generateBodies).toEqual([{ model: 'm1', keep_alive: '30m' }]);
  });
});
