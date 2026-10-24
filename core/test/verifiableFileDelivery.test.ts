import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
import { CoreToolRunner } from '../runtime/toolRunner';
import { GovernedCapabilityRegistry } from '../runtime/governedCapability';
import type { GovernedCapabilityAdapter, CapabilityHealth, CapabilityRisk } from '../runtime/governedCapability';
import type { ModelBackend, ModelChatMessage, ModelChatRequest, ModelChatResult } from '../runtime/modelBackend';

const TOKEN = generateToken();

const EXACT_CONTENT = `JARVIS HANDOFF TEST
Created by KarkeDikha
Status: SUCCESS`;

const OBJECTIVE = `Use KarkeDikha with local Ollama to create \`jarvis-handoff.txt\` in this workspace.

Its exact contents must be:

JARVIS HANDOFF TEST
Created by KarkeDikha
Status: SUCCESS

Do not modify README.md or any other existing file.

Request explicit approval before writing. Read the file back to verify its contents.

Report completion only after the file is actually created and verified.`;

type Script = (objective: string, turn: number, request: ModelChatRequest) => Omit<ModelChatResult, 'provider' | 'model' | 'usage'>;

class ScriptedBackend implements ModelBackend {
  requests: ModelChatRequest[] = [];
  constructor(public script: Script) {}
  async streamChat(request: ModelChatRequest): Promise<ModelChatResult> {
    const snapshot = { ...request, messages: request.messages.map((m) => ({ ...m })) };
    this.requests.push(snapshot);
    const objective = [...request.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    const turn = request.messages.filter((m) => m.role === 'tool').length;
    return { ...this.script(objective, turn, request), provider: 'ollama', model: request.model, usage: { durationMs: 1 } };
  }
}

let dir: string;
let db: CoreDatabase;
let api: RunningApiServer;
let ws: { close(): void };
let broadcaster: EventBroadcaster;
let baseUrl: string;
let backend: ScriptedBackend;
let n = 0;
const idemp = () => `idemp-verifiable-delivery-${++n}`;

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

async function jsonOf(res: Response) {
  expect(res.ok).toBe(true);
  return res.json();
}

async function pollAttempt(id: string, pred: (a: any) => boolean, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const attempt = await (await authedFetch(`/v1/attempts/${id}`)).json();
    if (pred(attempt)) return attempt;
    if (Date.now() > deadline) throw new Error(`attempt ${id} never satisfied; last=${attempt.status} reason=${attempt.failureReason}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function seedSaathKarTurn(message: string) {
  const conv = await jsonOf(await authedFetch('/v1/conversations', { method: 'POST', idempotencyKey: idemp(), body: JSON.stringify({ mode: 'saath_kar' }) }));
  await jsonOf(await authedFetch(`/v1/conversations/${conv.id}/messages`, { method: 'POST', idempotencyKey: idemp(), body: JSON.stringify({ role: 'user', content: message }) }));
  const req = await jsonOf(await authedFetch('/v1/requests', {
    method: 'POST', idempotencyKey: idemp(),
    body: JSON.stringify({
      currentMessage: message, requestedMode: 'saath_kar', resolvedMode: 'saath_kar', routeReason: 'test', conversationId: conv.id,
      contextPolicy: { includeConversationHistory: true, includeProjectContext: false, includeRepositoryContext: true, includeGlobalStoryContext: false },
    }),
  }));
  const attempt = await jsonOf(await authedFetch('/v1/attempts', { method: 'POST', idempotencyKey: idemp(), body: JSON.stringify({ requestId: req.id, kind: 'saath_kar' }) }));
  await authedFetch(`/v1/attempts/${attempt.id}/execute`, { method: 'POST', idempotencyKey: idemp() });
  return { conversationId: conv.id as string, attemptId: attempt.id as string };
}

async function pendingAction(conversationId: string, attemptId: string) {
  await pollAttempt(attemptId, (attempt) => attempt.status === 'waiting_for_approval');
  const snapshot = await (await authedFetch(`/v1/capabilities/actions?correlationId=${encodeURIComponent(conversationId)}`)).json();
  const own = snapshot.actions.filter((a: any) => a.actionable);
  expect(own.length).toBeGreaterThanOrEqual(1);
  return own[0];
}

async function resolveApproval(action: any, resolution: 'approved' | 'rejected') {
  return jsonOf(await authedFetch(`/v1/capabilities/approvals/${action.approvalId}/resolve`, {
    method: 'POST', idempotencyKey: idemp(),
    body: JSON.stringify({
      resolution,
      attemptId: action.attemptId,
      expectedAttemptRevision: action.expectedAttemptRevision,
      expectedAttemptStatus: action.expectedAttemptStatus,
      requestedActionDigest: action.requestedActionDigest,
      frozenContextHash: action.frozenContextHash,
    }),
  }));
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karkedikha-verifiable-delivery-'));
  fs.writeFileSync(path.join(dir, 'README.md'), '# Initial README\n', 'utf8');
  db = openCoreDatabase(path.join(dir, 'core.db')).db;
  broadcaster = new EventBroadcaster();
  backend = new ScriptedBackend(() => ({ content: 'ok', toolCalls: [] }));
  const workspaceRunner = new CoreToolRunner();
  const governedWorkspace: GovernedCapabilityAdapter = {
    id: 'workspace',
    definitions: () => workspaceRunner.definitions(),
    classify: (toolName): CapabilityRisk => (toolName === 'read_file' ? 'read_only' : 'consequential'),
    health: (): CapabilityHealth => ({ state: 'available', checkedAt: new Date().toISOString() }),
    run: (call, context) => workspaceRunner.run(call, context),
  };
  api = await startApiServer({
    db, token: TOKEN, broadcaster, dataDir: dir,
    coreInfo: () => ({ coreVersion: '0.1.0', apiVersion: 1, instanceId: 'test', startedAt: new Date().toISOString(), nodeVersion: process.version, electronVersion: null, dataDir: dir }),
    onShutdown: () => {},
    executorOptions: {
      backend, toolRunner: workspaceRunner, defaultModel: 'qwen2.5-coder:1.5b', defaultWorkingDirectory: dir, dataDir: dir,
      governedCapabilities: new GovernedCapabilityRegistry().register(governedWorkspace),
    },
  });
  ws = attachWsServer({ httpServer: api.server, token: TOKEN, broadcaster, instanceId: 'test', latestSequence: () => latestSequence(db) });
  baseUrl = `http://127.0.0.1:${api.port}`;
});

afterEach(async () => {
  ws?.close();
  await api?.close();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('deterministic verifiable file delivery acceptance tests', () => {
  it('1. Create one new file with exact contents -> success only after verified delivery', async () => {
    backend.script = (_obj, turn) => {
      if (turn === 0) {
        return {
          content: 'Creating jarvis-handoff.txt with required content.',
          toolCalls: [{ name: 'propose_file_change', arguments: { path: 'jarvis-handoff.txt', content: EXACT_CONTENT } }],
        };
      }
      return { content: 'File created and verified.', toolCalls: [] };
    };

    const { conversationId, attemptId } = await seedSaathKarTurn(OBJECTIVE);
    const action = await pendingAction(conversationId, attemptId);
    expect(action.toolName).toBe('propose_file_change');
    await resolveApproval(action, 'approved');

    const completed = await pollAttempt(attemptId, (a) => ['completed', 'failed'].includes(a.status));
    expect(completed.status).toBe('completed');
    expect(fs.existsSync(path.join(dir, 'jarvis-handoff.txt'))).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'jarvis-handoff.txt'), 'utf8').trim()).toBe(EXACT_CONTENT);
  });

  it('2. Model lists directory and stops -> not completed', async () => {
    backend.script = (_obj, turn) => {
      if (turn === 0) {
        return { content: 'Running dir to inspect workspace.', toolCalls: [{ name: 'run_command', arguments: { command: 'dir' } }] };
      }
      return { content: 'I listed the directory. Task is complete.', toolCalls: [] };
    };

    const { conversationId, attemptId } = await seedSaathKarTurn(OBJECTIVE);
    const action = await pendingAction(conversationId, attemptId);
    expect(action.toolName).toBe('run_command');
    await resolveApproval(action, 'approved');

    // After dir runs, model terminates without mutation proposal -> nudged -> terminates again -> failed
    const terminal = await pollAttempt(attemptId, (a) => ['completed', 'failed'].includes(a.status));
    expect(terminal.status).toBe('failed');
    expect(terminal.failureReason).toMatch(/actionable mutation proposal|delivery incomplete/i);
    expect(fs.existsSync(path.join(dir, 'jarvis-handoff.txt'))).toBe(false);
  });

  it('3. Model claims success without writing -> not completed', async () => {
    backend.script = () => ({ content: 'I have successfully created jarvis-handoff.txt with exact content.', toolCalls: [] });

    const { attemptId } = await seedSaathKarTurn(OBJECTIVE);
    const terminal = await pollAttempt(attemptId, (a) => ['completed', 'failed'].includes(a.status));
    expect(terminal.status).toBe('failed');
    expect(terminal.failureReason).toMatch(/actionable mutation proposal/i);
    expect(fs.existsSync(path.join(dir, 'jarvis-handoff.txt'))).toBe(false);
  });

  it('4. Proposed but unapplied file -> not completed', async () => {
    backend.script = (_obj, turn) => {
      if (turn === 0) {
        return {
          content: 'Proposing file.',
          toolCalls: [{ name: 'propose_file_change', arguments: { path: 'jarvis-handoff.txt', content: EXACT_CONTENT } }],
        };
      }
      return { content: 'Finished.', toolCalls: [] };
    };

    const { conversationId, attemptId } = await seedSaathKarTurn(OBJECTIVE);
    const action = await pendingAction(conversationId, attemptId);
    await resolveApproval(action, 'rejected');

    const terminal = await pollAttempt(attemptId, (a) => ['completed', 'failed', 'cancelled'].includes(a.status));
    expect(terminal.status).not.toBe('completed');
    expect(fs.existsSync(path.join(dir, 'jarvis-handoff.txt'))).toBe(false);
  });

  it('5. File created with incorrect contents -> not completed', async () => {
    backend.script = (_obj, turn) => {
      if (turn === 0) {
        return {
          content: 'Creating file with incorrect content.',
          toolCalls: [{ name: 'propose_file_change', arguments: { path: 'jarvis-handoff.txt', content: 'WRONG CONTENT\n' } }],
        };
      }
      return { content: 'Done.', toolCalls: [] };
    };

    const { conversationId, attemptId } = await seedSaathKarTurn(OBJECTIVE);
    const action = await pendingAction(conversationId, attemptId);
    await resolveApproval(action, 'approved');

    const terminal = await pollAttempt(attemptId, (a) => ['completed', 'failed'].includes(a.status));
    expect(terminal.status).toBe('failed');
    expect(terminal.failureReason).toMatch(/content does not match/i);
  });

  it('6. Correct file created with protected existing file unchanged -> success', async () => {
    const readmeBefore = fs.readFileSync(path.join(dir, 'README.md'), 'utf8');

    backend.script = (_obj, turn) => {
      if (turn === 0) {
        return {
          content: 'Creating jarvis-handoff.txt.',
          toolCalls: [{ name: 'propose_file_change', arguments: { path: 'jarvis-handoff.txt', content: EXACT_CONTENT } }],
        };
      }
      return { content: 'File created and verified.', toolCalls: [] };
    };

    const { conversationId, attemptId } = await seedSaathKarTurn(OBJECTIVE);
    const action = await pendingAction(conversationId, attemptId);
    await resolveApproval(action, 'approved');

    const terminal = await pollAttempt(attemptId, (a) => ['completed', 'failed'].includes(a.status));
    expect(terminal.status).toBe('completed');
    expect(fs.readFileSync(path.join(dir, 'README.md'), 'utf8')).toBe(readmeBefore);
  });

  it('7. Protected existing file changed -> failure', async () => {
    backend.script = (_obj, turn) => {
      if (turn === 0) {
        return {
          content: 'Modifying README.md.',
          toolCalls: [{ name: 'propose_file_change', arguments: { path: 'README.md', content: '# Modified README\n' } }],
        };
      }
      return { content: 'Done.', toolCalls: [] };
    };

    const { conversationId, attemptId } = await seedSaathKarTurn(OBJECTIVE);
    const action = await pendingAction(conversationId, attemptId);
    await resolveApproval(action, 'approved');

    const terminal = await pollAttempt(attemptId, (a) => ['completed', 'failed'].includes(a.status));
    expect(terminal.status).toBe('failed');
    expect(terminal.failureReason).toMatch(/objective violated/i);
  });

  it('8. Approval pause/resume preserves delivery requirements', async () => {
    backend.script = (_obj, turn) => {
      if (turn === 0) {
        return { content: 'Checking dir first.', toolCalls: [{ name: 'run_command', arguments: { command: 'dir' } }] };
      }
      if (turn === 1) {
        return {
          content: 'Now creating file.',
          toolCalls: [{ name: 'propose_file_change', arguments: { path: 'jarvis-handoff.txt', content: EXACT_CONTENT } }],
        };
      }
      return { content: 'Verified and finished.', toolCalls: [] };
    };

    const { conversationId, attemptId } = await seedSaathKarTurn(OBJECTIVE);

    // 1st pause: dir command
    const action1 = await pendingAction(conversationId, attemptId);
    expect(action1.toolName).toBe('run_command');
    await resolveApproval(action1, 'approved');

    // 2nd pause: propose_file_change
    const action2 = await pendingAction(conversationId, attemptId);
    expect(action2.toolName).toBe('propose_file_change');
    await resolveApproval(action2, 'approved');

    const terminal = await pollAttempt(attemptId, (a) => ['completed', 'failed'].includes(a.status));
    expect(terminal.status).toBe('completed');
    expect(fs.readFileSync(path.join(dir, 'jarvis-handoff.txt'), 'utf8').trim()).toBe(EXACT_CONTENT);
  });
});
