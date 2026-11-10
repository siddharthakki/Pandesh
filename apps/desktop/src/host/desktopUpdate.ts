/**
 * Host side of the Update & Restart control. It never modifies installed files itself: it asks the installed
 * updater (updater/apply-update.mjs, run by the bundled node.exe) to verify a package, makes Core safe to stop,
 * starts the updater as a separate process and lets Pandesh exit so the updater can replace files.
 */
import { execFile, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { lifecycleAddress, probeOwnedCore } from '../../../../src/core-client/coreOwnership';

export interface UpdateInspection {
  ok: true;
  revision: number;
  version: string;
  commit: string | null;
  components: string[];
  installedRevision: number;
  migrates: boolean;
  dbSchemaFrom: number;
  dbSchemaTo: number;
  notes: string | null;
}

export interface UpdateResultRecord {
  status: 'success' | 'rolled_back' | 'aborted' | 'rollback_failed';
  at: string;
  acknowledged: boolean;
  reason?: string;
  revision?: number;
  attemptedRevision?: number;
  fromRevision?: number;
}

export interface UpdateReadiness {
  quiescing: boolean;
  gmailWritesInFlight: number;
  activeAttempts: number;
  capabilityInFlight: boolean;
}

function updaterScript(productRoot: string): string {
  return path.join(productRoot, 'updater', 'apply-update.mjs');
}

export function updaterAvailable(productRoot: string): boolean {
  return fs.existsSync(updaterScript(productRoot)) && fs.existsSync(path.join(productRoot, 'updater', 'update-trust.json'));
}

function updatesDir(dataDir: string): string {
  return path.join(dataDir, 'updates');
}

export function readUpdateResult(dataDir: string): UpdateResultRecord | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(updatesDir(dataDir), 'result.json'), 'utf8')) as UpdateResultRecord;
  } catch {
    return null;
  }
}

export function acknowledgeUpdateResult(dataDir: string): void {
  const record = readUpdateResult(dataDir);
  if (!record) return;
  fs.writeFileSync(path.join(updatesDir(dataDir), 'result.json'), `${JSON.stringify({ ...record, acknowledged: true }, null, 2)}\n`);
}

/** Written once the window has loaded and Core is connected. The updater reads it to confirm the new version works. */
export function writeUiHealth(dataDir: string, health: { buildNumber: number | null; rendererLoaded: boolean; coreConnected: boolean }): void {
  fs.mkdirSync(updatesDir(dataDir), { recursive: true });
  fs.writeFileSync(
    path.join(updatesDir(dataDir), 'ui-health.json'),
    `${JSON.stringify({ pid: process.pid, ...health, at: new Date().toISOString() })}\n`,
  );
}

/** Verifies the package and returns what it would do. Throws with the updater's user-readable reason. */
export function inspectPackage(opts: { productRoot: string; dataDir: string; node: string; packagePath: string }): Promise<UpdateInspection> {
  return new Promise((resolve, reject) => {
    execFile(
      opts.node,
      [updaterScript(opts.productRoot), 'inspect', '--package', opts.packagePath, '--install-root', opts.productRoot, '--data-dir', opts.dataDir],
      { windowsHide: true, timeout: 120_000, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          let reason = 'The update package could not be checked.';
          try { reason = JSON.parse(String(stderr).trim().split(/\r?\n/).pop() ?? '').error ?? reason; } catch { /* keep generic */ }
          reject(new Error(reason));
          return;
        }
        resolve(JSON.parse(String(stdout).trim().split(/\r?\n/).pop() ?? '{}') as UpdateInspection);
      },
    );
  });
}

async function coreCall<T>(dataDir: string, route: string, method: 'GET' | 'POST', body?: unknown): Promise<T | null> {
  try {
    const token = fs.readFileSync(path.join(dataDir, 'core.token'), 'utf8').trim();
    if (!token) return null;
    // Only this profile's own Core: a copied core.json + core.token would otherwise pause (quiesce) the ORIGINAL
    // profile's Core. The address in the body makes Core itself refuse a call meant for another instance.
    const ownership = await probeOwnedCore({ dataDir, token, timeoutMs: 4000 });
    if (ownership.state !== 'owned') return null;
    const payload = method === 'POST'
      ? { ...(body && typeof body === 'object' ? body as Record<string, unknown> : {}), ...lifecycleAddress(ownership.info, dataDir) }
      : undefined;
    const attempt = () => fetch(`${ownership.baseUrl}${route}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: payload === undefined ? undefined : JSON.stringify(payload),
      signal: AbortSignal.timeout(4000),
    });
    const res = await attempt().catch(() => attempt()); // a pooled keep-alive socket may have been closed by Core
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}

export function readCoreReadiness(dataDir: string): Promise<UpdateReadiness | null> {
  return coreCall<UpdateReadiness>(dataDir, '/v1/core/update-readiness', 'GET');
}

export function setUpdateGate(dataDir: string, quiesce: boolean): Promise<UpdateReadiness | null> {
  return coreCall<UpdateReadiness>(dataDir, '/v1/core/update-gate', 'POST', { quiesce });
}

/**
 * Stops new Gmail writes and waits for any running one to finish. Returns false (and reopens the gate) if one is
 * still running after `timeoutMs`: the update is then not started, so a write is never cut in half.
 */
export async function quiesceCore(dataDir: string, timeoutMs = 60_000): Promise<boolean> {
  let state = await setUpdateGate(dataDir, true);
  if (!state) return true; // Core is not running: there is nothing to wait for.
  const deadline = Date.now() + timeoutMs;
  while (state && state.gmailWritesInFlight > 0) {
    if (Date.now() >= deadline) {
      await setUpdateGate(dataDir, false);
      return false;
    }
    await new Promise((r) => setTimeout(r, 250));
    state = await readCoreReadiness(dataDir);
  }
  return true;
}

/** Starts the updater as a detached process. It waits for this process to exit before touching any file. */
export function launchUpdater(opts: { productRoot: string; dataDir: string; node: string }): void {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(
    opts.node,
    [updaterScript(opts.productRoot), 'apply', '--install-root', opts.productRoot, '--data-dir', opts.dataDir, '--parent-pid', String(process.pid)],
    { detached: true, stdio: 'ignore', windowsHide: true, env },
  );
  child.unref();
}
