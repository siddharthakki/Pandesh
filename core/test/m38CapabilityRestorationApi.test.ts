import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openCoreDatabase } from '../db/openCore';
import type { CoreDatabase } from '../db/connection';
import { startApiServer, type RunningApiServer } from '../api/server';
import { EventBroadcaster } from '../ws/broadcaster';
import { generateToken } from '../auth/token';
import { GovernedCapabilityRegistry } from '../runtime/governedCapability';
import { createGithubCapabilityAdapter, type GithubCommandExecutor } from '../runtime/githubCapability';

/**
 * Real-HTTP proof of `GET /v1/capabilities/actions` (the M38 webview/restart
 * restoration query) against a genuinely running Core API server — the same
 * process class the packaged extension talks to, and the one that survives
 * an Extension Host restart per ADR-7 (Core owns durable state; the
 * Extension Host does not). Each test in the "after simulated restart"
 * section deliberately opens a brand-new HTTP client (a fresh `fetch` call
 * with no shared in-process state) against the SAME running server/db to
 * stand in for "a fresh Extension Host reconnecting to the still-running
 * Core process" — proving restoration is genuinely server-side durable, not
 * an artifact of any client-side cache.
 */
const TOKEN = generateToken();
let dir: string;
let db: CoreDatabase;
let api: RunningApiServer;
let baseUrl: string;
let executorCalls: string[][];

function freshClient() {
  return (pathAndQuery: string, init: RequestInit & { idempotencyKey?: string; clientId?: string } = {}) => {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      'X-Client-Id': init.clientId ?? 'test-client',
      ...(init.headers as Record<string, string> | undefined),
    };
    if (init.idempotencyKey) headers['Idempotency-Key'] = init.idempotencyKey;
    return fetch(`${baseUrl}${pathAndQuery}`, { ...init, headers });
  };
}

let idempotencyCounter = 0;
function nextIdemp(): string {
  idempotencyCounter += 1;
  return `idemp-m38-restore-http-${idempotencyCounter}`;
}

function scriptedGithubExecutor(script: Record<string, { stdout?: string; code?: number }>): GithubCommandExecutor {
  const executor: GithubCommandExecutor = async (args) => {
    executorCalls.push(args);
    const key = args.join(' ');
    const match = Object.keys(script).find((prefix) => key.startsWith(prefix));
    return { stdout: match ? script[match].stdout ?? '' : '', stderr: '', code: match ? script[match].code ?? 0 : 0 };
  };
  return executor;
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karkedikha-m38-restore-api-'));
  db = openCoreDatabase(path.join(dir, 'core.db')).db;
  executorCalls = [];
  const registry = new GovernedCapabilityRegistry().register(
    createGithubCapabilityAdapter({
      repository: 'acme/widgets',
      cwd: dir,
      executor: scriptedGithubExecutor({
        'issue view 42 --repo acme/widgets --json comments': { stdout: JSON.stringify({ comments: [] }) },
        'issue comment 42': { stdout: 'posted' },
      }),
    }),
  );
  api = await startApiServer({
    db,
    token: TOKEN,
    broadcaster: new EventBroadcaster(),
    dataDir: dir,
    capabilityRegistry: registry,
    coreInfo: () => ({
      coreVersion: '0.1.0',
      apiVersion: 1,
      instanceId: 'test-instance',
      startedAt: new Date().toISOString(),
      nodeVersion: process.version,
      electronVersion: null,
      dataDir: dir,
    }),
    onShutdown: () => {},
  });
  baseUrl = `http://127.0.0.1:${api.port}`;
});

