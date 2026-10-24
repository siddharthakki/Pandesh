import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { ReleaseReadiness } from '../release/ReleaseReadiness';
import { FileReleaseReportStorage, ReleaseScenario, ReleaseScenarioRunner } from './ReleaseScenarioRunner';

async function main(): Promise<void> {
  const root = process.cwd();
  let temporary = '';
  const scenarios: ReleaseScenario[] = [
    {
      id: 'release-readiness',
      description: 'Verify package, security and distribution prerequisites.',
      required: true,
      timeoutMs: 10_000,
      run: async () => {
        const report = await new ReleaseReadiness(root).inspect();
        if (!report.ready) {
          const failures = report.checks.filter(check => check.status === 'failed').map(check => check.id);
          throw new Error(`Release readiness failed: ${failures.join(', ')}`);
        }
        return { checks: report.checks.length };
      },
    },
    {
      id: 'durable-state-roundtrip',
      description: 'Verify atomic state persistence and replacement on this platform.',
      required: true,
      timeoutMs: 10_000,
      dependencies: ['release-readiness'],
      run: async () => {
        temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'ollama-agent-e2e-'));
        const target = path.join(temporary, 'state.json');
        const staging = `${target}.tmp`;
        await fs.writeFile(staging, JSON.stringify({ schemaVersion: 1, status: 'ready' }), 'utf8');
        await fs.rename(staging, target);
        const parsed = JSON.parse(await fs.readFile(target, 'utf8')) as { status?: unknown };
        if (parsed.status !== 'ready') throw new Error('Atomic state roundtrip returned unexpected content.');
        return { platform: process.platform, atomicRename: true };
      },
      cleanup: async () => {
        if (temporary) await fs.rm(temporary, { recursive: true, force: true });
      },
    },
    {
      id: 'compiled-entrypoint',
      description: 'Verify the compiled extension entrypoint exists.',
      required: true,
      timeoutMs: 5_000,
      dependencies: ['release-readiness'],
      run: async () => {
        const entrypoint = path.join(root, 'out', 'extension.js');
        const stat = await fs.stat(entrypoint);
        if (!stat.isFile() || stat.size === 0) throw new Error('Compiled extension entrypoint is missing.');
        return { bytes: stat.size };
      },
    },
  ];

  const storage = new FileReleaseReportStorage(
    path.join(root, '.ollama-agent', 'release', 'e2e-report.json'),
  );
  const report = await new ReleaseScenarioRunner(storage).run(scenarios);
  for (const result of report.results) {
    process.stdout.write(`[${result.status.toUpperCase()}] ${result.id} (${result.durationMs}ms)${result.error ? `: ${result.error}` : ''}\n`);
  }
  process.stdout.write(`End-to-end release gate: ${report.passed ? 'PASSED' : 'FAILED'}\n`);
  if (!report.passed) process.exitCode = 1;
}

void main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
