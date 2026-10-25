import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CoreDatabase } from '../db/connection';
import { openCoreDatabase } from '../db/openCore';
import { submitRequest } from '../domain/submission';
import { failDeadExecutorAttemptsOnBoot } from '../domain/bootReconciliation';
import { acquireFence } from '../domain/fence';
import { requestCancelAttempt, transitionAttempt, failAttempt, getAttempt } from '../domain/attempts';
import { startToolInvocation, completeToolInvocation } from '../domain/toolInvocations';
import { listApprovalsForAttempt } from '../domain/approvals';
import { getAttemptContext } from '../domain/attemptContext';
import { getTaskOutcome } from '../domain/taskOutcomes';
import { listCheckpointsForAttempt } from '../domain/checkpoints';
import {
  createIntent, evaluateChecks, getIntent, getIntentByRequest, latestIntentAttempt, resumeBriefForAttempt,
  resumeIntent, settleIntentAfterAttempt, snapshotIntent, INTENT_CHECKPOINT_KIND,
} from '../domain/intents';
import { RuntimeExecutor } from '../runtime/executor';
import { EventBroadcaster } from '../ws/broadcaster';
import type { ModelBackend, ModelChatRequest, ModelChatResult } from '../runtime/modelBackend';

let dir: string;
let workspace: string;
let db: CoreDatabase;
const DEAD_PID = 2_147_000_001;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'intent-kernel-'));
  workspace = path.join(dir, 'ws');
  fs.mkdirSync(workspace);
  db = openCoreDatabase(path.join(dir, 'core.db')).db;
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const ALLOWED = ['read_file', 'propose_file_change'];

function submit(message = 'Create a.txt, b.txt and c.txt, each containing its own name.', model = 'model-a') {
  return submitRequest(db, {
    clientId: 'intent-test',
    currentMessage: message,
    requestedMode: 'saath_kar',
    workspaceRoot: workspace,
    requestedProvider: 'ollama',
    requestedModel: model,
    selectedProvider: 'ollama',
    selectedModel: model,
    capability: { hasWorkspace: true, gitCapable: false },
    effectiveAllowedTools: ALLOWED,
    toolPermissionPolicy: { profile: 'confirm-mutations', allowedTools: ALLOWED },
    correlationId: `corr-${Math.random()}`,
  });
}

const threeFiles = [
  { kind: 'file_contains', path: 'a.txt', text: 'a' },
  { kind: 'file_contains', path: 'b.txt', text: 'b' },
  { kind: 'file_contains', path: 'c.txt', text: 'c' },
];

/** Model A wrote a.txt, was mid-write on b.txt when the executor died, and the boot sweep failed it. */
function crashedAfterFirstWrite() {
  const { request, attempt } = submit();
  const intent = createIntent(db, { requestId: request.id, checks: threeFiles, actor: 'test' });
  const fence = acquireFence(db, attempt.id, { owner: `core:executor:${DEAD_PID}`, actor: 'test', leaseMs: 60_000 });
  transitionAttempt(db, attempt.id, { toStatus: 'running', actor: 'test', fenceToken: fence.token });
  fs.writeFileSync(path.join(workspace, 'a.txt'), 'a');
  const done = startToolInvocation(db, { attemptId: attempt.id, toolName: 'write_file', argsSummary: { filePath: 'a.txt', content: 'a' }, actor: 'test' });
  completeToolInvocation(db, done.id, { status: 'succeeded', exitCode: 0, actor: 'test' });
  // in flight when the process died: never completed
  startToolInvocation(db, { attemptId: attempt.id, toolName: 'write_file', argsSummary: { filePath: 'b.txt', content: 'b' }, actor: 'test' });
  // an unrelated user file the recovery must never touch
  fs.writeFileSync(path.join(workspace, 'user-notes.txt'), 'mine');
  const settled = failDeadExecutorAttemptsOnBoot(db, { selfPid: process.pid, isProcessAlive: () => false });
  expect(settled).toEqual([expect.objectContaining({ attemptId: attempt.id, outcome: 'failed' })]);
  return { request, attempt, intent };
}

