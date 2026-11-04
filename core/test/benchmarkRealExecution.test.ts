/**
 * M-benchmark — the real execution verification.
 *
 * These are not unit tests: they drive the REAL Core executor through its
 * API, with a scripted model, a real workspace, real approvals and real
 * writes. They prove the three behaviours the benchmark measured and the
 * harness could not:
 *
 *   A. EDIT AND REPAIR — a `propose_text_edit` whose anchor does not resolve
 *      comes back with the BOUNDED, VERBATIM context of the current file, so
 *      the next attempt can copy the anchor exactly and land the edit.
 *   B. RESTART-SAFE MUTATION — the same change proposed again, after it has
 *      already landed, is written ONCE: the second execution is a verified
 *      no-op, and the ledger records the applied mutation.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openCoreDatabase } from '../db/openCore';
import type { CoreDatabase } from '../db/connection';
import { startApiServer, type RunningApiServer } from '../api/server';
import { attachWsServer } from '../ws/server';
import { EventBroadcaster } from '../ws/broadcaster';
import { generateToken } from '../auth/token';
import type { ModelBackend, ModelChatRequest, ModelChatResult, ModelToolCall } from '../runtime/modelBackend';
import { CoreToolRunner } from '../runtime/toolRunner';
import { GovernedCapabilityRegistry } from '../runtime/governedCapability';
import type { GovernedCapabilityAdapter, CapabilityHealth, CapabilityRisk } from '../runtime/governedCapability';

const TOKEN = generateToken();

type Script = (request: ModelChatRequest, call: number) => { content: string; toolCalls?: ModelToolCall[] };

class ScriptedBackend implements ModelBackend {
  calls = 0;
  requests: ModelChatRequest[] = [];
  constructor(public script: Script) {}
  async streamChat(request: ModelChatRequest): Promise<ModelChatResult> {
    this.requests.push({ ...request, messages: request.messages.map((message) => ({ ...message })) });
    const out = this.script(request, ++this.calls);
    return { content: out.content, toolCalls: out.toolCalls ?? [], provider: 'ollama', model: request.model, usage: { durationMs: 1 } };
  }
}

let dir: string;
let db: CoreDatabase;
let api: RunningApiServer;
let ws: { close(): void };
let baseUrl: string;
let backend: ScriptedBackend;
let n = 0;
const idemp = () => `idemp-m-bench-${++n}`;

function authedFetch(p: string, init: RequestInit & { idempotencyKey?: string } = {}) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', 'X-Client-Id': 'test-client',
    ...(init.headers as Record<string, string> | undefined),
  };
  if (init.idempotencyKey) headers['Idempotency-Key'] = init.idempotencyKey;
  return fetch(`${baseUrl}${p}`, { ...init, headers });
}
async function jsonOf(res: Response) { expect(res.ok).toBe(true); return res.json(); }

async function pollAttempt(id: string, pred: (a: any) => boolean, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const attempt = await (await authedFetch(`/v1/attempts/${id}`)).json();
    if (pred(attempt)) return attempt;
    if (Date.now() > deadline) throw new Error(`attempt ${id} never satisfied; last=${attempt.status} reason=${attempt.failureReason}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function seedTurn(message: string) {
  const conv = await jsonOf(await authedFetch('/v1/conversations', { method: 'POST', idempotencyKey: idemp(), body: JSON.stringify({ mode: 'saath_kar' }) }));
  await jsonOf(await authedFetch(`/v1/conversations/${conv.id}/messages`, { method: 'POST', idempotencyKey: idemp(), body: JSON.stringify({ role: 'user', content: message }) }));
  const req = await jsonOf(await authedFetch('/v1/requests', {
    method: 'POST', idempotencyKey: idemp(),
    body: JSON.stringify({
      currentMessage: message, requestedMode: 'saath_kar', resolvedMode: 'saath_kar', routeReason: 'test', conversationId: conv.id,
      contextPolicy: { includeConversationHistory: true, includeProjectContext: false, includeRepositoryContext: true, includeGlobalContext: false },
    }),
  }));
  const attempt = await jsonOf(await authedFetch('/v1/attempts', { method: 'POST', idempotencyKey: idemp(), body: JSON.stringify({ requestId: req.id, kind: 'saath_kar' }) }));
  await authedFetch(`/v1/attempts/${attempt.id}/execute`, { method: 'POST', idempotencyKey: idemp() });
  return { conversationId: conv.id as string, attemptId: attempt.id as string };
}

async function pendingActions(turn: { conversationId: string; attemptId: string }) {
  const snapshot = await (await authedFetch(`/v1/capabilities/actions?correlationId=${encodeURIComponent(turn.conversationId)}`)).json();
  return (snapshot.actions as Array<{ actionable: boolean; approvalId: string; attemptId: string; expectedAttemptRevision: number; expectedAttemptStatus: string; requestedActionDigest: string; frozenContextHash: string }>).filter((a) => a.actionable);
}

async function approve(action: any) {
  return jsonOf(await authedFetch(`/v1/capabilities/approvals/${action.approvalId}/resolve`, {
    method: 'POST', idempotencyKey: idemp(),
    body: JSON.stringify({
      resolution: 'approved', attemptId: action.attemptId, expectedAttemptRevision: action.expectedAttemptRevision,
      expectedAttemptStatus: action.expectedAttemptStatus, requestedActionDigest: action.requestedActionDigest, frozenContextHash: action.frozenContextHash,
    }),
  }));
}

const toolMessages = (request: ModelChatRequest) => request.messages.filter((message) => message.role === 'tool').map((message) => message.content).join('\n');

async function startCore() {
  db = openCoreDatabase(path.join(dir, 'core.db')).db;
  const broadcaster = new EventBroadcaster();
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
      validationCommandRunner: async () => ({ status: 'succeeded', exitCode: 0, output: 'ok' }),
    },
  });
  ws = attachWsServer({ httpServer: api.server, token: TOKEN, broadcaster, instanceId: 'test', latestSequence: () => 0 });
  baseUrl = `http://127.0.0.1:${api.port}`;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karkedikha-bench-'));
  fs.writeFileSync(path.join(dir, 'note.txt'), 'line one\nline two\nline three\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'fixture', scripts: {} }), 'utf8');
});

afterEach(async () => {
  ws?.close();
  await api?.close();
  db?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('A. edit and repair with bounded file context', () => {
  it('feeds the current file text back so the next anchor resolves, and the edit lands', async () => {
    backend = new ScriptedBackend((request, call) => {
      if (call === 1) {
        // The anchor does not exist in the file, but one of its lines does:
        // the bounded context quotes the real text around it.
        return {
          content: 'Editing.',
          toolCalls: [{ name: 'propose_text_edit', arguments: { path: 'note.txt', find: 'line two\nline three (changed)', replace: 'line 2' } }],
        };
      }
      if (call === 2) {
        // The model has now seen the real text and copies it exactly.
        return {
          content: 'Editing with the exact anchor.',
          toolCalls: [{ name: 'propose_text_edit', arguments: { path: 'note.txt', find: 'line two', replace: 'line 2' } }],
        };
      }
      return { content: 'The change is in place.' };
    });
    await startCore();

    const turn = await seedTurn('Change the second line of note.txt to "line 2".');
    // The first proposal is refused BEFORE any approval exists (the anchor
    // cannot resolve), so the model gets the context immediately.
    await pollAttempt(turn.attemptId, (attempt) => attempt.status === 'waiting_for_approval');

    // The refusal reached the model with the file's real text in it: that is
    // what lets the next attempt copy the anchor exactly.
    expect(backend.requests.length).toBeGreaterThanOrEqual(2);
    const refusalContext = toolMessages(backend.requests[1]);
    expect(refusalContext).toContain('NOT SUBMITTED');
    expect(refusalContext).toContain('edit_anchor_not_found');
    expect(refusalContext).toContain('note.txt');
    // The real file text is in the refusal: the model can copy it exactly.
    expect(refusalContext).toContain('line three');

    const actions = await pendingActions(turn);
    expect(actions).toHaveLength(1);
    await approve(actions[0]);
    const attempt = await pollAttempt(turn.attemptId, (a) => ['completed', 'failed'].includes(a.status));
    expect(attempt.status).toBe('completed');
    expect(fs.readFileSync(path.join(dir, 'note.txt'), 'utf8')).toBe('line one\nline 2\nline three\n');
  }, 40_000);
});

describe('B. restart-safe, idempotent mutation', () => {
  it('writes the file once when the same change is proposed again after it landed', async () => {
    backend = new ScriptedBackend((request) => {
      // Propose once per attempt (the model has not seen a tool result yet),
      // then summarise.
      const seenToolResult = request.messages.some((message) => message.role === 'tool');
      if (seenToolResult) return { content: 'The change is in place.' };
      return {
        content: 'Proposing.',
        toolCalls: [{ name: 'propose_file_change', arguments: { path: 'note.txt', content: 'line one\nline 2\nline three\n' } }],
      };
    });
    await startCore();

    const turn = await seedTurn('Change the second line of note.txt to "line 2".');
    await pollAttempt(turn.attemptId, (attempt) => attempt.status === 'waiting_for_approval');
    const [action] = await pendingActions(turn);
    await approve(action);
    await pollAttempt(turn.attemptId, (a) => ['completed', 'failed'].includes(a.status));
    expect(fs.readFileSync(path.join(dir, 'note.txt'), 'utf8')).toBe('line one\nline 2\nline three\n');

    // The ledger recorded the mutation, with the pre-image and the result.
    const ledger = db.all('SELECT toolName, path, baselineSha256, resultSha256, status FROM mutation_ledger WHERE toolName = ?', ['propose_file_change']) as Array<Record<string, string>>;
    expect(ledger.length).toBeGreaterThanOrEqual(1);
    expect(ledger[0].status).toBe('applied');
    expect(ledger[0].resultSha256).not.toBe(ledger[0].baselineSha256);

    // A SECOND attempt proposes exactly the same change. It must not write
    // again: the file already holds that content, so the write is a verified
    // no-op.
    const second = await seedTurn('Change the second line of note.txt to "line 2".');
    await pollAttempt(second.attemptId, (attempt) => attempt.status === 'waiting_for_approval');
    const [secondAction] = await pendingActions(second);
    await approve(secondAction);
    const secondAttempt = await pollAttempt(second.attemptId, (a) => ['completed', 'failed'].includes(a.status));
    expect(secondAttempt.status, String(secondAttempt.failureReason)).toBe('completed');

    const invocations = db.all(
      "SELECT toolName, status, evidence FROM tool_invocations WHERE toolName = 'propose_file_change' ORDER BY startedAt",
    ) as Array<{ toolName: string; status: string; evidence: string }>;
    expect(invocations.length).toBeGreaterThanOrEqual(2);
    const categories = invocations.map((row) => {
      try { return String((JSON.parse(row.evidence) as { resultCategory?: string }).resultCategory ?? ''); } catch { return ''; }
    });
    expect(categories).toContain('mutation_already_applied');

    // The file is byte-identical: the change was written exactly once.
    expect(fs.readFileSync(path.join(dir, 'note.txt'), 'utf8')).toBe('line one\nline 2\nline three\n');
  }, 60_000);
});
