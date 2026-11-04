/**
 * M-benchmark P1 — the real Windows process tree.
 *
 * The unit tests in `core/test/processTreeTermination.test.ts` prove the
 * decision logic. This file proves the actual thing the benchmark measured:
 * that stopping a task kills the WHOLE owned tree (the shell, the tool it
 * started, and that tool's own children) while an unrelated process keeps
 * running.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { CommandService } from '../../../src/services/CommandService';

const platformIt = process.platform === 'win32' ? it : it.skip;
const owned = new Set<number>();

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function waitFor<T>(read: () => T | undefined, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('the controlled process tree did not reach the expected state');
}

/** A node process that spawns a child node process and reports both PIDs. */
const TREE_FIXTURE = `
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const pidFile = process.argv[2];
if (process.argv[3] === 'child') {
  setInterval(() => {}, 1000);
} else {
  const child = spawn(process.execPath, [__filename, pidFile, 'child'], { stdio: 'ignore', windowsHide: true });
  fs.writeFileSync(pidFile, JSON.stringify({ root: process.pid, child: child.pid }));
  setInterval(() => {}, 1000);
}
`;

afterEach(() => {
  for (const pid of owned) {
    if (isAlive(pid)) {
      try { process.kill(pid); } catch { /* the assertion reports the failure */ }
    }
  }
  owned.clear();
});

describe('Windows platform: a stop kills the whole owned tree', () => {
  platformIt('terminates cmd.exe, the tool it started and that tool\'s child', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'karkedikha-tree-'));
    const pidFile = path.join(root, 'pids.json');
    const fixture = path.join(root, 'tree.cjs');
    fs.writeFileSync(fixture, TREE_FIXTURE, 'utf8');
    const controller = new AbortController();
    try {
      // `cmd /c node tree.cjs` is the real shape: a shell that starts a tool
      // that starts its own child.
      const pending = CommandService.run(`node "${fixture}" "${pidFile}"`, root, 60_000, controller.signal);
      const pids = await waitFor(() => {
        if (!fs.existsSync(pidFile)) return undefined;
        try {
          return JSON.parse(fs.readFileSync(pidFile, 'utf8')) as { root: number; child: number };
        } catch { return undefined; }
      });
      owned.add(pids.root);
      owned.add(pids.child);
      expect(isAlive(pids.root)).toBe(true);
      expect(isAlive(pids.child)).toBe(true);

      const started = Date.now();
      controller.abort();
      const result = await pending;

      expect(result.cancelled).toBe(true);
      expect(result.termination).toBeDefined();
      expect(result.termination?.terminated).toBe(true);
      expect(result.termination?.survivors).toEqual([]);
      expect(Date.now() - started).toBeLessThan(15_000);

      // The grandchild is the one that used to survive: it is a child of the
      // node process, not of the shell.
      await waitFor(() => !isAlive(pids.root) && !isAlive(pids.child) ? true : undefined);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 40_000);

  platformIt('leaves an unrelated process running', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'karkedikha-unrelated-'));
    const pidFile = path.join(root, 'pids.json');
    const fixture = path.join(root, 'tree.cjs');
    fs.writeFileSync(fixture, TREE_FIXTURE, 'utf8');
    const controller = new AbortController();

    // A process Pandesh did not start: it must survive the stop untouched.
    const bystander = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
    const bystanderPid = bystander.pid as number;
    owned.add(bystanderPid);
    try {
      const pending = CommandService.run(`node "${fixture}" "${pidFile}"`, root, 60_000, controller.signal);
      const pids = await waitFor(() => {
        if (!fs.existsSync(pidFile)) return undefined;
        try {
          return JSON.parse(fs.readFileSync(pidFile, 'utf8')) as { root: number; child: number };
        } catch { return undefined; }
      });
      owned.add(pids.root);
      owned.add(pids.child);

      controller.abort();
      const result = await pending;
      expect(result.termination?.terminated).toBe(true);
      expect(isAlive(bystanderPid)).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 40_000);
});
