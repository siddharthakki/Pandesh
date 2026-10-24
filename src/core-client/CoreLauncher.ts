import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveDataDir, resolvePaths } from '../../core/env/dataDir';
import { readDiscoveryRecord, type DiscoveryRecord } from '../../core/discovery/record';
import { CORE_API_VERSION, type CoreInfo } from '../../core/shared/wireTypes';
import { hashCoreBundle } from '../../core/runtime/coreBundle';

const STARTUP_TIMEOUT_MS = 10_000;
const PROBE_TIMEOUT_MS = 2_000;
const POLL_INTERVAL_MS = 150;
const SHUTDOWN_WAIT_TIMEOUT_MS = 8_000;

export type LauncherOutcome =
  | { state: 'connected'; baseUrl: string; info: CoreInfo }
  | { state: 'incompatible'; detail: string; info: CoreInfo }
  | { state: 'authentication_failed'; detail: string }
  | { state: 'database_failed'; detail: string }
  | { state: 'unavailable'; detail: string };

export interface CoreLauncherOptions {
  /** Absolute path to the esbuild-bundled Core entry point shipped inside this extension (out-core/core.js). */
  corePath: string;
  /** The bearer token this extension holds (shared across windows for the same OS user). */
  token: string;
  /** This extension's own bundled Core version, used for the "safe replacement after upgrade" comparison. */
  bundledCoreVersion: string;
  /** Overridable for tests; defaults to the real OS-appropriate data dir. */
  dataDir?: string;
  log?: (message: string) => void;
  searxngUrl?: string;
  /**
   * Extra environment for the Core child. Required token/data-dir keys always
   * win over this map so a caller cannot overwrite credentials.
   */
  extraEnv?: Record<string, string>;
  /**
   * Executable used to spawn Core. Defaults to `process.execPath`. Desktop
   * hosts whose Electron Node is older than Core's `node:sqlite` requirement
   * pass a Node 22+ binary here.
   */
  nodeExecutable?: string;
}

function probeCore(port: number, token: string, timeoutMs: number): Promise<
  { ok: true; info: CoreInfo } | { ok: false; reason: 'unreachable' | 'unauthenticated' | 'error' }
> {
  return new Promise((resolve) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    fetch(`http://127.0.0.1:${port}/v1/core/info`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    })
      .then(async (res) => {
        clearTimeout(timer);
        if (res.status === 401 || res.status === 403) {
          resolve({ ok: false, reason: 'unauthenticated' });
          return;
        }
        if (!res.ok) {
          resolve({ ok: false, reason: 'error' });
          return;
        }
        const info = (await res.json()) as CoreInfo;
        resolve({ ok: true, info });
      })
      .catch(() => {
        clearTimeout(timer);
        resolve({ ok: false, reason: 'unreachable' });
      });
  });
}

export type ExistingCoreDecision =
  | 'connect'
  | 'replace'
  | 'incompatible-api'
  | 'incompatible-busy';

export function decideExistingCoreReuse(input: {
  clientApiVersion: number;
  runningApiVersion: number;
  bundledCoreVersion: string;
  runningCoreVersion: string;
  bundledBundleHash?: string;
  runningBundleHash?: string;
  busy: boolean;
}): ExistingCoreDecision {
  if (input.runningApiVersion !== input.clientApiVersion) {
    return isNewerVersion(input.bundledCoreVersion, input.runningCoreVersion)
      ? 'replace'
      : 'incompatible-api';
  }
  // A valid newer running Core with matching API version must never be downgraded.
  if (isNewerVersion(input.runningCoreVersion, input.bundledCoreVersion)) {
    return 'connect';
  }
  const outdated = Boolean(input.bundledBundleHash) && input.bundledBundleHash !== input.runningBundleHash;
  if (!outdated) return 'connect';
  return input.busy ? 'incompatible-busy' : 'replace';
}

