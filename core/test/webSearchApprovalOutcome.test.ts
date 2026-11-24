/**
 * The web-search approval outcome must be a fact, not a guess.
 *
 * The reported symptom was Pandesh answering "Web access wasn't approved just
 * now" while no approval was ever shown to the user. The cause: every outcome
 * that was not "approved" — including nobody answering at all, and the request
 * failing to be created — was reported to the assistant as "the user did not
 * approve". A refusal was therefore reported without a recorded refusal.
 *
 * These tests pin the corrected contract:
 *   - a recorded decision is a refusal;
 *   - an unanswered request is not, and stays retryable;
 *   - a request that could not be created is a system error;
 *   - an unanswered request is retired as `expired`, never as `rejected`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openCoreDatabase } from '../db/openCore';
import type { CoreDatabase } from '../db/connection';
import { createRequest } from '../domain/requests';
import { createAttempt, getAttempt, transitionAttempt } from '../domain/attempts';
import { createApproval, expireApproval, getApproval, listApprovalsForAttempt } from '../domain/approvals';
import { acquireFence } from '../domain/fence';
import { describeUnansweredApproval, type PiToolApprovalOutcome } from '../runtime/piAgentEngine';

let dir: string;
let db: CoreDatabase;

function seedApproval(): { attemptId: string; approvalId: string } {
  const request = createRequest(db, {
    clientId: 'approval-outcome-test',
    currentMessage: 'What is the latest news?',
    requestedMode: 'baat_kar',
    resolvedMode: 'baat_kar',
    routeReason: 'test',
    correlationId: 'corr-approval-outcome',
    contextPolicy: {
      includeConversationHistory: true,
      includeProjectContext: false,
      includeRepositoryContext: false,
      includeGlobalStoryContext: false,
    },
  });
  const attempt = createAttempt(db, { requestId: request.id, kind: 'baat_kar', actor: 'test' });
  const fence = acquireFence(db, attempt.id, { owner: 'core:executor:1', actor: 'test', leaseMs: 120_000 });
  transitionAttempt(db, attempt.id, { toStatus: 'running', fenceToken: fence.token, actor: 'test' });
  transitionAttempt(db, attempt.id, { toStatus: 'waiting_for_approval', fenceToken: fence.token, actor: 'test' });
  const summary = {
    toolName: 'web_research',
    query: 'latest news today',
    cardText: 'Pandesh wants to search the web for: "latest news today".',
  };
  const approval = createApproval(db, { attemptId: attempt.id, kind: 'mutation', summary, presentation: summary, actor: 'test' });
  return { attemptId: attempt.id, approvalId: approval.id };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kkd-approval-outcome-'));
  db = openCoreDatabase(path.join(dir, 'core.db')).db;
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('an unanswered approval is never reported as a refusal', () => {
  it('describes a recorded rejection as a refusal', () => {
    const text = describeUnansweredApproval({ outcome: 'rejected' });
    expect(text).toMatch(/declined/i);
    expect(text).toMatch(/do not claim any web findings/i);
  });

  it('describes an unanswered request as unanswered, and keeps it retryable', () => {
    const text = describeUnansweredApproval({ outcome: 'timed_out' });
    expect(text).toMatch(/no answer/i);
    expect(text).not.toMatch(/the user (did not|declined|refused)/i);
    expect(text).toMatch(/can be made again/i);
  });

  it('describes a request that could not be created as a system error, not the user\'s decision', () => {
    const text = describeUnansweredApproval({ outcome: 'not_requested', reason: 'attempt is terminal' });
    expect(text).toMatch(/could not be created/i);
    expect(text).toMatch(/system error, not the user's decision/i);
    expect(text).not.toMatch(/the user (did not|declined|refused)/i);
  });

  it('never uses a refusal wording for any non-rejection outcome', () => {
    const outcomes: PiToolApprovalOutcome[] = [
      { outcome: 'timed_out' },
      { outcome: 'not_requested', reason: 'boom' },
    ];
    for (const outcome of outcomes) {
      expect(describeUnansweredApproval(outcome)).not.toMatch(/the user did not approve/i);
    }
  });
});

describe('an unanswered approval is retired as expired, never as rejected', () => {
  it('records expired with a reason and leaves no actionable approval behind', () => {
    const { attemptId, approvalId } = seedApproval();
    const expired = expireApproval(db, approvalId, { actor: 'test', reason: 'no answer was recorded before the request stopped waiting' });

    expect(expired.status).toBe('expired');
    expect(expired.resolution).toBeNull();
    expect(expired.resolvedAt).toBeTruthy();
    // No recorded decision: the audit trail must not contain a refusal.
    expect(listApprovalsForAttempt(db, attemptId).some((a) => a.status === 'rejected')).toBe(false);
    const events = db.all<{ eventType: string }>(
      'SELECT eventType FROM runtime_events WHERE entityId = ? ORDER BY sequence', [approvalId],
    );
    expect(events.map((e) => e.eventType)).toContain('approval_expired');
    expect(events.map((e) => e.eventType)).not.toContain('approval_resolved');
  });

  it('is idempotent: an already-resolved approval is returned unchanged', () => {
    const { approvalId } = seedApproval();
    expireApproval(db, approvalId, { actor: 'test' });
    const again = expireApproval(db, approvalId, { actor: 'test' });
    expect(again.status).toBe('expired');
    const events = db.all<{ eventType: string }>(
      'SELECT eventType FROM runtime_events WHERE entityId = ? ORDER BY sequence', [approvalId],
    );
    expect(events.filter((e) => e.eventType === 'approval_expired')).toHaveLength(1);
  });

  it('does not touch an approval that was actually decided', () => {
    const { approvalId } = seedApproval();
    // A recorded decision stays a decision.
    db.run(`UPDATE approvals SET status = 'rejected', resolution = 'rejected', resolvedAt = ? WHERE id = ?`,
      [new Date().toISOString(), approvalId]);
    const after = expireApproval(db, approvalId, { actor: 'test' });
    expect(after.status).toBe('rejected');
    expect(getApproval(db, approvalId).status).toBe('rejected');
  });
});

describe('a refusal of web access holds for the rest of the task', () => {
  // Live finding 2026-11-23 (scratch instance, attempt att_1b8c83f6): the person pressed "Don't allow" on a web search; the
  // model called web_research again with other words and a second approval card was raised two seconds later.
  const engine = fs.readFileSync(path.join(__dirname, '../runtime/piAgentEngine.ts'), 'utf8');

  it('tells the assistant it was not asked again, forbids another request, and names what is still possible', async () => {
    const { describeRepeatedWebAccessRequest } = await import('../runtime/piAgentEngine');
    const text = describeRepeatedWebAccessRequest();
    expect(text).toContain('already declined web access for this task');
    expect(text).toContain('they were not asked again');
    expect(text).toContain('Do not ask for web access again in this turn');
    expect(text).toMatch(/allow a search by asking again.*paste the text or a link.*needs no web access/);
  });

  it('only a recorded refusal sets the flag, and the flag is checked before any approval is requested', () => {
    // Set from the recorded decision only: an unanswered or failed request stays retryable.
    expect(engine).toContain("if (decision.outcome === 'rejected') webResearchDeclined = true;");
    expect(engine).toContain("if (decision.outcome === 'rejected') agentReachDeclined = true;");
    expect(engine).not.toMatch(/outcome === 'timed_out'[^\n]*Declined = true/);
    // web_research: the refusal is honoured before the approval request.
    const guard = engine.indexOf('if (webResearchDeclined) {');
    const ask = engine.indexOf('if (!webResearchApproved || privacyFlag) {');
    const review = engine.indexOf("const privacyFlag = await queryPrivacyFlag('web_research', query);");
    expect(guard).toBeGreaterThan(0);
    expect(guard).toBeLessThan(ask);
    // ...and before the local privacy review: a query that will not be sent is not reviewed or recorded as "asked".
    expect(guard).toBeLessThan(review);
    expect(engine.slice(guard, review)).toContain('describeRepeatedWebAccessRequest()');
    expect(engine.slice(guard, review)).toContain("'web_access_request_not_repeated'");
    // agent_reach and the offer search behind advance_wish follow the same rule.
    expect(engine.indexOf('if (agentReachDeclined) {')).toBeLessThan(engine.indexOf('if (!agentReachApproved) {'));
    expect(engine).toContain('if (webResearchDeclined) return { approved: false, message: describeRepeatedWebAccessRequest() };');
  });
});
