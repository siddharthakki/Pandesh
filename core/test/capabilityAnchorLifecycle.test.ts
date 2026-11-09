/**
 * Release blocker (2026-11-09): conversation capability anchors stayed `running` after their turns ended (production
 * Build 159 had 133). A finished turn now settles its conversation's idle anchors; anchors waiting on a human or with a
 * tool call in flight stay open, the next governed call gets a fresh anchor, and nothing executes twice.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CoreDatabase } from '../db/connection';
import { openCoreDatabase } from '../db/openCore';
import { appendMessage, createConversation } from '../domain/conversations';
import { dispatchCapability } from '../domain/capabilityDispatch';
import { settleIdleCapabilityAnchorsForConversation } from '../domain/bootReconciliation';
import { getAttempt } from '../domain/attempts';
import { GovernedCapabilityRegistry } from '../runtime/governedCapability';
import { createMemoryCapabilityAdapter } from '../runtime/memoryCapability';

let dir: string;
let db: CoreDatabase;
let registry: GovernedCapabilityRegistry;
let conversationId: string;
let n = 0;
const dispatch = (toolName: string, args: Record<string, unknown>) =>
  dispatchCapability(db, registry, { correlationId: conversationId, toolName, arguments: args, cwd: dir, actor: 'test-client', clientId: 'test-client', idempotencyKey: `k-${++n}` } as never);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anchor-'));
  db = openCoreDatabase(path.join(dir, 'core.db')).db;
  registry = new GovernedCapabilityRegistry().register(createMemoryCapabilityAdapter({ db }));
  conversationId = createConversation(db, { mode: 'saath_kar', actor: 'test' }).id;
  appendMessage(db, conversationId, { role: 'user', content: 'Remember that the oven is serviced on Thursdays.', actor: 'test' });
});
afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

describe('capability anchors reach a terminal state when the turn ends', () => {
  it('settles an idle anchor, and the next governed call works on a fresh one', async () => {
    const first = await dispatch('memory_recall', { scopeType: 'user' });
    expect(first.outcome).toBe('executed');
    const anchor = first.attemptId;
    expect(getAttempt(db, anchor).status).toBe('running');
    expect(settleIdleCapabilityAnchorsForConversation(db, conversationId)).toEqual([anchor]);
    expect(getAttempt(db, anchor).status).toBe('completed');
    const next = await dispatch('memory_recall', { scopeType: 'user' });
    expect(next.outcome).toBe('executed');
    expect(next.attemptId).not.toBe(anchor);
    // nothing re-ran on the settled anchor
    expect(db.all('SELECT id FROM tool_invocations WHERE attemptId = ?', [anchor])).toHaveLength(1);
  });

  it('never settles an anchor that is waiting for the user\'s approval', async () => {
    const pending = await dispatch('memory_remember', { memoryType: 'user', scopeType: 'user', scopeId: 'user_profile', subject: 'oven', predicate: 'serviced on', value: 'Thursday', sensitivity: 'internal' });
    expect(pending.outcome).toBe('approval_required');
    expect(settleIdleCapabilityAnchorsForConversation(db, conversationId)).toEqual([]);
    expect(getAttempt(db, pending.attemptId).status).not.toBe('completed');
  });

  it('never settles an anchor with a tool call still in flight', async () => {
    const first = await dispatch('memory_recall', { scopeType: 'user' });
    db.run("UPDATE tool_invocations SET status = 'pending' WHERE attemptId = ?", [first.attemptId]);
    expect(settleIdleCapabilityAnchorsForConversation(db, conversationId)).toEqual([]);
  });
});
