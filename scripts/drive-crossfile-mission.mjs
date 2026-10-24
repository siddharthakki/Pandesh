#!/usr/bin/env node
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const repoRoot = process.cwd();
const vitest = path.join(repoRoot, 'node_modules', 'vitest', 'vitest.mjs');
const model = process.env.KARKEDIKHA_DEFAULT_MODEL || 'qwen3.8:27b-mtp-q4_K_M';
const evidence = path.join(repoRoot, '.tmp', 'crossfile-investigation-workflow.json');

const child = spawn(
  process.execPath,
  [vitest, 'run', 'core/test/missionCrossfile.workflow.test.ts', '--reporter=verbose'],
  {
    cwd: repoRoot,
    env: {
      ...process.env,
      KARKEDIKHA_LIVE_CROSSFILE: '1',
      KARKEDIKHA_DEFAULT_MODEL: model,
    },
    stdio: 'inherit',
    windowsHide: true,
  },
);

child.on('exit', (code) => {
  if (fs.existsSync(evidence)) {
    process.stdout.write(`\nLive cross-file evidence: ${evidence}\n`);
    process.stdout.write(fs.readFileSync(evidence, 'utf8'));
  }
  process.exit(code ?? 1);
});
