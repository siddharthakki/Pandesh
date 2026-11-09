/**
 * Tests that start a real Core process need the esbuild bundle (out-core/core.js). Each such test file used to rebuild
 * it in beforeAll; in a parallel full run two files rebuilt it at the same time, and one started Core from a half-written
 * bundle, which crashed before writing its discovery record ("discovery record did not appear", only in full runs).
 *
 * This builds the bundle only when it is older than Core's sources, under a cross-process lock, so one build happens
 * and every other test file reuses it.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function newestSourceMtime(dir: string): number {
  let newest = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'test' || entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) newest = Math.max(newest, newestSourceMtime(full));
    else if (/\.(?:ts|js|json|sql)$/.test(entry.name)) newest = Math.max(newest, fs.statSync(full).mtimeMs);
  }
  return newest;
}

export function ensureCoreBundle(repoRoot: string): string {
  const bundle = path.join(repoRoot, 'out-core', 'core.js');
  const lock = path.join(repoRoot, 'out-core', '.test-build.lock');
  fs.mkdirSync(path.dirname(bundle), { recursive: true });
  const deadline = Date.now() + 180_000;
  for (;;) {
    try { fs.mkdirSync(lock); break; } catch {
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 300_000) fs.rmSync(lock, { recursive: true, force: true }); } catch { /* gone */ }
      if (Date.now() > deadline) throw new Error('timed out waiting for another test to build the Core bundle');
      sleep(250);
    }
  }
  try {
    const stale = !fs.existsSync(bundle) || fs.statSync(bundle).mtimeMs < newestSourceMtime(path.join(repoRoot, 'core'));
    if (stale) execFileSync(process.execPath, [path.join(repoRoot, 'esbuild.core.js')], { cwd: repoRoot, stdio: 'inherit' });
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
  return bundle;
}
