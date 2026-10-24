import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openCoreDatabase } from '../db/openCore';
import type { CoreDatabase } from '../db/connection';
import {
  getOpenRouterBudget,
  reconcileOpenRouterBudget,
  reserveOpenRouterBudget,
} from '../domain/openRouterBudget';
import { refuseOpenRouterBeforeFetch, resolveAttemptModelBackend } from '../runtime/attemptModelBackend';
import {
  OPENROUTER_API_KEY_ENV,
  OpenAICompatibleModelBackend,
} from '../runtime/openaiCompatibleBackend';
import { finalizeOpenRouterCall, prepareOpenRouterCall } from '../runtime/openRouterExecution';
import { CONSERVATIVE_OPENROUTER_PRICING, pricingFromModelRecord, reservationUsd } from '../runtime/openRouterPricing';
import { buildMissionEnvelope } from '../runtime/missionAuthorization';
import { ModelBackendError } from '../runtime/modelBackend';
import type { AttemptContextRecord } from '../shared/wireTypes';
import { redactSensitiveEnv } from '../../apps/desktop/src/host/openRouterCredential';

function sseResponse(chunks: string[]): Response {
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(`${chunk}\n`));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function seedAttempt(db: CoreDatabase, attemptId: string): void {
  const now = new Date().toISOString();
  const requestId = `req_${attemptId}`;
  db.run(
    `INSERT INTO requests (id, createdAt, clientId, currentMessage, requestedMode, resolvedMode, routeReason, contextPolicy, correlationId, toolPermissionPolicy)
     VALUES (?, ?, 'client-test', 'hello', 'saath_kar', 'saath_kar', 'test', '{}', 'corr-test', '{}')`,
    [requestId, now],
  );
  db.run(
    `INSERT INTO attempts (id, requestId, kind, status, createdAt, updatedAt, revision)
     VALUES (?, ?, 'saath_kar', 'created', ?, ?, 1)`,
    [attemptId, requestId, now, now],
  );
}

function minimalOpenRouterContext(overrides: Partial<AttemptContextRecord> = {}): AttemptContextRecord {
  return {
    id: 'ctx_test',
    contextIdentity: 'ctx_test',
    requestId: 'req_test',
    attemptId: 'att_test',
    resolvedMode: 'saath_kar',
    workspaceRoot: '/tmp/repo',
    repositoryId: null,
    repositoryLocationId: null,
    taskInput: 'hello',
    selectedProvider: 'openrouter',
    selectedModel: 'openai/gpt-4o-mini',
    modelSelection: {
      requiredCapabilities: {
        readOnlyExplanation: true,
        repositoryExploration: true,
        toolCalling: true,
        fileModification: true,
        codingComplexity: 'low',
        contextRequirement: 'medium',
        vision: false,
        validationAndRepair: true,
      },
      selectedProvider: 'openrouter',
      selectedModel: 'openai/gpt-4o-mini',
      routingPolicy: 'explicit-openrouter',
      spendCapUsd: 0.5,
      selectionReason: 'test',
      suitabilitySummary: 'test',
      userOverrode: true,
      candidates: [],
      escalationCandidates: [],
    },
    permittedCapabilities: { hasWorkspace: true, gitCapable: true, allowedTools: [], contextPolicy: 'default' },
    approvalPolicy: { profile: 'autonomous-mission', worker: 'autonomous-mission', allowedTools: [] },
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    contextHash: 'abc',
    ...overrides,
  };
}

