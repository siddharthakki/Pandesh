/**
 * P0 — one Core per profile.
 *
 * A desktop instance may connect to, quiesce or stop ONLY the Core that serves
 * its own data directory, and a process may be force-terminated only by the
 * profile that started it.
 *
 * The Build 160 upgrade rehearsal copied a live profile. The copy kept
 * core.json and core.token, the rehearsal app attached to the PRODUCTION Core,
 * and quitting the rehearsal app stopped that Core. These tests rebuild that
 * situation with real Core processes on throwaway data directories: profile A
 * plays production, profile B is a copy of A taken while A runs.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CoreLauncher, type LauncherOutcome } from '../../../src/core-client/CoreLauncher';
import { ensureCoreBundle } from '../../../core/test/support/coreBundle';
import { createPortProcessManager } from '../../../core/runtime/portManager';
import { DesktopSession } from '../src/host/desktopSession';
import { setUpdateGate } from '../src/host/desktopUpdate';

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const corePath = path.join(repoRoot, 'out-core', 'core.js');

beforeAll(() => {
  ensureCoreBundle(repoRoot);
});

interface StartedCore { pid: number; port: number; token: string; instanceId: string }
const started: StartedCore[] = [];
const tempDirs: string[] = [];

function makeDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (err) { return (err as NodeJS.ErrnoException).code === 'EPERM'; }
}

function readRecord(dataDir: string): { pid: number; port: number; instanceId: string } {
  return JSON.parse(fs.readFileSync(path.join(dataDir, 'core.json'), 'utf8'));
}

async function launch(dataDir: string, token: string): Promise<LauncherOutcome> {
  const outcome = await new CoreLauncher({ corePath, token, bundledCoreVersion: '0.1.0', dataDir }).ensureCoreRunning();
  if (outcome.state === 'connected') {
    const record = readRecord(outcome.info.dataDir);
    if (!started.some((s) => s.pid === record.pid)) started.push({ pid: record.pid, port: record.port, token, instanceId: record.instanceId });
  }
  return outcome;
}

async function info(port: number, token: string): Promise<{ status: number; body: { instanceId?: string; dataDir?: string } | null }> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/core/info`, { headers: { Authorization: `Bearer ${token}` } });
    return { status: res.status, body: res.ok ? await res.json() : null };
  } catch {
    return { status: 0, body: null };
  }
}

function sameDir(a: string | undefined, b: string): boolean {
  return Boolean(a) && path.resolve(a as string).toLowerCase() === path.resolve(b).toLowerCase();
}

function copyFiles(from: string, to: string, names: string[]): void {
  for (const name of names) {
    const source = path.join(from, name);
    if (fs.existsSync(source)) fs.copyFileSync(source, path.join(to, name));
  }
}

/** A consistent copy of a live database, the way a careful backup tool takes one. */
function copyDatabase(from: string, to: string): void {
  const source = new DatabaseSync(path.join(from, 'core.db'), { readOnly: true });
  try {
    source.exec(`VACUUM INTO '${path.join(to, 'core.db').replace(/'/g, "''")}'`);
  } finally {
    source.close();
  }
}

/** Rewrites the copied lock file and database claim the way a Build 160 profile records them: without a data directory. */
function makeLegacyIdentity(dataDir: string): void {
  const lockPath = path.join(dataDir, 'core.lock');
  if (fs.existsSync(lockPath)) {
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as Record<string, unknown>;
    delete lock.dataDir;
    fs.writeFileSync(lockPath, JSON.stringify(lock));
  }
  const db = new DatabaseSync(path.join(dataDir, 'core.db'));
  try {
    const row = db.prepare("SELECT value FROM core_metadata WHERE key = 'singleton_owner'").get() as { value: string } | undefined;
    if (row) {
      const owner = JSON.parse(row.value) as Record<string, unknown>;
      delete owner.dataDir;
      db.prepare("UPDATE core_metadata SET value = ? WHERE key = 'singleton_owner'").run(JSON.stringify(owner));
    }
  } finally {
    db.close();
  }
}

