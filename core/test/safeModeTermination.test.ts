import { describe, expect, it, vi } from 'vitest';
import { SafeModeManager } from '../security/safeMode';
import type { ProcessIdentitySnapshot } from '../runtime/processOwnership';

describe('SAFE_MODE emergency termination', () => {
  const SPAWNED_AT = 1_700_000_000_000;

  function identity(pid: number, overrides: Partial<ProcessIdentitySnapshot> = {}): ProcessIdentitySnapshot {
    return {
      pid,
      alive: true,
      executablePath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      creationTimeMs: SPAWNED_AT + 100,
      commandLine: 'powershell.exe -NoProfile -Command dir',
      ...overrides,
    };
  }

  it('terminates a tracked child whose identity still matches', () => {
    const kill = vi.fn();
    const manager = new SafeModeManager(null, null, 'epoch-1', (pid: number) => identity(pid));
    manager.registerChildProcess(4242, kill, 'powershell: dir', undefined, { spawnedAtMs: SPAWNED_AT });

    const terminated = manager.terminateAllTrackedProcesses();
    expect(terminated).toEqual([4242]);
    expect(kill).toHaveBeenCalledTimes(1);
    expect(manager.getLastRefusedTerminations()).toHaveLength(0);
  });

  it('refuses to terminate a child whose pid was recycled', () => {
    const kill = vi.fn();
    const manager = new SafeModeManager(null, null, 'epoch-1', (pid: number) => identity(pid, { creationTimeMs: SPAWNED_AT + 9_000_000 }));
    manager.registerChildProcess(4242, kill, 'powershell: dir', undefined, { spawnedAtMs: SPAWNED_AT });

    const terminated = manager.terminateAllTrackedProcesses();
    expect(terminated).toHaveLength(0);
    expect(kill).not.toHaveBeenCalled();
    expect(manager.getLastRefusedTerminations()[0]?.reason).toMatch(/different process|creation time/i);
  });

  it('refuses to terminate a child whose identity the OS will not disclose', () => {
    const kill = vi.fn();
    const manager = new SafeModeManager(null, null, 'epoch-1', (pid: number) => ({
      pid, alive: false, executablePath: null, creationTimeMs: null, commandLine: null,
    }));
    manager.registerChildProcess(4242, kill, 'powershell: dir', undefined, { spawnedAtMs: SPAWNED_AT });

    const terminated = manager.terminateAllTrackedProcesses();
    expect(terminated).toHaveLength(0);
    expect(kill).not.toHaveBeenCalled();
    expect(manager.getLastRefusedTerminations()[0]?.reason).toMatch(/not running|identity|refus/i);
  });

  it('does not report a pid as terminated when the identity could not be read', () => {
    const kill = vi.fn();
    const manager = new SafeModeManager(null, null, 'epoch-1', (pid: number) => ({
      pid, alive: false, executablePath: null, creationTimeMs: null, commandLine: null,
    }));
    manager.registerChildProcess(9999, kill, 'powershell: dir', undefined, { spawnedAtMs: SPAWNED_AT });

    const terminated = manager.terminateAllTrackedProcesses();
    expect(terminated).not.toContain(9999);
    expect(kill).not.toHaveBeenCalled();
  });

  it('uses the recorded creation time when the spawner knew it', () => {
    const kill = vi.fn();
    const manager = new SafeModeManager(null, null, 'epoch-1', (pid: number) => identity(pid, { creationTimeMs: SPAWNED_AT + 5_000 }));
    manager.registerChildProcess(4242, kill, 'powershell: dir', undefined, {
      spawnedAtMs: SPAWNED_AT,
      creationTimeMs: SPAWNED_AT + 5_000,
    });
    expect(manager.terminateAllTrackedProcesses()).toEqual([4242]);
    expect(kill).toHaveBeenCalledTimes(1);
  });
});