function isNewerVersion(candidate: string, current: string): boolean {
  const parse = (v: string) => v.split('.').map((n) => Number(n) || 0);
  const a = parse(candidate);
  const b = parse(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Discovers, health-probes, launches, and — only in the narrow
 * post-VSIX-upgrade case — replaces the KarkeDikha Core. Never force-kills a
 * process: the only shutdown path is the authenticated
 * `POST /v1/core/shutdown` endpoint. If that doesn't complete in time, this
 * surfaces a diagnostic rather than sending a signal to an arbitrary PID —
 * per M31 security requirements, we never terminate a process based on PID
 * alone.
 */
export class CoreLauncher {
  private readonly dataDir: string;
  private readonly paths: ReturnType<typeof resolvePaths>;

  constructor(private readonly options: CoreLauncherOptions) {
    this.dataDir = options.dataDir ?? resolveDataDir();
    this.paths = resolvePaths(this.dataDir);
  }

  private log(message: string): void {
    this.options.log?.(message);
  }

  /** Explicit user-invoked restart (the "Restart KarkeDikha Core" command): unconditionally shuts down a reachable Core and relaunches, regardless of version match. */
  async restartCore(): Promise<LauncherOutcome> {
    const existing = readDiscoveryRecord(this.paths.discoveryRecordPath);
    if (existing) {
      const probe = await probeCore(existing.port, this.options.token, PROBE_TIMEOUT_MS);
      if (probe.ok) {
        const replaced = await this.authorizedReplace(existing);
        if (!replaced) {
          return { state: 'unavailable', detail: 'Core did not shut down in time for restart' };
        }
      } else if (probe.reason === 'unauthenticated') {
        return { state: 'authentication_failed', detail: 'cannot restart: a running Core rejected our credentials' };
      }
      // unreachable: fall through and just spawn fresh, same as ensureCoreRunning.
    }
    return this.spawnAndWait();
  }

  async ensureCoreRunning(): Promise<LauncherOutcome> {
    const existing = readDiscoveryRecord(this.paths.discoveryRecordPath);
    if (existing) {
      const outcome = await this.evaluateExisting(existing);
      if (outcome) return outcome;
      // evaluateExisting returns undefined only when it performed an authorized replace and we
      // should fall through to a fresh spawn below.
    }
    return this.spawnAndWait();
  }

  /** Returns a terminal outcome, or undefined if it replaced the Core and the caller should spawn fresh. */
  private async evaluateExisting(record: DiscoveryRecord): Promise<LauncherOutcome | undefined> {
    const probe = await probeCore(record.port, this.options.token, PROBE_TIMEOUT_MS);

    if (probe.ok) {
      const decision = decideExistingCoreReuse({
        clientApiVersion: CORE_API_VERSION,
        runningApiVersion: probe.info.apiVersion,
        bundledCoreVersion: this.options.bundledCoreVersion,
        runningCoreVersion: probe.info.coreVersion,
        bundledBundleHash: hashCoreBundle(this.options.corePath),
        runningBundleHash: probe.info.bundleHash,
        busy: probe.info.busy === true,
      });
      if (decision === 'connect') {
        return { state: 'connected', baseUrl: `http://127.0.0.1:${record.port}`, info: probe.info };
      }
      if (decision === 'incompatible-api') {
        return {
          state: 'incompatible',
          detail: `Core apiVersion ${probe.info.apiVersion} is incompatible with this client's ${CORE_API_VERSION}`,
          info: probe.info,
        };
      }
      if (decision === 'incompatible-busy') {
        return {
          state: 'incompatible',
          detail: `running Core build ${probe.info.bundleHash ?? 'unknown'} is outdated but busy; not replacing active work`,
          info: probe.info,
        };
      }
      this.log(`replacing outdated Core ${probe.info.coreVersion} hash=${probe.info.bundleHash ?? 'unknown'} with bundled ${this.options.bundledCoreVersion} hash=${hashCoreBundle(this.options.corePath) ?? 'unknown'}`);
      const replaced = await this.authorizedReplace(record);
      if (!replaced) {
        return { state: 'unavailable', detail: 'failed to replace an older, incompatible Core' };
      }
      return undefined;
    }

    if (probe.reason === 'unauthenticated') {
      // A healthy Core exists but our token doesn't match it. Per M31 §5, this must NOT trigger
      // spawning a second Core — surface the failure and let the user decide (e.g. manual restart).
      return { state: 'authentication_failed', detail: 'a running Core rejected our credentials' };
    }

    // Unreachable: the discovery record is stale (dead process, or a Core that crashed without
    // cleaning up). The Core's own singleton acquisition (lock file + DB claim) is authoritative
    // and safe to race against — we simply attempt a fresh spawn below.
    this.log(`existing discovery record at port ${record.port} is unreachable; will attempt a fresh spawn`);
    return undefined;
  }

  /** Authenticated shutdown of a *confirmed* Core instance, then waits for it to actually exit. Never sends an OS signal. */
  private async authorizedReplace(record: DiscoveryRecord): Promise<boolean> {
    try {
      const res = await fetch(`http://127.0.0.1:${record.port}/v1/core/shutdown`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.options.token}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': `upgrade-replace-${record.instanceId}`,
          'X-Client-Id': 'core-launcher',
        },
        body: '{}',
      });
      if (!res.ok && res.status !== 202) return false;
    } catch {
      return false;
    }

    const deadline = Date.now() + SHUTDOWN_WAIT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const current = readDiscoveryRecord(this.paths.discoveryRecordPath);
      if (!current || current.instanceId !== record.instanceId) return true;
      await sleep(POLL_INTERVAL_MS);
    }
    this.log(`Core instance ${record.instanceId} did not shut down within ${SHUTDOWN_WAIT_TIMEOUT_MS}ms`);
    return false;
  }

  private async spawnAndWait(): Promise<LauncherOutcome> {
    // Core's own console.log/console.error output (startup diagnostics,
    // per-request failures such as a local-transcription exception caught
    // and logged before being recorded as durable `localProcessingCapability:
    // 'failed'` evidence) must remain inspectable after a packaged run —
    // silently discarding it via stdio:'ignore' turned a real bug into an
    // unobservable one during acceptance debugging. Redirect to a bounded,
    // append-mode log file under the data dir instead of piping into this
    // process (which would require us to stay alive to drain it; Core is
    // meant to keep running detached after the launcher returns).
    let stdioTargets: childProcess.StdioOptions = 'ignore';
    try {
      const logDir = path.join(this.dataDir, 'logs');
      fs.mkdirSync(logDir, { recursive: true });
      const logPath = path.join(logDir, 'core.log');
      const fd = fs.openSync(logPath, 'a');
      stdioTargets = ['ignore', fd, fd];
    } catch (err) {
      this.log(`Failed to open Core log file, falling back to discarding Core stdio: ${(err as Error).message}`);
    }

    const nodeExecutable = this.options.nodeExecutable ?? process.execPath;
    const runAsElectronNode = path.basename(nodeExecutable).toLowerCase().includes('electron')
      || (nodeExecutable === process.execPath && Boolean(process.versions.electron));
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...this.options.extraEnv,
      KARKEDIKHA_CORE_TOKEN: this.options.token,
      KARKEDIKHA_DATA_DIR: this.dataDir,
      ...(this.options.searxngUrl ? { KARKEDIKHA_SEARXNG_URL: this.options.searxngUrl } : {}),
    };
    if (runAsElectronNode) env.ELECTRON_RUN_AS_NODE = '1';
    else delete env.ELECTRON_RUN_AS_NODE;
    const child = childProcess.spawn(nodeExecutable, [this.options.corePath], {
      env,
      detached: true,
      stdio: stdioTargets,
      windowsHide: true,
    });
    child.unref();

    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    let earlyExitCode: number | null = null;
    child.once('exit', (code) => {
      earlyExitCode = code;
    });

    // Without this handler, a synchronous or asynchronous spawn failure (bad
    // executable path, EACCES from an AV-quarantined binary, ENOENT from a
    // corrupted VSIX extract) emits an unhandled `'error'` event that Node
    // silently drops here — the loop below would then just run out its full
    // STARTUP_TIMEOUT_MS and report the generic "did not become healthy"
    // message, with the actual cause never captured anywhere, including
    // core.log (the process never got far enough to write to it). Capture it
    // so the real cause is both logged and part of the returned outcome.
    let spawnError: NodeJS.ErrnoException | null = null;
    child.once('error', (err) => {
      spawnError = err as NodeJS.ErrnoException;
    });

    while (Date.now() < deadline) {
      if (spawnError !== null) {
        const err = spawnError as NodeJS.ErrnoException;
        // Full diagnostic (executable/corePath/cwd/code/errno/syscall) goes to
        // the Core log only — the returned outcome's `detail` is what reaches
        // the Setup panel UI verbatim via `coreRuntimeSummaryForState`, so it
        // stays a short, non-leaky pointer rather than a raw stack of paths.
        this.log(
          `Core process failed to spawn: ${err.message} (code=${err.code ?? 'unknown'}, errno=${err.errno ?? 'unknown'},`
          + ` syscall=${err.syscall ?? 'unknown'}, executable=${nodeExecutable}, corePath=${this.options.corePath}, cwd=${process.cwd()})`,
        );
        return { state: 'unavailable', detail: `Core failed to spawn (${err.code ?? err.message}). See KarkeDikha Core logs.` };
      }
      const record = readDiscoveryRecord(this.paths.discoveryRecordPath);
      if (record) {
        const probe = await probeCore(record.port, this.options.token, PROBE_TIMEOUT_MS);
        if (probe.ok) {
          return { state: 'connected', baseUrl: `http://127.0.0.1:${record.port}`, info: probe.info };
        }
      }
      if (earlyExitCode !== null && earlyExitCode !== 0) {
        return { state: 'database_failed', detail: `Core process exited early with code ${earlyExitCode} (see Core logs)` };
      }
      await sleep(POLL_INTERVAL_MS);
    }
    return { state: 'unavailable', detail: `Core did not become healthy within ${STARTUP_TIMEOUT_MS}ms` };
  }
}

export function defaultCorePath(extensionPath: string): string {
  return path.join(extensionPath, 'out-core', 'core.js');
}
