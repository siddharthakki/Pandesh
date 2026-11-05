/**
 * M-benchmark P2 — the full validation tier must correspond to the FINAL
 * workspace state.
 *
 * The completion decision is backed by one full-tier validation. That
 * validation is evidence about ONE revision of the workspace: when an
 * approved edit lands after it ran, the result describes different bytes and
 * is stale. These tests drive the REAL Core executor and prove the rule:
 *
 *   A. STALE RESULT IS NOT REUSED — a repair edit after a failed full tier
 *      makes the recorded result stale, so the full tier runs AGAIN against
 *      the state the task ends on, and the task completes only if it passes.
 *   B. A FAILING FULL TIER IS NOT A SUCCESS — when the full tier still fails
 *      after the bounded repair, the attempt FAILS instead of reporting the
 *      task as done on a stale result.
 *   C. THE SUITE IS NOT RE-RUN WITHOUT A CODE CHANGE — a repair turn that
 *      changes nothing does not re-run the suite; the recorded failure is
 *      reused and the attempt fails.
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
const idemp = () => `idemp-m-bench-val-${++n}`;

/** Every validation command that actually ran, in order. */
let validationCalls: string[] = [];
/** How many times the expensive full gate has been asked to run. */
let fullGateRuns = 0;
/** When set, the expensive gate fails every time it runs. */
let failFullGateAlways = false;

function authedFetch(p: string, init: RequestInit & { idempotencyKey?: string } = {}) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', 'X-Client-Id': 'test-client',
    ...(init.headers as Record<string, string> | undefined),
  };
  if (init.idempotencyKey) headers['Idempotency-Key'] = init.idempotencyKey;
  return fetch(`${baseUrl}${p}`, { ...init, headers });
}
async function jsonOf(res: Response) { expect(res.ok).toBe(true); return res.json(); }

async function pollAttempt(id: string, pred: (a: any) => boolean, timeoutMs = 20_000) {
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

/** The recorded full-tier validations of this attempt, oldest first. */
function recordedFullValidations(attemptId: string): Array<{ status: string; revision: number; gates: string[] }> {
  const rows = db.all<{ status: string; evidence: string }>(
    "SELECT status, evidence FROM tool_invocations WHERE attemptId = ? AND toolName = 'workspace_validation' AND json_extract(evidence, '$.tier') = 'full' ORDER BY startedAt, rowid",
    [attemptId],
  );
  return rows.map((row) => {
    const evidence = JSON.parse(row.evidence) as { revision?: number; gates?: string[] };
    return { status: row.status, revision: Number(evidence.revision ?? -1), gates: evidence.gates ?? [] };
  });
}

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
      // The workspace declares one cheap gate (compile) and two expensive
      // ones (test, lint), so the cheap tier and the full tier are
      // distinguishable by the command that ran.
      validationCommandRunner: async (command) => {
        validationCalls.push(command);
        if (command === 'npm run test') {
          fullGateRuns += 1;
          if (failFullGateAlways || fullGateRuns === 1) return { status: 'failed' as const, exitCode: 1, output: 'FAIL: 1 test failed' };
        }
        return { status: 'succeeded' as const, exitCode: 0, output: 'ok' };
      },
    },
  });
  ws = attachWsServer({ httpServer: api.server, token: TOKEN, broadcaster, instanceId: 'test', latestSequence: () => 0 });
  baseUrl = `http://127.0.0.1:${api.port}`;
}

const FIRST_EDIT = 'line one\nline 2\nline three\n';
const SECOND_EDIT = 'line one\nline two\nline three\n';

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karkedikha-val-'));
  fs.writeFileSync(path.join(dir, 'note.txt'), 'line one\nline two\nline three\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: 'fixture', scripts: { compile: 'echo compile', test: 'echo test', lint: 'echo lint' },
  }), 'utf8');
  validationCalls = [];
  fullGateRuns = 0;
  failFullGateAlways = false;
});

