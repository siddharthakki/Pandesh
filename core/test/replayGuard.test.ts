/** M2 (reliability program): the replay guard decides on canonical resources, hashed large arguments and real file state. */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { canonicalPath, normalizeArgs, argsHash, reconcileFileWrite, findPriorTwin } from '../runtime/replayGuard';
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
