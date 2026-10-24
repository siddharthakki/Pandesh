import { describe, it, expect } from 'vitest';
import * as http from 'http';
import * as net from 'net';
import { OllamaProvider } from '../../providers/OllamaProvider';
import { ProviderCancelledError, ProviderConnectionError, ProviderTimeoutError } from '../../providers/ProviderTypes';

const CHAT_OPTIONS = {
  model: 'test-model',
  contextWindow: 2048,
  maxOutputTokens: 0,
  temperature: 0,
};

/** A local HTTP server whose body-write can be delayed after headers are sent. */
class SlowBodyServer {
  private readonly server: http.Server;

  constructor(private readonly headerDelayMs: number, private readonly bodyDelayMs: number, private readonly body: string) {
    this.server = http.createServer((_req, res) => {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.flushHeaders();
        setTimeout(() => {
          res.end(this.body);
        }, this.bodyDelayMs);
      }, this.headerDelayMs);
    });
  }

  async start(): Promise<string> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    const address = this.server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to bind SlowBodyServer.');
    }
    return `http://127.0.0.1:${address.port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

describe('OllamaTransport (direct undici.request) integration via OllamaProvider', () => {
  it('body delayed past the derived bodyTimeout classifies as transport:undici-body', async () => {
    // Headers arrive immediately; the body write is delayed 10s, well past
    // undici's coarse ~1s timer granularity and the 2000ms-tightened budget
    // derived from timeoutMs:4_000.
    const server = new SlowBodyServer(0, 10_000, JSON.stringify({ message: { role: 'assistant', content: 'ok' }, done: true }));
    const baseUrl = await server.start();
    const provider = new OllamaProvider(baseUrl);
    try {
      await expect(provider.chat(
        [{ role: 'user', content: 'hi' }],
        [],
        { ...CHAT_OPTIONS, timeoutMs: 4_000 },
      )).rejects.toMatchObject({
        name: 'ProviderTimeoutError',
        timeoutOwner: 'transport',
        evidenceTag: 'transport:undici-body',
      } satisfies Partial<ProviderTimeoutError>);
    } finally {
      await provider.dispose();
      await server.stop();
    }
  }, 8_000);

  it('ECONNREFUSED classifies as ProviderConnectionError', async () => {
    // Bind then immediately close to obtain a guaranteed-refused port.
    const probe = net.createServer();
    const port = await new Promise<number>((resolve) => {
      probe.listen(0, '127.0.0.1', () => {
        const address = probe.address();
        resolve(typeof address === 'object' && address ? address.port : 0);
      });
    });
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    const provider = new OllamaProvider(`http://127.0.0.1:${port}`);
    try {
      await expect(provider.chat(
        [{ role: 'user', content: 'hi' }],
        [],
        { ...CHAT_OPTIONS, timeoutMs: 5_000 },
      )).rejects.toMatchObject({ name: 'ProviderConnectionError' } satisfies Partial<ProviderConnectionError>);
    } finally {
      await provider.dispose();
    }
  });

  it('caller-side AbortController.abort() is classified as upstream cancellation, not a transport timeout', async () => {
    const server = http.createServer(() => { /* never respond */ });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') { throw new Error('bind failed'); }
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const provider = new OllamaProvider(baseUrl);
    const controller = new AbortController();
    try {
      const promise = provider.chat(
        [{ role: 'user', content: 'hi' }],
        [],
        { ...CHAT_OPTIONS, timeoutMs: 30_000 },
        controller.signal,
      );
      await new Promise((resolve) => setTimeout(resolve, 30));
      controller.abort();
      const error = await promise.catch((e) => e);
      expect(error).toBeInstanceOf(ProviderCancelledError);
      expect(error).not.toBeInstanceOf(ProviderConnectionError);
      expect(error).not.toBeInstanceOf(ProviderTimeoutError);
      expect(error.evidenceTag).toBe('upstream:cancellation');
    } finally {
      await provider.dispose();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('caller-side AbortController.abort() during chatStream() is classified as upstream cancellation', async () => {
    const server = http.createServer(() => { /* never respond */ });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') { throw new Error('bind failed'); }
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const provider = new OllamaProvider(baseUrl);
    const controller = new AbortController();
    try {
      const iterator = provider.chatStream!(
        [{ role: 'user', content: 'hi' }],
        [],
        { ...CHAT_OPTIONS, timeoutMs: 30_000 },
        controller.signal,
      )[Symbol.asyncIterator]();
      const promise = iterator.next();
      await new Promise((resolve) => setTimeout(resolve, 30));
      controller.abort();
      const error = await promise.then(() => undefined, (e) => e);
      expect(error).toBeInstanceOf(ProviderCancelledError);
      expect(error).not.toBeInstanceOf(ProviderConnectionError);
      expect(error).not.toBeInstanceOf(ProviderTimeoutError);
      expect(error.evidenceTag).toBe('upstream:cancellation');
    } finally {
      await provider.dispose();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('configured overall timeout (no upstream signal) surfaces as agent-owned ProviderTimeoutError', async () => {
    // Both the outer AbortController (timeoutMs) and undici's own headers
    // timer are racing; the outer one is what agent-configured timeouts mean
    // to test here — assert on the always-present agent budget path by using
    // a very small overall timeoutMs so the outer controller fires well
    // before undici's coarse-grained internal tick could realistically win.
    const server = http.createServer(() => { /* never respond */ });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') { throw new Error('bind failed'); }
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const provider = new OllamaProvider(baseUrl);
    try {
      await expect(provider.chat(
        [{ role: 'user', content: 'hi' }],
        [],
        { ...CHAT_OPTIONS, timeoutMs: 50 },
      )).rejects.toMatchObject({
        name: 'ProviderTimeoutError',
        timeoutOwner: 'agent',
      } satisfies Partial<ProviderTimeoutError>);
    } finally {
      await provider.dispose();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('provider disposal closes the reusable Agent idempotently (dispose twice is safe)', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: { role: 'assistant', content: 'ok' }, done: true }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') { throw new Error('bind failed'); }
    const provider = new OllamaProvider(`http://127.0.0.1:${address.port}`);
    try {
      await provider.chat([{ role: 'user', content: 'hi' }], [], { ...CHAT_OPTIONS, timeoutMs: 5_000 });
      await expect(provider.dispose()).resolves.toBeUndefined();
      await expect(provider.dispose()).resolves.toBeUndefined();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('early termination of chatStream destroys the response body/releases resources', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.write('{"message":{"content":"a"},"done":false}\n');
      // Keep the connection open indefinitely — the client will break early.
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') { throw new Error('bind failed'); }
    const provider = new OllamaProvider(`http://127.0.0.1:${address.port}`);
    try {
      const stream = provider.chatStream!([{ role: 'user', content: 'hi' }], [], { ...CHAT_OPTIONS, timeoutMs: 30_000 });
      const iterator = stream[Symbol.asyncIterator]();
      const first = await iterator.next();
      expect(first.done).toBe(false);
      // Breaking early triggers the async generator's .return(), which our
      // transport's finally block uses to destroy the response body.
      await expect(iterator.return?.()).resolves.toBeDefined();
    } finally {
      await provider.dispose();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
