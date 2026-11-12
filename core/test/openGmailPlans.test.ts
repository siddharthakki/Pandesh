/**
 * Production, 2026-11-12: a Gmail preview made in one turn could not be applied in the next. The reply had named it
 * "gplan_1a2b3c4d...", the next turn saw only that (tool results are not part of the history), the model made up the
 * rest of the id, and gmail_apply_plan found no such plan. The open preview, with its exact id, must reach the next turn.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CoreDatabase } from '../db/connection';
import { openCoreDatabase } from '../db/openCore';
import { createRequest } from '../domain/requests';
import { createConversation } from '../domain/conversations';
import { createGmailOrganizeStore } from '../domain/gmailChangePlans';
import { listOpenGmailPlans, renderOpenGmailPlansSection } from '../domain/openGmailPlans';
import type { GmailChangePlan } from '../runtime/connectors/gmailOrganize';

const NOW = Date.UTC(2026, 10, 12, 7, 14, 55);
const MINUTE = 60_000;

let dir: string;
let db: CoreDatabase;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pandesh-open-gmail-')); db = openCoreDatabase(path.join(dir, 'core.db')).db; });
afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const newPlanId = () => `gplan_${crypto.randomUUID()}`;

function plan(planId: string, overrides: Partial<GmailChangePlan> = {}): GmailChangePlan {
  return {
    planId, accountEmail: 'me@example.com', status: 'planned', digest: 'd'.repeat(64), query: 'category:promotions newer_than:30d',
    coverage: { listed: 2, estimatedTotal: 2, exhausted: true, statement: 'Complete' },
    operation: { addLabelIds: [], removeLabelIds: [], createLabels: ['Newsletters'], summary: 'add label "Newsletters" (new: "Newsletters")' },
    messages: [
      { id: 'm1', threadId: 't1', from: 'Shop <deals@shop.example>', subject: 'Private subject one', date: '', priorLabelIds: ['INBOX'], class: 'promotions' },
      { id: 'm2', threadId: 't2', from: 'Shop <deals@shop.example>', subject: 'Private subject two', date: '', priorLabelIds: ['INBOX'], class: 'promotions' },
    ],
    createdAt: new Date(NOW - 5 * MINUTE).toISOString(),
    expiresAt: new Date(NOW + 24 * 60 * MINUTE).toISOString(),
    ...overrides,
  };
}

/** What gmail_plan_changes returns: the id first, then the rest of the preview. */
const previewOutput = (planId: string) => JSON.stringify({ planId, planDigest: 'd'.repeat(64), status: 'planned', change: 'add label "Newsletters"', willChange: 2, sample: [{ subject: 'Private subject one' }] });

let seq = 0;
/** One earlier turn whose gmail_plan_changes call returned `output` (recorded `times` times, as the capability anchor does). */
function turnWithPreview(conversationId: string, output: string, options: { status?: string; times?: number; minutesAgo?: number } = {}): string {
  seq += 1;
  const request = createRequest(db, {
    clientId: 'client-1', currentMessage: `turn ${seq}`, requestedMode: 'saath_kar', resolvedMode: 'saath_kar', routeReason: 'test', conversationId,
    contextPolicy: { includeConversationHistory: true, includeProjectContext: false, includeRepositoryContext: false, includeGlobalStoryContext: false },
    correlationId: `corr-${seq}`,
  });
  const at = new Date(NOW - (options.minutesAgo ?? 1) * MINUTE + seq).toISOString();
  db.run(`INSERT INTO attempts (id, requestId, kind, status, createdAt, updatedAt, revision) VALUES (?, ?, 'saath_kar', 'completed', ?, ?, 1)`, [`att_${seq}`, request.id, at, at]);
  for (let i = 0; i < (options.times ?? 1); i += 1) {
    db.run(`INSERT INTO tool_invocations (id, attemptId, toolName, argsSummary, status, startedAt, endedAt, evidence) VALUES (?, ?, 'gmail_plan_changes', '{}', ?, ?, ?, ?)`,
      [`ti_${seq}_${i}`, `att_${seq}`, options.status ?? 'succeeded', at, at, JSON.stringify({ output })]);
  }
  return request.id;
}

const conversation = () => createConversation(db, { mode: 'saath_kar', actor: 'client-1' }).id;

