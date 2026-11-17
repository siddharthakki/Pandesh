/**
 * A slow Core must cost time, never the app: Build 181 exited ("failed to start") because Core did not answer for
 * about 50 s right after the desktop connected. The step waits for the client's reconnect and retries.
 */
import { describe, it, expect, vi } from 'vitest';
import { runStartupStep, watchEventLoopStalls } from '../src/host/startupResilience';

const clock = () => { let t = 0; return { now: () => t, advance: (ms: number) => { t += ms; } }; };

describe('runStartupStep', () => {
  it('runs the step straight away when Core is connected', async () => {
    const step = vi.fn(async () => 'ok');
    const r = await runStartupStep('init', step, { isReady: () => true, waitForReady: async () => true });
    expect(r).toMatchObject({ ok: true, value: 'ok', attempts: 1 });
    expect(step).toHaveBeenCalledTimes(1);
  });

  it('waits for the reconnect instead of failing when Core is not answering yet', async () => {
    let ready = false;
    const log: string[] = [];
    const step = vi.fn(async () => { if (!ready) throw new Error('The local Core is not answering. Reconnecting…'); return 42; });
    const r = await runStartupStep('init', step, {
      isReady: () => ready,
      waitForReady: async () => { ready = true; return true; },
      log: (m) => log.push(m),
    });
    expect(r).toMatchObject({ ok: true, value: 42, attempts: 1 });
    expect(log.join('\n')).toMatch(/waiting for Core/);
  });

  it('retries a step that fails once, then succeeds', async () => {
    let calls = 0;
    const r = await runStartupStep('init', async () => { calls += 1; if (calls === 1) throw new Error('fetch failed'); return 'done'; }, { isReady: () => true, waitForReady: async () => true });
    expect(r).toMatchObject({ ok: true, value: 'done', attempts: 2 });
  });

  it('never throws: when Core never comes back it reports the failure and stops after the bounded attempts', async () => {
    const c = clock();
    const step = vi.fn(async () => 'never');
    const wait = vi.fn(async (ms: number) => { c.advance(ms); return false; });
    const r = await runStartupStep('init', step, { isReady: () => false, waitForReady: wait, attempts: 3, readyWaitMs: 60_000, now: c.now });
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.error.message).toMatch(/did not answer in time/); expect(r.attempts).toBe(3); expect(r.ms).toBe(180_000); }
    expect(step).not.toHaveBeenCalled();
    expect(wait).toHaveBeenCalledTimes(3);
  });

  it('reports the last error when the step keeps failing', async () => {
    const r = await runStartupStep('init', async () => { throw new Error('boom'); }, { isReady: () => true, waitForReady: async () => true, attempts: 2 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toBe('boom');
  });
});

describe('watchEventLoopStalls', () => {
  it('logs a stall when the loop does not run for longer than the threshold', async () => {
    vi.useFakeTimers();
    const log: string[] = [];
    const stop = watchEventLoopStalls((m) => log.push(m), { thresholdMs: 1000, intervalMs: 100, label: 'host' });
    vi.advanceTimersByTime(300);
    expect(log).toEqual([]);
    // A blocked loop: the clock jumps 5 s without the timer running in between.
    vi.setSystemTime(Date.now() + 5000);
    vi.advanceTimersByTime(100);
    expect(log.join('\n')).toMatch(/host: event loop did not run for \d+ ms/);
    stop();
    vi.useRealTimers();
  });
});
