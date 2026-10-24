/**
 * Interactive priority lane (cooperative).
 *
 * Quick questions, status queries and corrections (baat_kar chat attempts) must not sit behind a long background
 * agent turn. This is not a second scheduler: attempts still run through RuntimeExecutor. The lane lets
 * background attempts yield at their model-call AND tool-call boundaries while an interactive attempt is active.
 *
 * What it does NOT do: abort or pause an inference call that is already running. An in-flight background model
 * call finishes (Ollama serves the interactive request on the same resident model in parallel); the background
 * attempt then waits before its NEXT model call or tool call. Waits are bounded so background work cannot be
 * starved forever, and nothing is persisted/interrupted, so there is no recovery state to restore.
 */

export const DEFAULT_MAX_YIELD_MS = 60_000;
export const DEFAULT_MAX_TOOL_YIELD_MS = 30_000;

export type AttemptLane = 'interactive' | 'background';

export function classifyAttemptLane(input: { kind: string; clientId?: string }): AttemptLane {
  if (input.clientId === 'core:scheduler') return 'background';
  return input.kind === 'baat_kar' ? 'interactive' : 'background';
}

export interface YieldResult {
  waitedMs: number;
  /** True when the bound expired and the background attempt proceeded while the lane was still busy. */
  timedOut: boolean;
}

export class InteractiveLane {
  private readonly active = new Set<string>();
  private waiters = new Set<() => void>();
  private yields = 0;
  private waitedMsTotal = 0;
  private timeouts = 0;

  /** Marks an interactive attempt active; the returned release is idempotent. */
  begin(attemptId: string): () => void {
    this.active.add(attemptId);
    return () => {
      if (!this.active.delete(attemptId)) return;
      if (this.active.size === 0) {
        const pending = [...this.waiters];
        this.waiters.clear();
        for (const wake of pending) wake();
      }
    };
  }

  isBusy(): boolean {
    return this.active.size > 0;
  }

  isInteractive(attemptId: string): boolean {
    return this.active.has(attemptId);
  }

  /** Resolves immediately unless an interactive attempt is active; then waits (bounded) for the lane to clear. */
  async yieldToInteractive(attemptId: string, signal?: AbortSignal, maxWaitMs = DEFAULT_MAX_YIELD_MS): Promise<YieldResult> {
    if (this.active.size === 0 || this.active.has(attemptId)) return { waitedMs: 0, timedOut: false };
    const startedAt = Date.now();
    let timedOut = false;
    await new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = () => {
        if (timer) clearTimeout(timer);
        this.waiters.delete(done);
        signal?.removeEventListener('abort', done);
        resolve();
      };
      timer = setTimeout(() => { timedOut = true; done(); }, maxWaitMs);
      timer.unref?.();
      this.waiters.add(done);
      signal?.addEventListener('abort', done, { once: true });
    });
    const waitedMs = Date.now() - startedAt;
    this.yields += 1;
    this.waitedMsTotal += waitedMs;
    if (timedOut) this.timeouts += 1;
    return { waitedMs, timedOut };
  }

  /** Yield at tool-call boundary with a shorter timeout for responsive tool queuing. */
  async yieldToInteractiveAtTool(attemptId: string, signal?: AbortSignal, maxWaitMs = DEFAULT_MAX_TOOL_YIELD_MS): Promise<YieldResult> {
    if (this.active.size === 0 || this.active.has(attemptId)) return { waitedMs: 0, timedOut: false };
    const startedAt = Date.now();
    let timedOut = false;
    await new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = () => {
        if (timer) clearTimeout(timer);
        this.waiters.delete(done);
        signal?.removeEventListener('abort', done);
        resolve();
      };
      timer = setTimeout(() => { timedOut = true; done(); }, maxWaitMs);
      timer.unref?.();
      this.waiters.add(done);
      signal?.addEventListener('abort', done, { once: true });
    });
    const waitedMs = Date.now() - startedAt;
    this.yields += 1;
    this.waitedMsTotal += waitedMs;
    if (timedOut) this.timeouts += 1;
    return { waitedMs, timedOut };
  }

  stats() {
    return { activeInteractive: this.active.size, yields: this.yields, waitedMsTotal: this.waitedMsTotal, timeouts: this.timeouts };
  }
}

/** One lane per Core process, like the executor it serves. */
export const interactiveLane = new InteractiveLane();
