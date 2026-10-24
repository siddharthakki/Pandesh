import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as http from 'http';
import type { AddressInfo } from 'net';
import { OllamaProvider } from '../../providers/OllamaProvider';
import { ProviderTimeoutError } from '../../providers/ProviderTypes';
import {
  COLD_START_ALLOWANCE_DEFAULT_MS,
  COLD_START_ALLOWANCE_MAX_MS,
  budgetForRequest,
  classifyOllamaPhase,
  clearResidencyCache,
  coldStartAllowanceMs,
  knownResident,
  modelIsResident,
  noteModelResident,
  RESIDENCY_CACHE_TTL_MS,
} from '../../providers/OllamaColdStart';

/**
 * Cold start vs stall. A model that is not loaded produces no bytes while it loads; a flat timeout either fails a
 * healthy cold start or lets every real hang wait as long as the longest load. The budget therefore follows
 * evidence: `/api/ps` says whether the model is resident, and only a model KNOWN not to be resident gets one bounded
 * startup allowance on top of the normal request timeout.
 */
describe('cold-start budgeting (pure)', () => {
  it('reads residency from /api/ps and treats an unintelligible body as unknown, never cold', () => {
    expect(modelIsResident({ models: [{ name: 'qwen3.8:27b-mtp-q4_K_M', model: 'qwen3.8:27b-mtp-q4_K_M' }] }, 'qwen3.8:27b-mtp-q4_K_M')).toBe(true);
    expect(modelIsResident({ models: [{ name: 'gemma4:12b' }] }, 'qwen3.8:27b-mtp-q4_K_M')).toBe(false);
    expect(modelIsResident({ models: [] }, 'x')).toBe(false);
    expect(modelIsResident({ models: [{ name: 'llama3:latest' }] }, 'llama3')).toBe(true);
    expect(modelIsResident({ models: [{ name: 'llama3' }] }, 'llama3:latest')).toBe(true);
    expect(modelIsResident(undefined, 'x')).toBeUndefined();
    expect(modelIsResident({}, 'x')).toBeUndefined();
    expect(modelIsResident({ models: 'nope' }, 'x')).toBeUndefined();
  });

  it('adds the allowance only for a model known not to be resident', () => {
    expect(budgetForRequest(300_000, true, 300_000)).toMatchObject({ timeoutMs: 300_000, coldStart: false });
    expect(budgetForRequest(300_000, undefined, 300_000)).toMatchObject({ timeoutMs: 300_000, coldStart: false });
    const cold = budgetForRequest(300_000, false, 300_000);
    expect(cold).toMatchObject({ timeoutMs: 600_000, coldStart: true, allowanceMs: 300_000 });
    expect(cold.note).toContain('not loaded');
    expect(budgetForRequest(300_000, false, 0)).toMatchObject({ timeoutMs: 300_000, coldStart: false });
  });

  it('the allowance is bounded and tunable, and a bad value falls back to the default', () => {
    expect(coldStartAllowanceMs({})).toBe(COLD_START_ALLOWANCE_DEFAULT_MS);
    expect(coldStartAllowanceMs({ KARKEDIKHA_OLLAMA_COLD_START_ALLOWANCE_MS: '0' })).toBe(0);
    expect(coldStartAllowanceMs({ KARKEDIKHA_OLLAMA_COLD_START_ALLOWANCE_MS: '90000' })).toBe(90_000);
    expect(coldStartAllowanceMs({ KARKEDIKHA_OLLAMA_COLD_START_ALLOWANCE_MS: '999999999999' })).toBe(COLD_START_ALLOWANCE_MAX_MS);
    expect(coldStartAllowanceMs({ KARKEDIKHA_OLLAMA_COLD_START_ALLOWANCE_MS: 'abc' })).toBe(COLD_START_ALLOWANCE_DEFAULT_MS);
    expect(coldStartAllowanceMs({ KARKEDIKHA_OLLAMA_COLD_START_ALLOWANCE_MS: '-5' })).toBe(COLD_START_ALLOWANCE_DEFAULT_MS);
  });

  it('remembers residency for a bounded window only', () => {
    clearResidencyCache();
    expect(knownResident('http://h:1', 'm', 1000)).toBe(false);
    noteModelResident('http://h:1', 'm', 1000);
    expect(knownResident('http://h:1', 'm', 1000 + RESIDENCY_CACHE_TTL_MS - 1)).toBe(true);
    expect(knownResident('http://h:1', 'm', 1000 + RESIDENCY_CACHE_TTL_MS + 1)).toBe(false);
    expect(knownResident('http://h:1', 'other', 1000)).toBe(false);
    expect(knownResident('http://other:1', 'm', 1000)).toBe(false);
    expect(RESIDENCY_CACHE_TTL_MS).toBeLessThan(5 * 60 * 1000);
  });

  it('names the four phases', () => {
    const base = { stallAfterMs: 60_000 };
    expect(classifyOllamaPhase({ ...base, resident: false, bytesReceived: false, idleMs: 5000 })).toBe('model_loading');
    expect(classifyOllamaPhase({ ...base, resident: true, bytesReceived: false, idleMs: 5000 })).toBe('first_token_wait');
    expect(classifyOllamaPhase({ ...base, resident: undefined, bytesReceived: false, idleMs: 5000 })).toBe('first_token_wait');
    expect(classifyOllamaPhase({ ...base, resident: true, bytesReceived: true, idleMs: 500 })).toBe('active_generation');
    expect(classifyOllamaPhase({ ...base, resident: true, bytesReceived: true, idleMs: 61_000 })).toBe('stall');
  });
});

