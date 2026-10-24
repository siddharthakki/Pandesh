/**
 * P0 — Shared process-ownership verification boundary.
 *
 * Every force-termination in Core goes through this module. Nothing else may
 * terminate a process on this machine unless this module first proves that
 * the target is a process Pandesh itself started.
 *
 * The previous state of the codebase was unsafe in three specific ways, all
 * observed on a real machine:
 *
 *  1. `ownedByPandesh` was a STORED BOOLEAN in the port-manager registry. It
 *     was set from a caller-supplied PID, so it proved nothing.
 *  2. The PID-reuse guard compared `record.processStartMs` with
 *     `info.startMs`, but the production identity provider always returned
 *     `startMs: null`. The condition `record.processStartMs !== null &&
 *     info.startMs !== null` was therefore never true, so the guard never
 *     fired and a recycled PID was killed as if it were ours.
 *  3. The SAFE_MODE emergency path fell back to `taskkill /pid <pid> /t /f`
 *     with no identity check at all, and reported the PID as "terminated"
 *     even when the kill had failed.
 *
 * The rules enforced here, in order, all failing CLOSED:
 *
 *  - No live identity  -> refuse. Missing identity information is a refusal,
 *    never a permission.
 *  - No ownership provenance -> refuse. A process Pandesh did not start has
 *    no provenance record, so it can never be terminated by this boundary.
 *  - Creation time outside the recorded window -> refuse (PID reuse).
 *  - Executable path different from the recorded one -> refuse.
 *  - Executable path outside the allowed roots -> refuse.
 *
 * The verification is deliberately split into a pure function
 * (`verifyProcessOwnership`) and the OS-touching boundary object, so the
 * decision logic is unit-testable with mocked termination APIs and no live
 * process is ever killed in a test.
 */
import { spawn, execFileSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createSanitizedChildEnvironment } from '../security/childEnvironment';

/** What the OS can tell us about a live process. */
export interface ProcessIdentitySnapshot {
  pid: number;
  alive: boolean;
  /** Absolute path of the running executable, when the OS will disclose it. */
  executablePath: string | null;
  /** Process creation time in epoch milliseconds, when the OS will disclose it. */
  creationTimeMs: number | null;
  commandLine: string | null;
}

/**
 * Evidence that Pandesh itself started a process. This is the only thing that
 * makes a process "owned": a stored flag or a matching executable name is not
 * evidence.
 */
export interface OwnershipProvenance {
  pid: number;
  /** The token of the owner that recorded this launch. */
  ownerToken: string;
  /** Exact creation time when it was known at spawn time. */
  creationTimeMs: number | null;
  /** Wall-clock moment the launch was requested; used as a creation window. */
  spawnedAtMs: number | null;
  /** Absolute executable path observed at spawn time. */
  executablePath: string | null;
  /** When the provenance was recorded (ISO-8601). */
  recordedAt: string;
  /** Which internal component recorded it. */
  source: string;
}

/** What the caller believes about the process it wants to terminate. */
export interface OwnershipExpectation {
  pid: number;
  /** Exact creation time the caller recorded, when known. */
  creationTimeMs: number | null;
  /** Executable path the caller recorded, when known. */
  executablePath: string | null;
  /** Roots the executable is allowed to live under (case-insensitive). */
  allowedExecutableRoots?: string[];
}

export type OwnershipRefusalCode =
  | 'identity_unavailable'
  | 'not_alive'
  | 'pid_reused'
  | 'executable_mismatch'
  | 'outside_allowed_root'
  | 'provenance_missing'
  | 'provenance_mismatch';

export interface OwnershipVerdict {
  verified: boolean;
  code: 'verified' | OwnershipRefusalCode;
  /** Human-readable, safe to show in an approval card or a log line. */
  reason: string;
  identity: ProcessIdentitySnapshot | null;
  provenance: OwnershipProvenance | null;
}

/** Creation-time comparison tolerance. Windows timestamps are ~15ms granular. */
export const DEFAULT_CREATION_TIME_TOLERANCE_MS = 1_500;
/**
 * A child is created within milliseconds of the spawn request, so the live
 * creation time must fall in this window around the recorded spawn time.
 * A recycled PID is created far outside it.
 */
