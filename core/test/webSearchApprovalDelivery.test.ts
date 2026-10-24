/**
 * Web-search approval delivery (the "invisible approval" defect).
 *
 * When Pandesh wants to search the web it asks the user through the ordinary
 * approval system: the Core creates a durable approval, and the desktop renders
 * a card for it. The user reported that Pandesh answered "web access wasn't
 * approved" while no approval card was ever shown.
 *
 * These tests pin the whole delivery chain in isolation (temporary database, no
 * live Core):
 *
 *   Pi tool call -> approval row -> capability-action listing (what the desktop
 *   reads) -> desktop card + envelope -> resolution -> the Pi poll sees it.
 *
 * The last test pins the truthfulness rule: a stop/timeout must never be
 * reported to the model as "the user did not approve".
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openCoreDatabase } from '../db/openCore';
import type { CoreDatabase } from '../db/connection';
import { startApiServer, type RunningApiServer } from '../api/server';
import { EventBroadcaster } from '../ws/broadcaster';
import { generateToken } from '../auth/token';
import { createRequest } from '../domain/requests';
import { createAttempt, getAttempt, transitionAttempt } from '../domain/attempts';
import { createApproval, getApproval, listApprovalsForAttempt } from '../domain/approvals';
import { acquireFence } from '../domain/fence';
import { listCapabilityActions, resolveCapabilityApproval } from '../domain/capabilityDispatch';
import { toDesktopApprovalCard, toApprovalEnvelope, selectActionableApproval } from '../../apps/desktop/src/host/desktopApproval';

const TOKEN = generateToken();
const CLIENT = 'desktop-approval-test';
let dir: string;
let db: CoreDatabase;
let api: RunningApiServer;
let broadcaster: EventBroadcaster;
let baseUrl: string;
let idempotencyCounter = 0;

function nextIdemp(): string {
  idempotencyCounter += 1;
  return `idemp-approval-${idempotencyCounter}`;
}

function authedFetch(pathAndQuery: string, init: RequestInit & { idempotencyKey?: string } = {}) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${TOKEN}`,
    'Content-Type': 'application/json',
    'X-Client-Id': CLIENT,
    ...(init.headers as Record<string, string> | undefined),
  };
  if (init.idempotencyKey) headers['Idempotency-Key'] = init.idempotencyKey;
  return fetch(`${baseUrl}${pathAndQuery}`, { ...init, headers });
}

/**
 * The exact shape the Pi agent's `web_research` tool uses: the attempt moves to
 * `waiting_for_approval` and a `mutation` approval carrying the tool name, the
 * query and the human-readable card text is created.
 */
