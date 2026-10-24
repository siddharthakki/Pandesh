/**
 * Everyday Tools proof driver (focused):
 * - Core note persistence across reopen (printer / A4)
 * - Scheduler fires a desktop-alert callback while "open"
 *
 * Does not claim notifications while Jarvis is closed.
 */
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const result = spawnSync(
  process.execPath,
  [
    path.join(root, 'node_modules/vitest/vitest.mjs'),
    'run',
    'core/test/everydayTools.test.ts',
    'apps/desktop/test/everydayTools.test.ts',
  ],
  { cwd: root, stdio: 'inherit', env: process.env },
);

if ((result.status ?? 1) !== 0) {
  process.exit(result.status ?? 1);
}

console.log('Everyday Tools proof: note persistence + open-app alert scheduler verified via focused tests.');
console.log('Honest limit: alerts while Jarvis is closed are not implemented.');
