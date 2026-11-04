/**
 * Verified process-tree termination (M-benchmark P1).
 *
 * WHY THIS EXISTS
 * ---------------
 * The benchmark harness stopped a task and found that the descendant
 * processes it had started were still alive afterwards:
 *
 *   - `src/services/CommandService.ts` killed only `cmd.exe`, so every
 *     `node.exe` / `npm` / `vitest` grandchild survived as an orphan;
 *   - `src/validation/BaseValidationRunner.ts` spawned with `shell: true`
 *     and killed only the shell;
 *   - `core/runtime/toolRunner.ts` used `taskkill /t /f`, which is the right
 *     primitive, but it was unbounded (a hung `taskkill` hangs the caller)
 *     and its result was ASSUMED: the code reported the command as stopped
 *     without ever checking that the processes were gone.
 *
 * This module is the single mechanism every "stop the work" path uses:
 *
 *   1. it enumerates the OWNED tree (the root process plus everything the
 *      OS reports as its descendant) before touching anything;
 *   2. it terminates the tree with the platform's tree primitive;
 *   3. it VERIFIES termination by re-checking liveness, and reports the
 *      PIDs that survived instead of pretending the stop succeeded.
 *
 * SCOPE — unrelated processes are preserved
 * -----------------------------------------
 * Only PIDs that are (a) the root this caller spawned and (b) descendants of
 * that root according to the OS parent/child relation are ever signalled.
 * A process that merely shares a name, a PID, or a command line is never
 * touched. The root PID is owned by construction here: every caller passes
 * the PID of a `ChildProcess` it started itself.
 *
 * RELATIONSHIP TO `processOwnership.ts`
 * ------------------------------------
 * `core/runtime/processOwnership.ts` decides WHETHER a PID may be killed
 * (ownership provenance, PID-reuse refusal). This module decides HOW a
 * permitted tree is killed and whether it actually died. A caller that
 * holds a PID it did not spawn must go through the ownership boundary
 * first; callers that spawned the process themselves own it by construction.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createSanitizedChildEnvironment } from '../security/childEnvironment';

/** One live process as the OS reports it. */
export interface ProcessEntry {
  pid: number;
  /** The parent PID the OS reports. 0 (or a missing value) means "no parent". */
  parentPid: number;
}

/** The owned tree, captured at one moment. */
export interface ProcessTreeSnapshot {
  rootPid: number;
  /** Every descendant of the root, excluding the root itself. */
  descendants: number[];
  capturedAtMs: number;
}

/** The outcome of one termination attempt, always verified. */
export interface ProcessTreeTerminationResult {
  /**
   * True only when the root AND every captured descendant are confirmed
   * dead. A `taskkill` that exited 0 is NOT enough: the result is decided
   * by re-reading liveness.
   */
  terminated: boolean;
  /** PIDs that were still alive when verification finished. */
  survivors: number[];
  /** PIDs that were alive before the attempt and are dead now. */
  killed: number[];
  /** Human-readable summary of what happened. */
  reason: string;
}

