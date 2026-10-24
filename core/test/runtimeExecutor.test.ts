import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { WebSocket } from 'ws';
import { openCoreDatabase } from '../db/openCore';
import type { CoreDatabase } from '../db/connection';
import { startApiServer, type RunningApiServer } from '../api/server';
import { attachWsServer } from '../ws/server';
import { EventBroadcaster } from '../ws/broadcaster';
import { latestSequence } from '../domain/events';
import { generateToken } from '../auth/token';
import type { ModelBackend, ModelChatRequest, ModelChatResult } from '../runtime/modelBackend';
import { startModelInvocation } from '../domain/modelInvocations';
import { allocateContextAtAssembly, measurePromptChars } from '../shared/contextBudget';
import { resolveImplicitNumCtx } from '../runtime/ollamaChatControls';

const TOKEN = generateToken();
let dir: string;
let db: CoreDatabase;
let api: RunningApiServer;
let ws: { close(): void };
let broadcaster: EventBroadcaster;
let baseUrl: string;
let wsUrl: string;
let backend: ProgrammableBackend;

/** A ModelBackend whose behavior each test controls. */
class ProgrammableBackend implements ModelBackend {
  mode: 'tokens' | 'hang' | 'late-success' | 'error' | 'm34-loop' = 'tokens';
  tokens: string[] = ['Paris', ' is', ' the', ' capital.'];
  aborted = false;
  started = false;
  calls = 0;
  models: string[] = [];
  lastRequest: ModelChatRequest | undefined;
  releaseLateSuccess: (() => void) | null = null;

  async streamChat(request: ModelChatRequest, onToken: (delta: string) => void): Promise<ModelChatResult> {
    this.lastRequest = request;
    this.started = true;
    this.calls += 1;
    this.models.push(request.model);
    if (this.mode === 'm34-loop') {
      if (this.calls <= 2) {
        return {
          content: '',
          toolCalls: [{ id: `call-${this.calls}`, name: 'read_file', arguments: { path: 'C:\\invented\\target.ts' } }],
          provider: 'ollama', model: request.model,
          usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 },
        };
      }
      return {
        content: 'Changed strategy and completed with repository evidence.',
        toolCalls: [], provider: 'ollama', model: request.model,
        usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 },
      };
    }
    if (this.mode === 'error') {
      throw new Error('backend exploded');
    }
    if (this.mode === 'hang') {
      // Block until the caller aborts, then throw an AbortError like a real fetch.
      await new Promise<void>((_resolve, reject) => {
        if (request.signal?.aborted) return finish();
        request.signal?.addEventListener('abort', finish);
        function finish() {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        }
      });
      throw new Error('unreachable');
    }
    if (this.mode === 'late-success') {
      await new Promise<void>((resolve) => { this.releaseLateSuccess = resolve; });
      return {
        content: 'must not be persisted',
        toolCalls: [],
        provider: 'ollama',
        model: request.model,
        usage: { promptTokens: 1, completionTokens: 1, durationMs: 10 },
      };
    }
    let content = '';
    for (const t of this.tokens) {
      if (request.signal?.aborted) {
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      }
      content += t;
      onToken(t);
      await new Promise((r) => setTimeout(r, 2));
    }
    return {
      content,
      toolCalls: [],
      provider: 'ollama',
      model: request.model,
      usage: { promptTokens: 10, completionTokens: 4, durationMs: 5 },
    };
  }
}

function authedFetch(pathAndQuery: string, init: RequestInit & { idempotencyKey?: string } = {}) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${TOKEN}`,
    'Content-Type': 'application/json',
    'X-Client-Id': 'test-client',
    ...(init.headers as Record<string, string> | undefined),
  };
  if (init.idempotencyKey) headers['Idempotency-Key'] = init.idempotencyKey;
  return fetch(`${baseUrl}${pathAndQuery}`, { ...init, headers });
}

let idempotencyCounter = 0;
function nextIdemp(): string {
  idempotencyCounter += 1;
  return `idemp-exec-${idempotencyCounter}`;
}

async function jsonOf(res: Response) {
  expect(res.ok).toBe(true);
  return res.json();
}

async function pollAttempt(id: string, predicate: (a: any) => boolean, timeoutMs = 5000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const a = await (await authedFetch(`/v1/attempts/${id}`)).json();
    if (predicate(a)) return a;
    if (Date.now() > deadline) throw new Error(`attempt ${id} never satisfied predicate; last status=${a.status}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Full pipeline: conversation + user message + request + attempt, ready to execute. */
