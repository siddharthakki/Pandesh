import * as crypto from 'crypto';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

export class TransactionJournal {
  static async recoveryState(workspaceRoot: string): Promise<{ state: 'clean' | 'recovery_required'; journalPath?: string }> {
    const dir = journalDir(workspaceRoot);
    try {
      const files = await fsp.readdir(dir);
      const journal = files.find(file => file.endsWith('.json'));
      return journal ? { state: 'recovery_required', journalPath: path.join(dir, journal) } : { state: 'clean' };
    } catch {
      return { state: 'clean' };
    }
  }

  static async writePrepared(workspaceRoot: string, transactionId: string, payload: Record<string, unknown>): Promise<string> {
    const dir = journalDir(workspaceRoot);
    await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
    const journalPath = path.join(dir, `${transactionId}.json`);
    await fsp.writeFile(journalPath, JSON.stringify({ transactionId, state: 'prepared', ...payload }), { mode: 0o600 });
    return journalPath;
  }

  static async complete(journalPath: string): Promise<void> {
    await fsp.rm(journalPath, { force: true });
  }
}

function journalDir(workspaceRoot: string): string {
  return path.join(os.tmpdir(), 'ollama-agent-forge', stableHash(path.resolve(workspaceRoot)).slice(7, 23), 'transactions');
}

function stableHash(value: unknown): string {
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}
