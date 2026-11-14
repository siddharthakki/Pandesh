/** M2 (reliability program): the replay guard decides on canonical resources, hashed large arguments and real file state. */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { canonicalPath, normalizeArgs, argsHash, reconcileFileWrite, reconcileOwnAction, findPriorTwin } from '../runtime/replayGuard';
import { openDatabase } from '../db/connection';
import { runMigrations } from '../db/migrations';
import { createConversation, appendMessage } from '../domain/conversations';
import { createRequest } from '../domain/requests';
import { createAttempt, rerouteAttempt } from '../domain/attempts';
import { startToolInvocation, completeToolInvocation } from '../domain/toolInvocations';

let dir: string; let db: ReturnType<typeof openDatabase>;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pandesh-replay-')); db = openDatabase(path.join(dir, 'core.db')); runMigrations(db); });
afterEach(() => { try { db.close(); } catch { /* closed */ } fs.rmSync(dir, { recursive: true, force: true }); });

function chain() {
  const conv = createConversation(db, { mode: 'saath_kar', actor: 'user', title: 't' });
  appendMessage(db, conv.id, { role: 'user', content: 'x', actor: 'user' });
  const req = createRequest(db, { clientId: 'desktop', conversationId: conv.id, currentMessage: 'x', requestedMode: 'saath_kar', resolvedMode: 'saath_kar', routeReason: 'user_prompt',
    contextPolicy: { includeConversationHistory: true, includeProjectContext: false, includeRepositoryContext: false, includeGlobalStoryContext: false }, correlationId: `c_${Math.random()}` } as any);
  const first = createAttempt(db, { requestId: req.id, kind: 'saath_kar', actor: 'client:desktop' });
  db.run("UPDATE attempts SET status = 'failed', failureReason = 'Interrupted: restart' WHERE id = ?", [first.id]);
  const second = rerouteAttempt(db, { predecessorAttemptId: first.id, actor: 't', provider: 'ollama', model: 'm', fingerprint: 'interrupted', reason: 'resume', rerouteIndex: 1, continuesUnfinishedTurn: true, guidance: 'g' } as any);
  return { first, second };
}

describe('resource canonicalisation', () => {
  it('one place, one spelling', () => {
    const ws = path.join(dir, 'ws');
    const a = canonicalPath('notes/a.txt', ws);
    expect(canonicalPath('./notes/../notes/a.txt', ws)).toBe(a);
    expect(canonicalPath(path.join(ws, 'notes', 'a.txt'), ws)).toBe(a);
    expect(canonicalPath(`${ws}${path.sep}notes${path.sep}a.txt${path.sep}`, ws)).toBe(a);
    if (process.platform === 'win32') expect(canonicalPath(['NOTES', 'A.TXT'].join(path.sep), ws)).toBe(a);
    expect(argsHash(normalizeArgs({ filePath: 'x/../y.txt', content: 'c' }, ws))).toBe(argsHash(normalizeArgs({ content: 'c', filePath: 'y.txt' }, ws)));
    expect(argsHash(normalizeArgs({ filePath: 'y.txt', content: 'c' }, ws))).not.toBe(argsHash(normalizeArgs({ filePath: 'y.txt', content: 'd' }, ws)));
  });

  it('finds a twin written with another spelling of the path', () => {
    const { first, second } = chain(); const ws = path.join(dir, 'ws'); fs.mkdirSync(ws);
    const inv = startToolInvocation(db, { attemptId: first.id, toolName: 'write_file', argsSummary: { filePath: 'sub/a.txt', content: 'a' }, actor: 't' });
    completeToolInvocation(db, inv.id, { status: 'succeeded', actor: 't' } as any);
    expect(findPriorTwin(db, second.id, 'write_file', { content: 'a', filePath: path.join(ws, 'sub', '..', 'sub', 'a.txt') }, ws)?.kind).toBe('done');
    expect(findPriorTwin(db, second.id, 'write_file', { content: 'b', filePath: 'sub/a.txt' }, ws)).toBeNull();
  });
});

describe('large arguments', () => {
  it('a twin whose arguments exceeded the storage bound is still matched (by hash), and a different one is not', () => {
    const { first, second } = chain();
    const big = 'x'.repeat(80_000);
    startToolInvocation(db, { attemptId: first.id, toolName: 'write_file', argsSummary: { filePath: 'big.txt', content: big }, actor: 't' });
    expect(JSON.parse((db.get('SELECT argsSummary FROM tool_invocations WHERE attemptId = ?', [first.id]) as { argsSummary: string }).argsSummary).argsHash).toMatch(/^[0-9a-f]{64}$/);
    expect(findPriorTwin(db, second.id, 'write_file', { content: big, filePath: 'big.txt' })?.kind).toBe('unknown');
    expect(findPriorTwin(db, second.id, 'write_file', { content: big + 'y', filePath: 'big.txt' })).toBeNull();
  });
});

