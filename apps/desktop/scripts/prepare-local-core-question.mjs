/**
 * Prepares the Local Core repository-question proof target.
 *
 * The target is a clean local clone of this repository's HEAD placed in
 * Core-owned scratch outside the product repository and outside any worktree,
 * so the proof cannot touch in-progress work and "repository unchanged" is
 * measurable against a known baseline.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
// Overridable so a run is never blocked by a previous fixture whose files are
// still held open by a process that has not fully exited.
const scratch = process.env.KARKEDIKHA_LOCAL_CORE_SCRATCH
  ?? path.join(os.tmpdir(), 'karkedikha-local-core-question');
const fixture = path.join(scratch, 'repo');
const dataDir = path.join(scratch, 'desktop-data');

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

// Git writes pack and object files read-only, which makes a plain recursive
// remove fail with EPERM on Windows. Clear the attribute first.
function removeScratch(target) {
  if (!fs.existsSync(target)) return;
  for (const entry of fs.readdirSync(target, { withFileTypes: true, recursive: true })) {
    const full = path.join(entry.parentPath ?? entry.path, entry.name);
    if (entry.isFile()) {
      try { fs.chmodSync(full, 0o666); } catch { /* best effort */ }
    }
  }
  fs.rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

removeScratch(scratch);
fs.mkdirSync(scratch, { recursive: true });

const head = git(['rev-parse', 'HEAD'], repoRoot);
git(['clone', '--no-hardlinks', '--quiet', repoRoot, fixture], scratch);
git(['checkout', '--quiet', head], fixture);
git(['config', 'user.email', 'proof@localhost'], fixture);
git(['config', 'user.name', 'Local Core Proof'], fixture);
// A clone has an origin pointing at the product repo. Remove it so nothing in
// the proof can reach the real repository even by accident.
git(['remote', 'remove', 'origin'], fixture);

const baseline = git(['rev-parse', 'HEAD'], fixture);
const status = git(['status', '--porcelain', '--untracked-files=all'], fixture);
if (status) throw new Error(`fixture clone is not clean:\n${status}`);

fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(
  path.join(dataDir, 'last-workspace.json'),
  `${JSON.stringify({ folder: fixture, updatedAt: new Date().toISOString() }, null, 2)}\n`,
  'utf8',
);

const info = { fixture, dataDir, baseline, productHead: head, preparedAt: new Date().toISOString() };
fs.writeFileSync(path.join(scratch, 'fixture.json'), `${JSON.stringify(info, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(info, null, 2));
