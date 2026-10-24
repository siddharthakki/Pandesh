/**
 * Focused proof for background reminder scheduling (no Electron UI required).
 * Marks-before-notify prevents duplicate delivery across resume reconcile.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { EverydayReminderScheduler } from '../src/host/everydayReminderScheduler';

afterEach(() => {
  vi.useRealTimers();
});

describe('background reminder delivery', () => {
  it('fires once for an overdue item and can be reconciled without a second notify when already marked', async () => {
    vi.useFakeTimers();
    const notify = vi.fn(async () => undefined);
    const marked = new Set<string>();
    const markNotified = vi.fn(async (id: string) => { marked.add(id); });
    const scheduler = new EverydayReminderScheduler({ notify, markNotified });

    const dueAt = new Date(Date.now() - 1_000).toISOString();
    scheduler.sync([{
      id: 'reminder_bg_1',
      title: 'check the oven',
      dueAt,
      status: 'scheduled',
      notifiedAt: null,
    }]);
    await vi.advanceTimersByTimeAsync(50);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(markNotified).toHaveBeenCalledWith('reminder_bg_1');

    // After mark, refresh would sync without this id as scheduled.
    scheduler.sync([{
      id: 'reminder_bg_1',
      title: 'check the oven',
      dueAt,
      status: 'notified',
      notifiedAt: new Date().toISOString(),
    }]);
    await vi.advanceTimersByTimeAsync(50);
    expect(notify).toHaveBeenCalledTimes(1);
    scheduler.dispose();
  });
});
