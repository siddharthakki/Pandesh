/**
 * Startup that survives a slow Core.
 *
 * Found on Build 181 in production (2026-11-17): for about 50 s after the desktop connected, Core (or the host's own
 * event loop) did not answer, the client's 45 s heartbeat marked the connection "reconnecting", the next startup
 * step threw "The local Core is not answering. Reconnecting…", and the desktop EXITED ("failed to start"). The same
 * Core answers in milliseconds a minute later. A slow start must cost time, never the whole app.
 *
 * `runStartupStep` runs one idempotent startup step. When Core is not connected it waits (bounded) for the client's own
 * reconnect, and retries a failed step a bounded number of times. It never throws: the caller gets the outcome and
 * keeps the window, the Retry button and the phone server alive.
 */
export interface StartupStepOptions {
  /** True while the Core client is connected. */
  isReady: () => boolean;
  /** Resolves true when the client became connected within `ms`, false when it did not. */
  waitForReady: (ms: number) => Promise<boolean>;
  log?: (message: string) => void;
  attempts?: number;
  /** How long to wait for a reconnect before each attempt. */
  readyWaitMs?: number;
  now?: () => number;
}

export type StartupStepResult<T> =
  | { ok: true; value: T; attempts: number; ms: number }
  | { ok: false; error: Error; attempts: number; ms: number };

export async function runStartupStep<T>(name: string, step: () => Promise<T>, options: StartupStepOptions): Promise<StartupStepResult<T>> {
  const attempts = Math.max(1, options.attempts ?? 3);
  const readyWaitMs = options.readyWaitMs ?? 90_000;
  const now = options.now ?? Date.now;
  const started = now();
  let lastError: Error = new Error('startup step did not run');
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (!options.isReady()) {
      options.log?.(`startup: ${name} is waiting for Core (attempt ${attempt} of ${attempts}, up to ${Math.round(readyWaitMs / 1000)} s)`);
      const ready = await options.waitForReady(readyWaitMs);
      if (!ready) {
        lastError = new Error('The local Core did not answer in time.');
        options.log?.(`startup: ${name}: ${lastError.message}`);
        continue;
      }
    }
    try {
      const value = await step();
      const ms = now() - started;
      options.log?.(`startup: ${name} done in ${ms} ms${attempt > 1 ? ` (attempt ${attempt})` : ''}`);
      return { ok: true, value, attempts: attempt, ms };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      options.log?.(`startup: ${name} failed on attempt ${attempt} of ${attempts}: ${lastError.message}`);
    }
  }
  return { ok: false, error: lastError, attempts, ms: now() - started };
}

/** Logs every stretch where this process's event loop did not run for `thresholdMs`, so a stalled start leaves a trace. */
export function watchEventLoopStalls(log: (message: string) => void, options: { thresholdMs?: number; intervalMs?: number; label?: string } = {}): () => void {
  const interval = options.intervalMs ?? 500;
  const threshold = options.thresholdMs ?? 2_000;
  let last = Date.now();
  const timer = setInterval(() => {
    const at = Date.now();
    const lag = at - last - interval;
    if (lag >= threshold) log(`${options.label ?? 'process'}: event loop did not run for ${Math.round(lag)} ms (until ${new Date(at).toISOString()})`);
    last = at;
  }, interval);
  timer.unref?.();
  return () => clearInterval(timer);
}
