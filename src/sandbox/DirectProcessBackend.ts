import { spawn } from 'child_process';
import { createSanitizedChildEnvironment } from '../../core/security/childEnvironment';
import { createProcessTreeTracker, terminateProcessTree } from '../../core/runtime/processTree';
import { SandboxBackend, SandboxPlan } from './SandboxRunner';

const INHERITED_ENV_KEYS = [
  'PATH', 'Path', 'HOME', 'USERPROFILE', 'TEMP', 'TMP', 'SystemRoot', 'COMSPEC',
] as const;

function safeEnvironment(overrides: Record<string, string>): NodeJS.ProcessEnv {
  return createSanitizedChildEnvironment(process.env, overrides);
}

function appendBounded(chunks: Buffer[], chunk: Buffer, state: { bytes: number }, limit: number): void {
  if (state.bytes >= limit) {
    return;
  }
  const remaining = limit - state.bytes;
  const accepted = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
  chunks.push(accepted);
  state.bytes += accepted.length;
}

export class DirectProcessBackend implements SandboxBackend {
  execute(plan: Readonly<SandboxPlan>, signal: AbortSignal): Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
  }> {
    return new Promise((resolve, reject) => {
      const child = spawn(plan.executable, [...plan.args], {
        cwd: plan.cwd,
        env: safeEnvironment(plan.environment),
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      const stdoutState = { bytes: 0 };
      const stderrState = { bytes: 0 };
      let settled = false;

      // The sandboxed process is only the root of the owned tree; a command
      // it launches is a descendant and must die with it. The stop is
      // verified before the cancellation is reported.
      const tree = child.pid ? createProcessTreeTracker(child.pid) : undefined;
      let killPromise: Promise<void> | undefined;
      const stop = (): Promise<void> => {
        if (killPromise) return killPromise;
        killPromise = (async () => {
          if (!child.pid) return;
          if (tree) { await tree.terminate(); return; }
          await terminateProcessTree(child.pid);
        })();
        return killPromise;
      };
      const timeout = setTimeout(() => { void stop(); }, plan.limits.timeoutMs);
      const onAbort = () => { void stop(); };
      signal.addEventListener('abort', onAbort, { once: true });

      child.stdout.on('data', chunk => {
        appendBounded(stdout, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk), stdoutState, plan.limits.maxOutputBytes);
      });
      child.stderr.on('data', chunk => {
        appendBounded(stderr, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk), stderrState, plan.limits.maxOutputBytes);
      });
      child.once('error', error => {
        if (settled) { return; }
        settled = true;
        clearTimeout(timeout);
        signal.removeEventListener('abort', onAbort);
        reject(error);
      });
      child.once('close', code => {
        if (settled) { return; }
        settled = true;
        clearTimeout(timeout);
        signal.removeEventListener('abort', onAbort);
        if (signal.aborted) {
          const error = new Error('Sandbox execution cancelled.');
          error.name = 'AbortError';
          // The cancellation is only reported once the owned tree has been
          // terminated and verified, so "cancelled" never means "the children
          // are still running".
          void (killPromise ?? Promise.resolve()).then(() => reject(error));
          return;
        }
        resolve({
          exitCode: code ?? -1,
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
        });
      });    });
  }
}
