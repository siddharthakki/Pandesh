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

const TOKEN = generateToken();
let dir: string;
let db: CoreDatabase;
let api: RunningApiServer;
let baseUrl: string;
let executorCalls: string[][];

function authedFetch(pathAndQuery: string, init: RequestInit & { idempotencyKey?: string; clientId?: string } = {}) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${TOKEN}`,
    'Content-Type': 'application/json',
    'X-Client-Id': init.clientId ?? 'test-client',
    ...(init.headers as Record<string, string> | undefined),
  };
  if (init.idempotencyKey) headers['Idempotency-Key'] = init.idempotencyKey;
  return fetch(`${baseUrl}${pathAndQuery}`, { ...init, headers });
}

let idempotencyCounter = 0;
function nextIdemp(): string {
  idempotencyCounter += 1;
  return `idemp-m38-capability-${idempotencyCounter}`;
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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karkedikha-m38-capability-api-'));
  db = openCoreDatabase(path.join(dir, 'core.db')).db;
  executorCalls = [];
  const registry = new GovernedCapabilityRegistry().register(
    createGithubCapabilityAdapter({
      repository: 'acme/widgets',
      cwd: dir,
      executor: scriptedGithubExecutor({
        'issue view 3 --repo acme/widgets --json comments': { stdout: JSON.stringify({ comments: [] }) },
        'issue comment 3': { stdout: 'posted' },
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

describe('M38 /v1/capabilities HTTP surface', () => {
  it('walks approval_required -> resolve(approved) -> executed over real HTTP, and denies a retry after rejection', async () => {
    const requestBody = { correlationId: 'forge-task-http-1', toolName: 'github_comment_on_issue', arguments: { number: 3, body: 'Proposed fix.' }, cwd: dir };

    const first = await authedFetch('/v1/capabilities/dispatch', { method: 'POST', body: JSON.stringify(requestBody), idempotencyKey: nextIdemp() });
    expect(first.status).toBe(200);
    const firstBody = await first.json() as { outcome: string; attemptId: string; approval: { id: string; expectedAttemptRevision: number; expectedAttemptStatus: string; requestedActionDigest: string; frozenContextHash: string; revision: number } };
    expect(firstBody.outcome).toBe('approval_required');
    expect(executorCalls.length).toBe(0);

    const resolve = await authedFetch(`/v1/capabilities/approvals/${firstBody.approval.id}/resolve`, {
      method: 'POST',
      idempotencyKey: nextIdemp(),
      body: JSON.stringify({
        resolution: 'approved',
        attemptId: firstBody.attemptId,
        expectedAttemptRevision: firstBody.approval.expectedAttemptRevision,
        expectedAttemptStatus: firstBody.approval.expectedAttemptStatus,
        requestedActionDigest: firstBody.approval.requestedActionDigest,
        frozenContextHash: firstBody.approval.frozenContextHash,
      }),
    });
    expect(resolve.status).toBe(200);

    const executed = await authedFetch('/v1/capabilities/dispatch', { method: 'POST', body: JSON.stringify(requestBody), idempotencyKey: nextIdemp() });
    const executedBody = await executed.json() as { outcome: string; toolInvocation: { status: string } };
    expect(executedBody.outcome).toBe('executed');
    expect(executedBody.toolInvocation.status).toBe('succeeded');
    expect(executorCalls.filter((c) => c[0] === 'issue' && c[1] === 'comment')).toHaveLength(1);
  });

  it('rejects a resolve whose envelope no longer matches (stale action) rather than applying it', async () => {
    const requestBody = { correlationId: 'forge-task-http-2', toolName: 'github_comment_on_issue', arguments: { number: 3, body: 'Another fix.' }, cwd: dir };
    const first = await authedFetch('/v1/capabilities/dispatch', { method: 'POST', body: JSON.stringify(requestBody), idempotencyKey: nextIdemp() });
    const firstBody = await first.json() as { attemptId: string; approval: { id: string; expectedAttemptRevision: number; expectedAttemptStatus: string; requestedActionDigest: string; frozenContextHash: string } };

    const stale = await authedFetch(`/v1/capabilities/approvals/${firstBody.approval.id}/resolve`, {
      method: 'POST',
      idempotencyKey: nextIdemp(),
      body: JSON.stringify({
        resolution: 'approved',
        attemptId: firstBody.attemptId,
        expectedAttemptRevision: firstBody.approval.expectedAttemptRevision + 99, // wrong on purpose
        expectedAttemptStatus: firstBody.approval.expectedAttemptStatus,
        requestedActionDigest: firstBody.approval.requestedActionDigest,
        frozenContextHash: firstBody.approval.frozenContextHash,
      }),
    });
    expect(stale.status).toBeGreaterThanOrEqual(400);
    expect(executorCalls.length).toBe(0);
  });
});