async function stopEverything(): Promise<void> {
  for (const core of started.splice(0)) {
    if (!isAlive(core.pid)) continue;
    try {
      await fetch(`http://127.0.0.1:${core.port}/v1/core/shutdown`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${core.token}`, 'Content-Type': 'application/json', 'Idempotency-Key': `iso-cleanup-${core.instanceId}`, 'X-Client-Id': 'isolation-test' },
        body: '{}',
      });
    } catch { /* already gone */ }
    const deadline = Date.now() + 5_000;
    while (isAlive(core.pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    // Test-owned process on a throwaway data directory: bounded fallback so nothing leaks.
    if (isAlive(core.pid)) { try { process.kill(core.pid); } catch { /* gone */ } }
  }
}

afterEach(async () => {
  await stopEverything();
  for (const dir of tempDirs.splice(0)) {
    for (let attempt = 0; attempt < 15; attempt++) {
      try { fs.rmSync(dir, { recursive: true, force: true }); break; } catch { await new Promise((r) => setTimeout(r, 200)); }
    }
  }
});

function portOf(baseUrl: string): number {
  return Number(new URL(baseUrl).port);
}

describe('one Core per profile (real Core processes)', () => {
  it('a copy of a running profile starts its own Core instead of attaching to the original', async () => {
    const token = 'shared-profile-token';
    const dirA = makeDir('pandesh-iso-a-');
    const a = await launch(dirA, token);
    expect(a.state).toBe('connected');
    if (a.state !== 'connected') return;

    const dirB = makeDir('pandesh-iso-b-');
    copyFiles(dirA, dirB, ['core.json', 'core.lock']);
    copyDatabase(dirA, dirB);

    const b = await launch(dirB, token);
    expect(b.state).toBe('connected');
    if (b.state !== 'connected') return;
    expect(sameDir(b.info.dataDir, dirB)).toBe(true);
    expect(b.info.instanceId).not.toBe(a.info.instanceId);
    expect(b.baseUrl).not.toBe(a.baseUrl);

    const original = await info(portOf(a.baseUrl), token);
    expect(original.status).toBe(200);
    expect(original.body?.instanceId).toBe(a.info.instanceId);
    expect(sameDir(original.body?.dataDir, dirA)).toBe(true);
  }, 90_000);

  it('a copy made from a profile that recorded no data directory (Build 160) is not blocked by the original Core', async () => {
    const token = 'shared-profile-token-legacy';
    const dirA = makeDir('pandesh-iso-a-');
    const a = await launch(dirA, token);
    expect(a.state).toBe('connected');
    if (a.state !== 'connected') return;

    const dirB = makeDir('pandesh-iso-b-');
    copyFiles(dirA, dirB, ['core.json', 'core.lock']);
    copyDatabase(dirA, dirB);
    makeLegacyIdentity(dirB);

    const b = await launch(dirB, token);
    expect(b.state).toBe('connected');
    if (b.state !== 'connected') return;
    expect(sameDir(b.info.dataDir, dirB)).toBe(true);
    expect((await info(portOf(a.baseUrl), token)).body?.instanceId).toBe(a.info.instanceId);
  }, 90_000);

  it('quitting a copied profile does not stop the Core of the original profile', async () => {
    const dirA = makeDir('pandesh-iso-a-');
    const token = 'shared-desktop-token';
    fs.writeFileSync(path.join(dirA, 'core.token'), token);
    const a = await launch(dirA, token);
    expect(a.state).toBe('connected');
    if (a.state !== 'connected') return;
    const pidA = readRecord(dirA).pid;

    const dirB = makeDir('pandesh-iso-b-');
    copyFiles(dirA, dirB, ['core.json', 'core.lock', 'core.token']);

    const copy = new DesktopSession({ productRoot: repoRoot, dataDir: dirB });
    await copy.shutdown({ timeoutMs: 1_500 });

    expect(isAlive(pidA)).toBe(true);
    expect((await info(portOf(a.baseUrl), token)).body?.instanceId).toBe(a.info.instanceId);
  }, 60_000);

  it('a copied process-ownership ledger cannot be used to kill the original profile\'s Core', async () => {
    const dirA = makeDir('pandesh-iso-a-');
    fs.writeFileSync(path.join(dirA, 'core.token'), 'token-of-a');
    const a = await launch(dirA, 'token-of-a');
    expect(a.state).toBe('connected');
    if (a.state !== 'connected') return;
    const pidA = readRecord(dirA).pid;
    expect(fs.existsSync(path.join(dirA, 'process-ownership-ledger.json'))).toBe(true);

    // The copy has its own Core token, so the authenticated shutdown is refused; the danger is
    // the forced-cleanup fallback acting on the copied ownership records.
    const dirB = makeDir('pandesh-iso-b-');
    copyFiles(dirA, dirB, ['core.json', 'core.lock', 'port-manager.token', 'port-manager-registry.json', 'process-ownership-ledger.json']);
    fs.writeFileSync(path.join(dirB, 'core.token'), 'token-of-b');

    const copy = new DesktopSession({ productRoot: repoRoot, dataDir: dirB });
    await copy.shutdown({ timeoutMs: 800 });

    expect(isAlive(pidA)).toBe(true);
    expect((await info(portOf(a.baseUrl), 'token-of-a')).body?.instanceId).toBe(a.info.instanceId);
  }, 60_000);

  it('the ownership boundary refuses a Core named only by a copied ledger, and still stops its own', async () => {
    const dirA = makeDir('pandesh-iso-a-');
    const a = await launch(dirA, 'ledger-token');
    expect(a.state).toBe('connected');
    if (a.state !== 'connected') return;
    const pidA = readRecord(dirA).pid;

    const dirB = makeDir('pandesh-iso-b-');
    copyFiles(dirA, dirB, ['port-manager.token', 'port-manager-registry.json', 'process-ownership-ledger.json']);
    const copied = await createPortProcessManager({ dataDir: dirB }).stopOwned('karkeDikha-core');
    expect(copied.stopped).toBe(false);
    expect(copied.reason).toMatch(/another profile/);
    expect(isAlive(pidA)).toBe(true);

    // A ledger written by Build 160 names no profile at all: it proves nothing either.
    copyFiles(dirA, dirB, ['port-manager-registry.json', 'process-ownership-ledger.json']);
    const ledgerPath = path.join(dirB, 'process-ownership-ledger.json');
    const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8')) as Record<string, Record<string, unknown>>;
    for (const entry of Object.values(ledger)) delete entry.dataDir;
    fs.writeFileSync(ledgerPath, JSON.stringify(ledger));
    const legacy = await createPortProcessManager({ dataDir: dirB }).stopOwned('karkeDikha-core');
    expect(legacy.stopped).toBe(false);
    expect(legacy.reason).toMatch(/names no profile/);
    expect(isAlive(pidA)).toBe(true);

    // The profile that started the Core can still stop it (the forced-cleanup path is not disabled).
    const own = await createPortProcessManager({ dataDir: dirA }).stopOwned('karkeDikha-core');
    expect(own.stopped).toBe(true);
    const deadline = Date.now() + 5_000;
    while (isAlive(pidA) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    expect(isAlive(pidA)).toBe(false);
  }, 60_000);

  it('the update gate of a copied profile never quiesces the original profile\'s Core', async () => {
    const dirA = makeDir('pandesh-iso-a-');
    const token = 'shared-update-token';
    fs.writeFileSync(path.join(dirA, 'core.token'), token);
    const a = await launch(dirA, token);
    expect(a.state).toBe('connected');
    if (a.state !== 'connected') return;

    const dirB = makeDir('pandesh-iso-b-');
    copyFiles(dirA, dirB, ['core.json', 'core.token']);

    expect(await setUpdateGate(dirB, true)).toBeNull();
    const readiness = await fetch(`${a.baseUrl}/v1/core/update-readiness`, { headers: { Authorization: `Bearer ${token}` } });
    expect((await readiness.json()).quiescing).toBe(false);
  }, 60_000);

  it('the Core refuses a shutdown addressed to another profile or another instance', async () => {
    const dirA = makeDir('pandesh-iso-a-');
    const token = 'shutdown-guard-token';
    const a = await launch(dirA, token);
    expect(a.state).toBe('connected');
    if (a.state !== 'connected') return;
    const pidA = readRecord(dirA).pid;
    const post = (body: unknown, key: string) => fetch(`${a.baseUrl}/v1/core/shutdown`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': key, 'X-Client-Id': 'isolation-test' },
      body: JSON.stringify(body),
    });

    expect((await post({ expectedDataDir: path.join(os.tmpdir(), 'some-other-profile') }, 'guard-1')).status).toBe(409);
    expect((await post({ expectedInstanceId: 'not-this-instance' }, 'guard-2')).status).toBe(409);
    await new Promise((r) => setTimeout(r, 300));
    expect(isAlive(pidA)).toBe(true);

    expect((await post({ expectedInstanceId: a.info.instanceId, expectedDataDir: dirA }, 'guard-3')).status).toBe(202);
    const deadline = Date.now() + 8_000;
    while (isAlive(pidA) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    expect(isAlive(pidA)).toBe(false);
  }, 60_000);
});
