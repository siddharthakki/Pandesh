// Aggregates an EXPLICIT list of model-bench run dirs into one cohort (manifest.json, RUNS.csv, SUMMARY.csv, SUMMARY.md).
// Historical runs are never discovered automatically: the caller names every run dir, so cohorts cannot mix silently.
//
//   node scripts/model-bench/cohort.mjs --out <dir> --name <cohort> (--runs dirA,dirB,... | --index RUN-INDEX.csv) [--reclassify]
//
// --index reads a CSV with Model, Run (repetition) and RunDir columns (the layout used by the POST-M49.2 cohort).
// --reclassify re-derives each verdict from the retained Golden evidence with the current classifier; nothing is re-run.
import fs from 'node:fs';
import path from 'node:path';
import { reclassifyRecord } from './evidence.mjs';
import { writeCohortArtifacts } from './lib.mjs';

const arg = name => {
  const index = process.argv.indexOf(name);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : null;
};
const out = arg('--out');
if (!out || (!arg('--runs') && !arg('--index'))) {
  console.error('usage: cohort.mjs --out <dir> --name <cohort> (--runs dirA,dirB | --index RUN-INDEX.csv) [--reclassify]');
  process.exit(1);
}
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));

/** Minimal CSV row split that honours double-quoted cells. */
const splitCsv = line => [...line.matchAll(/("(?:[^"]|"")*"|[^,]*)(?:,|$)/g)].map(match => match[1].replace(/^"|"$/g, '').replace(/""/g, '"')).slice(0, -1);

let entries;
if (arg('--index')) {
  const [header, ...rows] = fs.readFileSync(arg('--index'), 'utf8').replace(/^﻿/, '').trim().split(/\r?\n/).map(splitCsv);
  const col = name => header.findIndex(cell => cell.toLowerCase() === name);
  const [modelCol, repCol, dirCol] = [col('model'), col('run'), col('rundir')];
  if (dirCol < 0) throw new Error('index needs a RunDir column');
  entries = rows.map(row => ({ dir: row[dirCol], model: modelCol >= 0 ? row[modelCol] : null, repetition: repCol >= 0 ? Number(row[repCol]) : null }));
} else {
  entries = arg('--runs').split(',').map(dir => ({ dir: dir.trim(), model: null, repetition: null })).filter(item => item.dir);
}

const results = [];
const sources = [];
for (const entry of entries) {
  const dir = path.resolve(entry.dir);
  const runManifest = fs.existsSync(path.join(dir, 'manifest.json')) ? readJson(path.join(dir, 'manifest.json')) : {};
  const stored = fs.existsSync(path.join(dir, 'results.json')) ? readJson(path.join(dir, 'results.json')) : [];
  sources.push({ dir, gitHead: runManifest.gitHead ?? null, results: stored.length });
  for (const item of stored) {
    if (entry.model && item.model !== entry.model) continue;
    const record = { ...item, repetition: item.repetition ?? entry.repetition ?? 1, runDir: item.runDir ?? dir, commitSha: item.commitSha ?? runManifest.gitHead ?? null };
    results.push(process.argv.includes('--reclassify') ? reclassifyRecord(record) : record);
  }
}

const unique = values => [...new Set(values.filter(Boolean))];
// Sampling is part of a cohort's identity: runs with different seed/temperature settings are not comparable.
const samplings = unique(results.map(item => JSON.stringify({ seed: item.seed ?? null, temperature: item.temperature ?? null })));
if (samplings.length > 1) throw new Error(`Refusing to aggregate runs with different sampling settings: ${samplings.join(' vs ')}`);
const manifest = {
  sampling: JSON.parse(samplings[0] ?? '{"seed":null,"temperature":null}'),
  cohort: arg('--name') ?? path.basename(out), source: arg('--index') ? `index ${path.resolve(arg('--index'))}` : 'explicit --runs',
  aggregatedAt: new Date().toISOString(), reclassified: process.argv.includes('--reclassify'),
  models: unique(results.map(item => item.model)), scenarios: unique(results.map(item => item.scenario)),
  repetitions: Math.max(0, ...results.map(item => item.repetition ?? 1)),
  gitHead: unique(results.map(item => item.commitSha)).join(', ') || null,
  vsix: { sha256: unique(results.map(item => item.vsixSha256)).join(', ') || null },
  startedAt: results.map(item => item.finishedAt).filter(Boolean).sort()[0] ?? null,
  finishedAt: results.map(item => item.finishedAt).filter(Boolean).sort().at(-1) ?? null,
  runs: sources,
};
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'results.json'), `${JSON.stringify(results, null, 2)}\n`);
writeCohortArtifacts(out, manifest, results);
const changed = results.filter(item => item.reclassifiedFrom);
console.log(`Cohort ${manifest.cohort}: ${results.length} run(s) from ${sources.length} dir(s)${changed.length ? `; ${changed.length} reclassified` : ''} -> ${path.join(out, 'SUMMARY.md')}`);