describe('intent creation', () => {
  it('stores typed checks confined to the workspace and is idempotent per request', () => {
    const { request } = submit();
    const a = createIntent(db, { requestId: request.id, checks: threeFiles, actor: 'test' });
    expect(a.status).toBe('active');
    expect(a.workspaceRoot).toBe(workspace);
    expect(createIntent(db, { requestId: request.id, checks: threeFiles, actor: 'test' }).id).toBe(a.id);
  });

  it('refuses checks that point outside the workspace or are malformed', () => {
    const { request } = submit();
    for (const bad of [
      [{ kind: 'file_exists', path: '../outside.txt' }],
      [{ kind: 'file_exists', path: path.join(os.tmpdir(), 'x.txt') }],
      [{ kind: 'file_contains', path: 'a.txt', text: '' }],
      [{ kind: 'file_sha256', path: 'a.txt', sha256: 'nope' }],
      [{ kind: 'run_command', path: 'a.txt' }],
      [],
    ]) {
      expect(() => createIntent(db, { requestId: request.id, checks: bad, actor: 'test' })).toThrow();
    }
  });
});

describe('deterministic checks', () => {
  it('judge the workspace as it is, not what anyone claims', () => {
    fs.writeFileSync(path.join(workspace, 'a.txt'), 'hello world');
    const sha = crypto.createHash('sha256').update('hello world').digest('hex');
    const results = evaluateChecks(workspace, [
      { kind: 'file_exists', path: 'a.txt' },
      { kind: 'file_contains', path: 'a.txt', text: 'world' },
      { kind: 'file_contains', path: 'a.txt', text: 'absent' },
      { kind: 'file_sha256', path: 'a.txt', sha256: sha },
      { kind: 'file_exists', path: 'missing.txt' },
    ]);
    expect(results.map((r) => r.passed)).toEqual([true, true, false, true, false]);
  });

  it('does not follow a link out of the workspace', () => {
    const outside = path.join(dir, 'secret.txt');
    fs.writeFileSync(outside, 'secret');
    try {
      fs.symlinkSync(outside, path.join(workspace, 'link.txt'));
    } catch {
      return; // symlink creation needs privileges on some Windows setups; nothing to assert there
    }
    const [r] = evaluateChecks(workspace, [{ kind: 'file_contains', path: 'link.txt', text: 'secret' }]);
    expect(r.passed).toBe(false);
  });
});