describe('OpenRouter Gate 1', () => {
  let dir: string;
  let db: CoreDatabase;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'or-gate1-'));
    db = openCoreDatabase(path.join(dir, 'core.db')).db;
    seedAttempt(db, 'att_test');
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env[OPENROUTER_API_KEY_ENV];
    delete process.env.KARKEDIKHA_OPENROUTER_MAX_COMPLETION_TOKENS;
  });

  it('streams tool calls, reads usage.cost from the final chunk, and honors abort', async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read","arguments":"{\\"path\\":"}}]}}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"a.txt\\"}"}}]}}]}',
      'data: {"choices":[{"finish_reason":"tool_calls"}]}',
      'data: {"usage":{"prompt_tokens":10,"completion_tokens":2,"cost":0.000042}}',
      'data: [DONE]',
    ];
    const backend = new OpenAICompatibleModelBackend({
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'test-key',
      fetchFn: async () => sseResponse(chunks),
    });
    const result = await backend.streamChat(
      { model: 'openai/gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] },
      () => undefined,
    );
    expect(result.toolCalls).toEqual([{ name: 'read', arguments: { path: 'a.txt' } }]);
    expect(result.usage.costUsd).toBeCloseTo(0.000042, 8);

    const controller = new AbortController();
    controller.abort();
    await expect(backend.streamChat(
      { model: 'm', messages: [{ role: 'user', content: 'x' }], signal: controller.signal },
      () => undefined,
    )).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('refuses cloud before fetch when key, cap, or unresolved billing is missing', () => {
    const context = minimalOpenRouterContext();
    expect(() => refuseOpenRouterBeforeFetch(context, db)).toThrow(ModelBackendError);
    process.env[OPENROUTER_API_KEY_ENV] = 'sk-test';
    expect(() => refuseOpenRouterBeforeFetch(context, db)).not.toThrow();
    reserveOpenRouterBudget(db, context.attemptId, 0.5, 0.01);
    finalizeOpenRouterCall(db, context.attemptId, 'inv_1', 0.01, null);
    expect(() => refuseOpenRouterBeforeFetch(context, db)).toThrow(/unresolved/i);
  });

  it('reserves atomically, reconciles actual cost, and blocks overspend across calls', () => {
    const attemptId = 'att_budget';
    seedAttempt(db, attemptId);
    const cap = 1;
    const reserve = reservationUsd(200, 500, CONSERVATIVE_OPENROUTER_PRICING);
    reserveOpenRouterBudget(db, attemptId, cap, reserve);
    let ledger = getOpenRouterBudget(db, attemptId)!;
    expect(ledger.reservedUsd).toBeCloseTo(reserve, 6);
    reconcileOpenRouterBudget(db, attemptId, 'inv_1', reserve, 0.001);
    ledger = getOpenRouterBudget(db, attemptId)!;
    expect(ledger.spentUsd).toBeCloseTo(0.001, 6);
    expect(ledger.reservedUsd).toBeCloseTo(0, 6);
    expect(ledger.hasUnresolved).toBe(false);
    expect(() => reserveOpenRouterBudget(db, attemptId, cap, 1)).toThrow(/exceeded/i);
  });

  it('marks unresolved on missing cost and persists after reload', () => {
    const attemptId = 'att_unresolved';
    seedAttempt(db, attemptId);
    const cap = 1;
    const reserve = 0.02;
    reserveOpenRouterBudget(db, attemptId, cap, reserve);
    finalizeOpenRouterCall(db, attemptId, 'inv_x', reserve, null);
    db.close();
    const reloaded = openCoreDatabase(path.join(dir, 'core.db')).db;
    const ledger = getOpenRouterBudget(reloaded, attemptId)!;
    expect(ledger.hasUnresolved).toBe(true);
    expect(ledger.reservedUsd).toBeCloseTo(reserve, 6);
    reloaded.close();
  });

  it('prepareOpenRouterCall reserves before a hypothetical fetch', () => {
    process.env[OPENROUTER_API_KEY_ENV] = 'sk-test';
    process.env.KARKEDIKHA_OPENROUTER_MAX_COMPLETION_TOKENS = '256';
    const context = minimalOpenRouterContext({
      modelSelection: {
        ...minimalOpenRouterContext().modelSelection!,
        spendCapUsd: 5,
      },
    });
    const budget = prepareOpenRouterCall(db, context, [{ role: 'user', content: 'plan' }]);
    expect(budget.spendCapUsd).toBe(5);
    expect(budget.reserveUsd).toBeGreaterThan(0);
    const ledger = getOpenRouterBudget(db, context.attemptId)!;
    expect(ledger.reservedUsd).toBeCloseTo(budget.reserveUsd, 6);
  });

  it('ollama context uses injected backend and never OpenRouter fetch', async () => {
    process.env[OPENROUTER_API_KEY_ENV] = 'sk-test';
    let fetchCalled = false;
    const injected = {
      streamChat: async () => ({
        content: 'local',
        toolCalls: [],
        provider: 'ollama',
        model: 'local',
        usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 },
      }),
    };
    const backend = resolveAttemptModelBackend({
      context: minimalOpenRouterContext({ selectedProvider: 'ollama', modelSelection: undefined }),
      db,
      injectedBackend: injected,
      fetchFn: async () => {
        fetchCalled = true;
        return new Response('no', { status: 500 });
      },
    });
    const result = await backend.streamChat({ model: 'local', messages: [{ role: 'user', content: 'x' }] }, () => undefined);
    expect(result.content).toBe('local');
    expect(fetchCalled).toBe(false);
  });

  it('parses OpenRouter model pricing.prompt and pricing.completion USD strings', () => {
    const parsed = pricingFromModelRecord({
      id: 'openai/gpt-4o-mini',
      pricing: { prompt: '0.00000015', completion: '0.0000006' },
    });
    expect(parsed?.source).toBe('model');
    expect(parsed?.promptUsdPerToken).toBeCloseTo(0.00000015, 12);
  });

  it('freezes explicit-openrouter mission envelope with spend cap', () => {
    const envelope = buildMissionEnvelope({
      workspaceRoot: path.join('C:', 'repo'),
      objective: 'task',
      model: 'openai/gpt-4o-mini',
      selectedProvider: 'openrouter',
      spendCapUsd: 0.25,
    });
    expect(envelope.routingPolicy).toBe('explicit-openrouter');
    expect(envelope.spendCapUsd).toBe(0.25);
  });

  it('redacts OpenRouter API key from env snapshots', () => {
    const redacted = redactSensitiveEnv({ [OPENROUTER_API_KEY_ENV]: 'sk-secret', OTHER: 'ok' });
    expect(redacted[OPENROUTER_API_KEY_ENV]).toBe('[redacted]');
    expect(redacted.OTHER).toBe('ok');
  });
});
