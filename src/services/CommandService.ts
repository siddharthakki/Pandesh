import { spawn } from 'child_process';
import { createSanitizedChildEnvironment } from '../../core/security/childEnvironment';
import {
  createProcessTreeTracker,
  describeTermination,
  terminateProcessTree,
  type ProcessTreeTerminationResult,
} from '../../core/runtime/processTree';

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  /**
   * True when the command was stopped by a cancellation rather than by the
   * command itself exiting. The model must be able to tell "you stopped me"
   * apart from "the command failed".
   */
  cancelled: boolean;
  /**
   * The verified outcome of the tree termination, when one was attempted.
   * `terminated` is false when owned processes survived the stop — that is a
   * real, reportable fact and not an assumption.
   */
  termination?: ProcessTreeTerminationResult;
}

export class CommandService {
  /**
   * Runs a command line through the platform shell.
   *
   * Cancellation terminates the WHOLE owned process tree, not just the shell:
   * `cmd /c npm test` spawns `npm`, `cmd` and `node` as descendants, and
   * killing only `cmd.exe` left every one of them running after the user
   * pressed Stop (observed in the DeepSeek harness comparison). The
   * termination is then VERIFIED — the result reports the processes that
   * survived instead of assuming the stop worked.
   */
  static async run(
    command: string,
    cwd: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<CommandResult> {
    return new Promise((resolve) => {
      let timedOut = false;
      let cancelled = false;
      let settled = false;

      const proc = spawn('cmd', ['/c', command], {
        cwd,
        shell: false,
        windowsHide: true,
        env: createSanitizedChildEnvironment(),
        // Node's default Windows argv quoting escapes the quotes inside the
        // single command string, and cmd.exe does not understand that form:
        // a quoted path came back mangled (`"C:\my dir\file.js"` -> escaped
        // backslashes), so the command failed to run at all. The command is
        // already one approved shell program, so it is passed verbatim —
        // exactly as the Core tool runner does it.
        windowsVerbatimArguments: process.platform === 'win32',
      });

      const tree = proc.pid ? createProcessTreeTracker(proc.pid) : undefined;
      let termination: ProcessTreeTerminationResult | undefined;
      let killPromise: Promise<void> | undefined;
      const killTree = (): Promise<void> => {
        if (killPromise) return killPromise;
        killPromise = (async () => {
          if (!proc.pid) return;
          termination = tree
            ? await tree.terminate()
            : await terminateProcessTree(proc.pid);
        })();
        return killPromise;
      };

      let stdout = '';
      let stderr = '';

      proc.stdout?.on('data', (d: any) => { stdout += d.toString(); });
      proc.stderr?.on('data', (d: any) => { stderr += d.toString(); });

      const timer = setTimeout(() => {
        timedOut = true;
        void killTree();
      }, timeoutMs);

      const finish = (code: number) => {
        if (settled) { return; }
        settled = true;
        clearTimeout(timer);
        resolve({
          stdout,
          stderr,
          exitCode: code,
          timedOut,
          cancelled,
          ...(termination ? { termination } : {}),
        });
      };

      // The stop is reported only once the tree has been verified dead, so a
      // caller that sees `cancelled` knows the work really stopped.
      const finishAfterTermination = async (code: number) => {
        await killPromise;
        finish(code);
      };

      proc.on('close', (code) => {
        if (killPromise) { void finishAfterTermination(code ?? 1); return; }
        finish(code ?? 1);
      });
      proc.on('error', (err: any) => {
        stderr += err.message;
        finish(1);
      });

      const onAbort = () => {
        cancelled = true;
        void killTree();
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  }

  static async runGit(args: string[], cwd: string): Promise<CommandResult> {
    return new Promise((resolve) => {
      const proc = spawn('git', args, { cwd, shell: false, windowsHide: true });
      let stdout = '', stderr = '';
      proc.stdout?.on('data', (d: any) => { stdout += d.toString(); });
      proc.stderr?.on('data', (d: any) => { stderr += d.toString(); });
      proc.on('close', (code: number) => resolve({ stdout, stderr, exitCode: code ?? 1, timedOut: false, cancelled: false }));
      proc.on('error', (err: any) => { stderr += err.message; resolve({ stdout, stderr, exitCode: 1, timedOut: false, cancelled: false }); });
    });
  }
}

/** A one-line, model-facing description of a stop outcome. */
export function describeCommandStop(result: CommandResult): string {
  if (result.termination) return describeTermination(result.termination);
  if (result.cancelled) return 'stopped';
  if (result.timedOut) return 'timed out';
  return `exited with code ${result.exitCode}`;
}
