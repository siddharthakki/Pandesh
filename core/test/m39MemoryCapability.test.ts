/**
 * M39 focused governance tests — the memory capability on the real M38
 * dispatch path (`core/domain/capabilityDispatch.ts`), plus real Core HTTP.
 *
 * These prove the consent, exactly-once, sticky-denial, restart-restoration,
 * and cancellation behavior is inherited from M38 rather than reinvented.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openCoreDatabase } from '../db/openCore';
import type { CoreDatabase } from '../db/connection';
import { dispatchCapability, resolveCapabilityApproval, cancelCapabilityAction, listCapabilityActions } from '../domain/capabilityDispatch';
import { GovernedCapabilityRegistry } from '../runtime/governedCapability';
import { createMemoryCapabilityAdapter, MEMORY_CONSEQUENTIAL_TOOLS, MEMORY_READ_ONLY_TOOLS } from '../runtime/memoryCapability';
import { createConversation, appendMessage } from '../domain/conversations';
import { createProject } from '../domain/projects';
import { startApiServer, type RunningApiServer } from '../api/server';
import { EventBroadcaster } from '../ws/broadcaster';
import { generateToken } from '../auth/token';
import type { ApprovalRecord } from '../shared/wireTypes';

const FIXTURE_TOKEN = 'ghp_M39FIXTUREtokenAAAAAAAAAAAAAAAAAAAA';
const CLIENT = 'test-client';

let dir: string;
let dbPath: string;
let db: CoreDatabase;
let conversationId: string;

function openIsolatedCore(): CoreDatabase {
  return openCoreDatabase(dbPath).db;
}

function seed(database: CoreDatabase): string {
  createProject(database, { name: 'Atlas', actor: 'test:actor' });
  const conversation = createConversation(database, { mode: 'saath_kar', actor: 'test:actor' });
  appendMessage(database, conversation.id, {
    role: 'user',
    content: 'For project Atlas, use SQLite as the authoritative memory store.',
    actor: 'test:actor',
  });
  return conversation.id;
}

function registryFor(database: CoreDatabase): GovernedCapabilityRegistry {
  return new GovernedCapabilityRegistry().register(createMemoryCapabilityAdapter({ db: database }));
}

function rememberArgs(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    memoryType: 'semantic',
    scopeType: 'project',
    scopeId: 'Atlas',
    subject: 'authoritative memory store',
    predicate: 'is',
    value: 'SQLite',
    sensitivity: 'internal',
    affectedEntities: [
      { type: 'repository_file', canonicalKey: 'src/storage.ts' },
      { type: 'github_issue', canonicalKey: 'fixture/repository#39' },
      { type: 'product_record', canonicalKey: 'Atlas' },
    ],
    ...overrides,
  };
}

function dispatchInput(database: CoreDatabase, toolName: string, args: Record<string, unknown>) {
  return {
    correlationId: conversationId,
    toolName,
    arguments: args,
    cwd: dir,
    actor: CLIENT,
    clientId: CLIENT,
  };
}

function decisionFrom(approval: ApprovalRecord, resolution: 'approved' | 'rejected') {
  return {
    approvalId: approval.id,
    resolution,
    attemptId: approval.attemptId,
    expectedAttemptRevision: approval.expectedAttemptRevision,
    expectedAttemptStatus: approval.expectedAttemptStatus,
    requestedActionDigest: approval.requestedActionDigest,
    frozenContextHash: approval.frozenContextHash,
    actor: CLIENT,
    clientId: CLIENT,
    idempotencyKey: `idemp-${approval.id}-${resolution}`,
  };
}

function count(database: CoreDatabase, table: string): number {
  return Number(database.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)!.n);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karkedikha-m39-capability-'));
  dbPath = path.join(dir, 'core.db');
  db = openIsolatedCore();
  conversationId = seed(db);
});

afterEach(() => {
  try { db.close(); } catch { /* already closed by a restart test */ }
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('M39 memory capability classification', () => {
  it('classifies consequential and read-only memory tools exactly as the contract requires', () => {
    const registry = registryFor(db);
    for (const tool of MEMORY_CONSEQUENTIAL_TOOLS) expect(registry.classify(tool)).toEqual({ capabilityId: 'memory', risk: 'consequential' });
    for (const tool of MEMORY_READ_ONLY_TOOLS) expect(registry.classify(tool)).toEqual({ capabilityId: 'memory', risk: 'read_only' });
  });
});