describe('reconciling a file write against the disk', () => {
  it('in place, differs, unverifiable', () => {
    const ws = path.join(dir, 'ws'); fs.mkdirSync(ws);
    expect(reconcileFileWrite({ filePath: 'a.txt', content: 'a' }, ws)).toBe('differs');
    fs.writeFileSync(path.join(ws, 'a.txt'), 'a\r\n');
    expect(reconcileFileWrite({ filePath: 'a.txt', content: 'a\n' }, ws)).toBe('in_place');
    expect(reconcileFileWrite({ filePath: 'a.txt', content: 'b' }, ws)).toBe('differs');
    expect(reconcileFileWrite({ filePath: 'a.txt', content: 'a\n' }, null)).toBe('unverifiable');
    expect(reconcileFileWrite({ filePath: 'a.txt' }, ws)).toBe('unverifiable');
  });
});

describe('semantic twins: the same action in other words (M2)', () => {
  const done = (tool: string, args: Record<string, unknown>, first: { id: string }, status: 'succeeded' | 'pending' = 'succeeded', result = 'ok') => {
    const inv = startToolInvocation(db, { attemptId: first.id, toolName: tool, argsSummary: args, actor: 't' });
    if (status === 'succeeded') completeToolInvocation(db, inv.id, { status: 'succeeded', actor: 't' } as any);
    return inv;
  };

  it('a reworded reminder at the same time is the same reminder; another time or subject is not', () => {
    const { first, second } = chain();
    done('create_reminder', { title: 'Call Dr. Keller about the invoice', date: '2026-11-14', time: '09:00' }, first);
    expect(findPriorTwin(db, second.id, 'create_reminder', { title: 'Call Dr Keller about invoice', dueAt: new Date('2026-11-14T09:02').toISOString() })?.semantic).toBe(true);
    expect(findPriorTwin(db, second.id, 'create_reminder', { title: 'Call Dr. Keller about the invoice', date: '2026-11-14', time: '09:00' })?.kind).toBe('done'); // exact
    expect(findPriorTwin(db, second.id, 'create_reminder', { title: 'Call Dr. Keller about the invoice', date: '2026-11-14', time: '15:00' })).toBeNull();
    expect(findPriorTwin(db, second.id, 'create_reminder', { title: 'Buy milk', date: '2026-11-14', time: '09:00' })).toBeNull();
  });

  it('a calendar event with the same title and start, a draft to the same people with the same subject', () => {
    const { first, second } = chain();
    done('calendar_create_event', { title: 'Team sync', start: '2026-11-16T10:00', end: '2026-11-16T10:30' }, first);
    expect(findPriorTwin(db, second.id, 'calendar_create_event', { title: 'team sync', start: '2026-11-16T10:00:00', end: '2026-11-16T11:00' })?.semantic).toBe(true);
    expect(findPriorTwin(db, second.id, 'calendar_create_event', { title: 'Team sync', start: '2026-11-17T10:00' })).toBeNull();
    done('gmail_create_draft', { to: ['b@example.com', 'a@example.com'], subject: 'Invoice 42', bodyText: 'Hello' }, first);
    expect(findPriorTwin(db, second.id, 'gmail_create_draft', { to: ['A@example.com', 'b@example.com'], subject: 'RE: invoice 42', bodyText: 'Hi there, different body' })?.semantic).toBe(true);
    expect(findPriorTwin(db, second.id, 'gmail_create_draft', { to: ['a@example.com'], subject: 'Invoice 42', bodyText: 'Hello' })).toBeNull();
  });

  it('a call that was started but never finished (unknown) is also matched by meaning', () => {
    const { first, second } = chain();
    done('create_note', { title: 'Parking permits', body: 'Ask the city office about the parking permits before Friday.' }, first, 'pending');
    expect(findPriorTwin(db, second.id, 'create_note', { title: 'parking permits', body: 'Ask the city office about parking permits before Friday' })).toMatchObject({ kind: 'unknown', semantic: true });
    expect(findPriorTwin(db, second.id, 'create_note', { title: 'Other', body: 'Something entirely different' })).toBeNull();
  });

  it('Core reconciles its own stores for an unknown outcome and fails closed for email and calendar', () => {
    const since = new Date(Date.now() - 1000).toISOString();
    expect(reconcileOwnAction(db, 'create_reminder', { title: 'Call Keller', date: '2026-11-14', time: '09:00' }, since).state).toBe('not_happened');
    db.run("INSERT INTO everyday_reminders (id, title, body, dueAt, timezone, status, createdAt, updatedAt) VALUES ('r1', 'Call Keller', '', ?, 'UTC', 'scheduled', ?, ?)", [new Date('2026-11-14T09:00').toISOString(), new Date().toISOString(), new Date().toISOString()]);
    expect(reconcileOwnAction(db, 'create_reminder', { title: 'call keller', date: '2026-11-14', time: '09:00' }, since)).toMatchObject({ state: 'happened', id: 'r1' });
    expect(reconcileOwnAction(db, 'calendar_create_event', { title: 'x', start: '2026-11-14T09:00' }, since).state).toBe('unverifiable');
    expect(reconcileOwnAction(db, 'gmail_send_draft', { draftId: 'd1' }, since).state).toBe('unverifiable');
  });
});