export const DEFAULT_SPAWN_WINDOW_BEFORE_MS = 2_000;
export const DEFAULT_SPAWN_WINDOW_AFTER_MS = 15_000;

function normalizePath(value: string): string {
  return value.trim().replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}

function isUnderRoot(candidate: string, root: string): boolean {
  const normalizedRoot = normalizePath(root);
  if (!normalizedRoot) return false;
  const normalizedCandidate = normalizePath(candidate);
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}\\`);
}

/**
 * The pure decision. Everything the boundary needs is passed in, so the whole
 * fail-closed rule set is exercised by unit tests without touching the OS.
 */
export function verifyProcessOwnership(input: {
  expectation: OwnershipExpectation;
  identity: ProcessIdentitySnapshot | null;
  provenance: OwnershipProvenance | null;
  /** The owner token of the verifier; a provenance record from another owner is not ours. */
  currentOwnerToken: string;
  creationTimeToleranceMs?: number;
  spawnWindowBeforeMs?: number;
  spawnWindowAfterMs?: number;
}): OwnershipVerdict {
  const { expectation, identity, provenance } = input;
  const tolerance = input.creationTimeToleranceMs ?? DEFAULT_CREATION_TIME_TOLERANCE_MS;
  const windowBefore = input.spawnWindowBeforeMs ?? DEFAULT_SPAWN_WINDOW_BEFORE_MS;
  const windowAfter = input.spawnWindowAfterMs ?? DEFAULT_SPAWN_WINDOW_AFTER_MS;

  const refuse = (code: OwnershipRefusalCode, reason: string): OwnershipVerdict => ({
    verified: false, code, reason, identity, provenance,
  });

  if (!provenance) {
    return refuse('provenance_missing', `no ownership provenance for pid ${expectation.pid}: Pandesh did not record starting this process`);
  }
  if (!input.currentOwnerToken || provenance.ownerToken !== input.currentOwnerToken) {
    return refuse('provenance_mismatch', `ownership provenance for pid ${expectation.pid} belongs to a different owner`);
  }
  if (provenance.pid !== expectation.pid) {
    return refuse('provenance_mismatch', `ownership provenance for pid ${expectation.pid} records a different pid (${provenance.pid})`);
  }
  if (!identity) {
    return refuse('identity_unavailable', `could not read the identity of pid ${expectation.pid}; missing identity information is a refusal`);
  }
  if (!identity.alive) {
    return refuse('not_alive', `pid ${expectation.pid} is not running`);
  }
  if (identity.creationTimeMs === null || !identity.executablePath) {
    return refuse('identity_unavailable', `the OS did not disclose the creation time or executable path of pid ${expectation.pid}; missing identity information is a refusal`);
  }

  // PID reuse: the live process must be the one we started.
  const exactCreationTime = expectation.creationTimeMs ?? provenance.creationTimeMs;
  if (exactCreationTime !== null && exactCreationTime !== undefined) {
    if (Math.abs(identity.creationTimeMs - exactCreationTime) > tolerance) {
      return refuse('pid_reused', `pid ${expectation.pid} is now a different process (creation time ${new Date(identity.creationTimeMs).toISOString()} does not match the recorded ${new Date(exactCreationTime).toISOString()})`);
    }
  } else if (provenance.spawnedAtMs !== null && provenance.spawnedAtMs !== undefined) {
    const earliest = provenance.spawnedAtMs - windowBefore;
    const latest = provenance.spawnedAtMs + windowAfter;
    if (identity.creationTimeMs < earliest || identity.creationTimeMs > latest) {
      return refuse('pid_reused', `pid ${expectation.pid} is now a different process (creation time ${new Date(identity.creationTimeMs).toISOString()} is outside the recorded spawn window)`);
    }
  } else {
    return refuse('identity_unavailable', `no recorded creation time or spawn window for pid ${expectation.pid}; a recycled pid cannot be ruled out`);
  }

  // Executable identity. The allowed-root rule is checked first: a process
  // running outside the roots is a different, more specific refusal than a
  // merely different path.
  const roots = expectation.allowedExecutableRoots ?? [];
  if (roots.length > 0 && !roots.some((root) => isUnderRoot(identity.executablePath as string, root))) {
    return refuse('outside_allowed_root', `pid ${expectation.pid} is running ${identity.executablePath}, outside the allowed roots`);
  }
  const expectedExecutable = expectation.executablePath ?? provenance.executablePath;
  if (expectedExecutable) {
    if (normalizePath(identity.executablePath) !== normalizePath(expectedExecutable)) {
      return refuse('executable_mismatch', `pid ${expectation.pid} is running ${identity.executablePath}, not the recorded ${expectedExecutable}`);
    }
  }

  return {
    verified: true,
    code: 'verified',
    reason: `pid ${expectation.pid} is the process Pandesh started (${identity.executablePath})`,
    identity,
    provenance,
  };
}

/* ------------------------------------------------------------------ */
/* Durable ownership ledger                                             */
/* ------------------------------------------------------------------ */

const LEDGER_FILE = 'process-ownership-ledger.json';

export interface ProcessOwnershipLedger {
  readonly filePath: string;
  read(): Record<string, OwnershipProvenance>;
  get(pid: number): OwnershipProvenance | null;
  record(provenance: OwnershipProvenance): OwnershipProvenance;
  remove(pid: number): void;
}

export interface ProcessOwnershipLedgerOptions {
  dataDir: string;
  readFileFn?: (filePath: string) => string;
  writeFileFn?: (filePath: string, content: string) => void;
  existsFn?: (filePath: string) => boolean;
}

export function createProcessOwnershipLedger(options: ProcessOwnershipLedgerOptions): ProcessOwnershipLedger {
  const filePath = path.join(options.dataDir, LEDGER_FILE);
  const readFileFn = options.readFileFn ?? ((p: string) => fs.readFileSync(p, 'utf8'));
  const writeFileFn = options.writeFileFn ?? ((p: string, c: string) => {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, c, 'utf8');
  });
  const existsFn = options.existsFn ?? ((p: string) => fs.existsSync(p));

  function read(): Record<string, OwnershipProvenance> {
    if (!existsFn(filePath)) return {};
    try {
      const parsed = JSON.parse(readFileFn(filePath)) as Record<string, OwnershipProvenance>;
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  function write(records: Record<string, OwnershipProvenance>): void {
    try {
      writeFileFn(filePath, JSON.stringify(records, null, 2));
    } catch {
      /* best effort — a ledger that cannot be written cannot authorize a kill */
    }
  }

  return {
    filePath,
    read,
    get(pid) {
      const records = read();
      const entry = records[String(pid)];
      return entry ?? null;
    },
    record(provenance) {
      const records = read();
      records[String(provenance.pid)] = provenance;
      write(records);
      return provenance;
    },
    remove(pid) {
      const records = read();
      delete records[String(pid)];
      write(records);
    },
  };
}

/* ------------------------------------------------------------------ */
/* Identity provider                                                     */
/* ------------------------------------------------------------------ */

export type ProcessIdentityProvider = (pid: number) => Promise<ProcessIdentitySnapshot>;

/** A synchronous identity provider, for emergency paths that cannot await. */
export type SyncProcessIdentityProvider = (pid: number) => ProcessIdentitySnapshot;

const IDENTITY_QUERY_TIMEOUT_MS = 5_000;

/** The PowerShell query used by both providers. Read-only: one PID, no mutation. */
function identityQueryScript(pid: number): string {
  return [
    `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" -ErrorAction SilentlyContinue`,
    'if ($p) {',
    '  $created = $null',
    '  if ($p.CreationDate) { $created = $p.CreationDate.ToUniversalTime().ToString("o") }',
    '  $exe = $p.ExecutablePath',
    '  if (-not $exe) { try { $exe = (Get-Process -Id ' + pid + ' -ErrorAction Stop).Path } catch { $exe = $null } }',
    '  @{ pid = $p.ProcessId; exe = $exe; cmd = $p.CommandLine; created = $created } | ConvertTo-Json -Compress',
    '}',
  ].join('\n');
}