describe('M39 consent gate', () => {
  it('writes nothing before approval and exactly one fact after it', async () => {
    const registry = registryFor(db);
    const first = await dispatchCapability(db, registry, dispatchInput(db, 'memory_remember', rememberArgs()));
    expect(first.outcome).toBe('approval_required');
    expect(count(db, 'memory_facts')).toBe(0);
    expect(count(db, 'memory_evidence')).toBe(0);
    expect(count(db, 'knowledge_entities')).toBe(0);

    if (first.outcome !== 'approval_required') throw new Error('unreachable');
    resolveCapabilityApproval(db, decisionFrom(first.approval, 'approved'));
    const executed = await dispatchCapability(db, registry, dispatchInput(db, 'memory_remember', rememberArgs()));
    expect(executed.outcome).toBe('executed');
    expect(count(db, 'memory_facts')).toBe(1);
    expect(count(db, 'memory_evidence')).toBe(1);
    expect(count(db, 'knowledge_relationships')).toBe(4);
  });

  it('a repeated approved dispatch executes the adapter once and never duplicates the row', async () => {
    const registry = registryFor(db);
    const pending = await dispatchCapability(db, registry, dispatchInput(db, 'memory_remember', rememberArgs()));
    if (pending.outcome !== 'approval_required') throw new Error('expected approval_required');
    resolveCapabilityApproval(db, decisionFrom(pending.approval, 'approved'));
    const first = await dispatchCapability(db, registry, dispatchInput(db, 'memory_remember', rememberArgs()));
    const second = await dispatchCapability(db, registry, dispatchInput(db, 'memory_remember', rememberArgs()));
    const third = await dispatchCapability(db, registry, dispatchInput(db, 'memory_remember', rememberArgs()));
    expect([first.outcome, second.outcome, third.outcome]).toEqual(['executed', 'executed', 'executed']);
    if (first.outcome !== 'executed' || second.outcome !== 'executed' || third.outcome !== 'executed') throw new Error('unreachable');
    // The same terminal invocation is returned; the adapter is not re-run.
    expect(second.toolInvocation.id).toBe(first.toolInvocation.id);
    expect(third.toolInvocation.id).toBe(first.toolInvocation.id);
    expect(count(db, 'memory_facts')).toBe(1);
    expect(count(db, 'tool_invocations')).toBe(1);
  });

  it('a rejected remember writes zero rows and stays denied on retry', async () => {
    const registry = registryFor(db);
    const pending = await dispatchCapability(db, registry, dispatchInput(db, 'memory_remember', rememberArgs()));
    if (pending.outcome !== 'approval_required') throw new Error('expected approval_required');
    resolveCapabilityApproval(db, decisionFrom(pending.approval, 'rejected'));
    const retried = await dispatchCapability(db, registry, dispatchInput(db, 'memory_remember', rememberArgs()));
    expect(retried.outcome).toBe('denied');
    expect(count(db, 'memory_facts')).toBe(0);
    expect(count(db, 'tool_invocations')).toBe(0);
    const again = await dispatchCapability(db, registry, dispatchInput(db, 'memory_remember', rememberArgs()));
    expect(again.outcome).toBe('denied');
  });

  it('read-only recall/impact/export execute without a mutation approval', async () => {
    const registry = registryFor(db);
    const recall = await dispatchCapability(db, registry, dispatchInput(db, 'memory_recall', { scopeType: 'project', scopeId: 'Atlas' }));
    expect(recall.outcome).toBe('executed');
    const exported = await dispatchCapability(db, registry, dispatchInput(db, 'memory_export', { scopeType: 'project', scopeId: 'Atlas' }));
    expect(exported.outcome).toBe('executed');
    expect(count(db, 'approvals')).toBe(0);
  });
});

describe('M39 sensitive-data behavior on the governed path', () => {
  it('keeps a raw fixture token out of every M39 table, the approval envelope, and tool-invocation evidence', async () => {
    const registry = registryFor(db);
    const args = rememberArgs({ sensitivity: 'restricted', value: `deploy with ${FIXTURE_TOKEN}`, affectedEntities: [] });
    const pending = await dispatchCapability(db, registry, dispatchInput(db, 'memory_remember', args));
    expect(pending.outcome).toBe('approval_required');
    if (pending.outcome !== 'approval_required') throw new Error('unreachable');
    // Even the approval summary the user is shown is already redacted.
    expect(JSON.stringify(pending.approval.summary)).not.toContain(FIXTURE_TOKEN);

    resolveCapabilityApproval(db, decisionFrom(pending.approval, 'approved'));
    const executed = await dispatchCapability(db, registry, dispatchInput(db, 'memory_remember', args));
    expect(executed.outcome).toBe('executed');
    if (executed.outcome !== 'executed') throw new Error('unreachable');
    // Restricted + credential-shaped => fail closed, zero M39 writes.
    expect(executed.toolInvocation.status).toBe('failed');
    expect(count(db, 'memory_facts')).toBe(0);
    expect(count(db, 'memory_evidence')).toBe(0);
    expect(count(db, 'knowledge_entities')).toBe(0);
    for (const table of ['memory_facts', 'memory_evidence', 'knowledge_entities', 'knowledge_relationships', 'memory_contradictions', 'tool_invocations', 'approvals']) {
      expect(JSON.stringify(db.all(`SELECT * FROM ${table}`)), table).not.toContain(FIXTURE_TOKEN);
    }
  });
});

