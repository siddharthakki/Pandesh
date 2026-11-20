/**
 * Observes the model calls Core itself makes, so "waiting for the model" is a measured fact and not a guess from elapsed time.
 * It does not schedule anything: it wraps the existing per-attempt ModelBackend and records, per attempt, whether a call is in
 * flight, whether its first token has arrived, when the last token arrived, and how many other calls are in flight at the same
 * time (the contention the person is waiting behind).
 */
import type { ModelBackend } from './modelBackend';

interface Call { attemptId: string; startedAt: number; firstTokenAt: number | null; lastTokenAt: number | null }

export interface ModelWait {
  /** A call for this attempt is in flight right now. */
  inFlight: boolean;
  /** In flight and no token received yet: loading the model or queued behind other work. */
  awaitingFirstToken: boolean;
  /** How long the current call has been in flight (ms). */
  inFlightMs: number;
  /** Other attempts' calls in flight at the same time. */
  othersInFlight: number;
  /** Last time this attempt's call produced a token or finished (ms epoch), or null. */
  lastActivityAt: number | null;
}

export class ModelCallTracker {
  private calls = new Map<number, Call>();
  private lastActivity = new Map<string, number>();
  private seq = 0;

  wrap(attemptId: string, backend: ModelBackend): ModelBackend {
    return {
      streamChat: async (request, onToken) => {
        const id = ++this.seq;
        const call: Call = { attemptId, startedAt: Date.now(), firstTokenAt: null, lastTokenAt: null };
        this.calls.set(id, call);
        this.lastActivity.set(attemptId, call.startedAt);
        try {
          return await backend.streamChat(request, (delta) => {
            const t = Date.now();
            call.firstTokenAt ??= t; call.lastTokenAt = t; this.lastActivity.set(attemptId, t);
            onToken(delta);
          });
        } finally {
          this.calls.delete(id);
          this.lastActivity.set(attemptId, Date.now());
        }
      },
    };
  }

  snapshot(attemptId: string, now = Date.now()): ModelWait {
    let mine: Call | undefined; let others = 0;
    for (const c of this.calls.values()) { if (c.attemptId === attemptId) mine = mine && mine.startedAt < c.startedAt ? mine : c; else others++; }
    return {
      inFlight: Boolean(mine), awaitingFirstToken: Boolean(mine && mine.firstTokenAt === null), inFlightMs: mine ? now - mine.startedAt : 0,
      othersInFlight: others, lastActivityAt: this.lastActivity.get(attemptId) ?? null,
    };
  }

  /** Drops bookkeeping for a finished attempt. */
  forget(attemptId: string): void { this.lastActivity.delete(attemptId); }
}

export const modelCallTracker = new ModelCallTracker();