function parseIdentityOutput(pid: number, output: string): ProcessIdentitySnapshot {
  const trimmed = output.trim();
  if (!trimmed) {
    return { pid, alive: false, executablePath: null, creationTimeMs: null, commandLine: null };
  }
  let parsed: { pid?: number; exe?: string | null; cmd?: string | null; created?: string | null };
  try {
    parsed = JSON.parse(trimmed) as typeof parsed;
  } catch {
    return { pid, alive: false, executablePath: null, creationTimeMs: null, commandLine: null };
  }
  const creationTimeMs = parsed.created ? Date.parse(parsed.created) : NaN;
  return {
    pid: typeof parsed.pid === 'number' ? parsed.pid : pid,
    alive: true,
    executablePath: parsed.exe ? String(parsed.exe) : null,
    creationTimeMs: Number.isFinite(creationTimeMs) ? creationTimeMs : null,
    commandLine: parsed.cmd ? String(parsed.cmd) : null,
  };
}

/**
 * Synchronous identity read, for emergency paths that must act inside a
 * synchronous call (the SAFE_MODE kill switch).
 */
export function createWindowsProcessIdentityProviderSync(
  execFileSyncImpl: typeof execFileSync = execFileSync,
): SyncProcessIdentityProvider {
  return (pid: number): ProcessIdentitySnapshot => {
    if (!Number.isInteger(pid) || pid <= 0) {
      return { pid, alive: false, executablePath: null, creationTimeMs: null, commandLine: null };
    }
    if (process.platform !== 'win32') {
      try {
        process.kill(pid, 0);
        return { pid, alive: true, executablePath: process.execPath, creationTimeMs: Date.now(), commandLine: null };
      } catch {
        return { pid, alive: false, executablePath: null, creationTimeMs: null, commandLine: null };
      }
    }
    try {
      const out = execFileSyncImpl(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', identityQueryScript(pid)],
        { encoding: 'utf8', timeout: IDENTITY_QUERY_TIMEOUT_MS, windowsHide: true },
      );
      return parseIdentityOutput(pid, String(out ?? ''));
    } catch {
      return { pid, alive: false, executablePath: null, creationTimeMs: null, commandLine: null };
    }
  };
}