afterEach(async () => {
  await api.close();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('M38 GET /v1/capabilities/actions (restart/webview restoration) over real HTTP', () => {
  it('returns no attempt for a correlationId that never dispatched, over real HTTP', async () => {
    const client = freshClient();
    const response = await client('/v1/capabilities/actions?correlationId=chat-conv-never-seen');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ attemptId: null, actions: [] });
  });

  it('pending -> restored by a fresh HTTP client -> approve -> dispatch executes exactly once, verified over real HTTP', async () => {
    const liveClient = freshClient();
    const correlationId = 'chat-conv-restore-approve';
    const requestBody = { correlationId, toolName: 'github_comment_on_issue', arguments: { number: 42, body: 'Root cause analysis.' }, cwd: dir };

    const first = await liveClient('/v1/capabilities/dispatch', { method: 'POST', body: JSON.stringify(requestBody), idempotencyKey: nextIdemp() });
    const firstBody = await first.json() as { outcome: string; attemptId: string; approval: { id: string; expectedAttemptRevision: number; expectedAttemptStatus: string; requestedActionDigest: string; frozenContextHash: string } };
    expect(firstBody.outcome).toBe('approval_required');
    expect(executorCalls.length).toBe(0);

    // Simulated Extension Host restart: a brand-new HTTP client, no shared
    // in-process state, reconnecting to the SAME still-running Core server.
    const restoredClient = freshClient();
    const restored = await restoredClient(`/v1/capabilities/actions?correlationId=${encodeURIComponent(correlationId)}`);
    expect(restored.status).toBe(200);
    const restoredBody = await restored.json() as { attemptId: string; actions: Array<{ approvalId: string; actionable: boolean; requestedActionDigest: string; expectedAttemptRevision: number; expectedAttemptStatus: string; toolName: string; arguments: Record<string, unknown> }> };
    expect(restoredBody.attemptId).toBe(firstBody.attemptId);
    expect(restoredBody.actions).toHaveLength(1);
    const [action] = restoredBody.actions;
    expect(action.actionable).toBe(true);
    expect(action.approvalId).toBe(firstBody.approval.id);
    expect(action.requestedActionDigest).toBe(firstBody.approval.requestedActionDigest);
    expect(action.toolName).toBe('github_comment_on_issue');
    expect(action.arguments).toEqual({ number: 42, body: 'Root cause analysis.' });

    // Approve using EXACTLY the envelope fields the restored query returned (mirrors
    // AgentPanel.resolveRestoredCapabilityApproval), then dispatch once more with the
    // same correlationId/{toolName,arguments} — Core's own idempotent execute-after-approval path.
    const resolve = await restoredClient(`/v1/capabilities/approvals/${action.approvalId}/resolve`, {
      method: 'POST',
      idempotencyKey: nextIdemp(),
      body: JSON.stringify({
        resolution: 'approved',
        attemptId: restoredBody.attemptId,
        expectedAttemptRevision: action.expectedAttemptRevision,
        expectedAttemptStatus: action.expectedAttemptStatus,
        requestedActionDigest: action.requestedActionDigest,
        frozenContextHash: firstBody.approval.frozenContextHash,
      }),
    });
    expect(resolve.status).toBe(200);
    const dispatched = await restoredClient('/v1/capabilities/dispatch', { method: 'POST', body: JSON.stringify(requestBody), idempotencyKey: nextIdemp() });
    const dispatchedBody = await dispatched.json() as { outcome: string; toolInvocation: { status: string } };
    expect(dispatchedBody.outcome).toBe('executed');
    expect(dispatchedBody.toolInvocation.status).toBe('succeeded');
    expect(executorCalls.filter((c) => c[0] === 'issue' && c[1] === 'comment')).toHaveLength(1);

    // A THIRD fresh client (second "restart") sees it as resolved/non-actionable, never re-actionable.
    const secondRestore = await freshClient()(`/v1/capabilities/actions?correlationId=${encodeURIComponent(correlationId)}`);
    const secondRestoreBody = await secondRestore.json() as { actions: Array<{ actionable: boolean; outcome: string }> };
    expect(secondRestoreBody.actions[0].actionable).toBe(false);
    expect(secondRestoreBody.actions[0].outcome).toBe('succeeded');
  });

  it('pending -> restored by a fresh HTTP client -> deny -> zero executor calls, verified over real HTTP', async () => {
    const liveClient = freshClient();
    const correlationId = 'chat-conv-restore-deny';
    const requestBody = { correlationId, toolName: 'github_comment_on_issue', arguments: { number: 42, body: 'Spam?' }, cwd: dir };

    const first = await liveClient('/v1/capabilities/dispatch', { method: 'POST', body: JSON.stringify(requestBody), idempotencyKey: nextIdemp() });
    const firstBody = await first.json() as { attemptId: string; approval: { id: string } };

    const restoredClient = freshClient();
    const restored = await restoredClient(`/v1/capabilities/actions?correlationId=${encodeURIComponent(correlationId)}`);
    const restoredBody = await restored.json() as { attemptId: string; actions: Array<{ approvalId: string; expectedAttemptRevision: number; expectedAttemptStatus: string; requestedActionDigest: string; frozenContextHash: string }> };
    const [action] = restoredBody.actions;

    const resolve = await restoredClient(`/v1/capabilities/approvals/${action.approvalId}/resolve`, {
      method: 'POST',
      idempotencyKey: nextIdemp(),
      body: JSON.stringify({
        resolution: 'rejected',
        attemptId: restoredBody.attemptId,
        expectedAttemptRevision: action.expectedAttemptRevision,
        expectedAttemptStatus: action.expectedAttemptStatus,
        requestedActionDigest: action.requestedActionDigest,
        frozenContextHash: action.frozenContextHash,
      }),
    });
    expect(resolve.status).toBe(200);
    expect(executorCalls.length).toBe(0);

    const retried = await restoredClient('/v1/capabilities/dispatch', { method: 'POST', body: JSON.stringify(requestBody), idempotencyKey: nextIdemp() });
    const retriedBody = await retried.json() as { outcome: string };
    expect(retriedBody.outcome).toBe('denied');
    expect(executorCalls.length).toBe(0);

    const secondRestore = await freshClient()(`/v1/capabilities/actions?correlationId=${encodeURIComponent(correlationId)}`);
    const secondRestoreBody = await secondRestore.json() as { actions: Array<{ actionable: boolean; outcome: string }> };
    expect(secondRestoreBody.actions[0].actionable).toBe(false);
    expect(secondRestoreBody.actions[0].outcome).toBe('rejected');
  });

  it('requires correlationId (400) rather than defaulting or crashing', async () => {
    const response = await freshClient()('/v1/capabilities/actions');
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
  });
});
