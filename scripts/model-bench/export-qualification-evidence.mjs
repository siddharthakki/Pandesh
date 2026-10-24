// Exports router-facing qualification evidence from an EXPLICIT list of model-bench run dirs (same rule as cohort.mjs:
// historical runs are never discovered automatically, so evidence cannot be mixed in silently).
//
//   node scripts/model-bench/export-qualification-evidence.mjs --out <file.json> --runs dirA,dirB,...
//
// The extension reads <globalStorage>/model-qualification-evidence.json (or KKD_QUALIFICATION_EVIDENCE). Without the
// file the router simply has no benchmark evidence, which is neutral.
import fs from 'node:fs';
import path from 'node:path';
import { aggregateQualificationEvidence } from './lib.mjs';

const arg = name => {
  const index = process.argv.indexOf(name);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : null;
};
const out = arg('--out');
const runs = (arg('--runs') ?? '').split(',').map(item => item.trim()).filter(Boolean);
if (!out || runs.length === 0) {
  console.error('usage: export-qualification-evidence.mjs --out <file.json> --runs dirA,dirB,...');
  process.exit(1);
}
const rows = runs.flatMap(dir => JSON.parse(fs.readFileSync(path.join(dir, 'results.json'), 'utf8')));
const evidence = { ...aggregateQualificationEvidence(rows), generatedAt: new Date().toISOString(), runCount: runs.length };
fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
fs.writeFileSync(out, `${JSON.stringify(evidence, null, 2)}\n`);
console.log(`wrote evidence for ${Object.keys(evidence.models).length} model(s) from ${runs.length} run(s) to ${out}`);