describe('Gmail previews still open in a conversation', () => {
  it('carries the open preview with its exact id into the next turn, without senders or subjects', () => {
    const store = createGmailOrganizeStore(db, () => NOW);
    const conv = conversation();
    const planId = newPlanId();
    store.save(plan(planId));
    turnWithPreview(conv, previewOutput(planId), { times: 2 });

    const open = listOpenGmailPlans(db, conv, { nowMs: NOW });
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ planId, messages: 2, change: 'add label "Newsletters" (new: "Newsletters")' });

    const section = renderOpenGmailPlansSection(open);
    expect(section).toContain(`planId ${planId}:`);
    expect(section).toContain('2 messages; found with: category:promotions newer_than:30d');
    expect(section).toMatch(/call gmail_apply_plan with its planId exactly as written here, never shortened or retyped from memory/);
    expect(section).toContain('nothing in the mailbox has changed yet');
    expect(section).not.toContain('Private subject');
    expect(section).not.toContain('deals@shop.example');
  });

  it("finds the id in Core's shortened copy of the tool output", () => {
    const store = createGmailOrganizeStore(db, () => NOW);
    const conv = conversation();
    const planId = newPlanId();
    store.save(plan(planId));
    turnWithPreview(conv, previewOutput(planId).slice(0, 70));
    expect(listOpenGmailPlans(db, conv, { nowMs: NOW }).map((p) => p.planId)).toEqual([planId]);
  });

  it('lists only open previews of this conversation, newest first: not applied, expired, task, failed or other ones', () => {
    const store = createGmailOrganizeStore(db, () => NOW);
    const conv = conversation();
    const other = conversation();
    const [older, newer, applied, expired, task, inOther] = Array.from({ length: 6 }, newPlanId);
    store.save(plan(older));
    store.save(plan(newer));
    store.save(plan(applied, { status: 'applied' }));
    store.save(plan(expired, { expiresAt: new Date(NOW - MINUTE).toISOString() }));
    store.save(plan(task, { taskId: 'gtask_1' }));
    store.save(plan(inOther));
    turnWithPreview(conv, previewOutput(older), { minutesAgo: 9 });
    turnWithPreview(conv, previewOutput(applied), { minutesAgo: 8 });
    turnWithPreview(conv, previewOutput(expired), { minutesAgo: 7 });
    turnWithPreview(conv, previewOutput(task), { minutesAgo: 6 });
    turnWithPreview(conv, previewOutput(newPlanId()), { minutesAgo: 5, status: 'failed' });
    turnWithPreview(conv, previewOutput(newer), { minutesAgo: 4 });
    turnWithPreview(other, previewOutput(inOther), { minutesAgo: 3 });
    const current = turnWithPreview(conv, 'NOT DONE (gws_invalid_arguments): gmail_plan_changes: provide a Gmail "query"', { minutesAgo: 0 });

    expect(listOpenGmailPlans(db, conv, { nowMs: NOW, excludeRequestId: current }).map((p) => p.planId)).toEqual([newer, older]);
    expect(listOpenGmailPlans(db, conv, { nowMs: NOW, limit: 1 }).map((p) => p.planId)).toEqual([newer]);
  });

  it('is empty when no preview is open', () => {
    const conv = conversation();
    expect(listOpenGmailPlans(db, conv, { nowMs: NOW })).toEqual([]);
    expect(renderOpenGmailPlansSection([])).toBe('');
  });

  it('the plan journal lists the open previews of an account, newest first', () => {
    const store = createGmailOrganizeStore(db, () => NOW);
    const first = newPlanId();
    const second = newPlanId();
    store.save(plan(first, { createdAt: new Date(NOW - 9 * MINUTE).toISOString() }));
    store.save(plan(second, { createdAt: new Date(NOW - 2 * MINUTE).toISOString() }));
    store.save(plan(newPlanId(), { status: 'applied' }));
    store.save(plan(newPlanId(), { accountEmail: 'someone-else@example.com' }));
    store.save(plan(newPlanId(), { expiresAt: new Date(NOW - MINUTE).toISOString() }));
    const nowIso = new Date(NOW).toISOString();
    expect(store.listOpen!('ME@example.com', nowIso, 5).map((p) => p.planId)).toEqual([second, first]);
    expect(store.listOpen!('me@example.com', nowIso, 1).map((p) => p.planId)).toEqual([second]);
  });
});
