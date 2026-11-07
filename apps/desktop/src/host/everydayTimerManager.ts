/**
 * Deterministic Everyday Timer Manager for Pandesh Desktop.
 *
 * Requirements:
 * - Recognize natural language durations (minutes, seconds, hours, German "funf/fünf Minuten").
 * - Maintain monotonic wall-clock deadline timestamps (Date.now() + durationMs).
 * - Ensure accurate timekeeping when app is minimized, hidden, or throttled.
 * - Support live countdown updates, pause, resume, and cancellation without drift.
 * - Suppress accidental double-submit duplicate timers within 3 seconds.
 * - Persist active timers locally in timers.json for truthful recovery upon restart.
 * - Deliver desktop native alert notifications when timer expires.
 * - Never invoke an LLM for timer operations.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface ActiveTimer {
  id: string;
  label: string;
  durationMs: number;
  startedAt: string;
  deadlineMs: number;
  remainingMs: number;
  state: 'running' | 'paused' | 'completed' | 'cancelled';
  pausedAt?: number | null;
  conversationId?: string | null;
}

export interface TimerManagerOptions {
  dataDir?: string;
  storageDir?: string;
  notify?: (input: { id: string; title: string; body: string }) => void | Promise<void>;
  log?: (message: string) => void;
  onTimerChange?: (timer: ActiveTimer) => void;
}

export class EverydayTimerManager {
  private readonly timers = new Map<string, ActiveTimer>();
  private readonly timeoutHandles = new Map<string, NodeJS.Timeout>();
  private readonly timersFile: string;
  private readonly notify?: (input: { id: string; title: string; body: string }) => void | Promise<void>;
  private readonly log?: (message: string) => void;
  private readonly onTimerChange?: (timer: ActiveTimer) => void;

  constructor(options: TimerManagerOptions) {
    const dir = options.dataDir || options.storageDir || (process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'KarkeDikha', 'desktop') : os.tmpdir());
    this.timersFile = path.join(dir, 'timers.json');
    this.notify = options.notify;
    this.log = options.log;
    this.onTimerChange = options.onTimerChange;
    this.load();
  }

  /**
   * Start a new countdown timer.
   * If an identical timer was started in the last 3000ms, returns the existing timer (duplicate protection).
   */
  startTimer(durationMs: number, label: string, conversationId?: string | null): { timer: ActiveTimer; message: string; duplicate: boolean } {
    const now = Date.now();

    // Accidental double-send suppression (RWTS-286)
    for (const existing of this.timers.values()) {
      if (
        existing.state === 'running' &&
        existing.durationMs === durationMs &&
        now - Date.parse(existing.startedAt) < 3000
      ) {
        return {
          timer: existing,
          message: `Timer for ${existing.label} is already running (${this.formatRemaining(existing.deadlineMs - now)} remaining).`,
          duplicate: true,
        };
      }
    }

    const id = `timer_${now}_${Math.random().toString(36).slice(2, 6)}`;
    const deadlineMs = now + durationMs;
    const timer: ActiveTimer = {
      id,
      label: label.trim() || this.formatDuration(durationMs),
      durationMs,
      startedAt: new Date(now).toISOString(),
      deadlineMs,
      remainingMs: durationMs,
      state: 'running',
      conversationId: conversationId || null,
    };

    this.timers.set(id, timer);
    this.armTimer(timer);
    this.save();
    this.onTimerChange?.(timer);

    return {
      timer,
      message: `Started a ${timer.label} timer. Live countdown is running on screen.`,
      duplicate: false,
    };
  }

  /**
   * Stop / cancel a timer.
   */
  stopTimer(target?: string): { success: boolean; message: string; timer?: ActiveTimer } {
    const timer = this.resolveTimer(target);
    if (!timer) {
      return { success: false, message: 'No active timer to stop.' };
    }

    this.clearHandle(timer.id);
    timer.state = 'cancelled';
    timer.remainingMs = 0;
    this.save();
    this.onTimerChange?.(timer);

    return {
      success: true,
      message: `Cancelled the ${timer.label} timer.`,
      timer,
    };
  }

  /**
   * Pause an active running timer.
   */
  pauseTimer(target?: string): { success: boolean; message: string; timer?: ActiveTimer } {
    const timer = this.resolveTimer(target, 'running');
    if (!timer) {
      return { success: false, message: 'No running timer to pause.' };
    }

    this.clearHandle(timer.id);
    const now = Date.now();
    const remainingMs = Math.max(0, timer.deadlineMs - now);
    timer.remainingMs = remainingMs;
    timer.pausedAt = now;
    timer.state = 'paused';
    this.save();
    this.onTimerChange?.(timer);

    return {
      success: true,
      message: `Paused ${timer.label} timer with ${this.formatRemaining(remainingMs)} remaining.`,
      timer,
    };
  }

  /**
   * Resume a paused timer without drift.
   */
  resumeTimer(target?: string): { success: boolean; message: string; timer?: ActiveTimer } {
    const timer = this.resolveTimer(target, 'paused');
    if (!timer) {
      return { success: false, message: 'No paused timer to resume.' };
    }

    const now = Date.now();
    timer.deadlineMs = now + timer.remainingMs;
    timer.state = 'running';
    timer.pausedAt = null;
    this.armTimer(timer);
    this.save();
    this.onTimerChange?.(timer);

    return {
      success: true,
      message: `Resumed ${timer.label} timer with ${this.formatRemaining(timer.remainingMs)} remaining.`,
      timer,
    };
  }

  /**
   * Query status / remaining time.
   */
  queryTimer(target?: string): { active: boolean; message: string; timer?: ActiveTimer } {
    const timer = this.resolveTimer(target);
    if (!timer || (timer.state !== 'running' && timer.state !== 'paused')) {
      return { active: false, message: 'No active timer is running or paused.' };
    }

    const now = Date.now();
    const rem = timer.state === 'running' ? Math.max(0, timer.deadlineMs - now) : timer.remainingMs;
    const statusText = timer.state === 'paused' ? 'paused' : 'running';
    return {
      active: true,
      message: `Timer for ${timer.label} has ${this.formatRemaining(rem)} remaining (${statusText}).`,
      timer,
    };
  }

  /**
   * Returns list of currently relevant timers for snapshot projection.
   */
  listActiveTimers(): ActiveTimer[] {
    const now = Date.now();
    const result: ActiveTimer[] = [];
    for (const timer of this.timers.values()) {
      if (timer.state === 'running' || timer.state === 'paused') {
        const remainingMs = timer.state === 'running' ? Math.max(0, timer.deadlineMs - now) : timer.remainingMs;
        result.push({
          ...timer,
          remainingMs,
        });
      } else if (timer.state === 'completed' && now - timer.deadlineMs < 60_000) {
        // Show recently completed timers for 60s
        result.push({ ...timer, remainingMs: 0 });
      }
    }
    return result;
  }

  dispose(): void {
    for (const h of this.timeoutHandles.values()) clearTimeout(h);
    this.timeoutHandles.clear();
  }

  private armTimer(timer: ActiveTimer): void {
    this.clearHandle(timer.id);
    const delay = Math.max(0, timer.deadlineMs - Date.now());
    const handle = setTimeout(() => {
      this.timeoutHandles.delete(timer.id);
      void this.fireTimer(timer.id);
    }, delay);
    handle.unref?.();
    this.timeoutHandles.set(timer.id, handle);
  }

  private clearHandle(id: string): void {
    const h = this.timeoutHandles.get(id);
    if (h) {
      clearTimeout(h);
      this.timeoutHandles.delete(id);
    }
  }

  private async fireTimer(id: string): Promise<void> {
    const timer = this.timers.get(id);
    if (!timer || timer.state !== 'running') return;

    timer.state = 'completed';
    timer.remainingMs = 0;
    this.save();
    this.onTimerChange?.(timer);

    try {
      if (this.notify) {
        await this.notify({
          id: timer.id,
          title: 'Timer Finished',
          body: `Timer for ${timer.label} has finished!`,
        });
      }
      this.log?.(`Timer completed: ${timer.id} (${timer.label})`);
    } catch (err) {
      this.log?.(`Timer notification failed: ${(err as Error).message}`);
    }
  }

  private resolveTimer(target?: string, requiredState?: 'running' | 'paused'): ActiveTimer | null {
    const list = Array.from(this.timers.values())
      .filter((t) => !requiredState || t.state === requiredState)
      .sort((a, b) => b.deadlineMs - a.deadlineMs);

    if (list.length === 0) return null;
    if (!target) return list[0];

    const raw = target.toLowerCase().trim();
    const cleanTarget = raw.replace(/^id:/i, '').trim();

    // 1. Direct ID match
    const byId = list.find((t) => t.id === cleanTarget || t.id.toLowerCase() === cleanTarget);
    if (byId) return byId;

    // 2. Relative ordinal / duration matching (short, long, first, second)
    if (cleanTarget === 'short' || cleanTarget === 'shorter') {
      return list.slice().sort((a, b) => a.durationMs - b.durationMs)[0];
    }
    if (cleanTarget === 'long' || cleanTarget === 'longer') {
      return list.slice().sort((a, b) => b.durationMs - a.durationMs)[0];
    }
    if (cleanTarget === 'first') {
      return list.slice().sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt))[0];
    }
    if (cleanTarget === 'second') {
      const sorted = list.slice().sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
      return sorted[1] ?? sorted[0];
    }

    // 3. Label matching
    const byLabel = list.find((t) => t.label.toLowerCase().includes(cleanTarget));
    if (byLabel) return byLabel;

    // 4. Do not mutate unintended timer if specific target was given but not found
    return null;
  }

  private formatRemaining(ms: number): string {
    const totalSec = Math.max(0, Math.ceil(ms / 1000));
    const mins = Math.floor(totalSec / 60);
    const secs = totalSec % 60;
    if (mins === 0) return `${secs} second${secs === 1 ? '' : 's'}`;
    if (secs === 0) return `${mins} minute${mins === 1 ? '' : 's'}`;
    return `${mins}m ${secs}s`;
  }

  private formatDuration(ms: number): string {
    const totalSec = Math.round(ms / 1000);
    if (totalSec < 60) return `${totalSec} seconds`;
    const mins = Math.round(totalSec / 60);
    return `${mins} minute${mins === 1 ? '' : 's'}`;
  }

  private save(): void {
    try {
      const active = Array.from(this.timers.values())
        .filter((t) => t.state === 'running' || t.state === 'paused' || (t.state === 'completed' && Date.now() - t.deadlineMs < 300_000));
      // A fresh profile has no data folder yet; without it every timer was silently lost on restart.
      fs.mkdirSync(path.dirname(this.timersFile), { recursive: true });
      fs.writeFileSync(this.timersFile, JSON.stringify(active, null, 2), 'utf8');
    } catch (err) {
      this.log?.(`Failed to persist timers: ${(err as Error).message}`);
    }
  }

  private load(): void {
    if (!fs.existsSync(this.timersFile)) return;
    try {
      const raw = fs.readFileSync(this.timersFile, 'utf8');
      const items: ActiveTimer[] = JSON.parse(raw);
      const now = Date.now();
      for (const item of items) {
        if (item.state === 'running') {
          if (item.deadlineMs > now) {
            // Timer resumes accurately across restart! (RWTS-288)
            this.timers.set(item.id, item);
            this.armTimer(item);
          } else {
            // Expired while app was closed: truthfully mark completed without phantom fire
            item.state = 'completed';
            item.remainingMs = 0;
            this.timers.set(item.id, item);
          }
        } else if (item.state === 'paused') {
          this.timers.set(item.id, item);
        }
      }
    } catch (err) {
      this.log?.(`Failed to load timers: ${(err as Error).message}`);
    }
  }
}

