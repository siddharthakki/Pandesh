import { execFileSync } from 'node:child_process';

/**
 * Best-effort lookup of a process's start time, used as a secondary guard
 * against PID reuse (the primary staleness signal is the heartbeat
 * timestamp, which is far more reliable on the timescales involved here).
 * Returns null if the platform/tooling doesn't support the lookup or the
 * process no longer exists — callers must treat null as "cannot verify",
 * not as "mismatch".
 */
export function getProcessStartTimeIso(pid: number): string | null {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString("o")`],
        { encoding: 'utf8', timeout: 3000, windowsHide: true },
      ).trim();
      return out.length > 0 ? out : null;
    }
    if (process.platform === 'linux') {
      // /proc/<pid>/stat field 22 is starttime in clock ticks since boot; converting to a wall
      // clock time needs /proc/uptime too. Best-effort: use `stat` on /proc/<pid> as a coarse
      // proxy (creation time of the /proc entry approximates process start).
      const out = execFileSync('stat', ['-c', '%Y', `/proc/${pid}`], { encoding: 'utf8', timeout: 3000 }).trim();
      const epochSeconds = Number(out);
      if (!Number.isFinite(epochSeconds)) return null;
      return new Date(epochSeconds * 1000).toISOString();
    }
    return null;
  } catch {
    return null;
  }
}