describe('M39 restart restoration and cancellation', () => {
  it('restores a pending memory approval after a Core restart and then writes exactly once', async () => {
    const registry = registryFor(db);
    const pending = await dispatchCapability(db, registry, dispatchInput(db, 'memory_remember', rememberArgs()));
    if (pending.outcome !== 'approval_required') throw new Error('expected approval_required');
    db.close();

    // Fresh Core process against the same durable database.
    const restarted = openIsolatedCore();
    db = restarted;
    const snapshot = listCapabilityActions(restarted, { correlationId: conversationId, clientId: CLIENT });
    expect(snapshot.actions).toHaveLength(1);
    expect(snapshot.actions[0].actionable).toBe(true);
    expect(snapshot.actions[0].toolName).toBe('memory_remember');
    expect(count(restarted, 'memory_facts')).toBe(0);

    const restartedRegistry = registryFor(restarted);
    resolveCapabilityApproval(restarted, decisionFrom(pending.approval, 'approved'));
    await dispatchCapability(restarted, restartedRegistry, dispatchInput(restarted, 'memory_remember', rememberArgs()));
    await dispatchCapability(restarted, restartedRegistry, dispatchInput(restarted, 'memory_remember', rememberArgs()));
    expect(count(restarted, 'memory_facts')).toBe(1);
    const after = listCapabilityActions(restarted, { correlationId: conversationId, clientId: CLIENT });
    expect(after.actions[0].actionable).toBe(false);
    expect(after.actions[0].outcome).toBe('succeeded');
  });

  it('cancellation before the memory transaction commits writes zero rows and ignores late completion', async () => {
    const registry = registryFor(db);
    const pending = await dispatchCapability(db, registry, dispatchInput(db, 'memory_remember', rememberArgs()));
    if (pending.outcome !== 'approval_required') throw new Error('expected approval_required');
    resolveCapabilityApproval(db, decisionFrom(pending.approval, 'approved'));
    // Cancel first: the adapter observes an already-aborted signal and must
    // perform zero writes rather than committing and being "fenced" after.
    cancelCapabilityAction(db, pending.attemptId, { actor: CLIENT, clientId: CLIENT });
    const executed = await dispatchCapability(db, registry, dispatchInput(db, 'memory_remember', rememberArgs()));
    expect(executed.outcome).toBe('executed');
    if (executed.outcome !== 'executed') throw new Error('unreachable');
    expect(executed.toolInvocation.status).toBe('cancelled');
    expect(count(db, 'memory_facts')).toBe(0);
    expect(count(db, 'memory_evidence')).toBe(0);
  });
});