/**
 * Reads one process's identity from the OS. Read-only by construction: it
 * queries a single PID and never mutates anything.
 *
 * It deliberately does NOT go through `runPowerShellScript`, because that
 * helper refuses to run while SAFE_MODE is active — and SAFE_MODE is exactly
 * the mode that must be able to terminate its own tracked children. Reading a
 * PID's identity is not a mutation and grants no authority.
 */
export function createWindowsProcessIdentityProvider(
  spawnImpl: typeof spawn = spawn,
): ProcessIdentityProvider {
  return async (pid: number): Promise<ProcessIdentitySnapshot> => {
    if (!Number.isInteger(pid) || pid <= 0) {
      return { pid, alive: false, executablePath: null, creationTimeMs: null, commandLine: null };
    }
    if (process.platform !== 'win32') {
      try {
        process.kill(pid, 0);
        return { pid, alive: true, executablePath: process.execPath, creationTimeMs: Date.now(), commandLine: null };
      } catch {
        return { pid, alive: false, executablePath: null, creationTimeMs: null, commandLine: null };
      }
    }
    const output = await new Promise<string>((resolve) => {
      let out = '';
      let settled = false;
      const finish = (value: string) => { if (!settled) { settled = true; resolve(value); } };
      try {
        const child = spawnImpl('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', identityQueryScript(pid)], {
          windowsHide: true,
          env: createSanitizedChildEnvironment(),
        });
        const timer = setTimeout(() => {
          try { child.kill(); } catch { /* best effort */ }
          finish('');
        }, IDENTITY_QUERY_TIMEOUT_MS);
        timer.unref?.();
        child.stdout?.on('data', (chunk: Buffer) => { out += chunk.toString('utf8'); });
        child.stderr?.on('data', () => { /* ignore */ });
        child.on('error', () => { clearTimeout(timer); finish(''); });
        child.on('close', () => { clearTimeout(timer); finish(out); });
      } catch {
        finish('');
      }
    });
    return parseIdentityOutput(pid, output);
  };
}

