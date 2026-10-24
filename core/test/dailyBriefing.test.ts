/**
 * The daily briefing ranks by importance, carries unresolved items across days,
 * says plainly what it could not read, groups old clutter, and never writes.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CoreDatabase } from '../db/connection';
import { openCoreDatabase } from '../db/openCore';
import { submitRequest } from '../domain/submission';
import { createConversation } from '../domain/conversations';
import { claimAttempt, transitionAttempt } from '../domain/attempts';
import { createApproval } from '../domain/approvals';
import { createCommitment, listCommitments } from '../domain/commitments';
import { createReminder, listReminders, markReminderNotified } from '../domain/everydayTools';
import { createScheduledTask, listScheduledTasks } from '../domain/scheduledTasks';
import { configureDailyBriefRoutine as _unused } from '../domain/assistantRoutine';
import { buildAssistantTodaySections } from '../domain/assistantBrief';
import { findDuplicateBriefingSchedules, summarizeCalendar, triageEmail, ymdInZone } from '../domain/briefingTriage';
import { buildDailyBriefing, renderDailyBriefing, type BriefingReader } from '../runtime/dailyBriefing';

void _unused;
const TZ = 'Europe/Berlin';
// Fri 23 Oct 2026, 07:30 in Berlin (CEST, UTC+2).
const NOW = Date.parse('2026-10-23T05:30:00Z');
const YESTERDAY_EVENING = '2026-10-22T16:04:00Z';

let dir: string;
let db: CoreDatabase;
let n = 0;

function mail(id: string, subject: string, from: string, snippet: string, receivedAt: string, labels: string[] = ['INBOX', 'UNREAD']) {
  return { id, threadId: `t_${id}`, subject, from, snippet, receivedAt, labels };
}

function searchResult(rows: any[], extra: Record<string, unknown> = {}) {
  return { ok: true as const, data: { results: rows, truncated: false, counts: { matched: rows.length, matchedIsExact: true, listed: rows.length, shown: rows.length, failedLookups: 0 }, ...extra } };
}

/** A fake Gmail/Calendar whose answers depend on which of the briefing's searches is asked. */
function fakeReader(opts: {
  inbox?: any[];
  signals?: any[];
  sent?: any[];
  events?: any[] | 'fail';
  mailFails?: boolean;
  calls?: Array<{ tool: string; query?: string }>;
}): BriefingReader {
  return async (tool, args) => {
    opts.calls?.push({ tool, query: String(args.query ?? '') });
    if (tool === 'calendar_list_events') {
      return opts.events === 'fail' ? { ok: false, reason: 'Google Calendar is not connected' } : { ok: true, data: { timeZone: TZ, events: opts.events ?? [] } };
    }
    if (opts.mailFails) return { ok: false, reason: 'Gmail read access has not been granted' };
    const q = String(args.query);
    if (q.startsWith('in:sent')) return searchResult(opts.sent ?? []);
    if (q.includes('is:starred')) return searchResult([]);
    if (q.includes('expires OR')) return searchResult(opts.signals ?? []);
    return searchResult(opts.inbox ?? []);
  };
}

