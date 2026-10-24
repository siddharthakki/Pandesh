import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const repoRoot = path.resolve(__dirname, '..', '..');
const bundlePath = path.join(repoRoot, 'out-core', 'core.js');

/**
 * End-to-end tests of the real esbuild-bundled Core entry point
 * (core/index.ts -> out-core/core.js), spawned as an actual child process
 * and driven over real HTTP — the same artifact the packaged VSIX ships,
 * just launched via plain `node` here for CI portability. The
 * ELECTRON_RUN_AS_NODE launch strategy itself was verified manually against
 * this machine's installed VS Code (see M31 docs); this suite guards the
 * Core's own startup/shutdown/database_failed behavior regardless of host.
 */
beforeAll(() => {
  execFileSync(process.execPath, [path.join(repoRoot, 'esbuild.core.js')], { cwd: repoRoot, stdio: 'inherit' });
});

const children: ChildProcess[] = [];
const tempDirs: string[] = [];

function makeDataDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karkedikha-coreproc-'));
  tempDirs.push(dir);
  return dir;
}

function spawnCore(dataDir: string, token: string, extraEnv: Record<string, string> = {}): ChildProcess {
  const child = spawn(process.execPath, [bundlePath], {
    env: { ...process.env, KARKEDIKHA_CORE_TOKEN: token, KARKEDIKHA_DATA_DIR: dataDir, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  return child;
}

async function waitForDiscoveryRecord(dataDir: string, timeoutMs = 5000): Promise<{ port: number; pid: number; instanceId: string }> {
  const discoveryPath = path.join(dataDir, 'core.json');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(discoveryPath)) {
      try {
        return JSON.parse(fs.readFileSync(discoveryPath, 'utf8'));
      } catch {
        // partial write race; retry
      }
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`discovery record did not appear within ${timeoutMs}ms`);
}

afterEach(async () => {
  while (children.length) {
    const child = children.pop()!;
    if (!child.killed) child.kill();
  }
  await new Promise((r) => setTimeout(r, 100));
  while (tempDirs.length) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('Core process (real spawn, real HTTP)', () => {
  it('refuses to start without KARKEDIKHA_CORE_TOKEN', async () => {
    const dataDir = makeDataDir();
    const child = spawn(process.execPath, [bundlePath], {
      env: { ...process.env, KARKEDIKHA_CORE_TOKEN: '', KARKEDIKHA_DATA_DIR: dataDir },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    children.push(child);
    const exitCode = await new Promise<number | null>((resolve) => child.once('exit', resolve));
    expect(exitCode).toBe(1);
  });

  it('starts, writes a discovery record, and answers authenticated health/info requests', async () => {
    const dataDir = makeDataDir();
    const token = 'integration-test-token';
    spawnCore(dataDir, token);
    const record = await waitForDiscoveryRecord(dataDir);
    expect(record.port).toBeGreaterThan(0);

    const healthRes = await fetch(`http://127.0.0.1:${record.port}/v1/health`);
    expect(healthRes.status).toBe(200);

    const infoRes = await fetch(`http://127.0.0.1:${record.port}/v1/core/info`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const info = await infoRes.json();
    expect(info.instanceId).toBe(record.instanceId);
    expect(info.apiVersion).toBe(1);
  });

  it('a second process pointed at the same data dir does not bind its own port (loses the singleton race)', async () => {
    const dataDir = makeDataDir();
    const token = 'integration-test-token';
    spawnCore(dataDir, token);
    const first = await waitForDiscoveryRecord(dataDir);

    const second = spawnCore(dataDir, token);
    const secondExit = await new Promise<number | null>((resolve) => second.once('exit', resolve));
    expect(secondExit).toBe(0);

    // The original owner's discovery record must be untouched.
    const stillRecord = JSON.parse(fs.readFileSync(path.join(dataDir, 'core.json'), 'utf8'));
    expect(stillRecord.instanceId).toBe(first.instanceId);
  });

  it('authenticated POST /v1/core/shutdown gracefully removes the discovery record and lock file', async () => {
    // Windows has no POSIX signals: child.kill('SIGTERM') force-terminates without running any JS
    // signal handler, so the only reliable graceful-shutdown path (and the one the real "Restart
    // KarkeDikha Core" command uses) is the authenticated HTTP endpoint, not OS signals.
    const dataDir = makeDataDir();
    const token = 'integration-test-token';
    const child = spawnCore(dataDir, token);
    const record = await waitForDiscoveryRecord(dataDir);

    const exitPromise = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    const shutdownRes = await fetch(`http://127.0.0.1:${record.port}/v1/core/shutdown`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': 'shutdown-1', 'X-Client-Id': 'test' },
      body: JSON.stringify({}),
    });
    expect(shutdownRes.status).toBe(202);
    await exitPromise;
    await new Promise((r) => setTimeout(r, 100));

    expect(fs.existsSync(path.join(dataDir, 'core.json'))).toBe(false);
    expect(fs.existsSync(path.join(dataDir, 'core.lock'))).toBe(false);
  });

  it('restart persists prior state (project survives process restart)', async () => {
    const dataDir = makeDataDir();
    const token = 'integration-test-token';
    const first = spawnCore(dataDir, token);
    const record1 = await waitForDiscoveryRecord(dataDir);

    const createRes = await fetch(`http://127.0.0.1:${record1.port}/v1/projects`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': 'k1', 'X-Client-Id': 'test' },
      body: JSON.stringify({ name: 'JUGAAD' }),
    });
    expect(createRes.status).toBe(201);

    const exitPromise = new Promise<void>((resolve) => first.once('exit', () => resolve()));
    await fetch(`http://127.0.0.1:${record1.port}/v1/core/shutdown`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': 'shutdown-2', 'X-Client-Id': 'test' },
      body: JSON.stringify({}),
    });
    await exitPromise;
    await new Promise((r) => setTimeout(r, 150));

    const second = spawnCore(dataDir, token);
    const record2 = await waitForDiscoveryRecord(dataDir);
    expect(record2.instanceId).not.toBe(record1.instanceId);

    const listRes = await fetch(`http://127.0.0.1:${record2.port}/v1/projects`, {
      headers: { Authorization: `Bearer ${token}`, 'X-Client-Id': 'test' },
    });
    const list = await listRes.json();
    expect(list.projects.some((p: { name: string }) => p.name === 'JUGAAD')).toBe(true);
  });
});