describe('M39 memory over real Core HTTP', () => {
  let api: RunningApiServer;
  let baseUrl: string;
  const TOKEN = generateToken();

  async function authedFetch(pathAndQuery: string, init: RequestInit & { idempotencyKey?: string } = {}) {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      'X-Client-Id': CLIENT,
      ...(init.headers as Record<string, string> | undefined),
    };
    if (init.idempotencyKey) headers['Idempotency-Key'] = init.idempotencyKey;
    return fetch(`${baseUrl}${pathAndQuery}`, { ...init, headers });
  }

  beforeEach(async () => {
    api = await startApiServer({
      db,
      token: TOKEN,
      broadcaster: new EventBroadcaster(),
      dataDir: dir,
      capabilityRegistry: registryFor(db),
      coreInfo: () => ({
        coreVersion: '0.1.0', apiVersion: 1, instanceId: 'test-instance',
        startedAt: new Date().toISOString(), nodeVersion: process.version, electronVersion: null, dataDir: dir,
      }),
      onShutdown: () => {},
    });
    baseUrl = `http://127.0.0.1:${api.port}`;
  });

  afterEach(async () => { await api.close(); });

  it('walks approval_required -> resolve(approved) -> executed -> recall over real HTTP', async () => {
    const body = JSON.stringify({ correlationId: conversationId, toolName: 'memory_remember', arguments: rememberArgs(), cwd: dir });
    const pending = await (await authedFetch('/v1/capabilities/dispatch', { method: 'POST', body })).json() as
      { outcome: string; attemptId: string; approval: ApprovalRecord };
    expect(pending.outcome).toBe('approval_required');
    expect(count(db, 'memory_facts')).toBe(0);

    const resolveResponse = await authedFetch(`/v1/capabilities/approvals/${pending.approval.id}/resolve`, {
      method: 'POST',
      idempotencyKey: 'idemp-m39-http-approve',
      body: JSON.stringify({
        resolution: 'approved',
        attemptId: pending.attemptId,
        expectedAttemptRevision: pending.approval.expectedAttemptRevision,
        expectedAttemptStatus: pending.approval.expectedAttemptStatus,
        requestedActionDigest: pending.approval.requestedActionDigest,
        frozenContextHash: pending.approval.frozenContextHash,
      }),
    });
    expect(resolveResponse.status).toBe(200);

    const executed = await (await authedFetch('/v1/capabilities/dispatch', { method: 'POST', body })).json() as
      { outcome: string; toolInvocation: { status: string; evidence: Record<string, unknown> } };
    expect(executed.outcome).toBe('executed');
    expect(executed.toolInvocation.status).toBe('succeeded');
    expect(count(db, 'memory_facts')).toBe(1);

    const recalled = await (await authedFetch('/v1/capabilities/dispatch', {
      method: 'POST',
      body: JSON.stringify({ correlationId: conversationId, toolName: 'memory_recall', arguments: { scopeType: 'project', scopeId: 'Atlas' }, cwd: dir }),
    })).json() as { outcome: string; toolInvocation: { evidence: { output: string } } };
    expect(recalled.outcome).toBe('executed');
    const payload = JSON.parse(recalled.toolInvocation.evidence.output) as { entries: Array<{ kind: string; evidence: unknown[] }> };
    expect(payload.entries).toHaveLength(1);
    expect(payload.entries[0].kind).toBe('durable_fact');
    expect(payload.entries[0].evidence).toHaveLength(1);

    const actions = await (await authedFetch(`/v1/capabilities/actions?correlationId=${conversationId}`)).json() as
      { actions: Array<{ toolName: string; actionable: boolean; outcome: string }> };
    expect(actions.actions).toHaveLength(1);
    expect(actions.actions[0]).toMatchObject({ toolName: 'memory_remember', actionable: false, outcome: 'succeeded' });
  });
});

describe('M39 large governed evidence (regression)', () => {
  it('a large memory export completes instead of failing the attempt on the runtime-event metadata bound', async () => {
    const registry = registryFor(db);
    // Seed enough memory that the export payload comfortably exceeds the
    // 8 KiB `runtime_events.metadata` hard limit that previously threw and
    // failed the whole Saath Kar attempt.
    for (let index = 0; index < 6; index += 1) {
      const messageId = appendMessage(db, conversationId, {
        role: 'user',
        content: `For project Atlas, decision number ${index} is recorded with a deliberately long justification: ${'x'.repeat(200)}`,
        actor: 'test:actor',
      }).id;
      const args = rememberArgs({ subject: `decision ${index}`, value: `value ${index} ${'y'.repeat(120)}`, sourceMessageId: messageId });
      const pending = await dispatchCapability(db, registry, dispatchInput(db, 'memory_remember', args));
      if (pending.outcome !== 'approval_required') throw new Error('expected approval_required');
      resolveCapabilityApproval(db, decisionFrom(pending.approval, 'approved'));
      await dispatchCapability(db, registry, dispatchInput(db, 'memory_remember', args));
    }
    expect(count(db, 'memory_facts')).toBe(6);

    const exported = await dispatchCapability(db, registry, dispatchInput(db, 'memory_export', { scopeType: 'project', scopeId: 'Atlas' }));
    expect(exported.outcome).toBe('executed');
    if (exported.outcome !== 'executed') throw new Error('unreachable');
    expect(exported.toolInvocation.status).toBe('succeeded');
    const output = String((exported.toolInvocation.evidence as { output?: string }).output ?? '');
    // Larger than the 8 KiB runtime-event limit that used to be fatal, and
    // still stored complete rather than replaced by a truncation marker.
    expect(output.length).toBeGreaterThan(8192);
    expect(output.length).toBeLessThan(32_000);
    // The durable evidence is complete and still parseable — never replaced
    // by a truncation marker.
    const payload = JSON.parse(output) as { memoryCount: number; memories: unknown[] };
    expect(payload.memoryCount).toBe(6);
    expect(payload.memories).toHaveLength(6);
    // The runtime-event projection is bounded rather than fatal.
    const events = db.all<{ metadata: string }>("SELECT metadata FROM runtime_events WHERE eventType = 'tool_invocation_completed'");
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) expect(Buffer.byteLength(event.metadata, 'utf8')).toBeLessThanOrEqual(8192);
  });
});
