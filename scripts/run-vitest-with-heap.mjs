#!/usr/bin/env node
// Vitest executes test files in forked Node workers. A parent-only V8 heap
// flag is not inherited by those workers, so place the bounded CI heap limit
// in NODE_OPTIONS instead. Preserve caller flags (for instrumentation) while
// refusing to silently replace an explicitly configured heap size.
//
// Vitest 4 retains transformed modules in each fork. This repository's broad
// packaging tests can otherwise push a long-lived Windows worker past any
// reasonable heap limit after every assertion has already run, so the suite
// runs in batches: each batch gets a fresh worker, and every worker's
// lifetime is bounded.
//
// The batch SIZE is learned rather than fixed. A fixed five-file batch pays
// a fresh Vitest start-up (config load, transform pipeline, worker fork) for
// every handful of files, which is what made the full sweep take tens of
// minutes. The adaptive batcher measures each batch and grows the next one
// when the batch finished well inside the time budget, while a batch that
// blew the budget shrinks again. The memory bound is unchanged: the worker
// count never rises.
import { runVitestBatched } from './lib/vitest-runner.mjs';
import { discoverTestFiles } from './lib/test-impact.mjs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function main() {
  const requested = process.argv.slice(2);
  if (requested.length > 0) {
    // An explicit invocation is the caller's choice: run exactly that.
    const { runVitest } = await import('./lib/vitest-runner.mjs');
    const result = await runVitest(repoRoot, requested, { maxWorkers: 1, label: 'requested files' });
    process.exitCode = result.code;
    return;
  }

  // The whole suite, in every category the repository owns - source, Core
  // AND the desktop app. The desktop tests were previously not discovered at
  // all, so `npm test` was quietly a partial run.
  const tests = discoverTestFiles(repoRoot);
  if (tests.length === 0) throw new Error('no Vitest test files were discovered');
  console.log(`[vitest] ${tests.length} test files across src/test/suite, core/test and apps/desktop/test`);

  const workers = Number(process.env.KARKEDIKHA_TEST_MAX_WORKERS ?? 4);
  const batched = process.env.KARKEDIKHA_TEST_BATCHED === '1';
  if (batched) {
    // The memory-bounded fallback: fresh workers in batches, for a machine
    // that cannot hold the whole suite in one run.
    const budgetMs = Number(process.env.KARKEDIKHA_TEST_BATCH_BUDGET_MS ?? 120_000);
    const result = await runVitestBatched(repoRoot, tests, {
      budgetMs,
      initialBatchSize: Number(process.env.KARKEDIKHA_TEST_BATCH_SIZE ?? 20),
      maxBatchSize: 60,
      maxWorkers: workers,
    });
    process.exitCode = result.ok ? 0 : 1;
    return;
  }

  // The normal path: one Vitest run over the repository's configured include
  // set, with a bounded number of workers. The batch runner paid a fresh
  // Vitest start-up (config load, transform pipeline, worker fork) for every
  // handful of files; with the files running in parallel the start-up is
  // paid once. The file list is not passed on the command line: Windows caps
  // a command line at 32 KiB and the suite's paths do not fit.
  const { runVitest } = await import('./lib/vitest-runner.mjs');
  const result = await runVitest(repoRoot, [], {
    maxWorkers: workers,
    fileParallelism: true,
    useConfigIncludes: true,
    label: `full suite (${tests.length} files)`,
  });
  process.exitCode = result.code;
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
