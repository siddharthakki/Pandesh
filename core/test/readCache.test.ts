/**
 * The overview projections are cached only while nothing changed: Build 182's start stalled Core for minutes because
 * the desktop's window load repeated the same synchronous projection.
 */
import { describe, it, expect, vi } from 'vitest';
import { createReadCache } from '../runtime/readCache';

describe('read cache', () => {
  it('reuses a result while the event sequence is unchanged and the entry is young', () => {
    let t = 0; const compute = vi.fn(() => ({ n: compute.mock.calls.length }));
    const cache = createReadCache(2000, () => t);
    const a = cache.get('overview:20', '41', compute);
    t = 1500;
    const b = cache.get('overview:20', '41', compute);
    expect(b).toBe(a);
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it('recomputes when anything was recorded since (a changed event sequence)', () => {
    const compute = vi.fn(() => Math.random());
    const cache = createReadCache(2000, () => 0);
    cache.get('k', '41', compute);
    cache.get('k', '42', compute);
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it('recomputes once the entry is older than the ttl, and keeps keys apart', () => {
    let t = 0; const compute = vi.fn(() => t);
    const cache = createReadCache(2000, () => t);
    cache.get('a', '1', compute);
    cache.get('b', '1', compute);
    expect(compute).toHaveBeenCalledTimes(2);
    t = 2001;
    cache.get('a', '1', compute);
    expect(compute).toHaveBeenCalledTimes(3);
  });

  it('shares one promise between callers and does not keep a failure', async () => {
    const compute = vi.fn(async () => 'brief');
    const cache = createReadCache(2000, () => 0);
    const [x, y] = await Promise.all([cache.get('brief', '1', compute), cache.get('brief', '1', compute)]);
    expect(x).toBe('brief'); expect(y).toBe('brief');
    expect(compute).toHaveBeenCalledTimes(1);
    const failing = vi.fn(async () => { throw new Error('boom'); });
    await expect(cache.get('f', '1', failing)).rejects.toThrow('boom');
    await new Promise((r) => setTimeout(r, 0));
    const ok = vi.fn(async () => 'fine');
    await expect(cache.get('f', '1', ok)).resolves.toBe('fine');
    expect(failing).toHaveBeenCalledTimes(1);
  });
});
