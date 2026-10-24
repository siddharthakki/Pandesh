import { ReleaseReadiness } from './ReleaseReadiness';

async function main(): Promise<void> {
  const report = await new ReleaseReadiness(process.cwd()).inspect();
  for (const check of report.checks) {
    const marker = check.status === 'passed' ? 'PASS' : check.status === 'warning' ? 'WARN' : 'FAIL';
    process.stdout.write(`[${marker}] ${check.id}: ${check.message}\n`);
    if (check.detail) { process.stdout.write(`       ${check.detail}\n`); }
  }
  process.stdout.write(`Release readiness: ${report.ready ? 'READY' : 'BLOCKED'}\n`);
  if (!report.ready) { process.exitCode = 1; }
}

void main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