afterEach(async () => {
  ws?.close();
  await api?.close();
  db?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('the full validation tier corresponds to the final workspace state', () => {
  it('re-runs the full tier after a repair edit and completes only when it passes', async () => {
    backend = new ScriptedBackend((_request, call) => {
      if (call === 1) {
        return { content: 'Proposing.', toolCalls: [{ name: 'propose_file_change', arguments: { path: 'note.txt', content: FIRST_EDIT } }] };
      }
      if (call === 2) {
        // The model declares the work done: the full tier runs here and fails.
        return { content: 'The change is in place.' };
      }
      if (call === 3) {
        // The bounded repair turn: the model edits again, so the workspace moves on.
        return { content: 'Repairing.', toolCalls: [{ name: 'propose_file_change', arguments: { path: 'note.txt', content: SECOND_EDIT } }] };
      }
      return { content: 'The change is in place.' };
    });
    await startCore();

    const turn = await seedTurn('Change the second line of note.txt to "line 2".');
    await pollAttempt(turn.attemptId, (attempt) => attempt.status === 'waiting_for_approval');
    await approve((await pendingActions(turn))[0]);

    // The repair edit asks for approval again.
    await pollAttempt(turn.attemptId, (attempt) => attempt.status === 'waiting_for_approval');
    await approve((await pendingActions(turn))[0]);

    const attempt = await pollAttempt(turn.attemptId, (a) => ['completed', 'failed'].includes(a.status));
    expect(attempt.status, String(attempt.failureReason)).toBe('completed');

    // The cheap gate ran after each edit; the expensive one ran at completion.
    expect(validationCalls.filter((command) => command === 'npm run compile').length).toBeGreaterThanOrEqual(2);
    // The full gate ran TWICE: once before the repair (it failed) and once
    // against the state the task ends on. A stale result is never reused.
    expect(validationCalls.filter((command) => command === 'npm run test').length).toBe(2);
    expect(validationCalls).toContain('npm run lint');

    // The recorded full validations: the first failed, the second passed, and
    // the second is the one that covers the final revision.
    const recorded = recordedFullValidations(turn.attemptId);
    expect(recorded.length).toBe(2);
    expect(recorded[0].status).toBe('failed');
    expect(recorded[1].status).toBe('succeeded');
    // Two mutations landed, so the workspace revision is 2 — and the passing
    // full validation is the one recorded against it.
    expect(recorded[1].revision).toBe(2);
    expect(recorded[0].revision).toBe(1);
  }, 60_000);

  it('fails the task when the full tier still fails after the bounded repair', async () => {
    backend = new ScriptedBackend((_request, call) => {
      if (call === 1) {
        return { content: 'Proposing.', toolCalls: [{ name: 'propose_file_change', arguments: { path: 'note.txt', content: FIRST_EDIT } }] };
      }
      if (call === 2) return { content: 'The change is in place.' };
      if (call === 3) {
        return { content: 'Repairing.', toolCalls: [{ name: 'propose_file_change', arguments: { path: 'note.txt', content: SECOND_EDIT } }] };
      }
      return { content: 'The change is in place.' };
    });
    await startCore();
    // The full gate fails EVERY time it runs.
    failFullGateAlways = true;

    const turn = await seedTurn('Change the second line of note.txt to "line 2".');
    await pollAttempt(turn.attemptId, (attempt) => attempt.status === 'waiting_for_approval');
    await approve((await pendingActions(turn))[0]);
    await pollAttempt(turn.attemptId, (attempt) => attempt.status === 'waiting_for_approval');
    await approve((await pendingActions(turn))[0]);

    const attempt = await pollAttempt(turn.attemptId, (a) => ['completed', 'failed'].includes(a.status));
    // The task is NOT reported as complete on a failing full tier.
    expect(attempt.status).toBe('failed');
    expect(String(attempt.failureReason ?? '')).toContain('final validation failed');
    // The repair edit changed the workspace, so the tier ran again against
    // the final revision — and failed again.
    expect(validationCalls.filter((command) => command === 'npm run test').length).toBe(2);
  }, 60_000);

  it('does not re-run the suite when the repair turn changes nothing', async () => {
    backend = new ScriptedBackend((_request, call) => {
      if (call === 1) {
        return { content: 'Proposing.', toolCalls: [{ name: 'propose_file_change', arguments: { path: 'note.txt', content: FIRST_EDIT } }] };
      }
      if (call === 2) return { content: 'The change is in place.' };
      // The repair turn changes NOTHING: the workspace stays at the same revision.
      return { content: 'The change is in place.' };
    });
    await startCore();

    const turn = await seedTurn('Change the second line of note.txt to "line 2".');
    await pollAttempt(turn.attemptId, (attempt) => attempt.status === 'waiting_for_approval');
    await approve((await pendingActions(turn))[0]);

    const attempt = await pollAttempt(turn.attemptId, (a) => ['completed', 'failed'].includes(a.status));
    expect(attempt.status).toBe('failed');
    // The expensive gate ran ONCE: without a code change there is nothing to
    // re-run, and the recorded failure is reused.
    expect(validationCalls.filter((command) => command === 'npm run test').length).toBe(1);
  }, 60_000);
});
