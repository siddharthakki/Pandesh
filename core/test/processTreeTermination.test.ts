/**
 * M-benchmark P1 — the shared process-tree termination mechanism.
 *
 * The decision logic is tested without touching the OS (the process table
 * and the kill function are injected), and the real behaviour is covered by
 * the Windows platform test in `core/test/platform/`.
 */
import { describe, expect, it } from 'vitest';
import {
  descendantsOf,
  describeTermination,
  terminateProcessTree,
  type ProcessEntry,
} from '../runtime/processTree';

function table(...rows: Array<[number, number]>): ProcessEntry[] {
  return rows.map(([pid, parentPid]) => ({ pid, parentPid }));
}

describe('descendantsOf', () => {
  it('finds the whole subtree, breadth first', () => {
    const processes = table([10, 1], [11, 10], [12, 11], [13, 10], [20, 1]);
    expect(descendantsOf(10, processes).sort((a, b) => a - b)).toEqual([11, 12, 13]);
  });

  it('never includes the root itself', () => {
    expect(descendantsOf(10, table([10, 1], [11, 10]))).not.toContain(10);
  });

  it('returns nothing for a process with no children', () => {
    expect(descendantsOf(99, table([10, 1]))).toEqual([]);
  });

  it('survives a process table with a cycle', () => {
    const processes = table([1, 2], [2, 1]);
    expect(descendantsOf(1, processes)).toEqual([2]);
  });

  it('ignores entries with no parent', () => {
    expect(descendantsOf(10, table([11, 0]))).toEqual([]);
  });
});

describe('terminateProcessTree', () => {
  it('reports success when the root was already gone', async () => {
    const result = await terminateProcessTree(4242, {
      listProcesses: async () => [],
      isAlive: () => false,
      killTree: async () => { throw new Error('must not be called'); },
    });
    expect(result.terminated).toBe(true);
    expect(result.survivors).toEqual([]);
  });

  it('kills the root and every captured descendant, and verifies each one', async () => {
    const killed: number[] = [];
    const alive = new Set([100, 101, 102]);
    const result = await terminateProcessTree(100, {
      listProcesses: async () => table([100, 1], [101, 100], [102, 101]),
      isAlive: (pid) => alive.has(pid),
      killTree: async (pid) => { killed.push(pid); alive.delete(pid); },
      sleep: async () => {},
    });
    expect(killed).toEqual([100, 101, 102]);
    expect(result.terminated).toBe(true);
    expect(result.survivors).toEqual([]);
    expect(result.killed.sort()).toEqual([100, 101, 102]);
  });

  it('reports the survivors instead of claiming a successful stop', async () => {
    const alive = new Set([100, 101]);
    const result = await terminateProcessTree(100, {
      listProcesses: async () => table([100, 1], [101, 100]),
      isAlive: (pid) => alive.has(pid),
      // The descendant refuses to die.
      killTree: async (pid) => { if (pid === 100) alive.delete(pid); },
      sleep: async () => {},
      verifyTimeoutMs: 30,
    });
    expect(result.terminated).toBe(false);
    expect(result.survivors).toEqual([101]);
    expect(result.reason).toContain('survived');
  });

  it('never signals a PID outside the owned tree', async () => {
    const killed: number[] = [];
    const alive = new Set([100, 101, 999]);
    await terminateProcessTree(100, {
      listProcesses: async () => table([100, 1], [101, 100], [999, 500]),
      isAlive: (pid) => alive.has(pid),
      killTree: async (pid) => { killed.push(pid); alive.delete(pid); },
      sleep: async () => {},
    });
    expect(killed).not.toContain(999);
  });

  it('kills a recorded descendant whose parent already exited', async () => {
    // The root is gone (its PID is free again) but the grandchild it started
    // is still running: the recorded descendant is terminated on its own.
    const killed: number[] = [];
    const alive = new Set([101]);
    const result = await terminateProcessTree(100, {
      listProcesses: async () => [],
      isAlive: (pid) => alive.has(pid),
      killTree: async (pid) => { killed.push(pid); alive.delete(pid); },
      sleep: async () => {},
      knownDescendants: [101],
    });
    expect(killed).toContain(101);
    expect(result.terminated).toBe(true);
  });

  it('treats an unreadable file identity as uncertain rather than as a kill', async () => {
    const killed: number[] = [];
    const result = await terminateProcessTree(100, {
      listProcesses: async () => table([100, 1]),
      isAlive: () => true,
      killTree: async (pid) => { killed.push(pid); },
      sleep: async () => {},
      verifyTimeoutMs: 20,
    });
    // The kill was attempted; the survivors are reported truthfully.
    expect(killed.length).toBeGreaterThan(0);
    expect(result.terminated).toBe(false);
    expect(result.survivors).toEqual([100]);
  });
});

describe('describeTermination', () => {
  it('describes a clean stop', () => {
    expect(describeTermination({ terminated: true, survivors: [], killed: [1, 2], reason: '' }))
      .toContain('2 owned process(es) terminated and verified dead');
  });

  it('describes an incomplete stop', () => {
    expect(describeTermination({ terminated: false, survivors: [7], killed: [], reason: 'x' }))
      .toContain('stop incomplete');
  });
});
