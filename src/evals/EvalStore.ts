import * as fs from 'fs/promises';
import * as path from 'path';
import { EvalRunResult } from './EvalTypes';

export class EvalStore {
  constructor(private readonly workspaceRoot: string) {}

  async write(result: EvalRunResult): Promise<string> {
    const directory = this.directory();
    await fs.mkdir(directory, { recursive: true });
    const destination = path.join(directory, `${result.runId}.json`);
    const temporary = `${destination}.${process.pid}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(result, null, 2), 'utf8');
    await fs.rename(temporary, destination);
    await this.writeLatestPointer(result.runId);
    return destination;
  }

  async read(runId: string): Promise<EvalRunResult | null> {
    try {
      const parsed = JSON.parse(
        await fs.readFile(path.join(this.directory(), `${runId}.json`), 'utf8'),
      ) as EvalRunResult;
      return parsed.schemaVersion === 1 ? parsed : null;
    } catch {
      return null;
    }
  }

  async latest(): Promise<EvalRunResult | null> {
    try {
      const runId = (await fs.readFile(path.join(this.directory(), 'latest'), 'utf8')).trim();
      return runId ? this.read(runId) : null;
    } catch {
      return null;
    }
  }

  async list(): Promise<EvalRunResult[]> {
    let entries: string[];
    try { entries = await fs.readdir(this.directory()); }
    catch { return []; }
    const results = await Promise.all(entries
      .filter(entry => entry.endsWith('.json'))
      .map(entry => this.read(entry.slice(0, -5))));
    return results
      .filter((result): result is EvalRunResult => Boolean(result))
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
  }

  private directory(): string {
    return path.join(this.workspaceRoot, '.ollama-agent', 'evals');
  }

  private async writeLatestPointer(runId: string): Promise<void> {
    const destination = path.join(this.directory(), 'latest');
    const temporary = `${destination}.${process.pid}.tmp`;
    await fs.writeFile(temporary, `${runId}\n`, 'utf8');
    await fs.rename(temporary, destination);
  }
}
