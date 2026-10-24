import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CoreToolRunner } from '../../runtime/toolRunner';

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

async function waitFor<T>(read: () => T | undefined, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('controlled process tree did not reach the expected state');
}

afterEach(() => {
  for (const pid of owned) {
    if (isAlive(pid)) {
      try { process.kill(pid); } catch { /* platform gate reports the assertion failure */ }
    }
  }
  owned.clear();
});

describe('Windows platform: Karke kills the exact process tree it owns', () => {
  platformIt('terminates the controlled child and grandchild on abort', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'karkedikha-owned-tree-'));
    const pidFile = path.join(root, 'owned-pids.json');
    const fixture = path.resolve(__dirname, 'fixtures/ownedProcessTree.cjs');
    const controller = new AbortController();
    try {
      const pending = new CoreToolRunner().run({
        name: 'run_command',
        arguments: { command: `node "${fixture}" "${pidFile}"` },
      }, { cwd: root, signal: controller.signal });
      const pids = await waitFor(() => {
        if (!fs.existsSync(pidFile)) return undefined;
        return JSON.parse(fs.readFileSync(pidFile, 'utf8')) as { child: number; grandchild: number };
      });
      owned.add(pids.child);
      owned.add(pids.grandchild);
      expect(isAlive(pids.child)).toBe(true);
      expect(isAlive(pids.grandchild)).toBe(true);

      const started = Date.now();
      controller.abort();
      const result = await pending;
      expect(result.status).toBe('failed');
      expect(Date.now() - started).toBeLessThan(5_000);
      await waitFor(() => !isAlive(pids.child) && !isAlive(pids.grandchild) ? true : undefined);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);
});
