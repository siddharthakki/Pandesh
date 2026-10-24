/**
 * P0 — Automatic Port & Process Manager (Pandesh).
 *
 * Owns Pandesh-managed service endpoints, process ownership and safe cleanup.
 * Pure-ish: all OS-touching operations are injected so the module is testable
 * and never kills an unknown process. Nothing here ever frees a port by
 * terminating a process Pandesh cannot prove it owns.
 *
 * Ownership is NOT the stored `ownedByPandesh` flag. That flag only records
 * what a caller claimed; it is not evidence. Every termination goes through
 * the shared ownership-verification boundary
 * (`core/runtime/processOwnership.ts`), which proves the live process is the
 * one Pandesh started (provenance + creation time + executable path) before
 * anything is killed. Missing identity information is a refusal.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import {
  createProcessOwnershipBoundary,
  type ProcessIdentityProvider,
  type ProcessOwnershipBoundary,
} from './processOwnership';

export type ServiceStatus = 'starting' | 'healthy' | 'stalled' | 'stopped' | 'unknown';

export interface ManagedServiceRecord {
  name: string;
  port: number;
  pid: number | null;
  processStartMs: number | null;
  ownedByPandesh: boolean;
  ownershipToken: string;
  executable: string | null;
  healthUrl: string | null;
  status: ServiceStatus;
  startedAt: string;
  lastHeartbeat: string | null;
  lastError: string | null;
}

export interface PortAllocation {
  port: number;
}

export interface ProcessInfo {
  pid: number;
  alive: boolean;
  startMs: number | null;
  commandLine: string | null;
  /** Absolute executable path when the OS discloses it. */
  executablePath?: string | null;
}

export interface PortProcessManagerOptions {
  dataDir: string;
  now?: () => number;
  allocatePortFn?: () => Promise<number>;
  isAliveFn?: (pid: number) => boolean;
  getProcessInfoFn?: (pid: number) => ProcessInfo;
  killFn?: (pid: number) => boolean;
  readFileFn?: (filePath: string) => string;
  writeFileFn?: (filePath: string, content: string) => void;
  existsFn?: (filePath: string) => boolean;
  fetchFn?: (url: string) => Promise<{ ok: boolean; status: number }>;
  /** The shared ownership-verification boundary. Injected in tests. */
  ownershipBoundary?: ProcessOwnershipBoundary;
  /** Read-only process identity lookups used by the ownership boundary. */
  identityProvider?: ProcessIdentityProvider;
}

export interface CleanupResult {
  removed: string[];
  killed: string[];
  kept: string[];
  errors: string[];
  /** Records that were refused because ownership could not be proven. */
  refused: string[];
}

export interface PortProcessManager {
  readonly dataDir: string;
  readonly ownershipToken: string;
  ownershipEnv(): Record<string, string>;
  allocatePort(): Promise<number>;
  isPortAvailable(port: number): Promise<boolean>;
  register(service: {
    name: string;
    port: number;
    pid: number | null;
    ownedByPandesh?: boolean;
    executable?: string | null;
    healthUrl?: string | null;
    processStartMs?: number | null;
  }): ManagedServiceRecord;
  unregister(name: string): boolean;
  get(name: string): ManagedServiceRecord | undefined;
  list(): ManagedServiceRecord[];
  healthCheck(name: string): Promise<{ healthy: boolean; reason?: string }>;
  /**
   * Records that Pandesh itself started a process. Only trusted internal
   * code may call this — a model-reachable registration must never be able
   * to manufacture ownership provenance.
   */
  recordOwnership(input: {
    pid: number;
    creationTimeMs?: number | null;
    spawnedAtMs?: number | null;
    executablePath?: string | null;
    source: string;
  }): void;
  stopOwned(name: string): Promise<{ stopped: boolean; reason?: string }>;
  cleanupOrphans(options?: { killOrphans?: boolean }): Promise<CleanupResult>;
  reconcile(): { reused: string[]; stale: string[] };
  ownershipProofMatches(record: ManagedServiceRecord, info: ProcessInfo): boolean;
}

