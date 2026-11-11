/**
 * Pandesh must never claim it did, scheduled or notified something without system evidence:
 * the notification outbox, the status answers built from recorded state, the promise audit,
 * and the honest Gmail task states.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openDatabase, type CoreDatabase } from '../db/connection';
import { runMigrations } from '../db/migrations';
import {
  CHANNEL_FRESH_MS, MAX_DELIVERY_ATTEMPTS, enqueueNotification, listDeliverable, notificationCapability, notificationReport,
  recordDelivery, registerChannel,
} from '../domain/notificationOutbox';
import { auditPromises, classifyStatusRequest, composeStatusAnswer } from '../runtime/assistantStatus';
import { taskState, terminalNotice, type GmailOrganizeTask } from '../runtime/connectors/gmailTask';

let dir: string;
let db: CoreDatabase;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pandesh-truth-'));
  db = openDatabase(path.join(dir, 'core.db'));
  runMigrations(db);
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const NOW = Date.parse('2026-11-03T12:00:00.000Z');

function task(patch: Partial<GmailOrganizeTask> = {}): GmailOrganizeTask {
  const at = new Date(NOW - 60_000).toISOString();
  return {
    taskId: 'gtask_1', accountEmail: 'me@example.com', status: 'active', scope: '', batchSize: 25, totalVerified: true, coverage: 'Complete', retries: 0,
    rules: [{ label: 'Finance', senders: ['kotak'] }], batches: [], createdAt: at, updatedAt: at,
    messages: [
      { id: 'a', rule: 0, from: 'Kotak', subject: 's', date: 'd', state: 'pending', attempts: 0 },
      { id: 'b', rule: 0, from: 'Kotak', subject: 's', date: 'd', state: 'pending', attempts: 0 },
    ],
    ...patch,
  };
}

describe('notification outbox', () => {
  it('is idempotent per source and starts pending, not delivered', () => {
    const a = enqueueNotification(db, { kind: 'task_completed', sourceId: 't1', title: 'Done', body: 'x' });
    const b = enqueueNotification(db, { kind: 'task_completed', sourceId: 't1', title: 'Done again', body: 'y' });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.record.id).toBe(a.record.id);
    expect(a.record.status).toBe('pending');
    expect(listDeliverable(db)).toHaveLength(1);
  });

  it('becomes delivered only when the host reports it, and keeps a failure on record with bounded retries', () => {
    const { record } = enqueueNotification(db, { kind: 'test', sourceId: 't', title: 'T', body: 'b' });
    expect(notificationReport(db).counts).toEqual({ pending: 1, delivered: 0, failed: 0 });
    for (let i = 0; i < MAX_DELIVERY_ATTEMPTS; i += 1) {
      expect(listDeliverable(db)).toHaveLength(1);
      recordDelivery(db, record.id, { status: 'failed', via: 'windows_toast', error: 'no show event' });
    }
    expect(listDeliverable(db)).toHaveLength(0);
    const failed = notificationReport(db).recent[0];
    expect(failed.status).toBe('failed');
    expect(failed.lastError).toBe('no show event');
    expect(failed.deliveredAt).toBeNull();
  });

  it('records the delivery channel and time once the host reports success', () => {
    const { record } = enqueueNotification(db, { kind: 'test', sourceId: 't', title: 'T', body: 'b' });
    const done = recordDelivery(db, record.id, { status: 'delivered', via: 'windows_toast' });
    expect(done).toMatchObject({ status: 'delivered', deliveredVia: 'windows_toast', attempts: 1 });
    expect(done.deliveredAt).not.toBeNull();
    expect(recordDelivery(db, record.id, { status: 'failed', via: 'x', error: 'late' }).status).toBe('delivered');
    expect(listDeliverable(db)).toHaveLength(0);
  });

  it('promises a notification only while a running host has registered a supported channel', () => {
    expect(notificationCapability(db, NOW).canNotify).toBe(false);
    expect(notificationCapability(db, NOW).statement).toMatch(/No Pandesh desktop is currently connected/);
    registerChannel(db, { channel: 'desktop', supported: true, detail: 'Windows desktop notifications (toast)' });
    expect(notificationCapability(db).canNotify).toBe(true);
    expect(notificationCapability(db, Date.now() + CHANNEL_FRESH_MS + 1_000).canNotify).toBe(false);
    registerChannel(db, { channel: 'desktop', supported: false, detail: 'unsupported on this system' });
    const unsupported = notificationCapability(db);
    expect(unsupported.canNotify).toBe(false);
    expect(unsupported.statement).toMatch(/not supported/);
  });
});

describe('Gmail task states are honest', () => {
  it('never reports a task with unlabeled messages as completed or running', () => {
    expect(taskState(task(), NOW).state).toBe('queued');
    expect(taskState(task({ currentPlanId: 'p' }), NOW).state).toBe('awaiting_approval');
    expect(taskState(task({ retryNotBefore: new Date(NOW + 600_000).toISOString(), batches: [{ planId: 'p', label: 'Finance', count: 2, status: 'failed', at: 'x' }] }), NOW).state).toBe('paused');
    const exhausted = task({ lastError: 'Gmail refused' });
    for (const m of exhausted.messages) m.attempts = 3;
    expect(taskState(exhausted, NOW).state).toBe('blocked');
    const done = task();
    for (const m of done.messages) m.state = 'done';
    expect(taskState(done, NOW).state).toBe('completed');
  });

  it('a failed last batch with no wait is blocked, not queued or done', () => {
    const t = task({ lastError: 'Gmail refused the change', batches: [{ planId: 'p', label: 'Finance', count: 2, status: 'failed', at: 'x' }] });
    expect(taskState(t, NOW).state).toBe('blocked');
    expect(terminalNotice(t, NOW)?.kind).toBe('task_blocked');
  });

  it('owes a notification only when the task is finished or stuck, never while it is merely waiting', () => {
    expect(terminalNotice(task(), NOW)).toBeNull();
    const done = task();
    for (const m of done.messages) m.state = 'done';
    expect(terminalNotice(done, NOW)).toMatchObject({ kind: 'task_completed', sourceId: 'gtask_1' });
  });
});

describe('status questions are answered from recorded state, without a workspace', () => {
  it.each([
    ['How are your notifications configured?', ['notifications']],
    ['but i didnt get any notification!!! Why is that ? how is your notifcation system configured and how does it work ?', ['notifications']],
    ["What's the status of my Gmail organization?", ['gmail']],
    ['What tasks are you running?', ['tasks']],
    ['Show my reminders.', ['reminders']],
  ])('classifies %j', (text, topics) => expect(classifyStatusRequest(text)).toEqual(topics));

  it.each([
    'Move all emails from Kotak to a Finance label and tell me the progress',
    'Remind me to call mom tomorrow',
    'Send me a notification when you are done',
    'Draft an email to my landlord',
    'hello',
    // Micro-test D-REM-1: a change to a reminder, or a question about one, goes to the assistant and its tools.
    'Change my stretch reminder to 6 PM.',
    'Pause my recurring recycling reminder.',
    'What time zone is this reminder in?',
    'Move my dentist reminder to Friday.',
    'Mark my ticket reminder as done.',
  ])('does not hijack %j', (text) => expect(classifyStatusRequest(text, true)).toBeNull());

  it('lists reminders in local time with the zone named, and "due today" keeps only today (micro-tests REM-009, REM-021)', () => {
    expect(classifyStatusRequest('Show reminders due today')).toEqual(['reminders']);
    expect(classifyStatusRequest('What reminders do I have tomorrow?')).toEqual(['reminders']);
    const now = Date.parse('2026-11-11T09:00:00.000Z');
    const at = (iso: string, title: string) => db.run(
      "INSERT INTO everyday_reminders (id, title, body, dueAt, timezone, status, createdAt, updatedAt) VALUES (?, ?, '', ?, 'Europe/Berlin', 'scheduled', ?, ?)",
      [`rem_${title.replace(/\W/g, '')}`, title, iso, '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:00.000Z'],
    );
    at('2026-11-11T14:00:00.000Z', 'Stretch');
    at('2026-11-12T07:00:00.000Z', 'Check mail');
    at('2026-12-01T08:00:00.000Z', 'Renew my ticket');
    const all = composeStatusAnswer(db, ['reminders'], now, 'Show my reminders');
    expect(all).toContain('(times in Europe/Berlin)');
    expect(all).toContain('15:00: Stretch'); // 14:00 UTC is 15:00 in Berlin
    expect(all).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    expect(all).toMatch(/Stretch[\s\S]*Check mail[\s\S]*Renew my ticket/);
    const today = composeStatusAnswer(db, ['reminders'], now, 'Show reminders due today');
    expect(today).toContain('due today');
    expect(today).toContain('Stretch');
    expect(today).not.toContain('Renew my ticket');
  });

  it('treats a bare "status" as a Gmail question only when Gmail work is recent', () => {
    expect(classifyStatusRequest('status', false)).toBeNull();
    expect(classifyStatusRequest('status', true)).toEqual(['gmail']);
    expect(classifyStatusRequest('astill not dpone?', true)).toEqual(['gmail']);
    expect(classifyStatusRequest('and?', true)).toEqual(['gmail']);
  });

  it('says plainly that nothing is running and no notification exists when the database is empty', () => {
    const tasks = composeStatusAnswer(db, ['tasks'], NOW);
    expect(tasks).toMatch(/Nothing\. No background task, Gmail task or routine is queued or running/);
    const gmail = composeStatusAnswer(db, ['gmail'], NOW);
    expect(gmail).toMatch(/No persistent Gmail organization task exists/);
    expect(gmail).toMatch(/Nothing is running in the background for Gmail/);
    expect(composeStatusAnswer(db, ['notifications'], NOW)).toMatch(/No Pandesh desktop is currently connected/);
  });

  it('does not describe an unverified or failed apply as done', () => {
    const planJson = JSON.stringify({ planId: 'gplan_x', accountEmail: 'me@example.com', messages: [{ id: '1' }, { id: '2' }] });
    db.run(
      `INSERT INTO gmail_change_plans (planId, accountEmail, status, digest, planJson, createdAt, updatedAt, expiresAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ['gplan_x', 'me@example.com', 'applied_unverified', 'd', planJson, new Date(NOW).toISOString(), new Date(NOW).toISOString(), new Date(NOW + 1e6).toISOString()],
    );
    const answer = composeStatusAnswer(db, ['gmail'], NOW + 1000);
    expect(answer).toMatch(/could not be fully verified/);
    expect(answer).toMatch(/do not treat these messages as done/);
    expect(answer).not.toMatch(/completed|finished/i);
  });
});

describe('promise audit', () => {
  const none = { activeWorker: false, canNotify: false, notifyStatement: 'No Pandesh desktop is currently connected to deliver notifications, so none can be promised.' };

  it('corrects promised background retries and notifications when nothing will do them', () => {
    const reply = 'I will retry the remaining messages in a few minutes. I will notify you as soon as the entire inbox organization is complete.';
    const correction = auditPromises(reply, none);
    expect(correction).toMatch(/nothing is running in the background/);
    expect(correction).toMatch(/no notification is scheduled/);
    expect(correction).toMatch(/No Pandesh desktop is currently connected/);
  });

  it('says no notification is scheduled even when a channel exists but no task is tracking the work', () => {
    const correction = auditPromises('I will let you know when it is done.', { activeWorker: false, canNotify: true, notifyStatement: 'ok' });
    expect(correction).toMatch(/no running task will report back later/);
  });

  it('leaves a reply alone when a real worker owns the work, or when it promises nothing', () => {
    expect(auditPromises('I will notify you when it is done.', { ...none, activeWorker: true })).toBeNull();
    expect(auditPromises('Batch 1 was applied and verified: 100 of 100 messages.', none)).toBeNull();
  });
});
