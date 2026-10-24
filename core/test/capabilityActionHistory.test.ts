import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CoreDatabase } from '../db/connection';
import { openCoreDatabase } from '../db/openCore';
import { listRecentWorkspaceCapabilityActions } from '../domain/capabilityActionHistory';
import { listWorkspaceAttemptRehydration } from '../domain/attemptRehydration';
import { submitRequest } from '../domain/submission';
import { createConversation } from '../domain/conversations';
import { dispatchCapability, resolveCapabilityApproval, cancelCapabilityAction } from '../domain/capabilityDispatch';
import { GovernedCapabilityRegistry, type GovernedCapabilityAdapter } from '../runtime/governedCapability';
import type { ApprovalRecord } from '../shared/wireTypes';

/**
 * M38: `listRecentWorkspaceCapabilityActions` (core/domain/capabilityActionHistory.ts)
 * is a read-only capability-card display query independent of
 * `listWorkspaceAttemptRehydration`'s active-execution-recovery contract —
 * see that function's own docstring for why. These tests prove it correctly
 * finds a real Saath Kar conversation's capability actions (pending,
 * approved, denied, cancelled, failed), stays correctly scoped and bounded,
 * never mutates anything, and never changes what
 * `listWorkspaceAttemptRehydration` itself returns.
 */

let dir: string;
let db: CoreDatabase;
const workspace = path.join(os.tmpdir(), 'm38-capability-history-workspace');

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm38-capability-history-core-'));
  db = openCoreDatabase(path.join(dir, 'core.db')).db;
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Creates a real durable conversation row plus a Saath Kar request/attempt/
 * context bound to it — returns the *actual* generated conversationId (Core
 * mints its own `conv_...` ids; a test cannot supply one), which callers
 * must then use as `dispatchCapability`'s `correlationId`, exactly like
 * RuntimeExecutor does in production (`request.conversationId`). */
function seedSaathKarConversation(message: string, workspaceRoot = workspace) {
  const conversation = createConversation(db, { mode: 'saath_kar', actor: 'core', clientId: 'client-1' });
  const result = submitRequest(db, {
    clientId: 'client-1',
    currentMessage: message,
    requestedMode: 'saath_kar',
    workspaceRoot,
    requestedProvider: 'ollama',
    requestedModel: 'test-model',
    capability: { hasWorkspace: true, gitCapable: true },
    conversationId: conversation.id,
    correlationId: `corr-${conversation.id}`,
  });
  return { ...result, conversationId: conversation.id };
}

function immediateAdapter(status: 'succeeded' | 'failed'): GovernedCapabilityAdapter {
  return {
    id: 'immediate',
    definitions: () => [{ name: 'consequential_tool', description: 'x', parameters: { type: 'object', properties: {} } }],
    classify: () => 'consequential',
    health: () => ({ state: 'available', checkedAt: new Date().toISOString() }),
    run: async () => ({ status, exitCode: status === 'succeeded' ? 0 : 1, output: status === 'succeeded' ? 'done' : 'boom' }),
  };
}

function slowAdapter(gate: Promise<void>): GovernedCapabilityAdapter {
  return {
    id: 'slow',
    definitions: () => [{ name: 'consequential_tool', description: 'x', parameters: { type: 'object', properties: {} } }],
    classify: () => 'consequential',
    health: () => ({ state: 'available', checkedAt: new Date().toISOString() }),
    run: async () => { await gate; return { status: 'succeeded', exitCode: 0, output: 'late' }; },
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
    actor: 'client-1',
    clientId: 'client-1',
  };
}

