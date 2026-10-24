import { Logger } from './Logger';

export type StartupMark =
  | 'activate_start'
  | 'views_registered'
  | 'webview_resolved'
  | 'core_start_begin'
  | 'core_launcher_ready'
  | 'core_connected'
  | 'initial_snapshot_ready'
  | 'history_restore_begin'
  | 'history_restore_end'
  | 'attempt_rehydrate_begin'
  | 'attempt_rehydrate_end'
  | 'composer_ready'
  | 'activate_complete';

export interface StartupTimingRecord {
  mark: StartupMark;
  timestamp: number;
  elapsedMs: number;
}

export class StartupTelemetry {
  private static instance: StartupTelemetry;
  private readonly marks: StartupTimingRecord[] = [];
  private startTime: number = 0;

  static getInstance(): StartupTelemetry {
    if (!StartupTelemetry.instance) {
      StartupTelemetry.instance = new StartupTelemetry();
    }
    return StartupTelemetry.instance;
  }

  mark(name: StartupMark): void {
    const now = Date.now();
    if (this.marks.length === 0 || name === 'activate_start') {
      this.startTime = now;
    }
    const elapsedMs = Math.max(0, now - this.startTime);
    this.marks.push({
      mark: name,
      timestamp: now,
      elapsedMs,
    });
    Logger.info(`[StartupTelemetry] ${name} at +${elapsedMs}ms`);
  }

  getMarks(): readonly StartupTimingRecord[] {
    return this.marks;
  }

  getElapsed(name: StartupMark): number | undefined {
    return this.marks.find(m => m.mark === name)?.elapsedMs;
  }

  getSummary(): Record<string, number> {
    const summary: Record<string, number> = {};
    for (const record of this.marks) {
      summary[record.mark] = record.elapsedMs;
    }
    return summary;
  }

  reset(): void {
    this.marks.length = 0;
    this.startTime = 0;
  }
}

export const startupTelemetry = StartupTelemetry.getInstance();
