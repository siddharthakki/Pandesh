import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CoreDatabase } from '../db/connection';
import { openCoreDatabase } from '../db/openCore';
import { createConversation } from '../domain/conversations';
import { createRequest } from '../domain/requests';
import { answerTaskStatusQuestion, isTaskStatusQuestion, listPriorTurns, renderTaskHistorySection } from '../domain/conversationTaskHistory';

// Verbatim prompts from the Build 159 audit, M12 (stop, restart and truthful recovery).
const M12_TASK = 'Analyze the documents in this folder, identify the major differences, and prepare a summary report.';
const M12_FOLLOW_UP = 'What happened to my previous task? Was it completed, cancelled or interrupted?';

let dir: string;
let db: CoreDatabase;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pandesh-task-history-'));
  db = openCoreDatabase(path.join(dir, 'core.db')).db;
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function turn(conversationId: string, message: string, status: string, extra: { failureReason?: string; claimExpiresAt?: string; at?: string } = {}): string {
  const request = createRequest(db, {
    clientId: 'client-1', currentMessage: message, requestedMode: 'saath_kar', resolvedMode: 'saath_kar', routeReason: 'test', conversationId,
    contextPolicy: { includeConversationHistory: true, includeProjectContext: false, includeRepositoryContext: false, includeGlobalStoryContext: false },
    correlationId: `corr-${message.length}-${status}`,
  });
  const at = extra.at ?? new Date().toISOString();
  db.run(
    `INSERT INTO attempts (id, requestId, kind, status, createdAt, updatedAt, cancelledAt, failureReason, claimExpiresAt, revision)
     VALUES (?, ?, 'saath_kar', ?, ?, ?, ?, ?, ?, 1)`,
    [`att_${request.id}`, request.id, status, at, at, status === 'cancelled' ? at : null, extra.failureReason ?? null, extra.claimExpiresAt ?? null],
  );
  return request.id;
}

describe('conversation task history (audit D4)', () => {
  it('recognises the M12 follow-up as a task status question, and not ordinary requests', () => {
    expect(isTaskStatusQuestion(M12_FOLLOW_UP)).toBe(true);
    expect(isTaskStatusQuestion('Did you finish the report task?')).toBe(true);
    expect(isTaskStatusQuestion('Analyze the documents in this folder')).toBe(false);
    expect(isTaskStatusQuestion('What happened in the news today?')).toBe(false);
  });

  it('a cancelled task is reported as cancelled, not pending (M12)', () => {
    const conversation = createConversation(db, { mode: 'saath_kar', actor: 'client-1' });
    turn(conversation.id, M12_TASK, 'cancelled');
    const current = turn(conversation.id, M12_FOLLOW_UP, 'running');
    const turns = listPriorTurns(db, conversation.id, { excludeRequestId: current });
    expect(turns.map((t) => t.status)).toEqual(['cancelled']);
    const answer = answerTaskStatusQuestion(turns)!;
    expect(answer).toMatch(/was cancelled/);
    expect(answer).toMatch(/not resumed/);
    expect(answer).not.toMatch(/ready to|completed/);
    expect(renderTaskHistorySection(turns)).toMatch(/CANCELLED/);
  });

  it('a running attempt whose claim lapsed (app restarted under it) is interrupted', () => {
    const conversation = createConversation(db, { mode: 'saath_kar', actor: 'client-1' });
    turn(conversation.id, M12_TASK, 'running', { claimExpiresAt: new Date(Date.now() - 60_000).toISOString() });
    const turns = listPriorTurns(db, conversation.id, { excludeRequestId: 'none' });
    expect(turns[0].status).toBe('interrupted');
    expect(answerTaskStatusQuestion(turns)).toMatch(/interrupted/);
  });

  it('failed and completed tasks are reported as such, newest first', () => {
    const conversation = createConversation(db, { mode: 'saath_kar', actor: 'client-1' });
    turn(conversation.id, 'Summarise the policy', 'completed', { at: '2026-11-06T10:00:00.000Z' });
    turn(conversation.id, 'Export the report as PDF', 'failed', { failureReason: 'model connection lost', at: '2026-11-06T11:00:00.000Z' });
    const turns = listPriorTurns(db, conversation.id);
    expect(turns.map((t) => t.status)).toEqual(['failed', 'completed']);
    expect(answerTaskStatusQuestion(turns)).toMatch(/failed .* model connection lost/);
  });

  it('no earlier task → no answer and no prompt section', () => {
    const conversation = createConversation(db, { mode: 'saath_kar', actor: 'client-1' });
    expect(listPriorTurns(db, conversation.id)).toEqual([]);
    expect(answerTaskStatusQuestion([])).toBeNull();
    expect(renderTaskHistorySection([])).toBe('');
  });
});