async function seedAttempt(message: string): Promise<{ conversationId: string; attemptId: string }> {
  const conv = await jsonOf(await authedFetch('/v1/conversations', { method: 'POST', idempotencyKey: nextIdemp(), body: JSON.stringify({ mode: 'baat_kar' }) }));
  await jsonOf(await authedFetch(`/v1/conversations/${conv.id}/messages`, { method: 'POST', idempotencyKey: nextIdemp(), body: JSON.stringify({ role: 'user', content: message }) }));
  const req = await jsonOf(await authedFetch('/v1/requests', {
    method: 'POST',
    idempotencyKey: nextIdemp(),
    body: JSON.stringify({
      currentMessage: message,
      requestedMode: 'baat_kar',
      resolvedMode: 'baat_kar',
      routeReason: 'test',
      conversationId: conv.id,
      contextPolicy: { includeConversationHistory: true, includeProjectContext: false, includeRepositoryContext: false, includeGlobalStoryContext: false },
    }),
  }));
  const attempt = await jsonOf(await authedFetch('/v1/attempts', { method: 'POST', idempotencyKey: nextIdemp(), body: JSON.stringify({ requestId: req.id, kind: 'baat_kar' }) }));
  return { conversationId: conv.id, attemptId: attempt.id };
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karkedikha-exec-test-'));
  db = openCoreDatabase(path.join(dir, 'core.db')).db;
  broadcaster = new EventBroadcaster();
  backend = new ProgrammableBackend();
  api = await startApiServer({
    db,
    token: TOKEN,
    broadcaster,
    dataDir: dir,
    coreInfo: () => ({ coreVersion: '0.1.0', apiVersion: 1, instanceId: 'test', startedAt: new Date().toISOString(), nodeVersion: process.version, electronVersion: null, dataDir: dir }),
    onShutdown: () => {},
    executorOptions: { backend, defaultModel: 'qwen2.5-coder:1.5b', dataDir: dir },
  });
  ws = attachWsServer({ httpServer: api.server, token: TOKEN, broadcaster, instanceId: 'test', latestSequence: () => latestSequence(db) });
  baseUrl = `http://127.0.0.1:${api.port}`;
  wsUrl = `ws://127.0.0.1:${api.port}/v1/ws`;
});

afterEach(async () => {
  ws.close();
  await api.close();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function openClient(): Promise<{ socket: WebSocket; frames: any[] }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl, { headers: { Authorization: `Bearer ${TOKEN}` } });
    const frames: any[] = [];
    socket.on('message', (data) => frames.push(JSON.parse(data.toString())));
    socket.on('open', () => resolve({ socket, frames }));
    socket.on('error', reject);
  });
}

