/**
 * Best-effort liveness check for a recorded PID. `process.kill(pid, 0)` on
 * POSIX (and its emulation on Windows via libuv) throws ESRCH if no such
 * process exists, and does not actually send a signal.
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    // EPERM means the process exists but we can't signal it (still alive).
    if (code === 'EPERM') return true;
    return false;
  }
}
