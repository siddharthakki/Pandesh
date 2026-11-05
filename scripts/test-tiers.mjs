#!/usr/bin/env node
/**
 * The three testing layers, as one command.
 *
 *   unit        fast feedback: typecheck + the tests of the files you touched
 *   regression  impacted suites for a change, plus the governance invariants
 *               when the governed surface moved
 *   acceptance  the real thing: real Core, real tools, real approvals
 *
 * A fourth command, `full`, is the broad regression sweep for release
 * readiness. It is deliberately separate: a targeted green result must never
 * be mistaken for a fully green repository.
 *
 * Every run records a fingerprint of the source tree it validated. A later
 * run against different bytes is reported as STALE, so a validation can
 * never be reused for a revision it did not cover.
 */
import { execFileSync, spawn } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildImportGraph,
  discoverSourceFiles,
  discoverTestFiles,
  impactedTestFiles,
  relPosix,
} from './lib/test-impact.mjs';
import { runVitest, runVitestBatched, writeJsonReport } from './lib/vitest-runner.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const evidenceRoot = path.join(repoRoot, '.tmp', 'validation');

function arg(name, fallback = undefined) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1 || index === process.argv.length - 1) return fallback;
  return process.argv[index + 1];
}
function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function git(args) {
  try {
    return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).trim();
  } catch {
    return '';
  }
}

/** The revision this working tree is. A commit plus the dirty diff. */
export function workspaceFingerprint() {
  const head = git(['rev-parse', 'HEAD']);
  const dirty = git(['status', '--porcelain']);
  const diff = git(['diff', 'HEAD', '--unified=0', '--', 'core', 'src', 'apps/desktop/src', 'package.json', 'scripts']);
  const staged = git(['diff', '--cached', '--unified=0']);
  const hash = crypto.createHash('sha256');
  hash.update(head);
  hash.update('\n');
  hash.update(diff);
  hash.update('\n');
  hash.update(staged);
  hash.update('\n');
  hash.update(dirty);
  return { head, dirty: dirty.length > 0, hash: hash.digest('hex').slice(0, 16) };
}

