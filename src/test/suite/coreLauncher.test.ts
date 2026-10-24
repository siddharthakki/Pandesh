import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CoreLauncher, defaultCorePath } from '../../core-client/CoreLauncher';

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const corePath = defaultCorePath(repoRoot); // repoRoot/out-core/core.js

/**
 * Integration tests driving the real extension-side CoreLauncher against
 * the real esbuild-bundled Core process (spawned via plain `node` here for
 * CI portability — the ELECTRON_RUN_AS_NODE launch strategy itself was
 * verified manually against this machine's installed VS Code; see M31 docs).
 */
beforeAll(() => {
  execFileSync(process.execPath, [path.join(repoRoot, 'esbuild.core.js')], { cwd: repoRoot, stdio: 'inherit' });
});

const tempDirs: string[] = [];
const cleanupTargets: Array<{ dataDir: string; token: string }> = [];
function makeDataDir(token = 'test-token'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karkedikha-launcher-test-'));
  tempDirs.push(dir);
  cleanupTargets.push({ dataDir: dir, token });
  return dir;
}

async function shutdownAll(): Promise<void> {
  const ownedPids: number[] = [];
  for (const { dataDir, token } of cleanupTargets.splice(0)) {
    const discoveryPath = path.join(dataDir, 'core.json');
    if (!fs.existsSync(discoveryPath)) continue;
    const record = JSON.parse(fs.readFileSync(discoveryPath, 'utf8')) as { pid: number; port: number; instanceId: string };
    ownedPids.push(record.pid);
    try {
      const response = await fetch(`http://127.0.0.1:${record.port}/v1/core/shutdown`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': `cleanup-${record.instanceId}`, 'X-Client-Id': 'test' },
        body: '{}',
      });
      if (!response.ok && response.status !== 202) {
        throw new Error(`Core cleanup rejected with HTTP ${response.status}`);
      }
    } catch {
      // This PID came from a discovery record under a unique test-owned data
      // directory. A failed authenticated shutdown must not leak the detached
      // test process; force termination is the bounded cleanup fallback.
      try { process.kill(record.pid, 'SIGKILL'); } catch { /* already exited */ }
    }
  }
  const deadline = Date.now() + 5000;
  while (ownedPids.some(pid => isPidAlive(pid)) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }
  for (const pid of ownedPids.filter(pid => isPidAlive(pid))) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already exited */ }
  }
  await new Promise((r) => setTimeout(r, 100));
  expect(ownedPids.filter(pid => isPidAlive(pid))).toEqual([]);
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function rmSyncWithRetry(dir: string): Promise<void> {
  // The Core is a real detached child process; shutdownAll() only waits for its HTTP response,
  // not for the OS to finish releasing its file handles on the (WAL) database files in this
  // directory, which can lag slightly on Windows. Retry rather than race it.
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EPERM' && (err as NodeJS.ErrnoException).code !== 'EBUSY') throw err;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}

afterEach(async () => {
  await shutdownAll();
  while (tempDirs.length) {
    await rmSyncWithRetry(tempDirs.pop()!);
  }
});

describe('CoreLauncher (real spawned Core)', () => {
  it('spawns a fresh Core when none is running', async () => {
    const dataDir = makeDataDir();
    const launcher = new CoreLauncher({ corePath, token: 'test-token', bundledCoreVersion: '0.1.0', dataDir });
    const outcome = await launcher.ensureCoreRunning();
    expect(outcome.state).toBe('connected');
  }, 15000);

  it('replaces an idle Core when the bundled file hash no longer matches', async () => {
    const dataDir = makeDataDir();
    const copies = path.join(dataDir, 'bundles');
    fs.mkdirSync(copies);
    const original = path.join(copies, 'core-a.js');
    const rebuilt = path.join(copies, 'core-b.js');
    fs.copyFileSync(corePath, original);
    fs.copyFileSync(corePath, rebuilt);
    fs.appendFileSync(rebuilt, '\n/* rebuilt desktop bundle */\n');
    const first = new CoreLauncher({ corePath: original, token: 'test-token', bundledCoreVersion: '0.1.0', dataDir });
    const connected = await first.ensureCoreRunning();
    expect(connected.state).toBe('connected');
    const firstId = connected.state === 'connected' ? connected.info.instanceId : '';
    const firstHash = connected.state === 'connected' ? connected.info.bundleHash : '';
    expect(firstHash).toBeTruthy();

    const second = new CoreLauncher({ corePath: rebuilt, token: 'test-token', bundledCoreVersion: '0.1.0', dataDir });
    const replaced = await second.ensureCoreRunning();
    expect(replaced.state).toBe('connected');
    if (replaced.state === 'connected') {
      expect(replaced.info.instanceId).not.toBe(firstId);
      expect(replaced.info.bundleHash).not.toBe(firstHash);
    }
  }, 25000);

  it('a second launcher instance (simulating a second VS Code window) reuses the same Core', async () => {
    const dataDir = makeDataDir();
    const launcherA = new CoreLauncher({ corePath, token: 'test-token', bundledCoreVersion: '0.1.0', dataDir });
    const outcomeA = await launcherA.ensureCoreRunning();
    expect(outcomeA.state).toBe('connected');

    const launcherB = new CoreLauncher({ corePath, token: 'test-token', bundledCoreVersion: '0.1.0', dataDir });
    const outcomeB = await launcherB.ensureCoreRunning();
    expect(outcomeB.state).toBe('connected');
    if (outcomeA.state === 'connected' && outcomeB.state === 'connected') {
      expect(outcomeB.info.instanceId).toBe(outcomeA.info.instanceId);
      expect(outcomeB.baseUrl).toBe(outcomeA.baseUrl);
    }
  }, 15000);

  it('a mismatched token surfaces authentication_failed without spawning a second Core', async () => {
    const dataDir = makeDataDir('correct-token');
    const launcherA = new CoreLauncher({ corePath, token: 'correct-token', bundledCoreVersion: '0.1.0', dataDir });
    const outcomeA = await launcherA.ensureCoreRunning();
    expect(outcomeA.state).toBe('connected');

    const launcherB = new CoreLauncher({ corePath, token: 'wrong-token', bundledCoreVersion: '0.1.0', dataDir });
    const outcomeB = await launcherB.ensureCoreRunning();
    expect(outcomeB.state).toBe('authentication_failed');

    // Confirm no second Core process was spawned: the lock file/discovery record still point at
    // the original instance.
    const discoveryPath = path.join(dataDir, 'core.json');
    const record = JSON.parse(fs.readFileSync(discoveryPath, 'utf8'));
    if (outcomeA.state === 'connected') expect(record.instanceId).toBe(outcomeA.info.instanceId);
  }, 15000);

  it('restartCore() replaces a running Core with a fresh instance', async () => {
    const dataDir = makeDataDir();
    const launcher = new CoreLauncher({ corePath, token: 'test-token', bundledCoreVersion: '0.1.0', dataDir });
    const first = await launcher.ensureCoreRunning();
    expect(first.state).toBe('connected');

    const restarted = await launcher.restartCore();
    expect(restarted.state).toBe('connected');
    if (first.state === 'connected' && restarted.state === 'connected') {
      expect(restarted.info.instanceId).not.toBe(first.info.instanceId);
    }
  }, 20000);

  it('surfaces a spawn failure immediately instead of degrading into the generic startup timeout', async () => {
    const dataDir = makeDataDir();
    const bogusExecutable = path.join(dataDir, 'does-not-exist-node-binary');
    const launcher = new CoreLauncher({
      corePath,
      token: 'test-token',
      bundledCoreVersion: '0.1.0',
      dataDir,
      nodeExecutable: bogusExecutable,
    });
    const startedAt = Date.now();
    const outcome = await launcher.ensureCoreRunning();
    const elapsedMs = Date.now() - startedAt;

    expect(outcome.state).toBe('unavailable');
    if (outcome.state === 'unavailable') {
      expect(outcome.detail).toContain('failed to spawn');
      // A real spawn error (ENOENT here) must be caught and returned well
      // before the 10s STARTUP_TIMEOUT_MS the "did not become healthy"
      // fallback uses — otherwise it degrades into that generic message and
      // the real cause is lost.
      expect(elapsedMs).toBeLessThan(8000);
    }
  }, 15000);

  it('recovers from a stale discovery record pointing at a dead process', async () => {
    const dataDir = makeDataDir();
    fs.writeFileSync(
      path.join(dataDir, 'core.json'),
      JSON.stringify({ pid: 999999, port: 59999, apiVersion: 1, coreVersion: '0.1.0', instanceId: 'dead', startedAtIso: new Date().toISOString() }),
    );
    const launcher = new CoreLauncher({ corePath, token: 'test-token', bundledCoreVersion: '0.1.0', dataDir });
    const outcome = await launcher.ensureCoreRunning();
    expect(outcome.state).toBe('connected');
  }, 15000);
});
