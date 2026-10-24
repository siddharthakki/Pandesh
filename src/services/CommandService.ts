import { spawn } from 'child_process';
import { createSanitizedChildEnvironment } from '../../core/security/childEnvironment';
import * as vscode from 'vscode';

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

export class CommandService {
  static async run(
    command: string,
    cwd: string,
    timeoutMs: number,
    signal?: any,
  ): Promise<CommandResult> {
    return new Promise((resolve) => {
      let timedOut = false;
      let settled = false;

      const proc = spawn('cmd', ['/c', command], {
        cwd,
        shell: false,
        windowsHide: true,
        env: createSanitizedChildEnvironment(),
      });

      let stdout = '';
      let stderr = '';

      proc.stdout?.on('data', (d: any) => { stdout += d.toString(); });
      proc.stderr?.on('data', (d: any) => { stderr += d.toString(); });

      const timer = setTimeout(() => {
        timedOut = true;
        proc.kill('SIGTERM');
      }, timeoutMs);

      const finish = (code: number) => {
        if (settled) { return; }
        settled = true;
        clearTimeout(timer);
        resolve({ stdout, stderr, exitCode: code, timedOut });
      };

      proc.on('close', (code) => finish(code ?? 1));
      proc.on('error', (err: any) => {
        stderr += err.message;
        finish(1);
      });

      signal?.addEventListener('abort', () => {
        proc.kill('SIGTERM');
        finish(1);
      });
    });
  }

  static async runGit(args: string[], cwd: string): Promise<CommandResult> {
    return new Promise((resolve) => {
      const proc = spawn('git', args, { cwd, shell: false, windowsHide: true });
      let stdout = '', stderr = '';
      proc.stdout?.on('data', (d: any) => { stdout += d.toString(); });
      proc.stderr?.on('data', (d: any) => { stderr += d.toString(); });
      proc.on('close', (code: number) => resolve({ stdout, stderr, exitCode: code ?? 1, timedOut: false }));
      proc.on('error', (err: any) => { stderr += err.message; resolve({ stdout, stderr, exitCode: 1, timedOut: false }); });
    });
  }
}