/** Injection points, so the decision logic is testable without touching the OS. */
export interface ProcessTreeDeps {
  /** Lists every live process with its parent PID. */
  listProcesses?: () => Promise<ProcessEntry[]>;
  /** Terminates a PID and, where the platform supports it, its descendants. */
  killTree?: (pid: number) => Promise<void>;
  /** True when the PID is alive. */
  isAlive?: (pid: number) => boolean;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const DEFAULT_KILL_TIMEOUT_MS = 5_000;
const DEFAULT_VERIFY_TIMEOUT_MS = 3_000;
const DEFAULT_POLL_INTERVAL_MS = 50;

/* ------------------------------------------------------------------ */
/* Platform primitives                                                  */
/* ------------------------------------------------------------------ */

export function defaultIsProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Enumerates every live process with its parent PID.
 *
 * Windows: one PowerShell/CIM query. The script prints `<pid> <ppid>` lines
 * so the parse is trivial and cannot be confused by a localised property
 * name.
 *
 * POSIX: `ps -A -o pid=,ppid=`.
 */
export function listLiveProcesses(): Promise<ProcessEntry[]> {
  if (process.platform !== 'win32') {
    return new Promise((resolve) => {
      try {
        const out = spawnSync('ps', ['-A', '-o', 'pid=,ppid='], {
          encoding: 'utf8',
          timeout: DEFAULT_KILL_TIMEOUT_MS,
          windowsHide: true,
        });
        resolve(parsePsOutput(String(out?.stdout ?? '')));
      } catch {
        resolve([]);
      }
    });
  }
  return new Promise((resolve) => {
    const script = [
      'Get-CimInstance Win32_Process -ErrorAction SilentlyContinue',
      '  | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }',
    ].join(' ');
    let out = '';
    let settled = false;
    const finish = (value: ProcessEntry[]) => { if (!settled) { settled = true; resolve(value); } };
    try {
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        windowsHide: true,
        env: createSanitizedChildEnvironment(),
      });
      const timer = setTimeout(() => {
        try { child.kill(); } catch { /* best effort */ }
        finish(parsePsOutput(out));
      }, DEFAULT_KILL_TIMEOUT_MS);
      timer.unref?.();
      child.stdout?.on('data', (chunk: Buffer) => { out += chunk.toString('utf8'); });
      child.stderr?.on('data', () => { /* ignored */ });
      child.on('error', () => { clearTimeout(timer); finish(parsePsOutput(out)); });
      child.on('close', () => { clearTimeout(timer); finish(parsePsOutput(out)); });
    } catch {
      finish([]);
    }
  });
}

function parsePsOutput(output: string): ProcessEntry[] {
  const entries: ProcessEntry[] = [];
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = /^(\d+)\s+(\d+)$/.exec(trimmed);
    if (!match) continue;
    const pid = Number(match[1]);
    const parentPid = Number(match[2]);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    entries.push({ pid, parentPid: Number.isInteger(parentPid) && parentPid > 0 ? parentPid : 0 });
  }
  return entries;
}

/**
 * Terminates a PID together with its descendants.
 *
 * Windows: `taskkill /pid <pid> /t /f`. The call is BOUNDED — `taskkill`
 * can hang under a restricted token, and a hang here would hang the very
 * stop button the user pressed.
 *
 * POSIX: the negative-PID group signal (the caller spawns detached, so the
 * child leads its own process group), falling back to the single PID.
 */
export function defaultKillTree(pid: number): Promise<void> {
  if (process.platform !== 'win32') {
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => { if (!settled) { settled = true; resolve(); } };
      try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
      finish();
    });
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => { if (!settled) { settled = true; resolve(); } };
    try {
      const killer = spawnSync('taskkill', ['/pid', String(pid), '/t', '/f'], {
        windowsHide: true,
        timeout: DEFAULT_KILL_TIMEOUT_MS,
        stdio: 'ignore',
      });
      if (killer.error) {
        // taskkill could not even start: fall back to the single process so
        // the root at least dies, and let verification report the rest.
        try { process.kill(pid); } catch { /* already gone */ }
      }
    } catch {
      try { process.kill(pid); } catch { /* already gone */ }
    }
    finish();
  });
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/* ------------------------------------------------------------------ */
/* Tree discovery                                                       */
/* ------------------------------------------------------------------ */

/** The descendants of `rootPid` in the given process table, breadth first. */
export function descendantsOf(rootPid: number, processes: readonly ProcessEntry[]): number[] {
  const children = new Map<number, number[]>();
  for (const entry of processes) {
    if (entry.parentPid <= 0) continue;
    const list = children.get(entry.parentPid);
    if (list) list.push(entry.pid);
    else children.set(entry.parentPid, [entry.pid]);
  }
  const out: number[] = [];
  const seen = new Set<number>([rootPid]);
  const queue: number[] = [rootPid];
  while (queue.length > 0) {
    const current = queue.shift() as number;
    for (const child of children.get(current) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      out.push(child);
      queue.push(child);
    }
  }
  return out;
}