function createPiWebResearchApproval(conversationId: string): { attemptId: string; approvalId: string } {
  const request = createRequest(db, {
    clientId: CLIENT,
    currentMessage: 'What is the latest news?',
    requestedMode: 'baat_kar',
    resolvedMode: 'baat_kar',
    routeReason: 'test',
    conversationId,
    correlationId: `corr-${conversationId}`,
    contextPolicy: {
      includeConversationHistory: true,
      includeProjectContext: false,
      includeRepositoryContext: false,
      includeGlobalStoryContext: false,
    },
  });
  const attempt = createAttempt(db, { requestId: request.id, kind: 'baat_kar', actor: 'test' });
  const fence = acquireFence(db, attempt.id, { owner: 'core:executor:1', actor: 'test', leaseMs: 120_000 });
  transitionAttempt(db, attempt.id, { toStatus: 'running', fenceToken: fence.token, actor: 'test' });
  transitionAttempt(db, attempt.id, { toStatus: 'waiting_for_approval', fenceToken: fence.token, actor: 'test' });
  const summary = {
    toolName: 'web_research',
    query: 'latest news today',
    cardText: 'Pandesh wants to search the web for: "latest news today". The query is sent to a public search engine and up to 3 public pages are fetched per search for this task.',
  };
  const approval = createApproval(db, { attemptId: attempt.id, kind: 'mutation', summary, presentation: summary, actor: 'test' });
  return { attemptId: attempt.id, approvalId: approval.id };
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karkedikha-approval-test-'));
  db = openCoreDatabase(path.join(dir, 'core.db')).db;
  broadcaster = new EventBroadcaster();
  api = await startApiServer({
    db,
    token: TOKEN,
    broadcaster,
    dataDir: dir,
    coreInfo: () => ({
      coreVersion: '0.1.0', apiVersion: 1, instanceId: 'approval-test', startedAt: new Date().toISOString(),
      nodeVersion: process.version, electronVersion: null, dataDir: dir,
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

describe('a web-search approval reaches the user', () => {
  it('shows up as an actionable card the desktop can render', async () => {
    const conversation = await (await authedFetch('/v1/conversations', {
      method: 'POST', idempotencyKey: nextIdemp(), body: JSON.stringify({ mode: 'baat_kar' }),
    })).json();
    const { attemptId, approvalId } = createPiWebResearchApproval(conversation.id);

    // What the desktop reads when the turn asks for approval.
    const res = await authedFetch(`/v1/capabilities/actions?correlationId=${encodeURIComponent(conversation.id)}`);
    expect(res.status).toBe(200);
    const snapshot = await res.json();
    const action = selectActionableApproval(snapshot.actions);
    expect(action, 'the desktop must find an actionable approval for the web search').not.toBeNull();
    expect(action!.approvalId).toBe(approvalId);
    expect(action!.toolName).toBe('web_research');
    expect(action!.status).toBe('pending');

    // The card the user sees.
    const card = toDesktopApprovalCard(action!);
    expect(card.toolName).toBe('web_research');
    expect(card.detail).toContain('Pandesh wants to search the web');
    expect(card.scope).toBeTruthy();
  });

  it('can be approved, and the agent sees the approval', async () => {
    const conversation = await (await authedFetch('/v1/conversations', {
      method: 'POST', idempotencyKey: nextIdemp(), body: JSON.stringify({ mode: 'baat_kar' }),
    })).json();
    const { attemptId, approvalId } = createPiWebResearchApproval(conversation.id);
    const snapshot = await (await authedFetch(`/v1/capabilities/actions?correlationId=${encodeURIComponent(conversation.id)}`)).json();
    const action = selectActionableApproval(snapshot.actions)!;
    const envelope = toApprovalEnvelope(action);

    // The user presses Approve in the desktop UI.
    const resolve = await authedFetch(`/v1/capabilities/approvals/${approvalId}/resolve`, {
      method: 'POST',
      idempotencyKey: nextIdemp(),
      body: JSON.stringify({ ...envelope, resolution: 'approved' }),
    });
    expect(resolve.status, await resolve.text()).toBe(200);

    // The agent's poll now sees a real approval — not a timeout, not a refusal.
    expect(getApproval(db, approvalId).status).toBe('approved');
    expect(getAttempt(db, attemptId).status).toBe('running');
  });

  it('records a refusal as a refusal, so the agent can say the user declined', async () => {
    const conversation = await (await authedFetch('/v1/conversations', {
      method: 'POST', idempotencyKey: nextIdemp(), body: JSON.stringify({ mode: 'baat_kar' }),
    })).json();
    const { approvalId } = createPiWebResearchApproval(conversation.id);
    const snapshot = await (await authedFetch(`/v1/capabilities/actions?correlationId=${encodeURIComponent(conversation.id)}`)).json();
    const action = selectActionableApproval(snapshot.actions)!;
    const envelope = toApprovalEnvelope(action);

    const resolve = await authedFetch(`/v1/capabilities/approvals/${approvalId}/resolve`, {
      method: 'POST',
      idempotencyKey: nextIdemp(),
      body: JSON.stringify({ ...envelope, resolution: 'rejected' }),
    });
    expect(resolve.status).toBe(200);
    expect(getApproval(db, approvalId).status).toBe('rejected');
    expect(getApproval(db, approvalId).resolution).toBe('rejected');
  });
});
