import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openDatabase, type CoreDatabase } from '../db/connection';
import { runMigrations } from '../db/migrations';
import { createConversation } from '../domain/conversations';
import { createRequest } from '../domain/requests';
import { createAttempt } from '../domain/attempts';
import { startToolInvocation, completeToolInvocation } from '../domain/toolInvocations';
import {
  activeItems, buildJournalContext, classifyEffect, extractRefs, listConversationEntries, recallJournal, resolveReference,
} from '../domain/toolJournal';

let tempDir: string;
let db: CoreDatabase;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pandesh-journal-'));
  db = openDatabase(path.join(tempDir, 'core.db'));
  runMigrations(db);
});
afterEach(() => {
  try { db.close(); } catch { /* closed */ }
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

function attemptIn(conversationId: string, agentId?: string) {
  const req = createRequest(db, { clientId: 'desktop', conversationId, currentMessage: 'x', requestedMode: 'baat_kar', resolvedMode: 'baat_kar', routeReason: 'user_prompt', contextPolicy: { includeConversationHistory: true, includeProjectContext: false, includeRepositoryContext: false, includeGlobalStoryContext: false }, correlationId: `c_${Math.random()}` });
  if (agentId) db.run(`INSERT INTO agent_runs (requestId, agentId, agentVersion, scope, handoffId, createdAt) VALUES (?, ?, 1, '{}', NULL, ?)`, [req.id, agentId, new Date().toISOString()]);
  return createAttempt(db, { requestId: req.id, kind: 'baat_kar', actor: 'test' });
}
function run(attemptId: string, toolName: string, args: Record<string, unknown>, text: string, status: 'succeeded' | 'failed' = 'succeeded', details?: unknown) {
  const inv = startToolInvocation(db, { attemptId, toolName, argsSummary: args, actor: 'test' });
  completeToolInvocation(db, inv.id, { actor: 'test', status, exitCode: status === 'succeeded' ? 0 : 1, evidence: { output: text.slice(0, 500) }, result: { text, details } });
  return inv.id;
}
const R1 = 'reminder_11111111-1111-4111-8111-111111111111';
const R2 = 'reminder_22222222-2222-4222-8222-222222222222';

describe('tool execution journal', () => {
  it('classifies effects from tool names, generically', () => {
    expect(classifyEffect('create_reminder')).toBe('created');
    expect(classifyEffect('dismiss_reminder')).toBe('modified');
    expect(classifyEffect('pc_organize_apply')).toBe('modified');
    expect(classifyEffect('gmail_undo_plan')).toBe('undone');
    expect(classifyEffect('read_file')).toBe('read');
    expect(classifyEffect('some_new_tool')).toBe('other');
  });

  it('extracts the created id, the acted-on id and file paths, with roles', () => {
    const created = extractRefs({ toolName: 'create_reminder', args: { title: 'Call Bob' }, resultText: `Reminder created (id ${R1}): "Call Bob"`, effect: 'created', status: 'succeeded' });
    expect(created).toEqual([{ kind: 'reminder', id: R1, role: 'created', label: 'Call Bob' }]);
    const target = extractRefs({ toolName: 'dismiss_reminder', args: { id: R1 }, resultText: 'Reminder dismissed', effect: 'modified', status: 'succeeded' });
    expect(target[0]).toMatchObject({ id: R1, role: 'target' });
    const file = extractRefs({ toolName: 'write_file', args: { filePath: 'C:\\w\\report.md', content: 'x' }, resultText: 'Wrote it', effect: 'created', status: 'succeeded' });
    expect(file[0]).toMatchObject({ kind: 'document', id: 'C:\\w\\report.md', role: 'created' });
  });

  it('records every completed invocation with its conversation, sanitized args and the full result', () => {
    const conv = createConversation(db, { mode: 'baat_kar', actor: 'user' });
    const att = attemptIn(conv.id);
    run(att.id, 'create_reminder', { title: 'Call Bob', apiKey: 'sk-secret-123456789012345678901234' }, `Reminder created (id ${R1}): "Call Bob"`);
    const [e] = listConversationEntries(db, { conversationId: conv.id, agentId: null });
    expect(e.conversationId).toBe(conv.id);
    expect(JSON.stringify(e.args)).not.toContain('sk-secret');
    expect(e.refs[0].id).toBe(R1);
    expect(activeItems([e])[0]).toMatchObject({ kind: 'reminder', id: R1, state: 'created' });
  });

  it('upgrade path: invocations recorded before the journal (Build ≤ 164) are journaled from their stored evidence', () => {
    const conv = createConversation(db, { mode: 'baat_kar', actor: 'user' });
    const att = attemptIn(conv.id);
    run(att.id, 'create_reminder', { title: 'Old' }, `Reminder created (id ${R1}): "Old"`);
    db.run('DELETE FROM tool_execution_journal');
    const ctx = buildJournalContext(db, { conversationId: conv.id, agentId: null }, { message: 'dismiss that reminder', localModel: true });
    expect(ctx.section).toContain(R1);
    expect(ctx.resolution).toMatchObject({ status: 'resolved' });
  });

  it('is isolated by conversation and by agent; recall of a foreign record is refused', () => {
    const a = createConversation(db, { mode: 'baat_kar', actor: 'user' });
    const b = createConversation(db, { mode: 'baat_kar', actor: 'user' });
    const inv = run(attemptIn(a.id).id, 'create_reminder', { title: 'Private A' }, `Reminder created (id ${R1}): "Private A"`);
    run(attemptIn(a.id, 'research').id, 'create_note', { title: 'Agent note' }, 'Note saved (id note_33333333-3333-4333-8333-333333333333)');
    const inB = buildJournalContext(db, { conversationId: b.id, agentId: null }, { message: `dismiss ${R1}`, localModel: true });
    expect(inB.section).not.toContain('Private A');
    expect(inB.resolution).toEqual({ status: 'inaccessible', ids: [R1] });
    expect(recallJournal(db, { conversationId: b.id, agentId: null }, inv, { localModel: true })).toMatchObject({ ok: false });
    const mainInA = buildJournalContext(db, { conversationId: a.id, agentId: null }, { message: 'what next', localModel: true });
    expect(mainInA.section).toContain('Private A');
    expect(mainInA.section).not.toContain('Agent note');
  });

  it('withholds private results from a non-local model and bounds the section', () => {
    const conv = createConversation(db, { mode: 'baat_kar', actor: 'user' });
    const att = attemptIn(conv.id);
    run(att.id, 'read_file', { filePath: 'C:\\w\\salary.txt' }, 'SALARY 98765');
    for (let i = 0; i < 60; i += 1) run(att.id, 'create_note', { title: `N${i}` }, `Note saved (id note_${String(i).padStart(8, '0')}-0000-4000-8000-000000000000): "${'x'.repeat(300)}"`);
    const cloud = buildJournalContext(db, { conversationId: conv.id, agentId: null }, { message: 'what is in the salary file', localModel: false });
    expect(cloud.section).not.toContain('98765');
    expect(cloud.section.length).toBeLessThanOrEqual(4_500);
    expect(recallJournal(db, { conversationId: conv.id, agentId: null }, 'C:\\w\\salary.txt', { localModel: false }).text).not.toContain('98765');
    expect(recallJournal(db, { conversationId: conv.id, agentId: null }, 'C:\\w\\salary.txt', { localModel: true }).text).toContain('98765');
  });

  it('asks rather than guesses when one turn produced two candidates', () => {
    const conv = createConversation(db, { mode: 'baat_kar', actor: 'user' });
    const att = attemptIn(conv.id);
    run(att.id, 'create_reminder', { title: 'Rent March' }, `Reminder created (id ${R1})`);
    run(att.id, 'create_reminder', { title: 'Rent April' }, `Reminder created (id ${R2})`);
    const entries = listConversationEntries(db, { conversationId: conv.id, agentId: null });
    expect(resolveReference('dismiss that reminder', entries)).toMatchObject({ status: 'ambiguous', action: true });
    expect(resolveReference('dismiss the April reminder you created', entries)).toMatchObject({ status: 'resolved', item: { id: R2 } });
    expect(resolveReference('what is the weather', entries)).toEqual({ status: 'none' });
  });

  it('a failed call never becomes the current item', () => {
    const conv = createConversation(db, { mode: 'baat_kar', actor: 'user' });
    const att = attemptIn(conv.id);
    run(att.id, 'create_reminder', { title: 'Good' }, `Reminder created (id ${R1})`);
    run(att.id, 'create_reminder', { title: 'Bad' }, `Could not create reminder ${R2}`, 'failed');
    const items = activeItems(listConversationEntries(db, { conversationId: conv.id, agentId: null }));
    expect(items.map((i) => i.id)).toEqual([R1]);
  });
});
