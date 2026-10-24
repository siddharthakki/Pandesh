import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..', '..');
const evidenceRoot = path.join(root, '.guardian-evidence');
if (!fs.existsSync(evidenceRoot)) {
  console.log('No guardian evidence exists yet.');
  process.exit(0);
}
const rows = [];
const counts = new Map();
for (const run of fs.readdirSync(evidenceRoot).sort()) {
  const resultFile = path.join(evidenceRoot, run, 'run-result.json');
  if (!fs.existsSync(resultFile)) continue;
  const result = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
  for (const item of result.results) {
    rows.push(`| ${run} | ${result.suite} | ${item.journey} | ${item.status} | ${path.relative(root, item.evidence)} |`);
    counts.set(item.status, (counts.get(item.status) ?? 0) + 1);
  }
}
const report = [
  '# KarkeDikha installed-product guardian report',
  '',
  ...[...counts.entries()].sort().map(([status, count]) => `- ${status}: ${count}`),
  '',
  '| Run | Suite | Journey | Result | Evidence |',
  '|---|---|---|---|---|',
  ...rows,
  '',
].join('\n');
const output = path.join(evidenceRoot, 'REPORT.md');
fs.writeFileSync(output, report, 'utf8');
console.log(report);
console.log(`Report written to ${output}`);