const REGISTRY_FILE = 'port-manager-registry.json';
const TOKEN_FILE = 'port-manager.token';

/**
 * Verdicts that mean the registry record can never be acted on again: the
 * target is gone, the PID now belongs to a different program, or the record
 * was never ours. A transient identity failure is NOT in this set — the
 * record is kept so a later, successful verification can still act on it.
 */
const STALE_VERDICT_CODES = new Set([
  'not_alive',
  'pid_reused',
  'executable_mismatch',
  'provenance_missing',
  'provenance_mismatch',
]);

function defaultNow(): number { return Date.now(); }

function defaultIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function defaultGetProcessInfo(pid: number): ProcessInfo {
  return { pid, alive: defaultIsAlive(pid), startMs: null, commandLine: null };
}

function defaultKill(pid: number): boolean {
  try { process.kill(pid); return true; } catch { return false; }
}

async function defaultAllocatePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => {
        if (port > 0) resolve(port);
        else reject(new Error('port allocation returned 0'));
      });
    });
    srv.on('error', reject);
  });
}

async function defaultIsPortAvailable(port: number): Promise<boolean> {
  // Try to bind exclusively; close immediately. This is a best-effort check
  // used only for diagnostics, never as the allocation mechanism.
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => {
      srv.close(() => resolve(true));
    });
  });
}

function readJsonSafe<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

