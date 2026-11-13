/** M1: the result of an attempt in the owner's words, derived from what Core recorded (never from the lifecycle alone). */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openCoreDatabase } from '../db/openCore';
import type { CoreDatabase } from '../db/connection';
import { createConversation } from '../domain/conversations';
import { createRequest } from '../domain/requests';
import { createAttempt } from '../domain/attempts';
import { updateTaskOutcome } from '../domain/taskOutcomes';
import { recordRuntimeEvent } from '../domain/runtimeEvents';
import { deriveResultStatus, INTERRUPTED_PREFIX, PARTIAL_PREFIX } from '../domain/resultStatus';

let dir: string; let db: CoreDatabase;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pandesh-result-')); db = openCoreDatabase(path.join(dir, 'core.db')).db; });
afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

function attempt(status: string, failureReason: string | null = null, predecessor?: string) {
  const conv = createConversation(db, { mode: 'saath_kar', title: 't', actor: 'test' });
  const req = createRequest(db, { clientId: 'desktop', conversationId: conv.id, currentMessage: 'x', requestedMode: 'saath_kar', resolvedMode: 'saath_kar', routeReason: 'user_prompt', contextPolicy: { includeConversationHistory: true, includeProjectContext: false, includeRepositoryContext: false, includeGlobalStoryContext: false }, correlationId: `c_${Math.random()}` });
  const att = createAttempt(db, { requestId: req.id, kind: 'saath_kar', actor: 'client:desktop', ...(predecessor ? { predecessorAttemptId: predecessor } : {}) } as any);
  db.run('UPDATE attempts SET status = ?, failureReason = ?, predecessorAttemptId = ? WHERE id = ?', [status, failureReason, predecessor ?? null, att.id]);
  return att.id;
}
const event = (id: string, eventType: string, metadata: object) => recordRuntimeEvent(db, { domain: 'attempt', entityId: id, eventType, actor: 'test', metadata } as any);

describe('deriveResultStatus', () => {
  it('maps lifecycle states', () => {
    expect(deriveResultStatus(db, attempt('running')).status).toBe('running');
    expect(deriveResultStatus(db, attempt('cancelled')).status).toBe('cancelled');
    expect(deriveResultStatus(db, attempt('waiting_for_approval')).status).toBe('blocked');
    expect(deriveResultStatus(db, attempt('recovery_required')).status).toBe('interrupted');
  });
  it('reads the failure reason prefixes', () => {
    expect(deriveResultStatus(db, attempt('failed', `${INTERRUPTED_PREFIX} KarkeDikha restarted`)).status).toBe('interrupted');
    expect(deriveResultStatus(db, attempt('failed', `${PARTIAL_PREFIX} still missing x.md`)).status).toBe('partial');
    expect(deriveResultStatus(db, attempt('failed', 'the model server stopped')).status).toBe('failed');
  });
  it('a completed attempt is completed only when nothing recorded says the work is unfinished', () => {
    expect(deriveResultStatus(db, attempt('completed'))).toEqual({ status: 'completed', reason: null });
  });
  it('a completed attempt whose task outcome is partial or blocked is not completed', () => {
    const a = attempt('completed'); updateTaskOutcome(db, { attemptId: a, objective: 'o', status: 'partial', blocker: 'one of six missing', nextAction: 'write it' });
    expect(deriveResultStatus(db, a)).toEqual({ status: 'partial', reason: 'one of six missing' });
    const b = attempt('completed'); updateTaskOutcome(db, { attemptId: b, objective: 'o', status: 'blocked', blocker: 'needs Gmail connected' });
    expect(deriveResultStatus(db, b).status).toBe('blocked');
  });
  it('a completed attempt that ended unfinished with no successor is failed (audit S04 run 2: gave up after list_directory)', () => {
    const a = attempt('completed'); event(a, 'turn_unfinished', { reason: 'nothing_built' });
    expect(deriveResultStatus(db, a)).toEqual({ status: 'failed', reason: 'nothing was built — no file was written or changed' });
  });
  it('but an unfinished attempt that was handed to a successor is not judged (the successor is)', () => {
    const a = attempt('completed'); event(a, 'turn_unfinished', { reason: 'nothing_built' }); db.run('UPDATE attempts SET predecessorAttemptId = ? WHERE id = ?', [a, attempt('completed')]);
    expect(deriveResultStatus(db, a).status).toBe('completed');
  });
});

import { unfinishedAttempts, personalOverview } from '../domain/personalContext';
describe('unfinished tasks in the personal overview (audit S14)', () => {
  it('lists interrupted, partial and failed tasks from any conversation, not continued ones, not cancelled ones', () => {
    const a = attempt('failed', `${INTERRUPTED_PREFIX} KarkeDikha restarted while this task was running.`);
    attempt('failed', `${PARTIAL_PREFIX} still missing x.md`);
    attempt('cancelled');
    attempt('completed');
    const continued = attempt('failed', 'the model server stopped'); db.run('UPDATE attempts SET predecessorAttemptId = ? WHERE id = ?', [continued, attempt('completed')]);
    const list = unfinishedAttempts(db, new Date(Date.now() - 86_400_000).toISOString());
    expect(list.map((t) => t.result).sort()).toEqual(['interrupted', 'partial']);
    expect(list.find((t) => t.id === a)?.result).toBe('interrupted');
    expect(personalOverview(db, { focus: 'unfinished' })).toMatch(/Tasks that did NOT finish[\s\S]*interrupted "x"/);
  });
});

import { finalizeTaskOutcome, getTaskOutcome } from '../domain/taskOutcomes';
describe('an unfinished turn is never left satisfied (M0 C01/F03 contradiction)', () => {
  it('finalizing a conversational/verified verdict on an unfinished turn makes the task record partial', () => {
    const a = attempt('completed');
    updateTaskOutcome(db, { attemptId: a, objective: 'fix the bug', status: 'satisfied', evidence: [{ kind: 'tool', reference: 'list_directory' }] });
    event(a, 'turn_unfinished', { reason: 'nothing_built' });
    finalizeTaskOutcome(db, a, { verdict: 'conversational', reason: 'answered', performed: [], refused: [], failed: [] });
    expect(getTaskOutcome(db, a)?.status).toBe('partial');
    expect(deriveResultStatus(db, a).status).toBe('partial');
  });
  it('a finished turn keeps its satisfied record', () => {
    const a = attempt('completed');
    updateTaskOutcome(db, { attemptId: a, objective: 'x', status: 'satisfied', evidence: [{ kind: 'tool', reference: 'write_file' }] });
    finalizeTaskOutcome(db, a, { verdict: 'verified', reason: 'ok', performed: ['write_file'], refused: [], failed: [] });
    expect(getTaskOutcome(db, a)?.status).toBe('satisfied');
  });
});