/** Captures the owned tree rooted at `rootPid`. */
export async function captureProcessTree(
  rootPid: number,
  deps: ProcessTreeDeps = {},
): Promise<ProcessTreeSnapshot> {
  const listProcesses = deps.listProcesses ?? listLiveProcesses;
  const now = deps.now ?? Date.now;
  if (!Number.isInteger(rootPid) || rootPid <= 0) {
    return { rootPid, descendants: [], capturedAtMs: now() };
  }
  let processes: ProcessEntry[] = [];
  try {
    processes = await listProcesses();
  } catch {
    processes = [];
  }
  return { rootPid, descendants: descendantsOf(rootPid, processes), capturedAtMs: now() };
}

/* ------------------------------------------------------------------ */
/* Termination                                                          */
/* ------------------------------------------------------------------ */

export interface TerminateProcessTreeOptions extends ProcessTreeDeps {
  /** How long to wait for the tree to die before reporting survivors. */
  verifyTimeoutMs?: number;
  /** PIDs known to belong to this tree even if the OS no longer reports them as descendants. */
  knownDescendants?: readonly number[];
}

/**
 * Terminates the owned tree and VERIFIES that it died.
 *
 * The order matters:
 *   1. capture the tree (so verification knows what "the tree" was);
 *   2. kill the root with the platform tree primitive;
 *   3. kill any recorded descendant that is still alive (this is the case
 *      where the root already exited and its children were re-parented);
 *   4. poll until every recorded PID is dead or the verify timeout passes;
 *   5. report the survivors.
 *
 * `terminated` is true only when nothing survived.
 */
export async function terminateProcessTree(
  rootPid: number,
  options: TerminateProcessTreeOptions = {},
): Promise<ProcessTreeTerminationResult> {
  const isAlive = options.isAlive ?? defaultIsProcessAlive;
  const killTree = options.killTree ?? defaultKillTree;
  const sleep = options.sleep ?? defaultSleep;
  const verifyTimeoutMs = options.verifyTimeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS;
  const pollIntervalMs = DEFAULT_POLL_INTERVAL_MS;

  if (!Number.isInteger(rootPid) || rootPid <= 0) {
    return { terminated: true, survivors: [], killed: [], reason: 'no process to terminate' };
  }

  const snapshot = await captureProcessTree(rootPid, options);
  const owned = new Set<number>([rootPid, ...snapshot.descendants, ...(options.knownDescendants ?? [])]);
  const aliveBefore = [...owned].filter((pid) => isAlive(pid));

  // The root is always signalled: it is the PID of a process this caller
  // spawned itself, so attempting the kill is safe even when the process has
  // already exited (a stale PID would only ever be a recycled one, and the
  // OS reports that as "not found" rather than killing the new owner).
  try { await killTree(rootPid); } catch { /* verified below */ }

  // Any recorded descendant that survived (the root had already exited, so
  // its children were re-parented and the tree primitive could not reach
  // them) is terminated on its own.
  for (const pid of aliveBefore) {
    if (pid === rootPid) continue;
    if (!isAlive(pid)) continue;
    try { await killTree(pid); } catch { /* verified below */ }
  }

  // 3. Verify. A successful kill call is not evidence; liveness is.
  const deadline = Date.now() + verifyTimeoutMs;
  let survivors = aliveBefore.filter((pid) => isAlive(pid));
  while (survivors.length > 0 && Date.now() < deadline) {
    await sleep(pollIntervalMs);
    survivors = survivors.filter((pid) => isAlive(pid));
  }

  // 4. One last escalation for anything that outlived the first attempt.
  if (survivors.length > 0) {
    for (const pid of survivors) {
      try { await killTree(pid); } catch { /* verified below */ }
    }
    const finalDeadline = Date.now() + Math.min(verifyTimeoutMs, 1_500);
    while (survivors.length > 0 && Date.now() < finalDeadline) {
      await sleep(pollIntervalMs);
      survivors = survivors.filter((pid) => isAlive(pid));
    }
  }

  const killed = aliveBefore.filter((pid) => !survivors.includes(pid));
  return {
    terminated: survivors.length === 0,
    survivors,
    killed,
    reason: survivors.length === 0
      ? (killed.length > 0
        ? `terminated the owned process tree (${killed.length} process(es) confirmed dead)`
        : 'the owned process tree was already gone')
      : `${survivors.length} owned process(es) survived the termination attempt: ${survivors.join(', ')}`,
  };
}

