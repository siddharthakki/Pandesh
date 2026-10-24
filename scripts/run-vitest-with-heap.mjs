#!/usr/bin/env node
// Vitest executes test files in forked Node workers. A parent-only V8 heap
// flag is not inherited by those workers, so place the bounded CI heap limit
// in NODE_OPTIONS instead. Preserve caller flags (for instrumentation) while
// refusing to silently replace an explicitly configured heap size.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const inherited = process.env.NODE_OPTIONS ?? '';
const heapFlag = '--max-old-space-size=16384';
const nodeOptions = /--max-old-space-size(?:=|\s+)/.test(inherited)
  ? inherited
  : `${inherited} ${heapFlag}`.trim();
const vitest = path.join(process.cwd(), 'node_modules', 'vitest', 'vitest.mjs');

function listTests(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) return entry.name === 'platform' ? [] : listTests(fullPath);
    if (entry.name === 'agentPromptLive.test.ts') return [];
    // Live-model, physical-workspace dogfood; stochastic, run via test:dogfood:physical.
    if (entry.name === 'physicalDogfoodAcceptance.test.ts') return [];
    return /\.(?:test|spec)\.ts$/.test(entry.name) ? [fullPath] : [];
  });
}

function runVitest(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [vitest, ...args], {
      cwd: process.cwd(),
      env: { ...process.env, NODE_OPTIONS: nodeOptions },
      stdio: 'inherit',
      windowsHide: true,
    });
    child.on('error', reject);
    child.on('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

async function main() {
  const requested = process.argv.slice(2);
  if (requested.length > 0) {
    process.exitCode = await runVitest(requested);
    return;
  }

  // Vitest 4 retains transformed modules in each fork. This repository's
  // broad packaging tests can otherwise push a long-lived Windows worker past
  // any reasonable heap limit after every assertion has already run. Fresh,
  // deterministic batches keep the full source+Core suite intact while
  // bounding each worker's lifetime and memory use.
  const tests = [
    ...listTests(path.join(process.cwd(), 'src', 'test', 'suite')),
    ...listTests(path.join(process.cwd(), 'core', 'test')),
  ].sort();
  if (tests.length === 0) throw new Error('no Vitest test files were discovered');
  const batchSize = 5;
  for (let start = 0; start < tests.length; start += batchSize) {
    const batch = tests.slice(start, start + batchSize);
    console.log(`\n[vitest-batch] ${start / batchSize + 1}/${Math.ceil(tests.length / batchSize)} (${batch.length} files)`);
    const exitCode = await runVitest(['run', '--maxWorkers=1', ...batch]);
    if (exitCode !== 0) {
      process.exitCode = exitCode;
      return;
    }
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