describe('recovery after a restart', () => {
  it('continues the same request on a different model from a ledger-built checkpoint', () => {
    const { request, attempt, intent } = crashedAfterFirstWrite();
    const out = resumeIntent(db, { intentId: intent.id, model: 'model-b', actor: 'test' });
    if (out.kind !== 'resumed') throw new Error(`expected resumed, got ${out.kind}`);

    expect(out.successor.requestId).toBe(request.id);
    expect(out.successor.predecessorAttemptId).toBe(attempt.id);
    expect(getAttemptContext(db, out.successor.id).selectedModel).toBe('model-b');
    expect(latestIntentAttempt(db, request.id)?.id).toBe(out.successor.id);
    expect(getIntent(db, intent.id)).toMatchObject({ status: 'recovering', resumeCount: 1 });

    const checkpoint = listCheckpointsForAttempt(db, attempt.id).find((c) => c.kind === INTENT_CHECKPOINT_KIND);
    expect(checkpoint?.metadata).toMatchObject({ intentId: intent.id, failedModel: 'model-a', successorModel: 'model-b', completed: 1, uncertain: 1, checksPassing: 1, checksTotal: 3 });
  });

  it('tells the successor what is done, what is uncertain (as Core observed it) and what still fails', () => {
    const { intent, attempt } = crashedAfterFirstWrite();
    const out = resumeIntent(db, { intentId: intent.id, model: 'model-b', actor: 'test' });
    if (out.kind !== 'resumed') throw new Error('expected resumed');
    const brief = resumeBriefForAttempt(db, out.successor.id) ?? '';
    expect(brief).toContain('do NOT repeat');
    expect(brief).toContain('write_file a.txt: completed');
    expect(brief).toMatch(/write_file b\.txt: Core observed: file does not exist/);
    expect(brief).toContain('PASS file_contains a.txt');
    expect(brief).toContain('FAIL file_contains b.txt');
    expect(brief).toContain('FAIL file_contains c.txt');
    expect(brief).toContain('Do not modify, delete or overwrite any other file');
    expect(resumeBriefForAttempt(db, attempt.id)).toBeUndefined();
  });

  it('never replays side effects or touches unrelated files: recovery only reads the workspace', () => {
    const { intent } = crashedAfterFirstWrite();
    const before = fs.readdirSync(workspace).sort().map((f) => [f, fs.readFileSync(path.join(workspace, f), 'utf8')]);
    resumeIntent(db, { intentId: intent.id, model: 'model-b', actor: 'test' });
    snapshotIntent(db, intent.id);
    const after = fs.readdirSync(workspace).sort().map((f) => [f, fs.readFileSync(path.join(workspace, f), 'utf8')]);
    expect(after).toEqual(before);
    expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM tool_invocations WHERE toolName = 'write_file'")?.n).toBe(2);
  });

  it('does not list Core task bookkeeping as a completed side effect', () => {
    const { attempt, intent } = crashedAfterFirstWrite();
    const t = startToolInvocation(db, { attemptId: attempt.id, toolName: 'update_task_outcome', argsSummary: { objective: 'x' }, actor: 'test' });
    completeToolInvocation(db, t.id, { status: 'succeeded', exitCode: 0, actor: 'test' });
    const out = resumeIntent(db, { intentId: intent.id, model: 'model-b', actor: 'test' });
    if (out.kind !== 'resumed') throw new Error('expected resumed');
    expect(resumeBriefForAttempt(db, out.successor.id)).not.toContain('update_task_outcome');
  });

  it('reports an in-flight write that did land as present rather than assuming it failed', () => {
    const { intent } = crashedAfterFirstWrite();
    fs.writeFileSync(path.join(workspace, 'b.txt'), 'b'); // the interrupted write actually completed
    const out = resumeIntent(db, { intentId: intent.id, model: 'model-b', actor: 'test' });
    if (out.kind !== 'resumed') throw new Error('expected resumed');
    expect(resumeBriefForAttempt(db, out.successor.id)).toMatch(/write_file b\.txt: Core observed: file exists \(1 bytes\)/);
    expect(resumeBriefForAttempt(db, out.successor.id)).toContain('PASS file_contains b.txt');
  });

  it('starts nothing when the interrupted run had in fact finished the work', () => {
    const { request, intent } = crashedAfterFirstWrite();
    fs.writeFileSync(path.join(workspace, 'b.txt'), 'b');
    fs.writeFileSync(path.join(workspace, 'c.txt'), 'c');
    const out = resumeIntent(db, { intentId: intent.id, model: 'model-b', actor: 'test' });
    expect(out.kind).toBe('already_satisfied');
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM attempts WHERE requestId = ?', [request.id])?.n).toBe(1);
    expect(getIntent(db, intent.id).status).toBe('verified');
    expect(getTaskOutcome(db, latestIntentAttempt(db, request.id)!.id)?.status).toBe('satisfied');
  });

  it('requires a different model and a failed, uncancelled predecessor', () => {
    const { intent } = crashedAfterFirstWrite();
    expect(() => resumeIntent(db, { intentId: intent.id, model: 'model-a', actor: 'test' })).toThrow(/already worked/);
    expect(() => resumeIntent(db, { intentId: intent.id, model: '  ', actor: 'test' })).toThrow();

    const second = submit('Another task entirely, with its own files to write.', 'model-a');
    const live = createIntent(db, { requestId: second.request.id, checks: threeFiles, actor: 'test' });
    expect(() => resumeIntent(db, { intentId: live.id, model: 'model-b', actor: 'test' })).toThrow(/only a failed/);
  });

  it('never resumes a task the user stopped', () => {
    const { request, attempt, intent } = (() => {
      const s = submit();
      const i = createIntent(db, { requestId: s.request.id, checks: threeFiles, actor: 'test' });
      const fence = acquireFence(db, s.attempt.id, { owner: `core:executor:${DEAD_PID}`, actor: 'test', leaseMs: 60_000 });
      transitionAttempt(db, s.attempt.id, { toStatus: 'running', actor: 'test', fenceToken: fence.token });
      requestCancelAttempt(db, s.attempt.id, { actor: 'user' });
      return { request: s.request, attempt: s.attempt, intent: i };
    })();
    failDeadExecutorAttemptsOnBoot(db, { selfPid: process.pid, isProcessAlive: () => false });
    expect(getAttempt(db, attempt.id).status).toBe('cancelled');
    settleIntentAfterAttempt(db, attempt.id, 'test');
    expect(getIntentByRequest(db, request.id)?.status).toBe('abandoned');
    expect(() => resumeIntent(db, { intentId: intent.id, model: 'model-b', actor: 'test' })).toThrow(/cannot be resumed/);
  });

  it('stops at the resume limit and hands the task to a person', () => {
    const s = submit();
    const intent = createIntent(db, { requestId: s.request.id, checks: threeFiles, maxResumes: 1, actor: 'test' });
    failAttempt(db, s.attempt.id, { actor: 'test', failureReason: 'Interrupted: restart' });
    const first = resumeIntent(db, { intentId: intent.id, model: 'model-b', actor: 'test' });
    if (first.kind !== 'resumed') throw new Error('expected resumed');
    failAttempt(db, first.successor.id, { actor: 'test', failureReason: 'Interrupted: restart' });
    settleIntentAfterAttempt(db, first.successor.id, 'test');
    const second = resumeIntent(db, { intentId: intent.id, model: 'model-c', actor: 'test' });
    expect(second.kind).toBe('needs_review');
    expect(getIntent(db, intent.id).status).toBe('needs_review');
  });
});

