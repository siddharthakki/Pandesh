import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { Agent } from 'undici';
import {
  CORE_OLLAMA_STREAM_TIMEOUTS,
  isOllamaStreamTransportTermination,
  setCoreOllamaStreamAgentForTests,
  streamOllamaChatNdjson,
} from '../runtime/ollamaStreamTransport';
import { isAbortError, OllamaModelBackend } from '../runtime/modelBackend';

afterEach(() => {
  setCoreOllamaStreamAgentForTests(undefined);
});

function listen(handler: http.RequestListener): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer(handler);
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('no port'));
        return;
      }
      resolve({
        port: addr.port,
        close: () => new Promise((res, rej) => server.close((err) => (err ? rej(err) : res()))),
      });
    });
  });
}

describe('ollama stream transport (bodyTimeout)', () => {
  it('documents Core stream timeouts as disabled (AbortSignal owns deadlines)', () => {
    expect(CORE_OLLAMA_STREAM_TIMEOUTS.bodyTimeoutMs).toBe(0);
    expect(CORE_OLLAMA_STREAM_TIMEOUTS.headersTimeoutMs).toBe(0);
  });

  it('classifies TypeError terminated as transport termination', () => {
    expect(isOllamaStreamTransportTermination(new TypeError('terminated'))).toBe(true);
    expect(isOllamaStreamTransportTermination(Object.assign(new Error('x'), { code: 'UND_ERR_BODY_TIMEOUT' }))).toBe(true);
    expect(isOllamaStreamTransportTermination(new Error('model blew up'))).toBe(false);
  });

  it('honors a short undici bodyTimeout on a silent NDJSON body', async () => {
    const server = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.write(`${JSON.stringify({ message: { content: 'hi' } })}\n`);
      // then silence — undici bodyTimeout must fire
    });
    try {
      const agent = new Agent({ bodyTimeout: 250, headersTimeout: 5_000 });
      setCoreOllamaStreamAgentForTests(agent);
      const started = Date.now();
      await expect(
        (async () => {
          const streamed = await streamOllamaChatNdjson({
            baseUrl: `http://127.0.0.1:${server.port}`,
            body: { model: 'x', messages: [], stream: true },
            bodyTimeoutMs: 250,
            headersTimeoutMs: 5_000,
            agent,
          });
          for await (const _ of streamed.lines) {
            /* drain until timeout */
          }
        })(),
      ).rejects.toSatisfy((err: unknown) => isOllamaStreamTransportTermination(err));
      expect(Date.now() - started).toBeLessThan(5_000);
      await agent.close();
    } finally {
      await server.close();
    }
  });

  it('survives >300ms of silence when bodyTimeout is disabled (the production setting)', async () => {
    const server = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      setTimeout(() => {
        res.write(`${JSON.stringify({ message: { content: 'ok' }, done: true, prompt_eval_count: 1, eval_count: 1 })}\n`);
        res.end();
      }, 600);
    });
    try {
      const agent = new Agent({ bodyTimeout: 0, headersTimeout: 0 });
      setCoreOllamaStreamAgentForTests(agent);
      const streamed = await streamOllamaChatNdjson({
        baseUrl: `http://127.0.0.1:${server.port}`,
        body: { model: 'x', messages: [], stream: true },
        bodyTimeoutMs: 0,
        headersTimeoutMs: 0,
        agent,
      });
      const frames: unknown[] = [];
      for await (const frame of streamed.lines) frames.push(frame);
      expect(frames.length).toBeGreaterThan(0);
      await agent.close();
    } finally {
      await server.close();
    }
  });

  it('maps aborted streams to AbortError rather than model_stream_error', async () => {
    const server = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.write(`${JSON.stringify({ message: { content: 'partial' } })}\n`);
    });
    try {
      const backend = new OllamaModelBackend(`http://127.0.0.1:${server.port}`);
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 50);
      await expect(
        backend.streamChat(
          { model: 'x', messages: [{ role: 'user', content: 'hi' }], signal: controller.signal },
          () => undefined,
        ),
      ).rejects.toSatisfy((err: unknown) => isAbortError(err));
    } finally {
      await server.close();
    }
  });

  it('retries a transient 500 from /api/chat and succeeds once Ollama recovers', async () => {
    let requestCount = 0;
    const server = await listen((req, res) => {
      if (req.url === '/api/ps') {
        // Residency probe (loadedContextLength), not a chat attempt.
        res.writeHead(404);
        res.end();
        return;
      }
      requestCount++;
      if (requestCount < 3) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'model requires more system memory than is available' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.end(`${JSON.stringify({ message: { content: 'ok' }, done: true, prompt_eval_count: 1, eval_count: 1 })}\n`);
    });
    try {
      const backend = new OllamaModelBackend(`http://127.0.0.1:${server.port}`);
      const result = await backend.streamChat(
        { model: 'x', messages: [{ role: 'user', content: 'hi' }] },
        () => undefined,
      );
      expect(result.content).toBe('ok');
      expect(requestCount).toBe(3);
    } finally {
      await server.close();
    }
  });

  it('fails with a diagnostic message (not just the bare status) after exhausting retries on a persistent 500', async () => {
    let requestCount = 0;
    const server = await listen((req, res) => {
      if (req.url === '/api/ps') {
        // Residency probe (loadedContextLength), not a chat attempt.
        res.writeHead(404);
        res.end();
        return;
      }
      requestCount++;
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'model requires more system memory than is available' }));
    });
    try {
      const backend = new OllamaModelBackend(`http://127.0.0.1:${server.port}`);
      await expect(
        backend.streamChat({ model: 'x', messages: [{ role: 'user', content: 'hi' }] }, () => undefined),
      ).rejects.toMatchObject({
        code: 'model_http_error',
        message: expect.stringContaining('model requires more system memory'),
      });
      // 1 initial attempt + OLLAMA_TRANSIENT_RETRY_BACKOFF_MS.length retries.
      expect(requestCount).toBe(3);
    } finally {
      await server.close();
    }
  });

  it('never retries a non-transient 4xx (e.g. model not found)', async () => {
    let requestCount = 0;
    const server = await listen((req, res) => {
      if (req.url === '/api/ps') {
        // Residency probe (loadedContextLength), not a chat attempt.
        res.writeHead(404);
        res.end();
        return;
      }
      requestCount++;
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: "model 'nope' not found" }));
    });
    try {
      const backend = new OllamaModelBackend(`http://127.0.0.1:${server.port}`);
      await expect(
        backend.streamChat({ model: 'nope', messages: [{ role: 'user', content: 'hi' }] }, () => undefined),
      ).rejects.toMatchObject({ code: 'model_http_error', message: expect.stringContaining('404') });
      expect(requestCount).toBe(1);
    } finally {
      await server.close();
    }
  });
});
