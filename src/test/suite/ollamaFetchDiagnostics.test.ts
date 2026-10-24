import { afterEach, describe, expect, it, vi } from 'vitest';
import * as http from 'http';
import * as net from 'net';
import { inspectOllamaFetchError, OllamaProvider } from '../../providers/OllamaProvider';
import { ProviderCancelledError, ProviderConnectionError, ProviderTimeoutError } from '../../providers/ProviderTypes';


describe('OllamaProvider fetch diagnostics', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses direct undici chat transport independently of global fetch', async () => {
    const providerServer = new DelayedJsonServer(
      JSON.stringify({ message: { role: 'assistant', content: 'ok' }, done: true }),
    );
    const providerBaseUrl = await providerServer.start();

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('global fetch must not be used by OllamaProvider.chat');
      }) as unknown as typeof fetch,
    );

    const provider = new OllamaProvider(providerBaseUrl);

    try {
      await expect(provider.chat(
        [{ role: 'user', content: 'diagnostic prompt must not be persisted' }],
        [],
        {
          model: 'diagnostic-model',
          contextWindow: 2048,
          maxOutputTokens: 0,
          temperature: 0,
          timeoutMs: 5_000,
        },
      )).resolves.toMatchObject({
        message: { content: 'ok' },
      });
    } finally {
      await provider.dispose();
      await providerServer.stop();
    }
  });

  it('OllamaProvider.chat throws ProviderTimeoutError with evidence tag transport:undici-headers when headers exceed the derived headersTimeout', async () => {
    // Headers must be delayed well past the ~1s coarse tick granularity undici
    // uses internally on this runtime for headersTimeout, and well past the
    // 2000ms-tightened headersTimeoutMs derived from timeoutMs:4_000 below —
    // but the request errors out long before this 10s delay elapses.
    const server = new DelayedJsonServer(
      JSON.stringify({ message: { role: 'assistant', content: 'ok' }, done: true }),
      10_000,
    );
    const baseUrl = await server.start();
    const provider = new OllamaProvider(baseUrl);
    try {
      await expect(provider.chat(
        [{ role: 'user', content: 'diagnostic prompt must not be persisted' }],
        [],
        {
          model: 'diagnostic-model',
          contextWindow: 2048,
          maxOutputTokens: 0,
          temperature: 0,
          timeoutMs: 4_000,
        },
      )).rejects.toMatchObject({
        name: 'ProviderTimeoutError',
        timeoutOwner: 'transport',
        evidenceTag: 'transport:undici-headers',
      } satisfies Partial<ProviderTimeoutError>);
    } finally {
      await provider.dispose();
      await server.stop();
    }
  }, 8_000);

  it('OllamaProvider.healthCheck classifies upstream cancellation as ProviderCancelledError, not ProviderConnectionError', async () => {
    const server = new DelayedJsonServer('{"models":[]}', 10_000);
    const baseUrl = await server.start();
    const provider = new OllamaProvider(baseUrl);
    const controller = new AbortController();
    try {
      const promise = provider.healthCheck(controller.signal);
      await new Promise((resolve) => setTimeout(resolve, 30));
      controller.abort();
      const error = await promise.then(() => undefined, (e) => e);
      expect(error).toBeInstanceOf(ProviderCancelledError);
      expect(error).not.toBeInstanceOf(ProviderConnectionError);
      expect(error).not.toBeInstanceOf(ProviderTimeoutError);
      expect(error.evidenceTag).toBe('upstream:cancellation');
    } finally {
      await server.stop();
    }
  }, 8_000);

  it('extracts only bounded nested fetch error details', () => {
    const cause = Object.assign(new Error('Headers Timeout Error'), {
      name: 'HeadersTimeoutError',
      code: 'UND_ERR_HEADERS_TIMEOUT',
    });
    const error = Object.assign(new TypeError('fetch failed'), { cause });

    expect(inspectOllamaFetchError(error)).toEqual({
      topLevelName: 'TypeError',
      topLevelCode: undefined,
      nestedCauseName: 'HeadersTimeoutError',
      nestedCauseCode: 'UND_ERR_HEADERS_TIMEOUT',
      nestedCauseConstructorName: 'Error',
      classification: 'UND_ERR_HEADERS_TIMEOUT',
    });
  });
});

class DelayedJsonServer {
  private readonly server: http.Server;
  private readonly timers = new Set<NodeJS.Timeout>();
  private readonly sockets = new Set<net.Socket>();

  constructor(private readonly body: string, private readonly delayMs: number = 1_000) {
    this.server = http.createServer((_req, res) => {
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        if (!res.destroyed) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(this.body);
        }
      }, this.delayMs);
      this.timers.add(timer);
      res.once('close', () => {
        clearTimeout(timer);
        this.timers.delete(timer);
      });
    });
    this.server.on('connection', socket => {
      this.sockets.add(socket);
      socket.once('close', () => this.sockets.delete(socket));
    });
  }

  start(): Promise<string> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => {
        this.server.off('error', reject);
        const address = this.server.address();
        if (!address || typeof address === 'string') {
          reject(new Error('server did not receive a TCP address'));
          return;
        }
        resolve(`http://127.0.0.1:${address.port}`);
      });
    });
  }

  async stop(): Promise<void> {
    for (const timer of this.timers) {
      clearTimeout(timer);
    }
    this.timers.clear();
    await new Promise<void>((resolve, reject) => {
      this.server.close(error => error ? reject(error) : resolve());
      this.server.closeIdleConnections?.();
      for (const socket of this.sockets) {
        socket.destroy();
      }
    });
  }
}
