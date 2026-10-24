/**
 * Duplicate-attempt guard: a re-dispatch of a turn whose attempt is still active (hydration, history selection,
 * replay, reload, double UI dispatch) must resolve to the existing authoritative attempt, never a second live one.
 * Explicit Run again (after the attempt ended) and Retry stay legitimate.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CoreDatabase } from '../db/connection';
import { openCoreDatabase } from '../db/openCore';
import { submitRequest } from '../domain/submission';
import { createConversation, listMessages } from '../domain/conversations';
import { retryAttempt } from '../domain/attempts';

let dir: string;
let db: CoreDatabase;
let n = 0;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karkedikha-dup-'));
  db = openCoreDatabase(path.join(dir, 'core.db')).db;
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const submit = (conversationId: string, message: string, over: Partial<Parameters<typeof submitRequest>[1]> = {}) => submitRequest(db, {
  clientId: 'test-client', currentMessage: message, requestedMode: 'baat_kar', conversationId, workspaceRoot: dir,
  capability: { hasWorkspace: true, gitCapable: false }, correlationId: `corr-${++n}`, ...over,
});
const attemptCount = () => (db.get('SELECT COUNT(*) AS n FROM attempts') as { n: number }).n;
const endAttempt = (id: string, status: 'failed' | 'completed') => db.run('UPDATE attempts SET status = ? WHERE id = ?', [status, id]);

describe('duplicate-attempt guard', () => {
  it('a second dispatch of the same live objective returns the existing attempt: no new attempt, request or user message', () => {
    const conv = createConversation(db, { mode: 'baat_kar', actor: 'test' });
    const first = submit(conv.id, 'Explain the startup path.');
    expect(first.duplicateOfActiveAttempt).toBeUndefined();
    const second = submit(conv.id, 'Explain the startup path.');
    expect(second.duplicateOfActiveAttempt).toBe(true);
    expect(second.attempt.id).toBe(first.attempt.id);
    expect(second.request.id).toBe(first.request.id);
    expect(second.messageId).toBe(first.messageId);
    expect(attemptCount()).toBe(1);
    expect(db.get('SELECT COUNT(*) AS n FROM requests')).toMatchObject({ n: 1 });
    expect(listMessages(db, conv.id).filter((m) => m.role === 'user')).toHaveLength(1);
  });

  it('is keyed on the live attempt identity, not text alone: other conversation, other text, other mode all proceed', () => {
    const a = createConversation(db, { mode: 'baat_kar', actor: 'test' });
    const b = createConversation(db, { mode: 'baat_kar', actor: 'test' });
    const first = submit(a.id, 'Same words');
    expect(submit(b.id, 'Same words').attempt.id).not.toBe(first.attempt.id);
    expect(submit(a.id, 'Different words').attempt.id).not.toBe(first.attempt.id);
    expect(submit(a.id, 'Same words', { requestedMode: 'saath_kar' }).attempt.id).not.toBe(first.attempt.id);
    expect(attemptCount()).toBe(4);
  });

  it('explicit Run again after the attempt ended creates a new attempt (failed and completed alike)', () => {
    const conv = createConversation(db, { mode: 'baat_kar', actor: 'test' });
    const first = submit(conv.id, 'Run it');
    endAttempt(first.attempt.id, 'failed');
    const again = submit(conv.id, 'Run it');
    expect(again.duplicateOfActiveAttempt).toBeUndefined();
    expect(again.attempt.id).not.toBe(first.attempt.id);
    endAttempt(again.attempt.id, 'completed');
    expect(submit(conv.id, 'Run it').attempt.id).not.toBe(again.attempt.id);
  });

  it('explicit Retry of a failed attempt is untouched by the guard', () => {
    const conv = createConversation(db, { mode: 'baat_kar', actor: 'test' });
    const first = submit(conv.id, 'Run it');
    endAttempt(first.attempt.id, 'failed');
    const successor = retryAttempt(db, { predecessorAttemptId: first.attempt.id, actor: 'test', strategy: 'same_model' });
    expect(successor.predecessorAttemptId).toBe(first.attempt.id);
    // ...and while that retry is live, a replayed dispatch of the same turn resolves to the retry, not a third attempt.
    const replay = submit(conv.id, 'Run it');
    expect(replay.duplicateOfActiveAttempt).toBe(true);
    expect(replay.attempt.id).toBe(successor.id);
    expect(attemptCount()).toBe(2);
  });
});
