// npm run model:test:report [-- --run <dir>] - REPORT.md, results.csv and the cohort artifacts
// (SUMMARY.md, SUMMARY.csv, RUNS.csv) from the latest (or given) run.
import fs from 'node:fs';
import path from 'node:path';
import { buildCohortSummary, buildReport, latestRunDir, resultsToCsv, runsToCsv, summarizeCohort, summaryToCsv } from './lib.mjs';

const root = path.resolve(import.meta.dirname, '..', '..');
const runArg = process.argv.indexOf('--run');
const runDir = runArg >= 0 ? path.resolve(process.argv[runArg + 1]) : latestRunDir(path.join(root, '.model-bench'));
if (!runDir || !fs.existsSync(path.join(runDir, 'manifest.json'))) {
  console.error('No model-bench run found. Run `npm run model:test` first.');
  process.exit(1);
}
const readJson = (name, fallback) => (fs.existsSync(path.join(runDir, name)) ? JSON.parse(fs.readFileSync(path.join(runDir, name), 'utf8')) : fallback);
const manifest = readJson('manifest.json', {});
const results = readJson('results.json', []);
const out = (name, text) => fs.writeFileSync(path.join(runDir, name), text);
out('REPORT.md', buildReport({ manifest, models: readJson('models.json', []), results }));
out('results.csv', resultsToCsv(results));
// The manifest is left untouched here: it is the run's own record.
out('RUNS.csv', runsToCsv(results, { cohort: manifest.cohort ?? null }));
out('SUMMARY.csv', summaryToCsv(summarizeCohort(results)));
out('SUMMARY.md', buildCohortSummary({ manifest, results }));
console.log(`Report: ${path.join(runDir, 'SUMMARY.md')}`);