describe('permission boundaries on a resumed attempt', () => {
  it('re-freezes the same workspace, tools and approval policy, and inherits no approval', () => {
    const { attempt, intent } = crashedAfterFirstWrite();
    db.run(
      `INSERT INTO approvals (id, attemptId, kind, status, requestedAt, resolvedAt, resolution, summary)
       VALUES ('apr_pred', ?, 'mutation', 'approved', ?, ?, 'approved', '{}')`,
      [attempt.id, new Date().toISOString(), new Date().toISOString()],
    );
    expect(listApprovalsForAttempt(db, attempt.id)).toHaveLength(1);
    const out = resumeIntent(db, { intentId: intent.id, model: 'model-b', actor: 'test' });
    if (out.kind !== 'resumed') throw new Error('expected resumed');
    const before = getAttemptContext(db, attempt.id);
    const after = getAttemptContext(db, out.successor.id);
    expect(after.workspaceRoot).toBe(before.workspaceRoot);
    expect(after.permittedCapabilities.allowedTools).toEqual(before.permittedCapabilities.allowedTools);
    expect(after.approvalPolicy).toEqual(before.approvalPolicy);
    expect(listApprovalsForAttempt(db, out.successor.id)).toEqual([]);
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM mission_authorizations WHERE attemptId = ?', [out.successor.id])?.n).toBe(0);
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM execution_grants WHERE attemptId = ?', [out.successor.id])?.n).toBe(0);
  });

  it('refuses to resume if the attempt workspace no longer matches the intent', () => {
    const { intent } = crashedAfterFirstWrite();
    db.run('UPDATE intents SET workspaceRoot = ? WHERE id = ?', [path.join(dir, 'elsewhere'), intent.id]);
    expect(() => resumeIntent(db, { intentId: intent.id, model: 'model-b', actor: 'test' })).toThrow(/no longer matches/);
  });
});

