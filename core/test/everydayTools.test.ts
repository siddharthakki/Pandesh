import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openCoreDatabase } from '../db/openCore';
import type { CoreDatabase } from '../db/connection';
import * as everyday from '../domain/everydayTools';

let dir: string;
let db: CoreDatabase;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'everyday-tools-'));
  db = openCoreDatabase(path.join(dir, 'core.db')).db;
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('everyday notes', () => {
  it('creates, finds, edits, and soft-deletes notes', () => {
    const created = everyday.createNote(db, {
      body: 'Remember that my printer uses A4',
    });
    expect(created.body).toContain('A4');
    expect(created.title).toContain('printer');

    const found = everyday.listNotes(db, { query: 'printer' });
    expect(found).toHaveLength(1);
    expect(found[0].id).toBe(created.id);

    const edited = everyday.updateNote(db, created.id, {
      title: 'Printer paper',
      body: 'Remember that my printer uses A4 (confirmed)',
    });
    expect(edited.title).toBe('Printer paper');
    expect(edited.body).toContain('confirmed');

    everyday.deleteNote(db, created.id);
    expect(everyday.listNotes(db)).toHaveLength(0);
    expect(() => everyday.getNote(db, created.id)).toThrow(/not found/);
  });

  it('persists across reopen of the same Core database file', () => {
    const dbPath = path.join(dir, 'core.db');
    everyday.createNote(db, { body: 'Remember that my printer uses A4' });
    db.close();

    const reopened = openCoreDatabase(dbPath).db;
    const notes = everyday.listNotes(reopened, { query: 'A4' });
    expect(notes).toHaveLength(1);
    expect(notes[0].body).toBe('Remember that my printer uses A4');
    reopened.close();
    // Re-open for afterEach cleanup
    db = openCoreDatabase(dbPath).db;
  });
});

describe('everyday reminders', () => {
  it('creates, lists, completes, and cancels reminders with timezone overdue copy', () => {
    const dueAt = new Date(Date.now() - 60_000).toISOString();
    const reminder = everyday.createReminder(db, {
      title: 'check the oven',
      dueAt,
      timezone: 'Europe/Berlin',
    });
    expect(reminder.status).toBe('scheduled');

    const due = everyday.listDueReminders(db);
    expect(due).toHaveLength(1);
    expect(due[0].overdue).toBe(true);
    expect(due[0].overdueExplanation).toMatch(/Overdue since/);
    expect(due[0].overdueExplanation).toMatch(/Europe\/Berlin/);
    expect(due[0].overdueExplanation).toMatch(/not running at the due time|due now in Today/);

    everyday.markReminderNotified(db, reminder.id);
    const afterNotify = everyday.toReminderView(everyday.getReminder(db, reminder.id));
    expect(afterNotify.status).toBe('notified');
    expect(afterNotify.overdueExplanation).toMatch(/already fired/);

    const completed = everyday.completeReminder(db, reminder.id);
    expect(completed.status).toBe('completed');

    const other = everyday.createReminder(db, {
      title: 'cancel me',
      dueAt: new Date(Date.now() + 3_600_000).toISOString(),
      timezone: 'UTC',
    });
    expect(everyday.cancelReminder(db, other.id).status).toBe('cancelled');
    expect(everyday.listReminders(db, { status: 'open' })).toHaveLength(0);
  });

  it('rejects invalid timezones', () => {
    expect(() => everyday.createReminder(db, {
      title: 'x',
      dueAt: new Date().toISOString(),
      timezone: 'Not/AZone',
    })).toThrow(/IANA/);
  });
});
