import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as http from 'http';
import * as vscode from 'vscode';
import * as vscodeMock from '../mocks/vscode';
import { AgentLoop } from '../../agent/AgentLoop';
import { ContextManager } from '../../agent/ContextManager';
import { ApprovalFlow } from '../../policy/ApprovalFlow';
import { ProviderGateway } from '../../providers/ProviderGateway';
import { ContextPreflightResult } from '../../reliability/ContextBudget';
import { FakeToolExecutor } from '../mocks/FakeToolExecutor';
import { MockAuditService } from '../mocks/MockAuditService';
import { MockCheckpointManager } from '../mocks/MockCheckpointManager';
import { TOOL_CONTEXT } from '../fixtures/responses';

function secretStorage(): vscode.SecretStorage {
  return {
    get: async () => undefined,
    store: async () => undefined,
    delete: async () => undefined,
    onDidChange: (_listener, _thisArgs, disposables) => {
      const disposable: vscode.Disposable = { dispose: () => undefined };
      disposables?.push(disposable);
      return disposable;
    },
  };
}

interface FetchScript {
  showStatus?: number;
  chatResponses?: Array<{ status: number; body: unknown }>;
}

interface RecordedTraffic {
  order: string[];
  chatCalls: Array<Record<string, unknown>>;
}

/**
 * Ollama chat() now uses direct undici.request, not fetch, so /api/chat
 * traffic can no longer be captured by stubbing global fetch (health check,
 * model listing, and model metadata calls still use fetch and could be
 * stubbed — but it's simpler and more realistic to run one real local HTTP
 * server that serves all three Ollama endpoints).
 */
class GatewayTestServer {
  readonly traffic: RecordedTraffic = { order: [], chatCalls: [] };
  private chatIndex = 0;
  private readonly server: http.Server;