/** A real HTTP server speaking just enough Ollama: /api/ps residency and a /api/chat that answers after a delay. */
describe('OllamaProvider request budget (real HTTP)', () => {
  let server: http.Server;
  let baseUrl: string;
  let resident: string[];
  let psStatus: number;
  let chatDelayMs: number;
  let chatCalls: number;
  const previousAllowance = process.env.KARKEDIKHA_OLLAMA_COLD_START_ALLOWANCE_MS;

  beforeEach(async () => {
    clearResidencyCache();
    resident = [];
    psStatus = 200;
    chatDelayMs = 0;
    chatCalls = 0;
    server = http.createServer((req, res) => {
      if (req.url === '/api/ps') {
        res.writeHead(psStatus, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ models: resident.map(name => ({ name, model: name })) }));
        return;
      }
      if (req.url === '/api/chat') {
        chatCalls += 1;
        req.resume();
        setTimeout(() => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ model: 'm', message: { role: 'assistant', content: 'hello' }, done: true }));
        }, chatDelayMs);
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    server.closeAllConnections?.();
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (previousAllowance === undefined) delete process.env.KARKEDIKHA_OLLAMA_COLD_START_ALLOWANCE_MS;
    else process.env.KARKEDIKHA_OLLAMA_COLD_START_ALLOWANCE_MS = previousAllowance;
  });

  const options = (timeoutMs: number) => ({
    model: 'big:27b',
    contextWindow: 8192,
    temperature: 0,
    maxOutputTokens: 0,
    timeoutMs,
  });
  const ask = async (timeoutMs: number) => {
    const provider = new OllamaProvider(baseUrl);
    try {
      return await provider.chat([{ role: 'user', content: 'hi' }], [], options(timeoutMs) as never);
    } finally {
      await provider.dispose();
    }
  };

  it('a resident model keeps the normal timeout: a slow reply is a timeout, with no extra allowance', async () => {
    process.env.KARKEDIKHA_OLLAMA_COLD_START_ALLOWANCE_MS = '6000';
    resident = ['big:27b'];
    chatDelayMs = 4500;
    const failure = await ask(3000).then(() => undefined, (error: unknown) => error);
    expect(failure).toBeInstanceOf(ProviderTimeoutError);
    expect((failure as Error).message).not.toContain('startup allowance');
  }, 20_000);

  it('a model known not to be loaded gets the bounded startup allowance and completes a slow first reply', async () => {
    process.env.KARKEDIKHA_OLLAMA_COLD_START_ALLOWANCE_MS = '6000';
    resident = [];
    chatDelayMs = 4500;
    const response = await ask(3000);
    expect(response.message.content).toBe('hello');
    expect(chatCalls).toBe(1);
  }, 20_000);

  it('a cold start that exceeds even the allowance still fails, and says why', async () => {
    process.env.KARKEDIKHA_OLLAMA_COLD_START_ALLOWANCE_MS = '1000';
    resident = [];
    chatDelayMs = 8000;
    const failure = await ask(3000).then(() => undefined, (error: unknown) => error);
    expect(failure).toBeInstanceOf(ProviderTimeoutError);
    expect((failure as Error).message).toContain('startup allowance');
  }, 25_000);

  it('an unavailable residency lookup means unknown, not cold: no allowance is granted', async () => {
    process.env.KARKEDIKHA_OLLAMA_COLD_START_ALLOWANCE_MS = '6000';
    psStatus = 500;
    chatDelayMs = 4500;
    const failure = await ask(3000).then(() => undefined, (error: unknown) => error);
    expect(failure).toBeInstanceOf(ProviderTimeoutError);
  }, 20_000);

  it('after a successful reply the model is remembered as resident: the next request makes no /api/ps lookup', async () => {
    let psCalls = 0;
    server.removeAllListeners('request');
    server.on('request', (req, res) => {
      if (req.url === '/api/ps') { psCalls += 1; res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ models: [] })); return; }
      req.resume();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ model: 'm', message: { role: 'assistant', content: 'hello' }, done: true }));
    });
    process.env.KARKEDIKHA_OLLAMA_COLD_START_ALLOWANCE_MS = '6000';
    await ask(3000);
    expect(psCalls).toBe(1);
    await ask(3000);
    await ask(3000);
    expect(psCalls).toBe(1);
  }, 20_000);

  it('a disabled allowance (0) never extends the timeout even for a cold model', async () => {
    process.env.KARKEDIKHA_OLLAMA_COLD_START_ALLOWANCE_MS = '0';
    resident = [];
    chatDelayMs = 4500;
    const failure = await ask(3000).then(() => undefined, (error: unknown) => error);
    expect(failure).toBeInstanceOf(ProviderTimeoutError);
  }, 20_000);
});
