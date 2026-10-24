import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockExtensionContext } from '../mocks/vscode';
import { CoreManager } from '../../core-client/CoreManager';
import type { CoreLauncher, LauncherOutcome } from '../../core-client/CoreLauncher';

/**
 * CoreManager's background reconnect loop closes a real gap:
 * `CoreClient`'s own reconnect-with-backoff only runs once a client has
 * actually been constructed after a successful launch — it never gets a
 * chance to run if the launcher itself didn't reach 'connected' on the
 * first attempt (e.g. a cold first-ever start exceeding CoreLauncher's own
 * 10s timeout). These tests drive that loop with a scripted fake launcher
 * (via the `launcherFactory` test seam) and fake timers, so they're
 * deterministic and never spawn a real Core process or depend on wall-clock
 * time.
 */

function fakeLauncher(outcomes: LauncherOutcome[]): { launcher: CoreLauncher; calls: () => number } {
  let call = 0;
  const launcher = {
    ensureCoreRunning: vi.fn(async () => {
      const outcome = outcomes[Math.min(call, outcomes.length - 1)];
      call += 1;
      return outcome;
    }),
    restartCore: vi.fn(async () => outcomes[outcomes.length - 1]),
  } as unknown as CoreLauncher;
  return { launcher, calls: () => call };
}

describe('CoreManager background reconnect', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('retries on a transient "unavailable" outcome without the caller reopening VS Code', async () => {
    const { launcher, calls } = fakeLauncher([
      { state: 'unavailable', detail: 'Core did not become healthy within 10000ms' },
      { state: 'unavailable', detail: 'Core did not become healthy within 10000ms' },
      { state: 'incompatible', detail: 'apiVersion mismatch', info: { coreVersion: '9.9.9', apiVersion: 99 } },
    ]);
    const context = { ...createMockExtensionContext(), extensionUri: { fsPath: '/mock-extension' } };
    const manager = new CoreManager(context as never, () => launcher);

    await manager.start();
    expect(manager.getStatus().state).toBe('unavailable');
    expect(calls()).toBe(1);

    // First backoff tick: still unavailable, still retrying.
    await vi.advanceTimersByTimeAsync(3_000);
    expect(calls()).toBe(2);
    expect(manager.getStatus().state).toBe('unavailable');

    // Second backoff tick: this time the launcher reports a terminal,
    // non-transient state — the loop must stop retrying immediately.
    await vi.advanceTimersByTimeAsync(6_000);
    expect(calls()).toBe(3);
    expect(manager.getStatus().state).toBe('incompatible');

    // No further retries even after a long wait — 'incompatible' is terminal.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(calls()).toBe(3);

    manager.dispose();
  });

  it('never retries on authentication_failed — a live Core with the wrong credentials is a deliberate dead end, not spawned around', async () => {
    const { launcher, calls } = fakeLauncher([
      { state: 'authentication_failed', detail: 'a running Core rejected our credentials' },
    ]);
    const context = { ...createMockExtensionContext(), extensionUri: { fsPath: '/mock-extension' } };
    const manager = new CoreManager(context as never, () => launcher);

    await manager.start();
    expect(manager.getStatus().state).toBe('authentication_failed');
    expect(calls()).toBe(1);

    await vi.advanceTimersByTimeAsync(120_000);
    expect(calls()).toBe(1); // no retry attempted

    manager.dispose();
  });

  it('stops retrying once disposed', async () => {
    const { launcher, calls } = fakeLauncher([
      { state: 'unavailable', detail: 'cold start' },
      { state: 'unavailable', detail: 'cold start' },
    ]);
    const context = { ...createMockExtensionContext(), extensionUri: { fsPath: '/mock-extension' } };
    const manager = new CoreManager(context as never, () => launcher);

    await manager.start();
    expect(calls()).toBe(1);
    manager.dispose();

    await vi.advanceTimersByTimeAsync(120_000);
    expect(calls()).toBe(1); // disposed before the first backoff tick fired
  });
});