describe('M32 Core-owned execution (Baat Kar)', () => {
  it('adds frozen repository context to inference without changing the user message or exposing tools', async () => {
    const original = 'Where is task-model selection implemented and what does it do?';
    const conversation = await jsonOf(await authedFetch('/v1/conversations', {
      method: 'POST', idempotencyKey: nextIdemp(), body: JSON.stringify({ mode: 'baat_kar' }),
    }));
    const submission = await jsonOf(await authedFetch('/v1/submit', {
      method: 'POST', idempotencyKey: nextIdemp(),
      body: JSON.stringify({
        currentMessage: original,
        requestedMode: 'baat_kar',
        conversationId: conversation.id,
        workspaceRoot: dir,
        hasWorkspace: true,
        repositoryContext: {
          prompt: '## Automatically selected repository context\n### src/models/TaskModelSelection.ts\nexport function selectTaskModel() {}',
          selectedFiles: [{ path: 'src/models/TaskModelSelection.ts', estimatedTokens: 32 }],
          estimatedTokens: 48,
        },
      }),
    }));

    const storedContext = await jsonOf(await authedFetch(`/v1/attempts/${submission.attempt.id}/context`));
    expect(storedContext.taskInput).toBe(original);
    expect(storedContext.repositoryContext.selectedFiles).toEqual([{ path: 'src/models/TaskModelSelection.ts', estimatedTokens: 32 }]);
    expect(storedContext.permittedCapabilities.allowedTools).toEqual([]);
    expect(storedContext.permittedCapabilities.contextPolicy.includeRepositoryContext).toBe(true);

    await authedFetch(`/v1/attempts/${submission.attempt.id}/execute`, { method: 'POST', idempotencyKey: nextIdemp() });
    await pollAttempt(submission.attempt.id, (attempt) => attempt.status === 'completed');

    expect(backend.lastRequest?.messages.some(message => message.role === 'system' && message.content.includes('TaskModelSelection.ts'))).toBe(true);
    expect(backend.lastRequest?.messages.some(message => message.role === 'system' && message.content.includes('do not perform or propose mutations'))).toBe(true);
    expect(backend.lastRequest?.messages.filter(message => message.role === 'user').at(-1)?.content).toBe(original);
    expect(backend.lastRequest?.tools).toBeUndefined();
    expect(db.all('SELECT id FROM tool_invocations')).toHaveLength(0);
    expect(db.all('SELECT id FROM approvals')).toHaveLength(0);
    expect(db.all<{ kind: string }>('SELECT kind FROM attempts')).toEqual([expect.objectContaining({ kind: 'baat_kar' })]);
  });

  it('mode is an execution contract: a Baat Kar request that asks for edits still gets ONE tool-less inference, no tools, no mutation and no approval', async () => {
    const original = 'Check and update the README with missing info';
    const conversation = await jsonOf(await authedFetch('/v1/conversations', {
      method: 'POST', idempotencyKey: nextIdemp(), body: JSON.stringify({ mode: 'baat_kar' }),
    }));
    const submission = await jsonOf(await authedFetch('/v1/submit', {
      method: 'POST', idempotencyKey: nextIdemp(),
      body: JSON.stringify({
        currentMessage: original, requestedMode: 'baat_kar', conversationId: conversation.id, workspaceRoot: dir, hasWorkspace: true,
        repositoryContext: { prompt: '### README.md\n1: # Project', selectedFiles: [{ path: 'README.md', estimatedTokens: 8 }], estimatedTokens: 12 },
      }),
    }));
    const storedContext = await jsonOf(await authedFetch(`/v1/attempts/${submission.attempt.id}/context`));
    expect(storedContext.permittedCapabilities.allowedTools).toEqual([]);

    await authedFetch(`/v1/attempts/${submission.attempt.id}/execute`, { method: 'POST', idempotencyKey: nextIdemp() });
    await pollAttempt(submission.attempt.id, (attempt) => attempt.status === 'completed' || attempt.status === 'failed');

    expect(backend.lastRequest?.tools).toBeUndefined();
    expect(db.all('SELECT id FROM tool_invocations')).toHaveLength(0);
    expect(db.all('SELECT id FROM approvals')).toHaveLength(0);
    expect(db.all<{ kind: string }>('SELECT kind FROM attempts')).toEqual([expect.objectContaining({ kind: 'baat_kar' })]);
  });

  it('injects frozen repository context into the actual Saath Kar model request with mutation-aware framing', async () => {
    const original = 'Add validation to reject empty usernames.';
    const sentinel = 'SAATH_REPOSITORY_CONTEXT_SENTINEL';
    const conversation = await jsonOf(await authedFetch('/v1/conversations', {
      method: 'POST', idempotencyKey: nextIdemp(), body: JSON.stringify({ mode: 'saath_kar' }),
    }));
    const submission = await jsonOf(await authedFetch('/v1/submit', {
      method: 'POST', idempotencyKey: nextIdemp(),
      body: JSON.stringify({
        currentMessage: original,
        requestedMode: 'saath_kar',
        conversationId: conversation.id,
        workspaceRoot: dir,
        hasWorkspace: true,
        repositoryContext: {
          prompt: `## Automatically selected repository context\n### src/users.ts\n${sentinel}`,
          selectedFiles: [{ path: 'src/users.ts', estimatedTokens: 24 }],
          estimatedTokens: 36,
        },
      }),
    }));

    await authedFetch(`/v1/attempts/${submission.attempt.id}/execute`, { method: 'POST', idempotencyKey: nextIdemp() });
    // This test is about the request framing. The scripted model answers a change request with prose only, which M55
    // (correctly) no longer reports as completed, so wait for any terminal state.
    await pollAttempt(submission.attempt.id, (attempt) => ['completed', 'failed'].includes(attempt.status));

    const contextMessage = backend.lastRequest?.messages.find(message =>
      message.role === 'system' && message.content.includes(sentinel),
    );
    expect(contextMessage?.content).toContain("selected for the user's request");
    expect(contextMessage?.content).toContain('identify relevant files and symbols before requesting extra exploration');
    expect(contextMessage?.content).toContain('Saath Kar may propose mutations');
    expect(contextMessage?.content).toContain('do not claim facts beyond the supplied evidence');
    expect(contextMessage?.content).toContain('requires the existing approval mechanism');
    expect(contextMessage?.content).not.toContain('do not perform or propose mutations');
    expect(backend.lastRequest?.messages.filter(message => message.role === 'user').at(-1)?.content).toBe(original);
  });

  it('M55: a prose-only reply to a Saath Kar change request is never reported as completed', async () => {
    const conversation = await jsonOf(await authedFetch('/v1/conversations', {
      method: 'POST', idempotencyKey: nextIdemp(), body: JSON.stringify({ mode: 'saath_kar' }),
    }));
    const submission = await jsonOf(await authedFetch('/v1/submit', {
      method: 'POST', idempotencyKey: nextIdemp(),
      body: JSON.stringify({ currentMessage: 'make a new copy of this file and format, organize and refactor', requestedMode: 'saath_kar', conversationId: conversation.id, workspaceRoot: dir, hasWorkspace: true }),
    }));
    await authedFetch(`/v1/attempts/${submission.attempt.id}/execute`, { method: 'POST', idempotencyKey: nextIdemp() });
    const done = await pollAttempt(submission.attempt.id, (attempt) => ['completed', 'failed'].includes(attempt.status));
    expect(done.status).toBe('failed');
    expect(done.failureReason).toMatch(/actionable mutation proposal/);
  });

  it('runs the model call inside Core, streams tokens, records truth, and completes the attempt', async () => {
    const { conversationId, attemptId } = await seedAttempt('What is the capital of France?');
    const client = await openClient();

    const execRes = await authedFetch(`/v1/attempts/${attemptId}/execute`, { method: 'POST', idempotencyKey: nextIdemp() });
    expect(execRes.status).toBe(202);

    const finished = await pollAttempt(attemptId, (a) => a.status === 'completed');
    expect(finished.status).toBe('completed');
    expect(backend.started).toBe(true);

    // Assistant message durably appended by the Core, not the Extension Host.
    const messages = (await (await authedFetch(`/v1/conversations/${conversationId}/messages`)).json()).messages;
    const assistant = messages.find((m: any) => m.role === 'assistant');
    expect(assistant).toBeDefined();
    expect(assistant.content).toBe('Paris is the capital.');
    expect(assistant.modelInvocationId).toBeTruthy();

    // Model-invocation truth recorded.
    const invocations = (await (await authedFetch(`/v1/attempts/${attemptId}/model-invocations`)).json()).modelInvocations;
    expect(invocations).toHaveLength(1);
    expect(invocations[0].status).toBe('succeeded');
    expect(invocations[0].requestedModel).toBe('qwen2.5-coder:1.5b');
    expect(invocations[0].actualModel).toBe('qwen2.5-coder:1.5b');
    expect(invocations[0].actualProvider).toBe('ollama');

    // Live token frames streamed over WS.
    await new Promise((r) => setTimeout(r, 30));
    const tokenFrames = client.frames.filter((f) => f.type === 'runtime_token' && f.attemptId === attemptId);
    expect(tokenFrames.length).toBeGreaterThan(0);
    expect(tokenFrames.map((f) => f.delta).join('')).toBe('Paris is the capital.');
    client.socket.close();
  });

  it('cancellation aborts the live in-process model call, not just a status flag', async () => {
    backend.mode = 'hang';
    const { attemptId } = await seedAttempt('Explain quantum computing in detail.');

    await authedFetch(`/v1/attempts/${attemptId}/execute`, { method: 'POST', idempotencyKey: nextIdemp() });
    const running = await pollAttempt(attemptId, (a) => a.status === 'running');
    expect(backend.started).toBe(true);
    expect(running.claimExpiresAt).toBeTruthy();
    expect(running.fenceGeneration).toBe(1);

    // Re-activation/duplicate execute while the lease is live must reuse the
    // in-Core worker, not acquire a second fence or start another model call.
    await authedFetch(`/v1/attempts/${attemptId}/execute`, { method: 'POST', idempotencyKey: nextIdemp() });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const stillRunning = await (await authedFetch(`/v1/attempts/${attemptId}`)).json();
    expect(stillRunning.fenceGeneration).toBe(1);

    const cancelRes = await authedFetch(`/v1/attempts/${attemptId}/cancel`, { method: 'POST', idempotencyKey: nextIdemp() });
    expect(cancelRes.status).toBe(200);

    const cancelled = await pollAttempt(attemptId, (a) => a.status === 'cancelled');
    expect(cancelled.status).toBe('cancelled');

    const invocations = (await (await authedFetch(`/v1/attempts/${attemptId}/model-invocations`)).json()).modelInvocations;
    expect(invocations[0].status).toBe('cancelled');
    expect(invocations[0].endedAt).toBeTruthy();
    expect(invocations[0].usageMetadata.cancellationReason).toBe('attempt_cancelled');
    expect(invocations[0].usageMetadata.cancelledAt).toBe(invocations[0].endedAt);
    expect(invocations.filter((invocation: any) => !['succeeded', 'failed', 'cancelled'].includes(invocation.status))).toHaveLength(0);
  });

  it('cancelling before model dispatch resolves every pending invocation owned by the attempt only', async () => {
    const { attemptId } = await seedAttempt('Cancel before dispatch.');
    const { attemptId: unrelatedAttemptId } = await seedAttempt('Unrelated work.');
    const first = startModelInvocation(db, { attemptId, requestedProvider: 'ollama', requestedModel: 'model-a', actor: 'test' });
    const second = startModelInvocation(db, { attemptId, requestedProvider: 'ollama', requestedModel: 'model-b', actor: 'test' });
    const unrelated = startModelInvocation(db, { attemptId: unrelatedAttemptId, requestedProvider: 'ollama', requestedModel: 'model-c', actor: 'test' });

    await jsonOf(await authedFetch(`/v1/attempts/${attemptId}/cancel`, { method: 'POST', idempotencyKey: nextIdemp() }));
    await jsonOf(await authedFetch(`/v1/attempts/${attemptId}/confirm-cancelled`, { method: 'POST', idempotencyKey: nextIdemp() }));

    const owned = (await (await authedFetch(`/v1/attempts/${attemptId}/model-invocations`)).json()).modelInvocations;
    expect(owned.map((invocation: any) => invocation.id)).toEqual([first.id, second.id]);
    expect(owned.every((invocation: any) => invocation.status === 'cancelled')).toBe(true);
    expect(owned.every((invocation: any) => invocation.usageMetadata.cancellationReason === 'attempt_cancelled')).toBe(true);
    const unrelatedRows = (await (await authedFetch(`/v1/attempts/${unrelatedAttemptId}/model-invocations`)).json()).modelInvocations;
    expect(unrelatedRows).toHaveLength(1);
    expect(unrelatedRows[0].id).toBe(unrelated.id);
    expect(unrelatedRows[0].status).toBe('pending');
  });

  it('cancellation fences a transport that completes late and persists no fabricated assistant output', async () => {
    backend.mode = 'late-success';
    const { attemptId, conversationId } = await seedAttempt('Ignore abort and finish late.');
    await authedFetch(`/v1/attempts/${attemptId}/execute`, { method: 'POST', idempotencyKey: nextIdemp() });
    await pollAttempt(attemptId, (attempt) => attempt.status === 'running' && backend.started);

    await jsonOf(await authedFetch(`/v1/attempts/${attemptId}/cancel`, { method: 'POST', idempotencyKey: nextIdemp() }));
    backend.releaseLateSuccess?.();
    await pollAttempt(attemptId, (attempt) => attempt.status === 'cancelled');

    const invocations = (await (await authedFetch(`/v1/attempts/${attemptId}/model-invocations`)).json()).modelInvocations;
    expect(invocations).toHaveLength(1);
    expect(invocations[0].status).toBe('cancelled');
    const messages = (await (await authedFetch(`/v1/conversations/${conversationId}/messages`)).json()).messages;
    expect(messages.find((message: any) => message.role === 'assistant')).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect((await (await authedFetch(`/v1/attempts/${attemptId}`)).json()).status).toBe('cancelled');
    expect(((await (await authedFetch(`/v1/attempts/${attemptId}/model-invocations`)).json()).modelInvocations)[0].status).toBe('cancelled');
  });

  it('duplicate cancellation creates one request, one terminal attempt event, and one invocation event', async () => {
    const { attemptId } = await seedAttempt('Cancel idempotently.');
    const invocation = startModelInvocation(db, { attemptId, requestedProvider: 'ollama', requestedModel: 'model-a', actor: 'test' });

    await jsonOf(await authedFetch(`/v1/attempts/${attemptId}/cancel`, { method: 'POST', idempotencyKey: nextIdemp() }));
    await jsonOf(await authedFetch(`/v1/attempts/${attemptId}/confirm-cancelled`, { method: 'POST', idempotencyKey: nextIdemp() }));
    await jsonOf(await authedFetch(`/v1/attempts/${attemptId}/cancel`, { method: 'POST', idempotencyKey: nextIdemp() }));
    await jsonOf(await authedFetch(`/v1/attempts/${attemptId}/confirm-cancelled`, { method: 'POST', idempotencyKey: nextIdemp() }));

    const attemptEvents = db.all<{ eventType: string }>('SELECT eventType FROM runtime_events WHERE entityId = ? ORDER BY sequence', [attemptId]);
    expect(attemptEvents.filter((event) => event.eventType === 'attempt_cancel_requested')).toHaveLength(1);
    expect(attemptEvents.filter((event) => event.eventType === 'attempt_cancelled')).toHaveLength(1);
    const invocationEvents = db.all<{ eventType: string }>(
      "SELECT eventType FROM runtime_events WHERE entityId = ? ORDER BY sequence",
      [invocation.id],
    );
    expect(invocationEvents.filter((event) => event.eventType === 'model_invocation_started')).toHaveLength(1);
    expect(invocationEvents.filter((event) => event.eventType === 'model_invocation_completed')).toHaveLength(1);
  });

  it('records a backend error as a failed attempt and failed invocation', async () => {
    backend.mode = 'error';
    const { attemptId, conversationId } = await seedAttempt('Do the thing.');

    await authedFetch(`/v1/attempts/${attemptId}/execute`, { method: 'POST', idempotencyKey: nextIdemp() });
    const failed = await pollAttempt(attemptId, (a) => a.status === 'failed');
    expect(failed.status).toBe('failed');
    expect(failed.failureReason).toContain('backend exploded');

    const invocations = (await (await authedFetch(`/v1/attempts/${attemptId}/model-invocations`)).json()).modelInvocations;
    expect(invocations[0].status).toBe('failed');

    // No assistant message should have been appended on failure.
    const messages = (await (await authedFetch(`/v1/conversations/${conversationId}/messages`)).json()).messages;
    expect(messages.find((m: any) => m.role === 'assistant')).toBeUndefined();
  });

  it('execute is idempotent and a no-op once the attempt is terminal', async () => {
    const { attemptId } = await seedAttempt('Hi');
    await authedFetch(`/v1/attempts/${attemptId}/execute`, { method: 'POST', idempotencyKey: nextIdemp() });
    await pollAttempt(attemptId, (a) => a.status === 'completed');

    // A second execute on a completed attempt must not create a second invocation.
    const again = await authedFetch(`/v1/attempts/${attemptId}/execute`, { method: 'POST', idempotencyKey: nextIdemp() });
    expect(again.status).toBe(202);
    await new Promise((r) => setTimeout(r, 50));
    const invocations = (await (await authedFetch(`/v1/attempts/${attemptId}/model-invocations`)).json()).modelInvocations;
    expect(invocations).toHaveLength(1);
  });
});

