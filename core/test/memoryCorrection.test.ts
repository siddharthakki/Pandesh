/**
 * Alpha e2e re-run T6: Core-owned correction of a stored fact (memory_correct).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openDatabase, type CoreDatabase } from '../db/connection';
import { runMigrations } from '../db/migrations';
import { appendMessage, createConversation } from '../domain/conversations';
import { correctMemory, getMemoryFact, listMemoryContradictions, recallMemories, rememberMemory } from '../domain/memory';
import { createMemoryCapabilityAdapter, MEMORY_CONSEQUENTIAL_TOOLS } from '../runtime/memoryCapability';
import { GovernedCapabilityRegistry } from '../runtime/governedCapability';

let dir: string;
let db: CoreDatabase;
let conversationId: string;
let firstMessage: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pandesh-memcorrect-'));
  db = openDatabase(path.join(dir, 'core.db'));
  runMigrations(db);
  conversationId = createConversation(db, { mode: 'baat_kar', actor: 'test' }).id;
  firstMessage = appendMessage(db, conversationId, { role: 'user', content: "Remember: Project Glowworm's review meeting is Tuesday 14:30, colour orange.", actor: 'test' }).id;
});
afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

function seedFact() {
  return rememberMemory(db, {
    memoryType: 'project' as never, scopeType: 'project', scopeId: 'Project Glowworm', subject: 'project glowworm details', predicate: 'review meeting and colour',
    value: 'Review meeting: Tuesday at 14:30; colour: orange.', sensitivity: 'internal', sourceConversationId: conversationId, sourceMessageId: firstMessage, actor: 'test',
  }).memory;
}

describe('memory_correct', () => {
  it('writes the corrected value with fresh provenance and retires the old fact in one step', () => {
    const old = seedFact();
    const correction = appendMessage(db, conversationId, { role: 'user', content: 'Change the meeting to Wednesday 15:00 and forget the colour orange.', actor: 'test' }).id;
    const r = correctMemory(db, { memoryId: old.id, value: 'Review meeting: Wednesday at 15:00.', sourceConversationId: conversationId, sourceMessageId: correction, consentApprovalId: 'appr_x', actor: 'test' });
    expect(r.changed).toBe(true);
    expect(r.previous.displayValue).toContain('orange');
    expect(getMemoryFact(db, old.id).state).toBe('forgotten');
    expect(getMemoryFact(db, old.id).displayValue).toBe('[forgotten]');
    const active = db.all<{ displayValue: string }>("SELECT displayValue FROM memory_facts WHERE scopeId = 'Project Glowworm' AND state = 'active'");
    expect(active).toEqual([{ displayValue: 'Review meeting: Wednesday at 15:00.' }]);
    expect(r.evidence[0].sourceMessageId).toBe(correction);
    expect(listMemoryContradictions(db, old.id).filter((c) => c.state === 'unresolved')).toEqual([]);
    expect(JSON.stringify(recallMemories(db, { scopeType: 'project', scopeId: 'Project Glowworm' }))).not.toContain('orange');
  });

  it('changes nothing when the value is already stored, and refuses a forgotten fact or an empty value', () => {
    const old = seedFact();
    expect(correctMemory(db, { memoryId: old.id, value: 'Review meeting: Tuesday at 14:30; colour: orange.', sourceConversationId: conversationId, sourceMessageId: firstMessage, actor: 'test' }).changed).toBe(false);
    expect(getMemoryFact(db, old.id).state).toBe('active');
    expect(() => correctMemory(db, { memoryId: old.id, value: '  ', sourceConversationId: conversationId, sourceMessageId: firstMessage, actor: 'test' })).toThrow(/complete new value/);
    correctMemory(db, { memoryId: old.id, value: 'Review meeting: Wednesday.', sourceConversationId: conversationId, sourceMessageId: firstMessage, actor: 'test' });
    expect(() => correctMemory(db, { memoryId: old.id, value: 'x', sourceConversationId: conversationId, sourceMessageId: firstMessage, actor: 'test' })).toThrow(/only an active fact/);
  });

  it('is a consequential (approval-gated) memory tool', () => {
    expect(MEMORY_CONSEQUENTIAL_TOOLS).toContain('memory_correct');
    const registry = new GovernedCapabilityRegistry().register(createMemoryCapabilityAdapter({ db }));
    expect(registry.classify('memory_correct')).toEqual({ capabilityId: 'memory', risk: 'consequential' });
  });
});
