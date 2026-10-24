import { afterEach, describe, expect, it } from 'vitest';
import * as http from 'http';
import { OllamaProvider } from '../../providers/OllamaProvider';
import { OpenAICompatibleProvider } from '../../providers/OpenAICompatibleProvider';

interface RequestLog {
  method: string;
  url: string;
  authorization?: string;
}

class FakeProviderServer {
  readonly requests: RequestLog[] = [];
  private server?: http.Server;
  private handler: (req: http.IncomingMessage, res: http.ServerResponse) => void = (_req, res) => {
    res.writeHead(404);
    res.end('not found');
  };

  async start(): Promise<string> {
    this.server = http.createServer((req, res) => {
      this.requests.push({
        method: req.method ?? '',
        url: req.url ?? '',
        authorization: req.headers.authorization,
      });
      this.handler(req, res);
    });
    await new Promise<void>(resolve => {
      this.server?.listen(0, '127.0.0.1', resolve);
    });
    const address = this.server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to bind fake provider server.');
    }
    return `http://127.0.0.1:${address.port}`;
  }

  route(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): void {
    this.handler = handler;
  }

  async stop(): Promise<void> {
    if (!this.server) {
      return;
    }
    await new Promise<void>(resolve => this.server?.close(() => resolve()));
  }
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

describe('M8.6 deterministic provider transport', () => {
  const servers: FakeProviderServer[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map(server => server.stop()));
  });

  async function fakeServer(): Promise<{ server: FakeProviderServer; baseUrl: string }> {
    const server = new FakeProviderServer();
    servers.push(server);
    return { server, baseUrl: await server.start() };
  }

  it('calls Ollama health and model listing without chat or retry', async () => {
    const { server, baseUrl } = await fakeServer();
    server.route((_req, res) => json(res, 200, {
      models: [{ name: 'current' }, { name: 'other' }],
    }));
    const provider = new OllamaProvider(baseUrl);

    await provider.healthCheck();
    const models = await provider.listModels();

    expect(models.map(model => model.name)).toEqual(['current', 'other']);
    expect(server.requests.map(req => req.url)).toEqual(['/api/tags', '/api/tags']);
    expect(server.requests.some(req => req.url === '/api/chat')).toBe(false);
  });

  it('calls OpenAI-compatible health and model listing with authorization but without chat', async () => {
    const { server, baseUrl } = await fakeServer();
    server.route((_req, res) => json(res, 200, {
      data: [{ id: 'gpt-local', object: 'model' }],
    }));
    const provider = new OpenAICompatibleProvider(baseUrl, 'test-key');

    await provider.healthCheck();
    const models = await provider.listModels();

    expect(models).toEqual([{ name: 'gpt-local' }]);
    expect(server.requests.map(req => req.url)).toEqual(['/v1/models', '/v1/models']);
    expect(server.requests.every(req => req.authorization === 'Bearer test-key')).toBe(true);
    expect(server.requests.some(req => req.url === '/v1/chat/completions')).toBe(false);
  });

  it('maps authentication and provider API failures during model listing', async () => {
    const { server, baseUrl } = await fakeServer();
    server.route((_req, res) => json(res, 401, { error: 'raw secret payload' }));
    const provider = new OpenAICompatibleProvider(baseUrl, 'bad-key');

    await expect(provider.listModels()).rejects.toMatchObject({ name: 'ProviderAuthError' });
    expect(server.requests).toHaveLength(1);
  });

  it('cancels an in-flight listing request without issuing chat', async () => {
    const { server, baseUrl } = await fakeServer();
    let requestSeen: () => void = () => undefined;
    const seen = new Promise<void>(resolve => {
      requestSeen = resolve;
    });
    server.route((_req, _res) => undefined);
    server.route((_req, _res) => {
      requestSeen();
    });
    const provider = new OllamaProvider(baseUrl);
    const controller = new AbortController();

    const pending = provider.listModels(controller.signal);
    await seen;
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'ProviderCancelledError', evidenceTag: 'upstream:cancellation' });
    expect(server.requests.map(req => req.url)).toEqual(['/api/tags']);
    expect(server.requests.some(req => req.url === '/api/chat')).toBe(false);
  });

  it('surfaces malformed model payloads as deterministic provider failures to callers', async () => {
    const { server, baseUrl } = await fakeServer();
    server.route((_req, res) => json(res, 200, { models: 'not-an-array' }));
    const provider = new OllamaProvider(baseUrl);

    await expect(provider.listModels()).rejects.toMatchObject({ name: 'ProviderApiError' });
    expect(server.requests).toHaveLength(1);
  });
});
