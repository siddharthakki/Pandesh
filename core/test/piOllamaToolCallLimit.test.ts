/**
 * Micro-tests RAD-020 and FIN-007 (Build 163): gemma4:12b looped inside one response — 875 identical
 * list_scheduled_tasks calls (12,288 output tokens, 175 s) and 372 calls — and Core ran every one; FIN-007 then
 * showed the raw template token '<|tool_response>' as the reply. The transport now drops repeats of the same call,
 * stops the model at a per-response limit, and never passes chat-template control tokens on as text.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createPiOllamaFetch, stripControlTokens, type OllamaCallMetrics } from '../runtime/piOllamaNativeFetch';

const servers: http.Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(() => r(undefined))))); });

/** A fake Ollama streaming the given frames, one per line. Records whether the client hung up early. */
async function streaming(frames: unknown[], state: { closedEarly: boolean; sent: number }): Promise<string> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    let i = 0;
    res.on('close', () => { if (i < frames.length) state.closedEarly = true; });
    const next = () => {
      if (i >= frames.length) { res.end(); return; }
      const ok = res.write(`${JSON.stringify(frames[i++])}\n`);
      state.sent = i;
      // Paced like a model generating tokens, so a client that stops reading is seen to hang up early.
      if (ok) setTimeout(next, 2); else res.once('drain', next);
    };
    next();
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const tools = [
  { type: 'function', function: { name: 'list_scheduled_tasks', description: 'List schedules', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { filePath: { type: 'string' } } } } },
];
const call = (name: string, args: Record<string, unknown> = {}) => ({ message: { role: 'assistant', content: '', tool_calls: [{ function: { name, arguments: args } }] }, done: false });
const done = { message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', eval_count: 12288 };

async function run(frames: unknown[], max?: number) {
  const state = { closedEarly: false, sent: 0 };
  let metrics: OllamaCallMetrics | undefined;
  const pf = createPiOllamaFetch({ baseUrl: await streaming(frames, state), numCtx: () => 8192, think: false, maxToolCallsPerResponse: max, onMetrics: (m) => { metrics = m; } });
  const res = await pf('http://x/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'gemma4:12b', messages: [{ role: 'user', content: 'Pause my daily AI Radar.' }], tools, stream: true }) });
  const text = await res.text();
  const chunks = text.split('\n\n').filter((l) => l.startsWith('data: {')).map((l) => JSON.parse(l.slice(6)));
  const deltas = chunks.map((c) => c.choices[0].delta);
  return {
    state, metrics: metrics!,
    content: deltas.map((d) => d.content ?? '').join(''),
    calls: deltas.flatMap((d) => d.tool_calls ?? []).map((c: { function: { name: string; arguments: string } }) => ({ name: c.function.name, args: JSON.parse(c.function.arguments) })),
    finish: chunks.map((c) => c.choices[0].finish_reason).filter(Boolean).pop(),
    ended: text.includes('data: [DONE]'),
  };
}

describe('tool-call limits on the native Ollama transport', () => {
  it('collapses 875 identical calls in one response into one call (RAD-020)', async () => {
    const out = await run([...Array.from({ length: 875 }, () => call('list_scheduled_tasks')), done]);
    expect(out.calls).toEqual([{ name: 'list_scheduled_tasks', args: {} }]);
    expect(out.metrics.duplicateToolCallsDropped).toBe(874);
    expect(out.finish).toBe('tool_calls');
    expect(out.ended).toBe(true);
  });

  it('stops the model at the per-response limit when the calls differ (FIN-007 pattern)', async () => {
    const frames = [...Array.from({ length: 400 }, (_, i) => call('read_file', { filePath: `f${i}.csv` })), done];
    const out = await run(frames, 12);
    expect(out.calls).toHaveLength(12);
    expect(out.calls[11]).toEqual({ name: 'read_file', args: { filePath: 'f11.csv' } });
    expect(out.metrics.toolCallLimitHit).toBe(12);
    expect(out.finish).toBe('tool_calls');
    expect(out.ended).toBe(true);
    // The model is stopped: far fewer than the 400 looping frames were ever generated and sent.
    await new Promise((r) => setTimeout(r, 300));
    expect(out.state.sent).toBeLessThan(200);
  });

  it('keeps ordinary multi-call responses unchanged', async () => {
    const out = await run([call('read_file', { filePath: 'a.csv' }), call('read_file', { filePath: 'b.csv' }), call('list_scheduled_tasks'), done]);
    expect(out.calls.map((c) => c.args.filePath ?? c.name)).toEqual(['a.csv', 'b.csv', 'list_scheduled_tasks']);
    expect(out.metrics.duplicateToolCallsDropped).toBeUndefined();
    expect(out.metrics.toolCallLimitHit).toBeUndefined();
  });

  it('never shows a chat-template control token as the reply (FIN-007)', async () => {
    const out = await run([{ message: { role: 'assistant', content: '<|tool_response>' }, done: false }, done]);
    expect(out.content).toBe('');
    expect(out.metrics.controlTokensRemoved).toBe(1);
    const prose = await run([{ message: { role: 'assistant', content: 'Your total is 432.90 EUR.<|im_end|>' }, done: false }, done]);
    expect(prose.content).toBe('Your total is 432.90 EUR.');
  });

  it('leaves look-alike text alone', () => {
    expect(stripControlTokens('a <| b |> c, x<|y').text).toBe('a <| b |> c, x<|y');
  });
});