export function createPortProcessManager(options: PortProcessManagerOptions): PortProcessManager {
  const dataDir = options.dataDir;
  const now = options.now ?? defaultNow;
  const allocatePortFn = options.allocatePortFn ?? defaultAllocatePort;
  const isAliveFn = options.isAliveFn ?? defaultIsAlive;
  const getProcessInfoFn = options.getProcessInfoFn ?? defaultGetProcessInfo;
  const killFn = options.killFn ?? defaultKill;
  const readFileFn = options.readFileFn ?? ((p: string) => fs.readFileSync(p, 'utf8'));
  const writeFileFn = options.writeFileFn ?? ((p: string, c: string) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, c, 'utf8'); });
  const existsFn = options.existsFn ?? ((p: string) => fs.existsSync(p));
  const fetchFn = options.fetchFn ?? (async (url: string) => {
    const r = await fetch(url);
    return { ok: r.ok, status: r.status };
  });

  const registryPath = path.join(dataDir, REGISTRY_FILE);
  const tokenPath = path.join(dataDir, TOKEN_FILE);

  // Ownership token: a secret shared with child processes Pandesh spawns. A
  // process is "owned" only if its recorded token matches AND its start time
  // matches the recorded start time (guards against PID reuse).
  let ownershipToken = '';
  if (existsFn(tokenPath)) {
    try { ownershipToken = readFileFn(tokenPath).trim(); } catch { ownershipToken = ''; }
  }
  if (!ownershipToken) {
    ownershipToken = crypto.randomUUID();
    try { writeFileFn(tokenPath, ownershipToken); } catch { /* best effort */ }
  }

  // The shared ownership-verification boundary. It owns the durable provenance
  // ledger and is the ONLY thing allowed to authorize a termination.
  const ownershipBoundary = options.ownershipBoundary
    ?? createProcessOwnershipBoundary({
      dataDir,
      ownerToken: ownershipToken,
      ...(options.identityProvider ? { identityProvider: options.identityProvider } : {}),
    });

  function loadRegistry(): ManagedServiceRecord[] {
    if (!existsFn(registryPath)) return [];
    try {
      const parsed = readJsonSafe<ManagedServiceRecord[]>(readFileFn(registryPath), []);
      return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
  }

  function saveRegistry(records: ManagedServiceRecord[]): void {
    try { writeFileFn(registryPath, JSON.stringify(records, null, 2)); } catch { /* best effort */ }
  }

  let records: ManagedServiceRecord[] = loadRegistry();

  /**
   * Re-reads the registry from disk.
   *
   * The registry file is the shared truth between the Core process (which
   * registers itself and its children) and any other holder of this manager
   * (the governed capability the model reaches). Without this refresh, a
   * manager constructed BEFORE a service was registered keeps its empty
   * in-memory snapshot forever, and the model is told "no managed services"
   * while the Core is plainly running one. Every read therefore refreshes
   * first; every write saves the whole list back.
   */
  function refresh(): void {
    records = loadRegistry();
  }

  function findIndex(name: string): number {
    return records.findIndex((r) => r.name === name);
  }

  const manager: PortProcessManager = {
    dataDir,
    ownershipToken,
    ownershipEnv() {
      return { KARKEDIKHA_MANAGED_SERVICE_TOKEN: ownershipToken };
    },
    async allocatePort() {
      return allocatePortFn();
    },
    async isPortAvailable(port: number) {
      if (port <= 0 || port > 65535) return false;
      return defaultIsPortAvailable(port).then((v) => v).catch(() => false);
    },
    register(service) {
      refresh();
      const nowIso = new Date(now()).toISOString();
      const owned = service.ownedByPandesh ?? (service.pid !== null);
      const startMs = service.processStartMs ?? (service.pid !== null ? (getProcessInfoFn(service.pid).startMs ?? null) : null);
      const record: ManagedServiceRecord = {
        name: service.name,
        port: service.port,
        pid: service.pid,
        processStartMs: startMs,
        ownedByPandesh: owned,
        ownershipToken,
        executable: service.executable ?? null,
        healthUrl: service.healthUrl ?? null,
        status: 'starting',
        startedAt: nowIso,
        lastHeartbeat: null,
        lastError: null,
      };
      const idx = findIndex(service.name);
      if (idx >= 0) records[idx] = record;
      else records.push(record);
      saveRegistry(records);
      return record;
    },
    unregister(name: string) {
      refresh();
      const idx = findIndex(name);
      if (idx < 0) return false;
      records.splice(idx, 1);
      saveRegistry(records);
      return true;
    },
    get(name: string) {
      refresh();
      return records.find((r) => r.name === name);
    },
    list() {
      refresh();
      return records.map((r) => ({ ...r }));
    },
    async healthCheck(name: string) {
      refresh();
      const rec = records.find((r) => r.name === name);
      if (!rec) return { healthy: false, reason: 'service not registered' };
      // Process liveness (only meaningful for owned/known PIDs).
      if (rec.pid !== null) {
        const info = getProcessInfoFn(rec.pid);
        if (!info.alive) {
          rec.status = 'stopped';
          rec.lastError = 'process not alive';
          saveRegistry(records);
          return { healthy: false, reason: 'process not alive' };
        }
        if (rec.processStartMs !== null && info.startMs !== null && info.startMs !== rec.processStartMs) {
          rec.status = 'stopped';
          rec.lastError = 'PID reused by a different process';
          saveRegistry(records);
          return { healthy: false, reason: 'PID reused by a different process' };
        }
      }
      // Optional HTTP health probe.
      if (rec.healthUrl) {
        try {
          const r = await fetchFn(rec.healthUrl);
          if (r.ok) {
            rec.status = 'healthy';
            rec.lastHeartbeat = new Date(now()).toISOString();
            rec.lastError = null;
            saveRegistry(records);
            return { healthy: true };
          }
          rec.status = 'stalled';
          rec.lastError = `health endpoint returned ${r.status}`;
          saveRegistry(records);
          return { healthy: false, reason: `health endpoint returned ${r.status}` };
        } catch (err) {
          rec.status = 'stalled';
          rec.lastError = err instanceof Error ? err.message : String(err);
          saveRegistry(records);
          return { healthy: false, reason: rec.lastError };
        }
      }
      // No health URL: treat alive process (or no PID) as healthy.
      rec.status = 'healthy';
      rec.lastHeartbeat = new Date(now()).toISOString();
      saveRegistry(records);
      return { healthy: true };
    },
    recordOwnership(input) {
      ownershipBoundary.recordLaunch({
        pid: input.pid,
        creationTimeMs: input.creationTimeMs ?? null,
        spawnedAtMs: input.spawnedAtMs ?? null,
        executablePath: input.executablePath ?? null,
        source: input.source,
      });
    },
    async stopOwned(name: string) {
      refresh();
      const rec = records.find((r) => r.name === name);
      if (!rec) return { stopped: false, reason: 'service not registered' };
      if (!rec.ownedByPandesh) return { stopped: false, reason: 'service is not owned by Pandesh' };
      if (rec.pid === null) return { stopped: false, reason: 'no PID recorded' };
      // The ownership boundary verifies provenance, creation time and
      // executable path before anything is killed. A stored flag is not
      // evidence and a recycled PID is refused.
      const result = await ownershipBoundary.terminate({
        pid: rec.pid,
        expectation: {
          creationTimeMs: rec.processStartMs,
          executablePath: rec.executable,
        },
        killFn,
      });
      if (result.terminated) {
        records = records.filter((r) => r.name !== name);
        saveRegistry(records);
        return { stopped: true };
      }
      // A record whose target is gone, reused, or never ours is stale: drop
      // it so it can never be acted on again. A transient identity failure
      // keeps the record, because the target may still be ours.
      if (STALE_VERDICT_CODES.has(result.verdict.code)) {
        records = records.filter((r) => r.name !== name);
        saveRegistry(records);
      }
      return { stopped: false, reason: result.reason };
    },
    async cleanupOrphans(options) {
      refresh();
      const killOrphans = options?.killOrphans === true;
      const result: CleanupResult = { removed: [], killed: [], kept: [], errors: [], refused: [] };
      const survivors: ManagedServiceRecord[] = [];
      for (const rec of records) {
        if (!rec.ownedByPandesh || rec.pid === null) {
          survivors.push(rec);
          result.kept.push(rec.name);
          continue;
        }
        const info = getProcessInfoFn(rec.pid);
        const pidAlive = info.alive;
        const startMismatch = rec.processStartMs !== null && info.startMs !== null && info.startMs !== rec.processStartMs;
        if (!pidAlive) {
          result.removed.push(rec.name);
          continue;
        }
        if (startMismatch) {
          result.removed.push(rec.name);
          continue;
        }
        // Live, same-start process. It is only killed when its ownership is
        // proven; a live process we cannot prove we own is kept and reported.
        if (killOrphans) {
          const termination = await ownershipBoundary.terminate({
            pid: rec.pid,
            expectation: {
              creationTimeMs: rec.processStartMs,
              executablePath: rec.executable,
            },
            killFn,
          });
          if (termination.terminated) {
            result.killed.push(rec.name);
            continue;
          }
          result.refused.push(rec.name);
          result.errors.push(`refused to kill ${rec.name} (pid ${rec.pid}): ${termination.reason}`);
          survivors.push(rec);
          continue;
        }
        survivors.push(rec);
        result.kept.push(rec.name);
      }
      records = survivors;
      saveRegistry(records);
      return result;
    },
    reconcile() {
      refresh();
      const reused: string[] = [];
      const stale: string[] = [];
      const survivors: ManagedServiceRecord[] = [];
      for (const rec of records) {
        if (rec.pid === null) { survivors.push(rec); reused.push(rec.name); continue; }
        const info = getProcessInfoFn(rec.pid);
        if (!info.alive) { stale.push(rec.name); continue; }
        if (rec.processStartMs !== null && info.startMs !== null && info.startMs !== rec.processStartMs) { stale.push(rec.name); continue; }
        survivors.push(rec);
        reused.push(rec.name);
      }
      records = survivors;
      saveRegistry(records);
      return { reused, stale };
    },
    ownershipProofMatches(record, info) {
      if (!info.alive) return false;
      if (record.processStartMs !== null && info.startMs !== null && info.startMs !== record.processStartMs) return false;
      if (record.executable && info.executablePath) {
        const normalize = (value: string) => value.trim().replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
        if (normalize(record.executable) !== normalize(info.executablePath)) return false;
      }
      return true;
    },
  };

  // Best-effort reconcile on construction.
  try { manager.reconcile(); } catch { /* ignore */ }

  return manager;
}
