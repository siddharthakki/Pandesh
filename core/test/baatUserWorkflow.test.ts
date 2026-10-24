import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openCoreDatabase } from '../db/openCore';
import type { CoreDatabase } from '../db/connection';
import { startApiServer, type RunningApiServer } from '../api/server';
import { attachWsServer } from '../ws/server';
import { EventBroadcaster } from '../ws/broadcaster';
import { latestSequence } from '../domain/events';
import { generateToken } from '../auth/token';
import { submitRequest } from '../domain/submission';
import { createConversation } from '../domain/conversations';
import type { ModelBackend, ModelChatRequest, ModelChatResult, ModelChatMessage } from '../runtime/modelBackend';
import { CoreToolRunner } from '../runtime/toolRunner';

const TOKEN = generateToken();

class RepositoryAnswerBackend implements ModelBackend {
  lastMessages: ModelChatMessage[] = [];
  lastTools: ModelChatRequest['tools'] = [];

  async streamChat(request: ModelChatRequest): Promise<ModelChatResult> {
    this.lastMessages = request.messages.map(message => ({ ...message }));
    this.lastTools = request.tools ?? [];
    return {
      content: 'seatCount returns the array length.',
      toolCalls: [],
      provider: 'fixture',
      model: request.model,
      usage: { durationMs: 1 },
    };
  }
}

describe('Baat Kar repository question journey', () => {
  let dir: string;
  let db: CoreDatabase;
  let api: RunningApiServer;
  let ws: { close(): void };
  let baseUrl: string;
  let backend: RepositoryAnswerBackend;
  let sequence = 0;

  const idemp = () => `idemp-baat-workflow-${++sequence}`;

  function authedFetch(p: string, init: RequestInit & { idempotencyKey?: string } = {}) {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      'X-Client-Id': 'test-client',
      ...(init.headers as Record<string, string> | undefined),
    };
    if (init.idempotencyKey) headers['Idempotency-Key'] = init.idempotencyKey;
    return fetch(`${baseUrl}${p}`, { ...init, headers });
  }

  async function pollAttempt(id: string, timeoutMs = 8000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const attempt = await (await authedFetch(`/v1/attempts/${id}`)).json();
      if (attempt.status === 'completed') return attempt;
      if (Date.now() > deadline) throw new Error(`attempt ${id} never completed; last=${attempt.status} reason=${attempt.failureReason}`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karkedikha-baat-workflow-test-'));
    db = openCoreDatabase(path.join(dir, 'core.db')).db;
    const broadcaster = new EventBroadcaster();
    backend = new RepositoryAnswerBackend();
    api = await startApiServer({
      db,
      token: TOKEN,
      broadcaster,
      dataDir: dir,
      coreInfo: () => ({ coreVersion: '0.1.0', apiVersion: 1, instanceId: 'test', startedAt: new Date().toISOString(), nodeVersion: process.version, electronVersion: null, dataDir: dir }),
      onShutdown: () => {},
      executorOptions: { backend, toolRunner: new CoreToolRunner(), defaultModel: 'qwen2.5-coder:1.5b', defaultWorkingDirectory: dir, dataDir: dir },
    });
    ws = attachWsServer({ httpServer: api.server, token: TOKEN, broadcaster, instanceId: 'test', latestSequence: () => latestSequence(db) });
    baseUrl = `http://127.0.0.1:${api.port}`;
  });

  afterEach(async () => {
    ws.close();
    await api.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('grounds the Core model call in source content without tools, approvals or mutation', async () => {
    const source = 'export function seatCount(seats: string[]) { return seats.length; }\n';
    fs.writeFileSync(path.join(dir, 'seats.ts'), source, 'utf8');
    const conversation = createConversation(db, { mode: 'baat_kar', actor: 'test' });
    const submitted = submitRequest(db, {
      clientId: 'test-client',
      currentMessage: 'How does seatCount work?',
      requestedMode: 'baat_kar',
      conversationId: conversation.id,
      workspaceRoot: dir,
      capability: { hasWorkspace: true, gitCapable: true },
      correlationId: idemp(),
      repositoryContext: {
        prompt: `### seats.ts\n${source}`,
        selectedFiles: [{ path: 'seats.ts', estimatedTokens: 18 }],
        estimatedTokens: 24,
      },
    });

    await authedFetch(`/v1/attempts/${submitted.attempt.id}/execute`, { method: 'POST', idempotencyKey: idemp() });
    await pollAttempt(submitted.attempt.id);

    expect(backend.lastMessages.some(message => message.content.includes(source))).toBe(true);
    expect(backend.lastTools).toEqual([]);
    expect(db.all('SELECT id FROM approvals WHERE attemptId = ?', [submitted.attempt.id])).toHaveLength(0);
    expect(db.all('SELECT id FROM tool_invocations WHERE attemptId = ?', [submitted.attempt.id])).toHaveLength(0);
    expect(fs.readFileSync(path.join(dir, 'seats.ts'), 'utf8')).toBe(source);
  });
});