describe('M45 Baat Kar context assembly against the frozen window', () => {
  const evidence = (extra: Record<string, unknown> = {}) => ({
    selectedProvider: 'ollama', selectedModel: 'qwen2.5-coder:1.5b', selectionReason: 'test', suitabilitySummary: 'test',
    userOverrode: true, candidates: [], escalationCandidates: [],
    requiredCapabilities: { readOnlyExplanation: true, repositoryExploration: false, toolCalling: false, fileModification: false, codingComplexity: 'none', contextRequirement: 'small', vision: false, validationAndRepair: false },
    ...extra,
  });

  async function longConversationAttempt(modelSelection: Record<string, unknown>, priorMessages = 60, size = 2_000) {
    const conversation = await jsonOf(await authedFetch('/v1/conversations', {
      method: 'POST', idempotencyKey: nextIdemp(), body: JSON.stringify({ mode: 'baat_kar' }),
    }));
    for (let i = 0; i < priorMessages; i += 1) {
      await jsonOf(await authedFetch(`/v1/conversations/${conversation.id}/messages`, {
        method: 'POST', idempotencyKey: nextIdemp(),
        body: JSON.stringify({ role: i % 2 === 0 ? 'user' : 'assistant', content: `[m${i}] ${'x'.repeat(size)}` }),
      }));
    }
    const submission = await jsonOf(await authedFetch('/v1/submit', {
      method: 'POST', idempotencyKey: nextIdemp(),
      body: JSON.stringify({
        currentMessage: 'LATEST_USER_QUESTION_SENTINEL', requestedMode: 'baat_kar', conversationId: conversation.id,
        selectedProvider: 'ollama', selectedModel: 'qwen2.5-coder:1.5b', modelSelection,
      }),
    }));
    await authedFetch(`/v1/attempts/${submission.attempt.id}/execute`, { method: 'POST', idempotencyKey: nextIdemp() });
    await pollAttempt(submission.attempt.id, (attempt) => attempt.status === 'completed', 15_000);
    return submission.attempt.id as string;
  }

  const compactedEvents = (attemptId: string) => db.all<{ metadata: string }>(
    `SELECT metadata FROM runtime_events WHERE eventType = 'context_compacted' AND entityId = ?`, [attemptId],
  ).map((row) => JSON.parse(row.metadata));

  it('bounds replay to what an 8192-token window leaves, discloses the omission and records one event', async () => {
    const attemptId = await longConversationAttempt(evidence({ contextWindowTokens: 8192, contextWindowSource: 'router_metadata' }));
    const request = backend.lastRequest!;
    const replay = request.messages.filter((m) => m.role === 'user' || m.role === 'assistant');
    const replayChars = replay.reduce((sum, m) => sum + m.content.length, 0);
    const nonReplay = request.messages.filter((m) => m.role === 'system');
    const allocation = allocateContextAtAssembly({
      surface: 'baat_kar',
      window: { contextTokens: 8192, source: 'router_metadata' },
      fixedChars: measurePromptChars(nonReplay.filter((m) => !m.content.includes('earlier message(s)'))) + 200,
    });
    expect(replayChars).toBeLessThanOrEqual(allocation.conversationReplayChars);
    expect(replayChars).toBeLessThan(80_000);
    expect(request.messages.some((m) => m.role === 'system' && m.content.includes('earlier message(s) in this conversation were omitted'))).toBe(true);
    expect(request.messages.filter((m) => m.role === 'user').at(-1)?.content).toContain('LATEST_USER_QUESTION_SENTINEL');
    const events = compactedEvents(attemptId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ surface: 'baat_kar', tier: 'replay', windowTokens: 8192, windowSource: 'router_metadata' });
    expect(events[0].replayOmitted).toBeGreaterThan(0);
    expect(events[0].afterChars).toBeLessThan(events[0].beforeChars);
  });

  it('hands the backend the frozen window so an implicit num_ctx can never exceed it', async () => {
    await longConversationAttempt(evidence({ contextWindowTokens: 8192, contextWindowSource: 'router_metadata' }));
    const request = backend.lastRequest!;
    expect(request.contextBudget?.maxContextTokens).toBe(8192);
    expect(request.contextBudget?.outputReserveTokens).toBe(1638);
    const numCtx = resolveImplicitNumCtx({
      messages: request.messages,
      tools: request.tools,
      numCtx: request.ollama?.numCtx,
      outputReserveTokens: request.contextBudget?.outputReserveTokens,
      maxContextTokens: request.contextBudget?.maxContextTokens,
    });
    expect(numCtx).toBeDefined();
    expect(numCtx!).toBeLessThanOrEqual(8192);
  });

  it('assumes the conservative 32768 window, labelled, when none was frozen — and never grows it with history', async () => {
    const attemptId = await longConversationAttempt(evidence());
    const request = backend.lastRequest!;
    expect(request.contextBudget?.maxContextTokens).toBe(32_768);
    const events = compactedEvents(attemptId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ windowTokens: 32_768, windowSource: 'assumed_default' });
    const replayChars = request.messages.filter((m) => m.role === 'user' || m.role === 'assistant').reduce((sum, m) => sum + m.content.length, 0);
    expect(replayChars).toBeLessThanOrEqual(Math.min(20_000, Math.floor(32_768 * 0.3)) * 4);
  });

  it('records no compaction event when the whole conversation fits', async () => {
    const attemptId = await longConversationAttempt(evidence({ contextWindowTokens: 32_768, contextWindowSource: 'explicit_config' }), 4, 200);
    expect(compactedEvents(attemptId)).toHaveLength(0);
    expect(backend.lastRequest!.messages.some((m) => m.content.includes('were omitted from replay'))).toBe(false);
  });
});

