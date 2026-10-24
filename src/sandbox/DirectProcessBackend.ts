import { spawn } from 'child_process';
import { createSanitizedChildEnvironment } from '../../core/security/childEnvironment';
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

      const stop = () => {
        if (!child.killed) {
          child.kill();
        }
      };
      const timeout = setTimeout(stop, plan.limits.timeoutMs);
      const onAbort = () => stop();
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
          reject(error);
          return;
        }
        resolve({
          exitCode: code ?? -1,
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
        });
      });
    });
  }
}
