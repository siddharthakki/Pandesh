/**
 * A short read cache for the heavy overview projections (task overview, assistant brief).
 *
 * Found on Build 182 in production (2026-11-17): after the desktop connected, Core's event loop did not run for
 * 15-58 s at a time for about 3 minutes. A CPU profile of the same start on a copy of the profile put ~70 s of the
 * 120 s in `db.get` called from `deriveResultStatus` <- `listTaskOverview`, reached from the overview and brief
 * routes the desktop requests many times while its window loads. SQLite here is synchronous, so every repeat blocks
 * everything else, including the client's heartbeat.
 *
 * An entry is reused only while BOTH hold: it is younger than `ttlMs`, and Core's event sequence has not moved
 * (every attempt change records an event), so a real change is never hidden behind the cache.
 */
export interface ReadCache {
  get<T>(key: string, token: string, compute: () => T): T;
  clear(): void;
}

export function createReadCache(ttlMs = 2_000, now: () => number = Date.now, maxEntries = 64): ReadCache {
  const entries = new Map<string, { at: number; token: string; value: unknown }>();
  return {
    get<T>(key: string, token: string, compute: () => T): T {
      const at = now();
      const hit = entries.get(key);
      if (hit && hit.token === token && at - hit.at < ttlMs) return hit.value as T;
      const value = compute();
      if (value && typeof (value as { then?: unknown }).then === 'function') {
        // A promise is cached as the promise (concurrent callers share one run); a failure is not kept.
        (value as unknown as Promise<unknown>).catch(() => { if (entries.get(key)?.value === value) entries.delete(key); });
      }
      entries.set(key, { at, token, value });
      if (entries.size > maxEntries) { const oldest = entries.keys().next().value; if (oldest !== undefined) entries.delete(oldest); }
      return value;
    },
    clear() { entries.clear(); },
  };
}