function submit(message: string) {
  const conv = createConversation(db, { mode: 'saath_kar', actor: 'test' });
  return submitRequest(db, {
    clientId: 'test-client', currentMessage: message, requestedMode: 'saath_kar', conversationId: conv.id,
    workspaceRoot: dir, capability: { hasWorkspace: true, gitCapable: false }, correlationId: `corr-${++n}`,
    toolPermissionPolicy: { profile: 'confirm-mutations', allowedTools: ['read_file'] },
    modelSelection: {
      selectedProvider: 'ollama', selectedModel: 'zeta:1b', selectionReason: 'test', suitabilitySummary: 'test', userOverrode: false,
      candidates: [], escalationCandidates: [],
      requiredCapabilities: { readOnlyExplanation: false, repositoryExploration: true, toolCalling: true, fileModification: true, codingComplexity: 'low', contextRequirement: 'small', vision: false, validationAndRepair: false },
    },
  });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-briefing-'));
  db = openCoreDatabase(path.join(dir, 'core.db')).db;
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const yesterdaysItems = [
  mail('m1', 'AI Collusion Research Sprint begins October 23', 'Research Team <sprint@lab.org>', 'The sprint starts on October 23. Please confirm your participation.', YESTERDAY_EVENING),
  mail('m2', 'Your Creative Fabrica payment confirmation', 'Creative Fabrica <billing@creativefabrica.com>', 'We received your payment of $19.', '2026-10-22T10:00:00Z', ['INBOX']),
  mail('m3', 'Synology: failed login attempts on your NAS', 'Synology <no-reply@synology.com>', 'There were 5 failed login attempts.', '2026-10-22T03:00:00Z'),
  mail('m4', 'Reminder: table booking at Trattoria Roma', 'Trattoria Roma <info@roma.example>', 'Your reservation is confirmed for October 24 at 19:30.', '2026-10-21T12:00:00Z', ['INBOX']),
  mail('m5', 'HDFC account balance notice', 'HDFC Bank <alerts@hdfcbank.example>', 'Your account balance is low.', '2026-10-22T08:00:00Z', ['INBOX']),
];
const promos = Array.from({ length: 5 }, (_, i) =>
  mail(`p${i}`, `${20 + i}% off everything this weekend`, 'Shop <deals@shop.example>', 'Limited time sale, free shipping', `2026-10-23T0${i}:00:00Z`, ['INBOX', 'UNREAD', 'CATEGORY_PROMOTIONS']));

describe('importance, not recency', () => {
  it('keeps yesterday\'s unresolved important mail ahead of five fresh promotions', async () => {
    const briefing = await buildDailyBriefing(db, { nowMs: NOW, timeZone: TZ, read: fakeReader({ inbox: [...promos, ...yesterdaysItems] }) });
    const text = renderDailyBriefing(briefing);
    for (const subject of ['AI Collusion Research Sprint', 'Creative Fabrica', 'Synology', 'Trattoria Roma', 'HDFC']) expect(text).toContain(subject);
    expect(text).not.toContain('% off everything');
    expect(text).toContain('5 promotional emails hidden');
    // The deadline that is today outranks everything else.
    expect(briefing.priorities[0].title).toContain('AI Collusion Research Sprint');
    expect(briefing.priorities[0].fact).toContain('carried over');
    expect(briefing.priorities).toHaveLength(3);
  });

  it('does not carry forward a thread the owner already answered or that left the inbox', async () => {
    const reader = fakeReader({
      inbox: yesterdaysItems,
      sent: [mail('s1', 'Re: AI Collusion Research Sprint begins October 23', 'me', '', '2026-10-22T18:00:00Z', ['SENT'])].map((m) => ({ ...m, threadId: 't_m1' })),
    });
    const text = renderDailyBriefing(await buildDailyBriefing(db, { nowMs: NOW, timeZone: TZ, read: reader }));
    expect(text).not.toContain('AI Collusion Research Sprint begins');
    expect(text).toContain('Synology');
  });

  it('surfaces a promotional offer only when its deadline is near', () => {
    const ctx = { nowMs: NOW, timeZone: TZ };
    const today = triageEmail(mail('a', 'AI Governance offer expiring October 23', 'AI Gov <news@aigov.example>', 'Offer expires October 23.', YESTERDAY_EVENING, ['INBOX', 'CATEGORY_PROMOTIONS']), ctx);
    expect(today.kind).toBe('surface');
    const later = triageEmail(mail('b', 'Big sale ends November 30', 'Shop <deals@shop.example>', '30% off, ends November 30', YESTERDAY_EVENING, ['INBOX', 'CATEGORY_PROMOTIONS']), ctx);
    expect(later).toEqual({ kind: 'suppressed', reason: 'promotion' });
  });

  it('does not treat unread as important', () => {
    const verdict = triageEmail(mail('c', 'Weekly digest', 'Digest <newsletter@site.example>', 'Here is what happened', YESTERDAY_EVENING), { nowMs: NOW, timeZone: TZ });
    expect(verdict.kind).toBe('suppressed');
  });

  it('reads Gmail with a bounded number of searches', async () => {
    const calls: Array<{ tool: string; query?: string }> = [];
    await buildDailyBriefing(db, { nowMs: NOW, timeZone: TZ, read: fakeReader({ calls }) });
    expect(calls.filter((c) => c.tool === 'gmail_search')).toHaveLength(4);
    expect(calls.filter((c) => c.tool === 'calendar_list_events')).toHaveLength(1);
  });
});

describe('calendar wording', () => {
  it('says "No events scheduled today" after a successful empty read, and names the next event', async () => {
    const events = [{ id: 'e1', title: 'Dentist', start: '2026-10-26T10:00:00+01:00', end: '2026-10-26T11:00:00+01:00', allDay: false }];
    const text = renderDailyBriefing(await buildDailyBriefing(db, { nowMs: NOW, timeZone: TZ, read: fakeReader({ events }) }));
    expect(text).toContain('No events scheduled today.');
    expect(text).toContain('Next: Dentist');
    expect(text).not.toContain('Nothing recorded');
  });

  it('distinguishes a failed read from an empty one', async () => {
    const text = renderDailyBriefing(await buildDailyBriefing(db, { nowMs: NOW, timeZone: TZ, read: fakeReader({ events: 'fail' }) }));
    expect(text).toContain('Not checked: Google Calendar is not connected');
    expect(text).not.toContain('No events scheduled today');
  });

  it('flags a result that hit its cap as partial coverage', () => {
    const events = Array.from({ length: 25 }, (_, i) => ({ id: `e${i}`, title: `E${i}`, start: '2026-10-29T10:00:00+01:00', end: '2026-10-29T11:00:00+01:00', allDay: false }));
    const summary = summarizeCalendar({ ok: true, data: { events, timeZone: TZ } }, NOW, TZ, { maxResults: 25 });
    expect(summary.status).toBe('partial');
  });

  it('detects overlapping events today', () => {
    const events = [
      { id: 'a', title: 'A', start: '2026-10-23T10:00:00+02:00', end: '2026-10-23T11:00:00+02:00', allDay: false },
      { id: 'b', title: 'B', start: '2026-10-23T10:30:00+02:00', end: '2026-10-23T11:30:00+02:00', allDay: false },
    ];
    const summary = summarizeCalendar({ ok: true, data: { events, timeZone: TZ } }, NOW, TZ, { maxResults: 25 });
    expect(summary.today).toHaveLength(2);
    expect(summary.conflicts).toHaveLength(1);
  });
});

describe('Europe/Berlin dates and midnight rollover', () => {
  it('treats 23:30 UTC on the 22nd as already the 23rd in Berlin', () => {
    const lateUtc = Date.parse('2026-10-22T22:30:00Z');
    expect(ymdInZone(lateUtc, TZ)).toBe('2026-10-23');
    expect(ymdInZone(lateUtc, 'UTC')).toBe('2026-10-22');
    const events = [{ id: 'x', title: 'Early start', start: '2026-10-23T00:15:00+02:00', end: '2026-10-23T01:00:00+02:00', allDay: false }];
    expect(summarizeCalendar({ ok: true, data: { events, timeZone: TZ } }, lateUtc, TZ, { maxResults: 25 }).today).toHaveLength(1);
  });

  it('judges "ends today" against the local day, so a deadline flips at local midnight', () => {
    const m = mail('d', 'Offer expires October 23', 'Shop <news@shop.example>', 'expires October 23', '2026-10-20T10:00:00Z', ['INBOX']);
    const before = triageEmail(m, { nowMs: Date.parse('2026-10-22T21:30:00Z'), timeZone: TZ }); // 23:30 on the 22nd
    const after = triageEmail(m, { nowMs: Date.parse('2026-10-22T22:30:00Z'), timeZone: TZ }); // 00:30 on the 23rd
    expect(before.kind === 'surface' && before.email.daysUntil).toBe(1);
    expect(after.kind === 'surface' && after.email.daysUntil).toBe(0);
  });
});

describe('stale clutter and housekeeping', () => {
  it('groups old approvals, an old interrupted task and fired reminders instead of listing them', async () => {
    const old = new Date(NOW - 7 * 86_400_000).toISOString();
    for (let i = 0; i < 5; i++) {
      const sub = submit(`Find projects ${i}`);
      transitionAttempt(db, sub.attempt.id, { toStatus: 'running', actor: 'test' });
      transitionAttempt(db, sub.attempt.id, { toStatus: 'waiting_for_approval', actor: 'test' });
      const approval = createApproval(db, { attemptId: sub.attempt.id, kind: 'mutation', summary: { toolName: 'request_search_permission' }, presentation: { cardText: 'May I search project directory names in C:\\Projects? This is read-only.' }, actor: 'test' });
      db.run('UPDATE approvals SET requestedAt = ? WHERE id = ?', [old, approval.id]);
    }
    const stuck = submit('Refactor the importer');
    transitionAttempt(db, stuck.attempt.id, { toStatus: 'running', actor: 'test' });
    claimAttempt(db, stuck.attempt.id, { claimOwner: 'core:executor:1', leaseMs: 1, actor: 'test' });
    const sept = new Date('2026-09-11T10:00:00Z').toISOString();
    db.run('UPDATE attempts SET claimExpiresAt = ?, updatedAt = ?, createdAt = ? WHERE id = ?', [sept, sept, sept, stuck.attempt.id]);
    db.run("UPDATE runtime_events SET createdAt = ? WHERE domain = 'attempt' AND entityId = ?", [sept, stuck.attempt.id]);
    for (const title of ['Call the bank', 'Send the form']) {
      const r = createReminder(db, { title, dueAt: new Date(NOW - 3 * 3_600_000).toISOString(), timezone: TZ });
      markReminderNotified(db, r.id);
    }

    const briefing = await buildDailyBriefing(db, { nowMs: NOW, timeZone: TZ, read: fakeReader({}) });
    expect(briefing.decisions).toHaveLength(0);
    expect(briefing.priorities).toHaveLength(0);
    const text = renderDailyBriefing(briefing);
    expect(text).toContain('5 older approvals still pending');
    expect(text).toContain('5 are read-only folder search permissions');
    expect(text).toContain('I have not approved, rejected or expired any');
    expect(text).toContain('1 interrupted task');
    expect(text).toContain('2 reminders already fired');
    expect(text).toMatch(/dismiss.*reschedule/);
    // The briefing is a summary: it stays compact.
    expect(text.split('\n').length).toBeLessThan(40);
    // And nothing was resolved behind the owner's back.
    expect(db.get<{ c: number }>("SELECT COUNT(*) AS c FROM approvals WHERE status = 'pending'")!.c).toBe(5);
    expect(listReminders(db, { status: 'open' })).toHaveLength(2);
  });

  it('labels yesterday\'s completion as yesterday, never "earlier today"', () => {
    const sub = submit('Summarise the report');
    transitionAttempt(db, sub.attempt.id, { toStatus: 'running', actor: 'test' });
    transitionAttempt(db, sub.attempt.id, { toStatus: 'completed', actor: 'test' } as never);
    const yesterday = new Date(NOW - 20 * 3_600_000).toISOString();
    db.run('UPDATE attempts SET completedAt = ?, updatedAt = ? WHERE id = ?', [yesterday, yesterday, sub.attempt.id]);
    const items = buildAssistantTodaySections(db, { nowMs: NOW, timezone: TZ }).flatMap((s) => s.items);
    const done = items.find((i) => i.kind === 'task_completed');
    expect(done?.title).toBe('Completed yesterday');
  });

  it('keeps a fresh approval as a current decision', async () => {
    const sub = submit('Edit the invoice');
    transitionAttempt(db, sub.attempt.id, { toStatus: 'running', actor: 'test' });
    const approval = createApproval(db, { attemptId: sub.attempt.id, kind: 'mutation', summary: { toolName: 'write_file' }, presentation: { cardText: 'Write invoice.html' }, actor: 'test' });
    db.run('UPDATE approvals SET requestedAt = ? WHERE id = ?', [new Date(NOW - 3_600_000).toISOString(), approval.id]);
    const briefing = await buildDailyBriefing(db, { nowMs: NOW, timeZone: TZ, read: fakeReader({}) });
    expect(briefing.decisions.map((d) => d.title)).toContain('Approval needed: write a file');
    expect(briefing.housekeeping.join(' ')).not.toContain('older approval');
  });
});

describe('duplicate 08:00 briefings', () => {
  it('finds both, names the canonical one, and changes nothing', async () => {
    const routine = createScheduledTask(db, { title: 'Daily brief', instruction: 'Deliver today\'s brief.', dailyTime: '08:00', timezone: TZ, routine: 'daily_brief' });
    const model = createScheduledTask(db, { title: 'Morning briefing', instruction: 'Give me my daily briefing.', dailyTime: '08:00', timezone: TZ });
    createScheduledTask(db, { title: 'Water plants', instruction: 'Remind me to water plants.', dailyTime: '08:00', timezone: TZ });

    const groups = findDuplicateBriefingSchedules(listScheduledTasks(db));
    expect(groups).toHaveLength(1);
    expect(groups[0].canonical.id).toBe(routine.id);
    expect(groups[0].redundant.map((t) => t.id)).toEqual([model.id]);

    const before = JSON.stringify(listScheduledTasks(db, true));
    const text = renderDailyBriefing(await buildDailyBriefing(db, { nowMs: NOW, timeZone: TZ, read: fakeReader({}) }));
    expect(text).toContain('2 daily briefings are scheduled for 08:00');
    expect(text).toContain(`Keep "Daily brief" [schedule ${routine.id}]`);
    expect(text).toContain('Nothing has been changed');
    expect(JSON.stringify(listScheduledTasks(db, true))).toBe(before);
  });
});

describe('repeatability and honesty', () => {
  it('creates no commitments or reminders however often it runs', async () => {
    createCommitment(db, { title: 'Send Priya the draft', dueAt: new Date(NOW + 5 * 3_600_000).toISOString() });
    createReminder(db, { title: 'Pay rent', dueAt: new Date(NOW + 2 * 3_600_000).toISOString(), timezone: TZ });
    const reader = fakeReader({ inbox: yesterdaysItems });
    const first = renderDailyBriefing(await buildDailyBriefing(db, { nowMs: NOW, timeZone: TZ, read: reader }));
    const second = renderDailyBriefing(await buildDailyBriefing(db, { nowMs: NOW, timeZone: TZ, read: reader }));
    expect(second).toBe(first);
    expect(listCommitments(db, {})).toHaveLength(1);
    expect(listReminders(db, { status: 'all' })).toHaveLength(1);
  });

  it('says when mail could not be read instead of reporting an empty inbox', async () => {
    const text = renderDailyBriefing(await buildDailyBriefing(db, { nowMs: NOW, timeZone: TZ, read: fakeReader({ mailFails: true }) }));
    expect(text).toContain('Not checked: Gmail read access has not been granted');
    expect(text).not.toContain('Nothing in your inbox needs you');
  });

  it('reports truncated mail searches as partial coverage', async () => {
    const reader: BriefingReader = async (tool, args) => tool === 'calendar_list_events'
      ? { ok: true, data: { timeZone: TZ, events: [] } }
      : searchResult(yesterdaysItems.slice(0, 2), { truncated: true, counts: { matched: 400, matchedIsExact: false, listed: 30, shown: 2, failedLookups: 0 } });
    const briefing = await buildDailyBriefing(db, { nowMs: NOW, timeZone: TZ, read: reader });
    expect(briefing.email.status).toBe('partial');
    expect(renderDailyBriefing(briefing)).toContain('coverage is partial');
  });

  it('recommends a specific action grounded in the top item', async () => {
    const briefing = await buildDailyBriefing(db, { nowMs: NOW, timeZone: TZ, read: fakeReader({ inbox: yesterdaysItems }) });
    expect(briefing.nextAction.text).toContain('AI Collusion Research Sprint');
    expect(briefing.nextAction.basis).toContain('[Gmail m1]');
  });
});