/* ------------------------------------------------------------------ */
/* The boundary                                                          */
/* ------------------------------------------------------------------ */

export interface ProcessOwnershipBoundaryOptions {
  dataDir: string;
  /** The owner token every provenance record must carry. */
  ownerToken: string;
  identityProvider?: ProcessIdentityProvider;
  ledger?: ProcessOwnershipLedger;
  now?: () => number;
}

export interface TerminateRequest {
  pid: number;
  /** What the caller recorded about the target. */
  expectation?: Partial<OwnershipExpectation>;
  /** The actual kill. Only ever called after a verified ownership decision. */
  killFn?: (pid: number) => boolean;
  /** Roots the executable must live under. */
  allowedExecutableRoots?: string[];
}

export interface TerminateResult {
  terminated: boolean;
  reason: string;
  verdict: OwnershipVerdict;
}

export interface ProcessOwnershipBoundary {
  readonly ledger: ProcessOwnershipLedger;
  readonly ownerToken: string;
  /** Records that Pandesh started a process. Only trusted internal code may call this. */
  recordLaunch(input: {
    pid: number;
    creationTimeMs?: number | null;
    spawnedAtMs?: number | null;
    executablePath?: string | null;
    source: string;
  }): OwnershipProvenance;
  /** Verifies ownership without terminating anything. */
  verify(pid: number, expectation?: Partial<OwnershipExpectation>): Promise<OwnershipVerdict>;
  /**
   * The single force-termination entry point. It verifies first and refuses
   * closed; the kill function is never called for an unverified target.
   */
  terminate(request: TerminateRequest): Promise<TerminateResult>;
}

export function createProcessOwnershipBoundary(
  options: ProcessOwnershipBoundaryOptions,
): ProcessOwnershipBoundary {
  const now = options.now ?? Date.now;
  const ledger = options.ledger ?? createProcessOwnershipLedger({ dataDir: options.dataDir });
  const identityProvider = options.identityProvider ?? createWindowsProcessIdentityProvider();

  return {
    ledger,
    ownerToken: options.ownerToken,

    recordLaunch(input) {
      const provenance: OwnershipProvenance = {
        pid: input.pid,
        ownerToken: options.ownerToken,
        creationTimeMs: input.creationTimeMs ?? null,
        spawnedAtMs: input.spawnedAtMs ?? now(),
        executablePath: input.executablePath ?? null,
        recordedAt: new Date(now()).toISOString(),
        source: input.source,
      };
      return ledger.record(provenance);
    },

    async verify(pid, expectation) {
      const provenance = ledger.get(pid);
      const identity = await identityProvider(pid);
      return verifyProcessOwnership({
        expectation: {
          pid,
          creationTimeMs: expectation?.creationTimeMs ?? null,
          executablePath: expectation?.executablePath ?? null,
          allowedExecutableRoots: expectation?.allowedExecutableRoots,
        },
        identity,
        provenance,
        currentOwnerToken: options.ownerToken,
      });
    },

    async terminate(request) {
      const provenance = ledger.get(request.pid);
      const identity = await identityProvider(request.pid);
      const verdict = verifyProcessOwnership({
        expectation: {
          pid: request.pid,
          creationTimeMs: request.expectation?.creationTimeMs ?? null,
          executablePath: request.expectation?.executablePath ?? null,
          allowedExecutableRoots: request.allowedExecutableRoots ?? request.expectation?.allowedExecutableRoots,
        },
        identity,
        provenance,
        currentOwnerToken: options.ownerToken,
      });
      if (!verdict.verified) {
        return { terminated: false, reason: verdict.reason, verdict };
      }
      const killFn = request.killFn ?? ((pid: number) => {
        try { process.kill(pid); return true; } catch { return false; }
      });
      const killed = killFn(request.pid);
      if (killed) ledger.remove(request.pid);
      return {
        terminated: killed,
        reason: killed ? `terminated owned process ${request.pid}` : `kill of owned process ${request.pid} failed`,
        verdict,
      };
    },
  };
}

/** A stable owner token for callers that need one but have no manager yet. */
export function createOwnerToken(): string {
  return crypto.randomUUID();
}
