/**
 * Focused Command Queue proof wrapper — runs the Core domain acceptance test.
 * Usage: node apps/desktop/scripts/proof-command-queue.mjs
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const result = spawnSync(
  process.execPath,
  [
    path.join(root, 'node_modules/vitest/vitest.mjs'),
    'run',
    'core/test/commandQueue.test.ts',
    '--reporter=verbose',
  ],
  { cwd: root, stdio: 'inherit', shell: false },
);
process.exit(result.status ?? 1);
