import { spawn } from 'child_process';
import { hardenedGitArgs, hardenedGitEnv } from '../../core/security/hardenedGit';

/** Runs git without a shell, keeps whatever output arrived if the deadline or byte cap is hit. Pure Node (no VS Code). */
export function runGit(cwd: string, args: string[], timeoutMs: number, maxBytes = 4 * 1024 * 1024): Promise<{ stdout: string; ok: boolean; truncated: boolean }> {
  return new Promise(resolve => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('git', hardenedGitArgs(args), { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], env: hardenedGitEnv() });
    } catch {
      resolve({ stdout: '', ok: false, truncated: false });
      return;
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const finish = (ok: boolean, truncated = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout: Buffer.concat(chunks).toString('utf8'), ok, truncated });
    };
    const timer = setTimeout(() => { try { child.kill(); } catch { /* already gone */ } finish(chunks.length > 0, true); }, timeoutMs);
    child.stdout?.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      bytes += chunk.length;
      if (bytes > maxBytes) { try { child.kill(); } catch { /* already gone */ } finish(true, true); }
    });
    child.on('error', () => finish(false));
    child.on('close', code => finish(code === 0 || code === 1));
  });
}
