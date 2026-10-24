/**
 * Schedules Electron desktop notifications for Core-persisted reminders
 * while Jarvis Desktop is running. Does not claim alerts while closed.
 */
export interface SchedulableReminder {
  id: string;
  title: string;
  body?: string;
  dueAt: string;
  status: string;
  notifiedAt?: string | null;
}

export interface ReminderNotifier {
  (input: { id: string; title: string; body: string }): void | Promise<void>;
}

export interface ReminderSchedulerOptions {
  notify: ReminderNotifier;
  markNotified: (id: string) => Promise<void>;
  log?: (message: string) => void;
  now?: () => number;
}

export class EverydayReminderScheduler {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly notify: ReminderNotifier;
  private readonly markNotified: (id: string) => Promise<void>;
  private readonly log?: (message: string) => void;
  private readonly now: () => number;
  private disposed = false;

  constructor(options: ReminderSchedulerOptions) {
    this.notify = options.notify;
    this.markNotified = options.markNotified;
    this.log = options.log;
    this.now = options.now ?? (() => Date.now());
  }

  clear(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  dispose(): void {
    this.disposed = true;
    this.clear();
  }

  /** Replace pending timers from the current Core scheduled set. */
  sync(reminders: SchedulableReminder[]): void {
    if (this.disposed) return;
    const keep = new Set(reminders.filter((r) => r.status === 'scheduled' && !r.notifiedAt).map((r) => r.id));
    for (const [id, timer] of this.timers) {
      if (!keep.has(id)) {
        clearTimeout(timer);
        this.timers.delete(id);
      }
    }
    for (const reminder of reminders) {
      if (reminder.status !== 'scheduled' || reminder.notifiedAt) continue;
      this.arm(reminder);
    }
  }

  private arm(reminder: SchedulableReminder): void {
    if (this.timers.has(reminder.id)) return;
    const dueMs = Date.parse(reminder.dueAt);
    if (!Number.isFinite(dueMs)) {
      this.log?.(`everyday reminder ${reminder.id} has invalid dueAt`);
      return;
    }
    const delay = Math.max(0, dueMs - this.now());
    const timer = setTimeout(() => {
      this.timers.delete(reminder.id);
      void this.fire(reminder);
    }, delay);
    // Unref so tests / idle hosts are not kept alive solely by reminder timers.
    timer.unref?.();
    this.timers.set(reminder.id, timer);
  }

  private async fire(reminder: SchedulableReminder): Promise<void> {
    if (this.disposed) return;
    try {
      await this.notify({
        id: reminder.id,
        title: 'Jarvis reminder',
        body: reminder.title + (reminder.body ? `\n${reminder.body}` : ''),
      });
      await this.markNotified(reminder.id);
      this.log?.(`everyday reminder notified: ${reminder.id}`);
    } catch (err) {
      this.log?.(`everyday reminder notify failed: ${(err as Error).message}`);
    }
  }
}