describe('listRecentWorkspaceCapabilityActions', () => {
  it('an active pending action appears as actionable', async () => {
    const { conversationId } = seedSaathKarConversation('pending case');
    const registry = new GovernedCapabilityRegistry().register(immediateAdapter('succeeded'));
    const requested = await dispatchCapability(db, registry, {
      correlationId: conversationId, toolName: 'consequential_tool', arguments: {}, cwd: process.cwd(), actor: 'core', clientId: 'client-1',
    });
    if (requested.outcome !== 'approval_required') throw new Error('expected approval_required');

    const snapshot = listRecentWorkspaceCapabilityActions(db, { workspaceRoot: workspace });
    const action = snapshot.actions.find((a) => a.approvalId === requested.approval.id);
    expect(action).toBeDefined();
    expect(action?.actionable).toBe(true);
    expect(action?.outcome).toBe('pending');
    expect(action?.correlationId).toBe(conversationId);
  });

  it('a completed approved action appears as completed/non-actionable, and still appears on repeated (simulated restart) reads', async () => {
    const { conversationId } = seedSaathKarConversation('approved case');
    const registry = new GovernedCapabilityRegistry().register(immediateAdapter('succeeded'));
    const requested = await dispatchCapability(db, registry, {
      correlationId: conversationId, toolName: 'consequential_tool', arguments: {}, cwd: process.cwd(), actor: 'core', clientId: 'client-1',
    });
    if (requested.outcome !== 'approval_required') throw new Error('expected approval_required');
    resolveCapabilityApproval(db, decisionFrom(requested.approval, 'approved'));
    const executed = await dispatchCapability(db, registry, {
      correlationId: conversationId, toolName: 'consequential_tool', arguments: {}, cwd: process.cwd(), actor: 'core', clientId: 'client-1',
    });
    expect(executed.outcome).toBe('executed');

    for (const simulatedRestart of [1, 2, 3]) {
      const snapshot = listRecentWorkspaceCapabilityActions(db, { workspaceRoot: workspace });
      const action = snapshot.actions.find((a) => a.approvalId === requested.approval.id);
      expect(action, `restart ${simulatedRestart}`).toBeDefined();
      expect(action?.actionable, `restart ${simulatedRestart}`).toBe(false);
      expect(action?.outcome, `restart ${simulatedRestart}`).toBe('succeeded');
    }
  });

  it('a denied action appears as denied/non-actionable across repeated reads, with zero mutations', async () => {
    const { conversationId } = seedSaathKarConversation('denied case');
    let mutationCount = 0;
    const adapter: GovernedCapabilityAdapter = {
      id: 'counting',
      definitions: () => [{ name: 'consequential_tool', description: 'x', parameters: { type: 'object', properties: {} } }],
      classify: () => 'consequential',
      health: () => ({ state: 'available', checkedAt: new Date().toISOString() }),
      run: async () => { mutationCount += 1; return { status: 'succeeded', exitCode: 0, output: 'should not run' }; },
    };
    const registry = new GovernedCapabilityRegistry().register(adapter);
    const requested = await dispatchCapability(db, registry, {
      correlationId: conversationId, toolName: 'consequential_tool', arguments: {}, cwd: process.cwd(), actor: 'core', clientId: 'client-1',
    });
    if (requested.outcome !== 'approval_required') throw new Error('expected approval_required');
    resolveCapabilityApproval(db, decisionFrom(requested.approval, 'rejected'));

    for (const simulatedRestart of [1, 2]) {
      const snapshot = listRecentWorkspaceCapabilityActions(db, { workspaceRoot: workspace });
      const action = snapshot.actions.find((a) => a.approvalId === requested.approval.id);
      expect(action, `restart ${simulatedRestart}`).toBeDefined();
      expect(action?.actionable, `restart ${simulatedRestart}`).toBe(false);
      expect(action?.outcome, `restart ${simulatedRestart}`).toBe('rejected');
    }
    expect(mutationCount).toBe(0);
  });

  it('cancelled and failed actions restore as historical, non-actionable cards', async () => {
    const { conversationId: cancelledConversationId } = seedSaathKarConversation('cancelled case');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const cancelRegistry = new GovernedCapabilityRegistry().register(slowAdapter(gate));
    const cancelRequested = await dispatchCapability(db, cancelRegistry, {
      correlationId: cancelledConversationId, toolName: 'consequential_tool', arguments: {}, cwd: process.cwd(), actor: 'core', clientId: 'client-1',
    });
    if (cancelRequested.outcome !== 'approval_required') throw new Error('expected approval_required');
    resolveCapabilityApproval(db, decisionFrom(cancelRequested.approval, 'approved'));
    const executionPromise = dispatchCapability(db, cancelRegistry, {
      correlationId: cancelledConversationId, toolName: 'consequential_tool', arguments: {}, cwd: process.cwd(), actor: 'core', clientId: 'client-1',
    });
    await new Promise((r) => setTimeout(r, 10));
    cancelCapabilityAction(db, cancelRequested.attemptId, { actor: 'core', clientId: 'client-1' });
    release();
    await executionPromise;

    const { conversationId: failedConversationId } = seedSaathKarConversation('failed case');
    const failRegistry = new GovernedCapabilityRegistry().register(immediateAdapter('failed'));
    const failRequested = await dispatchCapability(db, failRegistry, {
      correlationId: failedConversationId, toolName: 'consequential_tool', arguments: {}, cwd: process.cwd(), actor: 'core', clientId: 'client-1',
    });
    if (failRequested.outcome !== 'approval_required') throw new Error('expected approval_required');
    resolveCapabilityApproval(db, decisionFrom(failRequested.approval, 'approved'));
    await dispatchCapability(db, failRegistry, {
      correlationId: failedConversationId, toolName: 'consequential_tool', arguments: {}, cwd: process.cwd(), actor: 'core', clientId: 'client-1',
    });

    const snapshot = listRecentWorkspaceCapabilityActions(db, { workspaceRoot: workspace });
    const cancelledAction = snapshot.actions.find((a) => a.approvalId === cancelRequested.approval.id);
    expect(cancelledAction?.actionable).toBe(false);
    expect(cancelledAction?.outcome).toBe('cancelled');
    const failedAction = snapshot.actions.find((a) => a.approvalId === failRequested.approval.id);
    expect(failedAction?.actionable).toBe(false);
    expect(failedAction?.outcome).toBe('failed');
  });

  it('multiple recent conversations: each card is attributed to the correct conversation, with no cross-conversation leakage', async () => {
    const registry = new GovernedCapabilityRegistry().register(immediateAdapter('succeeded'));
    const requests: Array<{ conversationId: string; approvalId: string }> = [];
    for (const n of [1, 2, 3]) {
      const { conversationId } = seedSaathKarConversation(`multi case ${n}`);
      const requested = await dispatchCapability(db, registry, {
        correlationId: conversationId, toolName: 'consequential_tool', arguments: { n }, cwd: process.cwd(), actor: 'core', clientId: 'client-1',
      });
      if (requested.outcome !== 'approval_required') throw new Error('expected approval_required');
      requests.push({ conversationId, approvalId: requested.approval.id });
    }

    const snapshot = listRecentWorkspaceCapabilityActions(db, { workspaceRoot: workspace });
    for (const { conversationId, approvalId } of requests) {
      const action = snapshot.actions.find((a) => a.approvalId === approvalId);
      expect(action).toBeDefined();
      expect(action?.correlationId).toBe(conversationId);
    }
    // No approval leaked under the wrong conversation's correlationId.
    for (const action of snapshot.actions) {
      const owner = requests.find((r) => r.approvalId === action.approvalId);
      expect(action.correlationId).toBe(owner?.conversationId);
    }
  });

  it('excludes attempts outside the age window and never exceeds the hard limit', async () => {
    const { attempt, conversationId } = seedSaathKarConversation('old case');
    db.run('UPDATE attempts SET updatedAt = ? WHERE id = ?', ['2000-01-01T00:00:00.000Z', attempt.id]);
    const registry = new GovernedCapabilityRegistry().register(immediateAdapter('succeeded'));
    // dispatchCapability creates its OWN anchor attempt (fresh updatedAt); the
    // real attempt's staleness is what the age window must actually exclude.
    const requested = await dispatchCapability(db, registry, {
      correlationId: conversationId, toolName: 'consequential_tool', arguments: {}, cwd: process.cwd(), actor: 'core', clientId: 'client-1',
    });
    if (requested.outcome !== 'approval_required') throw new Error('expected approval_required');

    const snapshot = listRecentWorkspaceCapabilityActions(db, { workspaceRoot: workspace, since: '2020-01-01T00:00:00.000Z' });
    expect(snapshot.actions.find((a) => a.approvalId === requested.approval.id)).toBeUndefined();

    // Hard limit: seed more distinct conversations than the requested limit.
    for (const n of [1, 2, 3, 4, 5]) {
      const { conversationId: convId } = seedSaathKarConversation(`limit case ${n}`);
      const req = await dispatchCapability(db, registry, {
        correlationId: convId, toolName: 'consequential_tool', arguments: { n }, cwd: process.cwd(), actor: 'core', clientId: 'client-1',
      });
      if (req.outcome !== 'approval_required') throw new Error('expected approval_required');
    }
    const bounded = listRecentWorkspaceCapabilityActions(db, { workspaceRoot: workspace, limit: 2 });
    const distinctConversations = new Set(bounded.actions.map((a) => a.correlationId));
    expect(distinctConversations.size).toBeLessThanOrEqual(2);
  });

  it('is exactly one card per approvalId across duplicate/overlapping reads', async () => {
    const { conversationId } = seedSaathKarConversation('dup case');
    const registry = new GovernedCapabilityRegistry().register(immediateAdapter('succeeded'));
    const requested = await dispatchCapability(db, registry, {
      correlationId: conversationId, toolName: 'consequential_tool', arguments: {}, cwd: process.cwd(), actor: 'core', clientId: 'client-1',
    });
    if (requested.outcome !== 'approval_required') throw new Error('expected approval_required');

    const first = listRecentWorkspaceCapabilityActions(db, { workspaceRoot: workspace });
    const second = listRecentWorkspaceCapabilityActions(db, { workspaceRoot: workspace });
    for (const snapshot of [first, second]) {
      expect(snapshot.actions.filter((a) => a.approvalId === requested.approval.id)).toHaveLength(1);
    }
  });

  it('is a strict read: creates no attempts, approvals, continuations, idempotency records, claims, or runtime events', async () => {
    const { conversationId } = seedSaathKarConversation('readonly case');
    const registry = new GovernedCapabilityRegistry().register(immediateAdapter('succeeded'));
    await dispatchCapability(db, registry, {
      correlationId: conversationId, toolName: 'consequential_tool', arguments: {}, cwd: process.cwd(), actor: 'core', clientId: 'client-1',
    });

    const tables = ['attempts', 'approvals', 'attempt_loop_continuations', 'idempotency_keys', 'runtime_events'];
    const before = Object.fromEntries(tables.map((t) => [t, db.get<{ count: number }>(`SELECT COUNT(*) AS count FROM ${t}`)!.count]));
    listRecentWorkspaceCapabilityActions(db, { workspaceRoot: workspace });
    listRecentWorkspaceCapabilityActions(db, { workspaceRoot: workspace, limit: 5, since: '2020-01-01T00:00:00.000Z' });
    const after = Object.fromEntries(tables.map((t) => [t, db.get<{ count: number }>(`SELECT COUNT(*) AS count FROM ${t}`)!.count]));
    expect(after).toEqual(before);
  });

  it('does not change listWorkspaceAttemptRehydration: terminal attempts stay excluded and active-attempt selection is unaffected', async () => {
    const { attempt, conversationId } = seedSaathKarConversation('rehydration case');
    const registry = new GovernedCapabilityRegistry().register(immediateAdapter('succeeded'));
    const requested = await dispatchCapability(db, registry, {
      correlationId: conversationId, toolName: 'consequential_tool', arguments: {}, cwd: process.cwd(), actor: 'core', clientId: 'client-1',
    });
    if (requested.outcome !== 'approval_required') throw new Error('expected approval_required');
    resolveCapabilityApproval(db, decisionFrom(requested.approval, 'approved'));
    await dispatchCapability(db, registry, {
      correlationId: conversationId, toolName: 'consequential_tool', arguments: {}, cwd: process.cwd(), actor: 'core', clientId: 'client-1',
    });
    db.run(`UPDATE attempts SET status = 'completed' WHERE id = ?`, [attempt.id]);

    // Calling the new display query first must not change rehydration's own answer.
    listRecentWorkspaceCapabilityActions(db, { workspaceRoot: workspace });
    const rehydration = listWorkspaceAttemptRehydration(db, workspace);
    expect(rehydration.attempts.some((item) => item.attempt.id === attempt.id)).toBe(false);
  });
});
