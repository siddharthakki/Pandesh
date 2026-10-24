import { spawn, spawnSync } from 'node:child_process';
import { LocalAutonomySecurityKernel } from '../security/kernel';
import { createSanitizedChildEnvironment } from '../security/childEnvironment';

const DEFAULT_MAX_OUTPUT_CHARS = 8_000;
const DEFAULT_TIMEOUT_MS = 20_000;

export interface ShellExecResult {
  succeeded: boolean;
  exitCode: number | null;
  output: string;
}

function bound(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n…[truncated]` : text;
}

/**
 * Runs a bounded PowerShell script, following the exact spawn/timeout/
 * kill-tree/abort pattern already used and tested for `run_command`
 * (`core/runtime/toolRunner.ts`'s `runCommand`) — a second, independent
 * implementation was deliberately avoided. Windows-only; callers own
 * deciding when that's appropriate. Injectable via `spawnImpl` for tests,
 * mirroring `desktopImageStudio.ts`'s `spawnImpl`/`fetchImpl` pattern.
 *
 * `maxOutputChars` defaults conservatively (matching `run_command`'s own
 * bound) but is overridable per call: a caller emitting structured JSON
 * meant to be parsed exactly (e.g. a process/service list) must raise it
 * enough that the JSON itself is never truncated mid-document — a silent
 * partial-JSON parse failure is worse than a larger bound.
 */
export function runPowerShellScript(
  script: string,
  options: { timeoutMs?: number; maxOutputChars?: number; signal?: AbortSignal; spawnImpl?: typeof spawn; spawnSyncImpl?: typeof spawnSync } = {},
): Promise<ShellExecResult> {
  const kernel = LocalAutonomySecurityKernel.getInstance();
  if (kernel.isSafeModeActive()) {
    return Promise.resolve({
      succeeded: false,
      exitCode: null,
      output: 'SecurityKernel violation: SAFE_MODE / EXECUTION_DISABLED is currently active.',
    });
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputChars = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
  const spawnFn = options.spawnImpl ?? spawn;
  const spawnSyncFn = options.spawnSyncImpl ?? spawnSync;
  return new Promise((resolve) => {
    const spawnedAtMs = Date.now();
    const child = spawnFn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      env: createSanitizedChildEnvironment(),
    });
    let unregisterProc: (() => void) | undefined;
    if (child.pid) {
      unregisterProc = kernel.getSafeModeManager().registerChildProcess(
        child.pid,
        () => killTree(),
        `powershell: ${script.slice(0, 100)}`,
        undefined,
        // Provenance: Pandesh started this child at this moment. The SAFE_MODE
        // kill switch verifies it before terminating anything, so a recycled
        // PID can never be mistaken for this child.
        { spawnedAtMs },
      );
    }
    let out = '';
    const append = (chunk: Buffer) => { if (out.length < maxOutputChars * 2) out += chunk.toString('utf8'); };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    let settled = false;
    let killedByAbort = false;
    const killTree = () => {
      if (!child.pid) return;
      try { spawnSyncFn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true }); } catch { /* best-effort */ }
    };
    const onAbort = () => { killedByAbort = true; killTree(); };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    const finish = (result: ShellExecResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (unregisterProc) { unregisterProc(); unregisterProc = undefined; }
      options.signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };
    const timer = setTimeout(() => {
      killTree();
      finish({ succeeded: false, exitCode: null, output: `${bound(out, maxOutputChars)}\n…[timed out after ${timeoutMs}ms]` });
    }, timeoutMs);
    timer.unref?.();
    if (options.signal?.aborted) onAbort();
    child.on('error', (err) => finish({ succeeded: false, exitCode: null, output: `${bound(out, maxOutputChars)}\n${err.message}` }));
    child.on('close', (code) => finish({
      succeeded: !killedByAbort && code === 0,
      exitCode: code,
      output: killedByAbort ? `${bound(out, maxOutputChars)}\n…[aborted]` : bound(out, maxOutputChars),
    }));
  });
}
