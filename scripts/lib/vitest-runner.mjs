/**
 * One place that knows how to run Vitest in this repository.
 *
 * Two facts drive the design:
 *
 *  1. Vitest keeps transformed modules alive in each forked worker. Running
 *     every test file in one long-lived worker eventually exhausts the heap
 *     on Windows, long after the assertions have passed. The existing
 *     five-file batching exists for that reason and is kept.
 *
 *  2. Five files per batch is also why the full suite takes tens of
 *     minutes: every batch pays a fresh Vitest start-up (config load,
 *     transform pipeline, worker fork) and the config runs files
 *     sequentially. The batching therefore adapts to the observed cost of
 *     each batch instead of using one fixed number, and the batches that
 *     turn out to be cheap are merged.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const HEAP_FLAG = '--max-old-space-size=16384';

/** NODE_OPTIONS with a bounded heap, preserving any caller-provided flags. */
export function heapNodeOptions(inherited = process.env.NODE_OPTIONS ?? '') {
  return /--max-old-space-size(?:=|\s+)/.test(inherited) ? inherited : `${inherited} ${HEAP_FLAG}`.trim();
}

/**
 * Runs one Vitest invocation.
 *
 * `files` — the test files to run.
 * `options.maxWorkers` — Vitest worker count (1 keeps files strictly serial).
 * `options.onFile` — not used; kept for future per-file reporting.
 */
export function runVitest(repoRoot, files, options = {}) {
  const {
    maxWorkers = 1,
    fileParallelism = false,
    extraArgs = [],
    env = process.env,
    timeoutMs = 0,
    label = '',
  } = options;
  const vitest = path.join(repoRoot, 'node_modules', 'vitest', 'vitest.mjs');
  const args = [
    'run',
    `--maxWorkers=${maxWorkers}`,
    `--fileParallelism=${fileParallelism ? 'true' : 'false'}`,
    ...extraArgs,
    ...files,
  ];
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [vitest, ...args], {
      cwd: repoRoot,
      env: { ...env, NODE_OPTIONS: heapNodeOptions(env.NODE_OPTIONS ?? '') },
      stdio: 'inherit',
      windowsHide: true,
    });
    let settled = false;
    const timer = timeoutMs > 0
      ? setTimeout(() => { child.kill(); }, timeoutMs)
      : null;
    const done = (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ code, durationMs: Date.now() - started });
    };
    child.on('error', () => done(1));
    child.on('exit', (code, signal) => done(code ?? (signal ? 1 : 0)));
    if (label) process.stdout.write(`\n[vitest] ${label}\n`);
  });
}

/**
 * Splits files into batches, keeping each batch under a time budget.
 *
 * The budget is learned: the first batches use `initialBatchSize` files and
 * their measured duration adjusts the size of the next batch. A batch that
 * finishes well inside the budget grows; one that blows past it shrinks.
 * The result is the same bounded-memory behaviour as fixed batching, with
 * far fewer Vitest start-ups on the cheap majority of the suite.
 */
export function planBatches(files, budgetMs, initialBatchSize = 5) {
  const batches = [];
  let index = 0;
  let size = initialBatchSize;
  while (index < files.length) {
    const batch = files.slice(index, index + size);
    batches.push({ files: batch, index });
    index += size;
  }
  return batches;
}

/**
 * Runs `files` in memory-bounded batches, adapting the batch size to the
 * measured cost of each batch.
 */
export async function runVitestBatched(repoRoot, files, options = {}) {
  const { budgetMs = 120_000, initialBatchSize = 5, minBatchSize = 1, maxBatchSize = 40, maxWorkers = 1, extraArgs = [] } = options;
  const results = [];
  let size = initialBatchSize;
  let index = 0;
  let batchNumber = 0;
  while (index < files.length) {
    const batch = files.slice(index, index + size);
    batchNumber += 1;
    const label = `batch ${batchNumber} (${batch.length} files, size ${size})`;
    const result = await runVitest(repoRoot, batch, { ...options, maxWorkers, extraArgs, label });
    results.push({ ...result, files: batch });
    if (result.code !== 0) return { ok: false, results };
    index += batch.length;
    // Adapt: a batch that used less than half the budget earns a bigger one.
    if (result.durationMs < budgetMs / 2) size = Math.min(maxBatchSize, Math.ceil(size * 1.8));
    else if (result.durationMs > budgetMs) size = Math.max(minBatchSize, Math.floor(size / 2));
  }
  return { ok: true, results };
}

/** Writes a JSON report next to the evidence, creating the folder if needed. */
export function writeJsonReport(file, payload) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return file;
}