  constructor(private readonly script: FetchScript) {
    this.server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const url = req.url ?? '';
        if (url.endsWith('/api/show')) {
          this.traffic.order.push('show');
          if (this.script.showStatus && this.script.showStatus !== 200) {
            res.writeHead(this.script.showStatus, { 'content-type': 'text/plain' });
            res.end('not found');
            return;
          }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            model_info: { 'qwen2.context_length': 131072 },
            parameters: 'num_ctx 32768',
            details: {},
          }));
          return;
        }
        if (url.endsWith('/api/chat')) {
          this.traffic.order.push('chat');
          this.traffic.chatCalls.push(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>);
          const scripted = this.script.chatResponses?.[Math.min(this.chatIndex, (this.script.chatResponses.length - 1))];
          this.chatIndex += 1;
          if (scripted && scripted.status !== 200) {
            res.writeHead(scripted.status, { 'content-type': 'text/plain' });
            res.end(String(scripted.body));
            return;
          }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(scripted?.body ?? {
            message: { role: 'assistant', content: 'All done.' },
            done: true,
          }));
          return;
        }
        if (url.endsWith('/api/tags')) {
          this.traffic.order.push('tags');
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ models: [] }));
          return;
        }
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end(`Unexpected request to ${url}`);
      });
    });
  }

  async start(): Promise<string> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    const address = this.server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to bind gateway test server.');
    }
    return `http://127.0.0.1:${address.port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

let activeServer: GatewayTestServer | undefined;

async function stubOllamaFetch(script: FetchScript = {}): Promise<RecordedTraffic> {
  const server = new GatewayTestServer(script);
  activeServer = server;
  const baseUrl = await server.start();
  vscodeMock._setConfig('ollama-agent.apiBase', baseUrl);
  return server.traffic;
}

async function makeGatewayLoop(model: string, userMessage: string) {
  const provider = await ProviderGateway.create(secretStorage());
  const context = new ContextManager('You are a production agent.');
  context.addUserMessage(userMessage);
  const executor = new FakeToolExecutor();
  const loop = new AgentLoop(context, {
    workspaceRoot: '/fake/workspace',
    approvalFlow: new ApprovalFlow(),
    checkpointManager: new MockCheckpointManager() as never,
    auditService: new MockAuditService() as never,
    provider,
    mode: 'agent',
    modelOverride: model,
    executor,
  });
  return { loop, provider, executor };
}

describe('M11 AgentLoop production integration (ProviderGateway + real wrapper)', () => {
  beforeEach(() => {
    vscodeMock._resetConfig();
    vscodeMock._setConfig('ollama-agent.providerType', 'ollama');
  });

  afterEach(async () => {
    vscodeMock._resetConfig();
    vi.unstubAllGlobals();
    await activeServer?.stop();
    activeServer = undefined;
  });

  it('provider runtime metadata reaches the planner through the ReliableOllamaProvider wrapper (no bypass)', async () => {
    const traffic = await stubOllamaFetch();
    const { loop, provider } = await makeGatewayLoop('qwen3-coder:30b', 'Say hello.');
    // The production wrapper, exactly as ProviderGateway builds it.
    expect(provider.constructor.name).toBe('ReliableOllamaProvider');

    const usages: ContextPreflightResult[] = [];
    await loop.run(TOOL_CONTEXT, { onContextUsage: usage => usages.push(usage) });

    expect(traffic.order).toContain('show');
    expect(usages.length).toBeGreaterThan(0);
    expect(usages[0].limit.provenance).toBe('provider_runtime');
    expect(usages[0].limit.effectiveLimit).toBe(32768);
    expect(usages[0].limit.providerRuntimeLimit).toBe(32768);
    expect(usages[0].limit.declaredLimit).toBe(131072);
  });

  it('dispatches a safe request exactly once, with the usage event emitted before dispatch', async () => {
    const traffic = await stubOllamaFetch();
    const { loop } = await makeGatewayLoop('qwen3-coder:30b', 'Summarize the repository purpose.');

    await loop.run(TOOL_CONTEXT, {
      onContextUsage: () => traffic.order.push('usage'),
    });

    expect(traffic.chatCalls).toHaveLength(1);
    expect(traffic.order.filter(entry => entry === 'chat')).toHaveLength(1);
    // The current-usage event is emitted strictly before dispatch.
    expect(traffic.order.indexOf('usage')).toBeLessThan(traffic.order.indexOf('chat'));
    // num_ctx and num_predict are exactly the preflight-approved values.
    const options = traffic.chatCalls[0]['options'] as Record<string, unknown>;
    expect(options['num_ctx']).toBe(32768);
    expect(options['num_predict']).toBeGreaterThan(0);
  });

  it('blocks an oversized request before dispatch: the provider is called zero times', async () => {
    vscodeMock._setConfig('ollama-agent.contextWindow', 300);
    const traffic = await stubOllamaFetch();
    const { loop } = await makeGatewayLoop('qwen3-coder:30b', 'x'.repeat(20_000));

    const usages: ContextPreflightResult[] = [];
    const errors: string[] = [];
    const result = await loop.run(TOOL_CONTEXT, {
      onContextUsage: usage => usages.push(usage),
      onError: error => errors.push(error),
    });

    expect(traffic.chatCalls).toHaveLength(0);
    expect(usages[0].status).toBe('blocked');
    expect(usages[0].limit.provenance).toBe('user_override');
    expect(result.stoppedByLimit).toBe(true);
    expect(errors[0]).toContain('Request blocked before model dispatch');
  });

  it('classifies genuine provider context overflow narrowly', async () => {
    const traffic = await stubOllamaFetch({
      chatResponses: [{ status: 500, body: 'error: this request exceeds the maximum context length of the model' }],
    });
    const { loop } = await makeGatewayLoop('qwen3-coder:30b', 'Do something.');

    const errors: string[] = [];
    await loop.run(TOOL_CONTEXT, { onError: error => errors.push(error) });

    expect(traffic.chatCalls).toHaveLength(1);
    expect(errors[0]).toContain('provider_context_overflow');
  });

  it('keeps unrelated token errors out of the overflow classification', async () => {
    await stubOllamaFetch({
      chatResponses: [{ status: 500, body: 'error: invalid API token supplied' }],
    });
    const { loop } = await makeGatewayLoop('qwen3-coder:30b', 'Do something.');

    const errors: string[] = [];
    await loop.run(TOOL_CONTEXT, { onError: error => errors.push(error) });

    expect(errors[0]).not.toContain('provider_context_overflow');
    expect(errors[0]).toContain('invalid API token');
  });

  it('shows unknown-model metadata as a visibly estimated conservative fallback', async () => {
    await stubOllamaFetch({ showStatus: 404 });
    const { loop } = await makeGatewayLoop('mystery-model:1b', 'Hello.');

    const usages: ContextPreflightResult[] = [];
    await loop.run(TOOL_CONTEXT, { onContextUsage: usage => usages.push(usage) });

    expect(usages.length).toBeGreaterThan(0);
    expect(usages[0].limit.fallback).toBe(true);
    expect(usages[0].limit.estimated).toBe(true);
    expect(usages[0].limit.effectiveLimit).toBe(8192);
    expect(usages[0].status).toBe('unknown_fallback');
    expect(usages[0].countingMode).toBe('estimated');
  });

  it('cancellation before the first iteration keeps the provider untouched', async () => {
    const traffic = await stubOllamaFetch();
    const { loop } = await makeGatewayLoop('qwen3-coder:30b', 'Hello.');
    const controller = new AbortController();
    controller.abort();

    const result = await loop.run(TOOL_CONTEXT, {}, controller.signal);

    expect(result.finalContent).toMatch(/stopped/i);
    expect(traffic.chatCalls).toHaveLength(0);
  });
});
