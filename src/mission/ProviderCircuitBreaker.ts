export type ProviderReachability = 'ready' | 'unavailable' | 'cancelled';

/** Only a genuine provider failure counts against the provider's breaker; environment, Git and task failures never do. */
export function providerReachabilityForCause(cause: string | undefined): ProviderReachability {
  return cause === 'provider_failure' ? 'unavailable' : 'ready';
}

export interface ProviderCircuitBreakerOptions {
  /** How long a provider observed `unavailable` stays skipped before the next probe is allowed. */
  cooldownMs?: number;
}

const DEFAULT_COOLDOWN_MS = 5 * 60_000;

/**
 * Per `docs/M43_ENDURANCE_FOUNDATION.md` item 1: `SystemOneDecisionService`
 * already builds a fresh provider per call and treats every failure as
 * stateless reconnect — "the remaining gap is a lightweight circuit breaker
 * so a provider that is down for the whole session isn't retried on every
 * single turn." This is that breaker, generic over any reachability probe
 * (works with `ProviderReadinessProbe.run()`'s `reachability` field without
 * depending on it directly, so it composes rather than wraps one concrete
 * probe implementation).
 */
export class ProviderCircuitBreaker {
  private lastBadAt?: number;
  private readonly cooldownMs: number;

  constructor(options: ProviderCircuitBreakerOptions = {}) {
    this.cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  }

  isOpen(now: number = Date.now()): boolean {
    return this.lastBadAt !== undefined && now - this.lastBadAt < this.cooldownMs;
  }

  recordOutcome(reachability: ProviderReachability, now: number = Date.now()): void {
    if (reachability === 'unavailable') {
      this.lastBadAt = now;
    } else if (reachability === 'ready') {
      this.lastBadAt = undefined;
    }
    // 'cancelled' is not a signal about the provider itself; state is unchanged.
  }

  /**
   * Runs `probe()` unless the breaker is currently open, in which case the
   * probe is skipped entirely (no network/process call made) and the last
   * known-bad result is reported instead.
   */
  async check<T extends { reachability: ProviderReachability }>(
    probe: () => Promise<T>,
    now: number = Date.now(),
  ): Promise<{ result?: T; skipped: boolean }> {
    if (this.isOpen(now)) {
      return { skipped: true };
    }
    const result = await probe();
    this.recordOutcome(result.reachability, now);
    return { result, skipped: false };
  }
}