/* ------------------------------------------------------------------ */
/* Tracker                                                              */
/* ------------------------------------------------------------------ */

/**
 * Tracks one owned process tree over its lifetime.
 *
 * The tracker exists for the case the OS makes awkward: a root that exits
 * on its own leaves its children orphaned, and at that point the OS no
 * longer reports them as descendants of anything. Recording the descendant
 * set while the root was alive is the only way to still know — and therefore
 * still be able to terminate — those processes later.
 */
export interface ProcessTreeTracker {
  readonly rootPid: number;
  /** PIDs currently believed to belong to this tree. */
  ownedPids(): number[];
  /** Refreshes the recorded descendant set. */
  refresh(): Promise<ProcessTreeSnapshot>;
  /** Terminates the tree and verifies it died. */
  terminate(): Promise<ProcessTreeTerminationResult>;
  /** Releases the tracker without terminating anything. */
  dispose(): void;
}

export interface ProcessTreeTrackerOptions extends ProcessTreeDeps {
  /** How often the descendant set is refreshed while the root is alive. */
  refreshIntervalMs?: number;
  /** The first refresh is delayed so a very short command costs no extra query. */
  initialDelayMs?: number;
}

export function createProcessTreeTracker(
  rootPid: number,
  options: ProcessTreeTrackerOptions = {},
): ProcessTreeTracker {
  const isAlive = options.isAlive ?? defaultIsProcessAlive;
  const refreshIntervalMs = options.refreshIntervalMs ?? 10_000;
  const initialDelayMs = options.initialDelayMs ?? 1_500;

  let recorded = new Set<number>();
  let timer: NodeJS.Timeout | undefined;
  let disposed = false;

  const refresh = async (): Promise<ProcessTreeSnapshot> => {
    const snapshot = await captureProcessTree(rootPid, options);
    for (const pid of snapshot.descendants) recorded.add(pid);
    return snapshot;
  };

  const schedule = () => {
    if (disposed || refreshIntervalMs <= 0) return;
    timer = setTimeout(async () => {
      timer = undefined;
      if (disposed) return;
      // The refresh is only useful while the root can still tell us who its
      // children are.
      if (isAlive(rootPid)) {
        try { await refresh(); } catch { /* best effort */ }
        schedule();
      }
    }, refreshIntervalMs);
    timer.unref?.();
  };

  if (initialDelayMs > 0 && refreshIntervalMs > 0) {
    const kickoff = setTimeout(() => {
      if (disposed) return;
      if (isAlive(rootPid)) {
        void refresh().then(schedule).catch(() => schedule());
      }
    }, initialDelayMs);
    kickoff.unref?.();
  }

  return {
    rootPid,
    ownedPids: () => [rootPid, ...recorded],
    refresh,
    async terminate() {
      disposed = true;
      if (timer) { clearTimeout(timer); timer = undefined; }
      const known = [...recorded];
      const result = await terminateProcessTree(rootPid, { ...options, knownDescendants: known });
      recorded = new Set<number>();
      return result;
    },
    dispose() {
      disposed = true;
      if (timer) { clearTimeout(timer); timer = undefined; }
    },
  };
}

/**
 * A one-line summary of a termination result, safe to put in a tool result
 * or an event log.
 */
export function describeTermination(result: ProcessTreeTerminationResult): string {
  if (result.terminated) {
    return result.killed.length > 0
      ? `stopped: ${result.killed.length} owned process(es) terminated and verified dead`
      : 'stopped: nothing was running';
  }
  return `stop incomplete: ${result.reason}`;
}