describe('M34 repository recovery and bounded strategy change', () => {
  it('fails closed instead of silently switching a frozen unsupported provider', async () => {
    const submission = await jsonOf(await authedFetch('/v1/submit', {
      method: 'POST', idempotencyKey: nextIdemp(),
      body: JSON.stringify({
        currentMessage: 'Explain this.', requestedMode: 'baat_kar',
        requestedProvider: 'openai-compatible', requestedModel: 'configured-model',
        modelSelection: {
          requiredCapabilities: {
            readOnlyExplanation: true, repositoryExploration: false, toolCalling: false, fileModification: false,
            codingComplexity: 'none', contextRequirement: 'small', vision: false, validationAndRepair: false,
          },
          selectedProvider: 'openai-compatible', selectedModel: 'configured-model', selectionReason: 'User-configured provider.',
          suitabilitySummary: 'Using an efficient model suited to this task', userOverrode: false, candidates: [], escalationCandidates: [],
        },
      }),
    }));
    await authedFetch(`/v1/attempts/${submission.attempt.id}/execute`, { method: 'POST', idempotencyKey: nextIdemp() });
    const failed = await pollAttempt(submission.attempt.id, attempt => attempt.status === 'failed');
    expect(failed.failureReason).toContain('will not switch providers silently');
    expect(backend.started).toBe(false);
  });

  it('corrects one unique path, suppresses the duplicate invocation, and escalates on non-progress', async () => {
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'target.ts'), 'export const grounded = true;\n');
    backend.mode = 'm34-loop';
    const selection = {
      requiredCapabilities: {
        readOnlyExplanation: false, repositoryExploration: true, toolCalling: true, fileModification: false,
        codingComplexity: 'none', contextRequirement: 'medium', vision: false, validationAndRepair: false,
      },
      selectedProvider: 'ollama', selectedModel: 'coder:14b',
      selectionReason: 'Selected configured repository model.', suitabilitySummary: 'Using a tool-capable model suited to this task',
      userOverrode: false, candidates: [],
      escalationCandidates: [{ provider: 'ollama', model: 'coder:30b', reason: 'Stronger same-provider model.' }],
    };
    const submission = await jsonOf(await authedFetch('/v1/submit', {
      method: 'POST', idempotencyKey: nextIdemp(),
      body: JSON.stringify({
        currentMessage: 'Inspect target.ts and explain it.', requestedMode: 'saath_kar', workspaceRoot: dir,
        requestedProvider: 'ollama', requestedModel: 'coder:14b', modelSelection: selection,
        hasWorkspace: true, gitCapable: false,
      }),
    }));
    const execute = await authedFetch(`/v1/attempts/${submission.attempt.id}/execute`, {
      method: 'POST', idempotencyKey: nextIdemp(), body: JSON.stringify({ workingDirectory: dir }),
    });
    expect(execute.status).toBe(202);
    await pollAttempt(submission.attempt.id, attempt => attempt.status === 'completed');

    const tools = db.all<Record<string, unknown>>('SELECT * FROM tool_invocations WHERE attemptId = ?', [submission.attempt.id]);
    expect(tools).toHaveLength(1);
    const quality = db.all<{ eventType: string }>(
      "SELECT eventType FROM runtime_events WHERE domain = 'execution_quality' AND entityId = ? ORDER BY sequence",
      [submission.attempt.id],
    ).map(event => event.eventType);
    expect(quality).toEqual(expect.arrayContaining([
      'model_selection_decided', 'repository_path_corrected', 'loop_detected', 'strategy_changed', 'model_escalated', 'final_verification_recorded',
    ]));
    expect(backend.models).toEqual(['coder:14b', 'coder:14b', 'coder:30b']);
  });
});