function changedSourceFiles(base) {
  const raw = git(['diff', '--name-only', `${base}...HEAD`]);
  const unstaged = git(['diff', '--name-only']);
  const untracked = git(['ls-files', '--others', '--exclude-standard']);
  const all = new Set(
    [...raw.split(/\r?\n/), ...unstaged.split(/\r?\n/), ...untracked.split(/\r?\n/)]
      .map((line) => line.trim())
      .filter(Boolean),
  );
  return [...all].filter((file) => /^(core|src|apps\/desktop\/src)\//.test(file) && /\.tsx?$/.test(file));
}

function record(report) {
  const file = path.join(evidenceRoot, `${report.tier}.json`);
  writeJsonReport(file, report);
  return file;
}

function readPrevious(tier) {
  const file = path.join(evidenceRoot, `${tier}.json`);
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** True when a previous validation still describes the current bytes. */
export function previousIsFresh(tier) {
  const previous = readPrevious(tier);
  if (!previous) return false;
  return previous.fingerprint?.hash === workspaceFingerprint().hash;
}

function typecheck() {
  const started = Date.now();
  const steps = [
    ['core typecheck', ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.core.json', '--noEmit']],
    ['app typecheck', ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json', '--noEmit']],
  ];
  for (const [label, args] of steps) {
    console.log(`\n[typecheck] ${label}`);
    try {
      execFileSync(process.execPath, args, { cwd: repoRoot, stdio: 'inherit' });
    } catch {
      return { ok: false, label, durationMs: Date.now() - started };
    }
  }
  return { ok: true, durationMs: Date.now() - started };
}

// ---------------------------------------------------------------------------
// Tier 1 — unit
// ---------------------------------------------------------------------------

async function tierUnit() {
  const started = Date.now();
  const explicit = arg('files');
  const testFiles = discoverTestFiles(repoRoot);
  let selected;
  if (explicit) {
    selected = explicit.split(',').map((f) => f.trim()).filter(Boolean);
  } else {
    const base = arg('base', 'HEAD');
    const changed = changedSourceFiles(base);
    if (changed.length === 0) {
      console.log('No changed source files since the base revision; nothing to scope to.');
    }
    const sourceFiles = discoverSourceFiles(repoRoot);
    const importers = buildImportGraph(repoRoot, sourceFiles);
    const impact = impactedTestFiles(changed, testFiles, importers, repoRoot);
    selected = impact.files.map((rel) => path.join(repoRoot, rel));
    console.log(`Changed source files: ${changed.length}`);
    console.log(`Impacted test files: ${selected.length} (governance surface touched: ${impact.governanceTouched ? 'yes' : 'no'})`);
  }
  const typecheckResult = typecheck();
  if (!typecheckResult.ok) {
    const report = { tier: 'unit', ok: false, failedAt: 'typecheck', fingerprint: workspaceFingerprint(), durationMs: Date.now() - started };
    record(report);
    process.exitCode = 1;
    return;
  }
  let ok = true;
  if (selected.length > 0) {
    const result = await runVitest(repoRoot, selected, { maxWorkers: 1, label: `unit (${selected.length} files)` });
    ok = result.code === 0;
  } else {
    console.log('No impacted test files to run.');
  }
  const report = {
    tier: 'unit',
    ok,
    fingerprint: workspaceFingerprint(),
    files: selected.map((file) => relPosix(repoRoot, file)),
    durationMs: Date.now() - started,
    typecheckMs: typecheckResult.durationMs,
    at: new Date().toISOString(),
  };
  const file = record(report);
  console.log(`\n[unit] ${ok ? 'PASS' : 'FAIL'} in ${((Date.now() - started) / 1000).toFixed(1)}s — ${file}`);
  if (!ok) process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// Tier 2 — regression (impacted)
// ---------------------------------------------------------------------------

async function tierRegression() {
  const started = Date.now();
  const base = arg('base', 'main');
  const changed = changedSourceFiles(base);
  const testFiles = discoverTestFiles(repoRoot);
  const sourceFiles = discoverSourceFiles(repoRoot);
  const importers = buildImportGraph(repoRoot, sourceFiles);
  const impact = impactedTestFiles(changed, testFiles, importers, repoRoot);
  const selected = impact.files.map((rel) => path.join(repoRoot, rel));
  console.log(`Base revision: ${base}`);
  console.log(`Changed source files: ${changed.length}`);
  console.log(`Impacted test files: ${selected.length}`);
  if (impact.governanceTouched) console.log('Governed surface changed: privacy/approval/mutation/cancellation invariants included.');
  let ok = true;
  if (selected.length > 0) {
    const result = await runVitest(repoRoot, selected, { maxWorkers: 1, label: `regression (${selected.length} files)` });
    ok = result.code === 0;
  }
  const report = {
    tier: 'regression',
    ok,
    base,
    fingerprint: workspaceFingerprint(),
    changed,
    files: selected.map((file) => relPosix(repoRoot, file)),
    durationMs: Date.now() - started,
    at: new Date().toISOString(),
  };
  const file = record(report);
  console.log(`\n[regression] ${ok ? 'PASS' : 'FAIL'} in ${((Date.now() - started) / 1000).toFixed(1)}s — ${file}`);
  if (!ok) process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// Broad sweep — every test file, memory bounded
// ---------------------------------------------------------------------------

async function tierFull() {
  const started = Date.now();
  const testFiles = discoverTestFiles(repoRoot);
  console.log(`Full sweep over ${testFiles.length} test files.`);
  const budgetMs = Number(arg('budget-ms', '150000'));
  const result = await runVitestBatched(repoRoot, testFiles, {
    budgetMs,
    initialBatchSize: Number(arg('batch-size', '10')),
    maxWorkers: 1,
  });
  const report = {
    tier: 'full',
    ok: result.ok,
    fingerprint: workspaceFingerprint(),
    fileCount: testFiles.length,
    durationMs: Date.now() - started,
    batches: result.results.map((r) => ({ files: r.files.length, durationMs: r.durationMs, code: r.code })),
    at: new Date().toISOString(),
  };
  const file = record(report);
  console.log(`\n[full] ${result.ok ? 'PASS' : 'FAIL'} in ${((Date.now() - started) / 1000).toFixed(1)}s — ${file}`);
  if (!result.ok) process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// Tier 3 — acceptance (real Core, real tools)
// ---------------------------------------------------------------------------

const ACCEPTANCE_SCENARIOS = [
  { id: 'aw1', script: 'scripts/acceptance/run-aw1-ocr-acceptance.mjs', label: 'AW1 — OCR to a verified file' },
  { id: 'aw2', script: 'scripts/acceptance/run-aw2-comfyui-jugaad-acceptance.mjs', label: 'AW2 — ComfyUI to theUGAAD companion' },
  { id: 'aw3', script: 'scripts/acceptance/run-aw3-research-document-calendar-acceptance.mjs', label: 'AW3 — research, browser, document, calendar' },
];

async function tierAcceptance() {
  const only = arg('only');
  const wanted = only ? new Set(only.split(',').map((s) => s.trim())) : null;
  const results = [];
  for (const scenario of ACCEPTANCE_SCENARIOS) {
    if (wanted && !wanted.has(scenario.id)) continue;
    const script = path.join(repoRoot, scenario.script);
    if (!fs.existsSync(script)) {
      console.log(`\n[acceptance] ${scenario.label}: script not present (${scenario.script})`);
      results.push({ id: scenario.id, ok: false, reason: 'script_missing' });
      continue;
    }
    console.log(`\n[acceptance] ${scenario.label}`);
    const started = Date.now();
    const code = await new Promise((resolve) => {
      const child = spawn(process.execPath, [script], { cwd: repoRoot, stdio: 'inherit', windowsHide: true });
      child.on('error', () => resolve(1));
      child.on('exit', (c) => resolve(c ?? 1));
    });
    results.push({ id: scenario.id, ok: code === 0, exitCode: code, durationMs: Date.now() - started });
  }
  const report = {
    tier: 'acceptance',
    ok: results.every((r) => r.ok),
    fingerprint: workspaceFingerprint(),
    results,
    at: new Date().toISOString(),
  };
  const file = record(report);
  console.log(`\n[acceptance] ${report.ok ? 'PASS' : 'FAIL'} — ${file}`);
  if (!report.ok) process.exitCode = 1;
}

function tierStatus() {
  const fingerprint = workspaceFingerprint();
  const rows = ['unit', 'regression', 'full', 'acceptance'].map((tier) => {
    const previous = readPrevious(tier);
    return {
      tier,
      recorded: previous ? previous.at : null,
      ok: previous ? previous.ok : null,
      fresh: previous ? previous.fingerprint?.hash === fingerprint.hash : false,
      durationMs: previous ? previous.durationMs : null,
    };
  });
  console.log(JSON.stringify({ fingerprint, results: rows }, null, 2));
}

// ---------------------------------------------------------------------------

async function main() {
  const command = process.argv[2] ?? 'status';
  switch (command) {
    case 'unit': return tierUnit();
    case 'regression': return tierRegression();
    case 'full': return tierFull();
    case 'acceptance': return tierAcceptance();
    case 'status': return tierStatus();
    default:
      console.error(`unknown command '${command}'. Use unit | regression | full | acceptance | status.`);
      process.exitCode = 2;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
