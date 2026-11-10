/**
 * Wrong pairing codes are limited twice: per client (one phone or script guessing) and in total (many addresses
 * guessing together, or one client behind the Tailscale proxy where every request comes from 127.0.0.1). Past the
 * total, pairing pauses for everyone until the pause ends or the owner allows it again on the PC.
 *
 * With 5 tries per client per 5 minutes and 20 per 15 minutes in total, guessing a 40-bit code is hopeless.
 */
export interface PairLimits {
  perClient: number;
  perClientWindowMs: number;
  total: number;
  totalWindowMs: number;
  pauseMs: number;
}

export const DEFAULT_PAIR_LIMITS: PairLimits = {
  perClient: 5,
  perClientWindowMs: 5 * 60_000,
  total: 20,
  totalWindowMs: 15 * 60_000,
  pauseMs: 15 * 60_000,
};

/** Clients remembered at once; the oldest are dropped first (a flood of addresses cannot grow memory). */
const MAX_TRACKED_CLIENTS = 1000;

export type PairGate =
  | { allowed: true }
  | { allowed: false; reason: 'client' | 'paused'; retryAfterMs: number };

export class PairAttemptLimiter {
  private readonly clients = new Map<string, number[]>();
  private total: number[] = [];
  private pausedUntil = 0;

  constructor(
    private readonly limits: PairLimits = DEFAULT_PAIR_LIMITS,
    private readonly now: () => number = Date.now,
  ) {}

  check(client: string): PairGate {
    const t = this.now();
    if (this.pausedUntil > t) return { allowed: false, reason: 'paused', retryAfterMs: this.pausedUntil - t };
    const recent = this.recent(client, t);
    if (recent.length >= this.limits.perClient) {
      return { allowed: false, reason: 'client', retryAfterMs: Math.max(1000, recent[0] + this.limits.perClientWindowMs - t) };
    }
    return { allowed: true };
  }

  recordFailure(client: string): void {
    const t = this.now();
    const recent = this.recent(client, t);
    recent.push(t);
    this.clients.delete(client);
    this.clients.set(client, recent);
    if (this.clients.size > MAX_TRACKED_CLIENTS) {
      const oldest = this.clients.keys().next().value;
      if (oldest !== undefined) this.clients.delete(oldest);
    }
    this.total = this.total.filter((at) => t - at < this.limits.totalWindowMs);
    this.total.push(t);
    if (this.total.length >= this.limits.total) {
      this.pausedUntil = t + this.limits.pauseMs;
      this.total = [];
    }
  }

  recordSuccess(client: string): void {
    this.clients.delete(client);
  }

  /** When pairing is paused for everyone, until when; null when it is not. */
  pausedUntilMs(): number | null {
    return this.pausedUntil > this.now() ? this.pausedUntil : null;
  }

  /** The owner allows pairing again from the PC. */
  resume(): void {
    this.pausedUntil = 0;
    this.total = [];
    this.clients.clear();
  }

  private recent(client: string, t: number): number[] {
    return (this.clients.get(client) ?? []).filter((at) => t - at < this.limits.perClientWindowMs);
  }
}
