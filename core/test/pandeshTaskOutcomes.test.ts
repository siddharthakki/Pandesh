/**
 * The outcome record of a task, and the evidence that decides it.
 *
 * The defect this exists to fix: a turn that said "done" was recorded as a
 * completed task with a passing final verification, because the only witness
 * was the model's own sentence. A declined approval, a service that was not
 * connected, a permission that was not granted — all of them produced a green
 * result.
 *
 * These tests pin the three claims:
 *   1. A task cannot be satisfied without evidence.
 *   2. A refused action is not a completed task.
 *   3. A failed action that really ran (a build that does not compile) is a
 *      finding, not a broken task — the difference is not guessed at.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CoreDatabase } from '../db/connection';
import { openCoreDatabase } from '../db/openCore';
import {
  ensureTaskOutcome,
  finalizeTaskOutcome,
  getTaskOutcome,
  listTaskOutcomes,
  objectiveFromRequest,
  updateTaskOutcome,
} from '../domain/taskOutcomes';
import { evaluateTurnOutcome, type TurnToolCall } from '../runtime/turnOutcome';

let dir: string;
let db: CoreDatabase;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pandesh-task-outcomes-'));
  db = openCoreDatabase(path.join(dir, 'core.db')).db;
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function call(tool: string, text: string, isError = false): TurnToolCall {
  return {
    tool,
    status: 'completed',
    result: { isError, content: [{ type: 'text', text }] },
  };
}

describe('the task outcome record', () => {
  it('keeps the objective, the criteria, the capabilities and the next action', () => {
    const record = updateTaskOutcome(db, {
      attemptId: 'att_1',
      conversationId: 'conv_1',
      requestId: 'req_1',
      objective: 'Prepare the invoice PDF and put it in the reports folder',
      successCriteria: ['the PDF exists', 'it opens without an error'],
      capabilities: ['write_file', 'run_command'],
      status: 'in_progress',
      nextAction: 'run the build',
    });
    expect(record.objective).toContain('invoice PDF');
    expect(record.successCriteria).toHaveLength(2);
    expect(record.capabilities).toEqual(['write_file', 'run_command']);
    expect(record.nextAction).toBe('run the build');
    expect(getTaskOutcome(db, 'att_1')?.status).toBe('in_progress');
    expect(listTaskOutcomes(db, { conversationId: 'conv_1' })).toHaveLength(1);
  });

  it('refuses to satisfy a task with no evidence', () => {
    expect(() => updateTaskOutcome(db, {
      attemptId: 'att_2',
      objective: 'Send the invoice',
      status: 'satisfied',
    })).toThrow(/satisfied with evidence/);
  });

  it('refuses a blocked task that does not say what blocks it', () => {
    expect(() => updateTaskOutcome(db, {
      attemptId: 'att_3',
      objective: 'Send the invoice',
      status: 'blocked',
    })).toThrow(/must say what blocks it/);
  });

  it('refuses a partial task that does not name the next action', () => {
    expect(() => updateTaskOutcome(db, {
      attemptId: 'att_4',
      objective: 'Send the invoice',
      status: 'partial',
    })).toThrow(/must name the next action/);
  });

  it('accepts a satisfied task once there is real evidence', () => {
    const record = updateTaskOutcome(db, {
      attemptId: 'att_5',
      objective: 'Send the invoice',
      status: 'satisfied',
      evidence: [{ kind: 'artifact', reference: 'art_9' }],
    });
    expect(record.status).toBe('satisfied');
    expect(record.evidence).toEqual([{ kind: 'artifact', reference: 'art_9' }]);
  });
});

describe('what a turn actually did', () => {
  it('calls a plain answer a conversation, not a task', () => {
    const outcome = evaluateTurnOutcome([]);
    expect(outcome.verdict).toBe('conversational');
  });

  it('does not fail a turn because a read failed', () => {
    const outcome = evaluateTurnOutcome([call('read_file', 'Error: file not found', true)]);
    expect(outcome.verdict).toBe('conversational');
  });

  it('calls a refused action unverified — nothing happened', () => {
    const outcome = evaluateTurnOutcome([
      call('gmail_create_draft', 'NOT DONE: the user declined this action. NOTHING was done.'),
    ]);
    expect(outcome.verdict).toBe('unverified');
    expect(outcome.refused).toEqual(['gmail_create_draft']);
    expect(outcome.reason).toContain('did not happen');
  });

  it('calls a tool that ran and failed an attempted failure, not a refusal', () => {
    const outcome = evaluateTurnOutcome([
      call('run_command', 'Command exited with code 1\nnpm ERR! build failed', true),
    ]);
    expect(outcome.verdict).toBe('attempted_failed');
    expect(outcome.failed).toEqual(['run_command']);
    expect(outcome.refused).toEqual([]);
  });

  it('calls a successful action verified', () => {
    const outcome = evaluateTurnOutcome([call('write_file', 'Wrote C:/reports/invoice.html (2.1 KB)')]);
    expect(outcome.verdict).toBe('verified');
    expect(outcome.performed).toEqual(['write_file']);
  });

  it('treats an action that was started and never finished as refused', () => {
    const outcome = evaluateTurnOutcome([{ tool: 'gmail_send_draft', status: 'running' }]);
    expect(outcome.verdict).toBe('unverified');
  });

  it('does not call a finished action refused just because it has a start entry', () => {
    // The ledger keeps a 'running' entry when a call starts and a
    // 'completed' entry when it finishes. Both are present for every call
    // that worked, so the start entry must not be read as "it never happened".
    const outcome = evaluateTurnOutcome([
      { tool: 'memory_remember', status: 'running' },
      call('memory_remember', '{"memoryId":"mem_1","deduplicated":false}'),
    ]);
    expect(outcome.verdict).toBe('verified');
    expect(outcome.performed).toEqual(['memory_remember']);
    expect(outcome.refused).toEqual([]);
  });

  it('still refuses a call that only ever started', () => {
    const outcome = evaluateTurnOutcome([
      { tool: 'memory_remember', status: 'running' },
      { tool: 'write_file', status: 'running' },
    ]);
    expect(outcome.verdict).toBe('unverified');
    expect(outcome.refused.sort()).toEqual(['memory_remember', 'write_file']);
  });
});

describe('the deterministic task record', () => {
  it('creates the record from the request itself, with no help from the model', () => {
    const record = ensureTaskOutcome(db, {
      attemptId: 'att_det',
      conversationId: 'conv_det',
      requestId: 'req_det',
      objective: objectiveFromRequest('Build a small app for me.\n\nIt should do the thing.'),
    });
    expect(record.status).toBe('in_progress');
    // The objective is the user's own words, not a summary somebody invented.
    expect(record.objective).toBe('Build a small app for me. It should do the thing.');
  });

  it('never overwrites what the assistant already recorded', () => {
    ensureTaskOutcome(db, { attemptId: 'att_det2', objective: 'the raw request' });
    updateTaskOutcome(db, {
      attemptId: 'att_det2',
      objective: 'the objective the assistant agreed with the user on',
      successCriteria: ['it runs'],
    });
    const again = ensureTaskOutcome(db, { attemptId: 'att_det2', objective: 'the raw request' });
    expect(again.objective).toBe('the objective the assistant agreed with the user on');
    expect(again.successCriteria).toEqual(['it runs']);
  });

  it('bounds a very long request', () => {
    const objective = objectiveFromRequest('x'.repeat(5_000));
    expect(objective.length).toBeLessThanOrEqual(1_000);
  });
});

describe('finalizing a task from the evidence', () => {
  it('satisfies a task whose action reported success', () => {
    updateTaskOutcome(db, { attemptId: 'att_a', objective: 'Write the report' });
    const record = finalizeTaskOutcome(db, 'att_a', {
      verdict: 'verified',
      reason: '1 action completed',
      performed: ['write_file'],
      refused: [],
      failed: [],
    });
    expect(record?.status).toBe('satisfied');
    expect(record?.evidence).toEqual([{ kind: 'tool', reference: 'write_file' }]);
  });

  it('leaves a refused task partial, with the blocker written down', () => {
    updateTaskOutcome(db, { attemptId: 'att_b', objective: 'Create the draft' });
    const record = finalizeTaskOutcome(db, 'att_b', {
      verdict: 'unverified',
      reason: 'the requested work did not happen: gmail_create_draft reported that it could not do it',
      performed: [],
      refused: ['gmail_create_draft'],
      failed: [],
    });
    expect(record?.status).toBe('partial');
    expect(record?.blocker).toContain('did not happen');
    expect(record?.nextAction).toBeTruthy();
  });

  it('does nothing to a task that has no record at all', () => {
    expect(finalizeTaskOutcome(db, 'att_missing', {
      verdict: 'verified', reason: 'x', performed: ['write_file'], refused: [], failed: [],
    })).toBeUndefined();
  });
});
