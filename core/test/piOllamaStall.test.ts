/**
 * P1 (Build 161 audit): a model call that stops producing output must end the turn with a clear reason.
 *
 * The native Ollama transport disabled every undici timer ("AbortSignal owns attempt deadlines"), but a chat turn's
 * signal is aborted only by the user's Stop. An Ollama that accepted a request and then hung kept the turn — and an
 * unattended scheduled model run — waiting forever.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createPiOllamaFetch } from '../runtime/piOllamaNativeFetch';

const servers: http.Server[] = [];
const sockets = new Set<import('node:net').Socket>();
afterEach(async () => {
  for (const s of sockets) s.destroy();
  sockets.clear();
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(() => r(undefined)))));
});

async function fakeOllama(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<string> {
  const server = http.createServer(handler);
  server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const request = { model: 'gemma4:12b', messages: [{ role: 'user', content: 'hi' }], stream: true };

async function readAll(res: Response): Promise<string> {
  const reader = res.body!.getReader();
  let out = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return out;
    out += new TextDecoder().decode(value);
  }
}

describe('model stall watchdog', () => {
  it('fails a call that never produces any output, with a reason that says so', async () => {
    const baseUrl = await fakeOllama(() => { /* accepts, never answers */ });
    const metrics: Array<{ status: string; error?: string }> = [];
    const pf = createPiOllamaFetch({ baseUrl, numCtx: () => 8192, think: false, onMetrics: (m) => metrics.push(m), firstOutputTimeoutMs: 400, idleTimeoutMs: 400 });
    const started = Date.now();
    await expect(pf('http://ignored/v1/chat/completions', { method: 'POST', body: JSON.stringify(request) })).rejects.toThrow(/no output from Ollama/i);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(metrics[0]?.status).toBe('error');
  }, 15_000);

  it('fails a reply that stops in the middle, instead of waiting forever', async () => {
    const baseUrl = await fakeOllama((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.write(`${JSON.stringify({ message: { role: 'assistant', content: 'Hel' }, done: false })}\n`);
      // …and then nothing more, connection kept open.
    });
    const pf = createPiOllamaFetch({ baseUrl, numCtx: () => 8192, think: false, firstOutputTimeoutMs: 2_000, idleTimeoutMs: 400 });
    const res = await pf('http://ignored/v1/chat/completions', { method: 'POST', body: JSON.stringify(request) });
    const started = Date.now();
    await expect(readAll(res)).rejects.toThrow(/no output from Ollama/i);
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 15_000);

  it('a reply that keeps streaming is never cut off', async () => {
    const baseUrl = await fakeOllama((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      let i = 0;
      const timer = setInterval(() => {
        i += 1;
        if (i <= 6) res.write(`${JSON.stringify({ message: { role: 'assistant', content: `t${i} ` }, done: false })}\n`);
        else { clearInterval(timer); res.end(`${JSON.stringify({ message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', eval_count: 6 })}\n`); }
      }, 150); // 6 × 150 ms = 900 ms in total, longer than the 400 ms idle allowance, but never idle that long
    });
    const pf = createPiOllamaFetch({ baseUrl, numCtx: () => 8192, think: false, firstOutputTimeoutMs: 2_000, idleTimeoutMs: 400 });
    const res = await pf('http://ignored/v1/chat/completions', { method: 'POST', body: JSON.stringify(request) });
    const text = await readAll(res);
    expect(text).toContain('t6');
    expect(text).toContain('[DONE]');
  }, 15_000);
});