describe('settlement is decided by the workspace, not the model', () => {
  it('does not accept a completed run whose checks fail', () => {
    const s = submit();
    const intent = createIntent(db, { requestId: s.request.id, checks: threeFiles, actor: 'test' });
    transitionAttempt(db, s.attempt.id, { toStatus: 'running', actor: 'test' });
    transitionAttempt(db, s.attempt.id, { toStatus: 'completed', actor: 'test' });
    const settled = settleIntentAfterAttempt(db, s.attempt.id, 'test');
    expect(settled?.intent.status).toBe('unverified');
    const outcome = getTaskOutcome(db, s.attempt.id);
    expect(outcome?.status).toBe('partial');
    expect(outcome?.blocker).toContain('even though the run reported completion');
    expect(getIntent(db, intent.id).verifiedAt).toBeNull();
  });

  it('verifies a run that failed after finishing the work, with check evidence', () => {
    const s = submit();
    createIntent(db, { requestId: s.request.id, checks: threeFiles.slice(0, 1), actor: 'test' });
    fs.writeFileSync(path.join(workspace, 'a.txt'), 'a');
    failAttempt(db, s.attempt.id, { actor: 'test', failureReason: 'model crashed after writing' });
    const settled = settleIntentAfterAttempt(db, s.attempt.id, 'test');
    expect(settled?.intent.status).toBe('verified');
    const outcome = getTaskOutcome(db, s.attempt.id);
    expect(outcome?.status).toBe('satisfied');
    expect(outcome?.evidence).toEqual([{ kind: 'check', reference: 'file_contains a.txt "a"' }]);
  });

  it('ignores a superseded attempt finishing late', () => {
    const { attempt, intent } = crashedAfterFirstWrite();
    resumeIntent(db, { intentId: intent.id, model: 'model-b', actor: 'test' });
    fs.writeFileSync(path.join(workspace, 'b.txt'), 'b');
    fs.writeFileSync(path.join(workspace, 'c.txt'), 'c');
    expect(settleIntentAfterAttempt(db, attempt.id, 'test')?.results).toEqual([]);
    expect(getIntent(db, intent.id).status).toBe('recovering');
  });
});

describe('executor integration', () => {
  class Chatty implements ModelBackend {
    async streamChat(request: ModelChatRequest): Promise<ModelChatResult> {
      return { content: 'All three files are done.', toolCalls: [], provider: 'ollama', model: request.model, finishReason: 'stop', usage: { durationMs: 1 } };
    }
  }

  it('does not let a model that says "done" verify an intent whose checks fail', async () => {
    const s = submit();
    createIntent(db, { requestId: s.request.id, checks: threeFiles, actor: 'test' });
    await new RuntimeExecutor(db, new EventBroadcaster(), { backend: new Chatty(), defaultWorkingDirectory: workspace, dataDir: dir }).execute(s.attempt.id);
    const intent = getIntentByRequest(db, s.request.id)!;
    expect(intent.status).not.toBe('verified');
    const latest = latestIntentAttempt(db, s.request.id)!;
    expect(getTaskOutcome(db, latest.id)?.status).not.toBe('satisfied');
  });

  it('verifies, and does not reroute, when the workspace already satisfies the intent', async () => {
    const s = submit();
    createIntent(db, { requestId: s.request.id, checks: threeFiles, actor: 'test' });
    for (const f of ['a', 'b', 'c']) fs.writeFileSync(path.join(workspace, `${f}.txt`), f);
    await new RuntimeExecutor(db, new EventBroadcaster(), { backend: new Chatty(), defaultWorkingDirectory: workspace, dataDir: dir }).execute(s.attempt.id);
    expect(getIntentByRequest(db, s.request.id)?.status).toBe('verified');
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM attempts WHERE requestId = ?', [s.request.id])?.n).toBe(1);
    expect(getTaskOutcome(db, s.attempt.id)?.status).toBe('satisfied');
  });
});
