import { isProcessAlive } from './processLiveness';
import { getProcessStartTimeIso } from './processStartTime';

export const HEARTBEAT_INTERVAL_MS = 5000;
// A live, provably-same process is only presumed hung after this long. Core runs synchronous child processes
// (story acceptance checks, up to 60s each) that block the event loop and starve the 5s heartbeat; a 15s threshold
// let a second Core take over a busy-but-healthy one on the same data directory.
export const STALE_THRESHOLD_MS = 5 * 60_000;

export interface StalenessCheckInput {
  pid: number;
  processStartedAtIso: string | null;
  heartbeatAt: string;
}

export interface StalenessResult {
  stale: boolean;
  reason: string | null;
}

/**
 * A recorded owner is stale if: the PID is no longer alive, OR its recorded
 * start time provably mismatches the live process's actual start time (PID
 * reuse), OR its heartbeat has aged past STALE_THRESHOLD_MS (a healthy Core
 * always heartbeats every HEARTBEAT_INTERVAL_MS, so an aged heartbeat means
 * it crashed or hung without cleaning up). An undeterminable start time
 * (platform/tooling limitation) is never itself treated as a mismatch.
 */
export function checkStaleness(
  input: StalenessCheckInput,
  deps: { isProcessAlive: typeof isProcessAlive; getProcessStartTimeIso: typeof getProcessStartTimeIso; now: () => Date } = {
    isProcessAlive,
    getProcessStartTimeIso,
    now: () => new Date(),
  },
): StalenessResult {
  if (!deps.isProcessAlive(input.pid)) {
    return { stale: true, reason: `pid ${input.pid} is not running` };
  }

  if (input.processStartedAtIso) {
    const actualStartTime = deps.getProcessStartTimeIso(input.pid);
    if (actualStartTime && actualStartTime !== input.processStartedAtIso) {
      return { stale: true, reason: `pid ${input.pid} start time mismatch (likely PID reuse)` };
    }
  }

  const heartbeatAgeMs = deps.now().getTime() - new Date(input.heartbeatAt).getTime();
  if (heartbeatAgeMs > STALE_THRESHOLD_MS) {
    return { stale: true, reason: `heartbeat is ${heartbeatAgeMs}ms old, exceeds ${STALE_THRESHOLD_MS}ms threshold` };
  }

  return { stale: false, reason: null };
}
