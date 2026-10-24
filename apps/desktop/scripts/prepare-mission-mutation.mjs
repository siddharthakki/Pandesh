/**
 * Prepares the Autonomous Mission mutation proof target.
 *
 * A tiny disposable repository in Core-owned scratch, outside the product
 * repository and any worktree: one small module with a concrete behaviour
 * defect, one focused check that fails against it, and no git remote, so the
 * mission cannot push and cannot reach real work.
 *
 * The focused check is discovered by Core's existing validation gate
 * discovery: the only package.json script is `test`, so the single gate is
 * `npm run test`. No new command vocabulary is introduced.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const requestedScratch = process.env.KARKEDIKHA_MISSION_MUTATION_SCRATCH
  ?? path.join(os.tmpdir(), 'karkedikha-mission-mutation');

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

/**
 * A previous scratch directory can still be held open by a process that has
 * not fully exited, which makes removal fail outright on Windows. A disposable
 * fixture has no reason to insist on one exact path, so fall back to a fresh
 * sibling rather than refusing to run.
 */
function freshScratch(preferred) {
  try {
    removeScratch(preferred);
    return preferred;
  } catch {
    const alternate = `${preferred}-${Date.now().toString(36)}`;
    removeScratch(alternate);
    return alternate;
  }
}

const scratch = freshScratch(requestedScratch);
const fixture = path.join(scratch, 'repo');
const dataDir = path.join(scratch, 'desktop-data');
fs.mkdirSync(path.join(fixture, 'src'), { recursive: true });
fs.mkdirSync(path.join(fixture, 'tests'), { recursive: true });

const write = (relative, contents) => {
  fs.writeFileSync(path.join(fixture, relative), contents, 'utf8');
};

write('package.json', `${JSON.stringify({
  name: 'word-count-fixture',
  version: '1.0.0',
  private: true,
  type: 'module',
  // Bare `node --test` discovers tests/*.test.js. Passing `tests/` makes Node
  // resolve it as a module specifier instead of a directory.
  scripts: { test: 'node --test' },
}, null, 2)}\n`);

write('README.md', [
  '# word-count-fixture',
  '',
  '`countWords(text)` returns the number of words in `text`.',
  '',
  'Words are separated by any run of whitespace, including repeated spaces,',
  'tabs, and newlines. An empty or whitespace-only string has no words.',
  'A non-string argument is a programming error and throws `TypeError`.',
  '',
  'Run the focused check with `npm test`.',
  '',
].join('\n'));

// The defect: splitting on a single space counts empty strings between
// repeated separators, does not treat tabs or newlines as separators, and
// reports one word for an empty string.
write('src/wordCount.js', [
  'export function countWords(text) {',
  "  if (typeof text !== 'string') {",
  "    throw new TypeError('countWords expects a string');",
  '  }',
  "  return text.split(' ').length;",
  '}',
  '',
].join('\n'));

write('tests/wordCount.test.js', [
  "import assert from 'node:assert/strict';",
  "import { test } from 'node:test';",
  "import { countWords } from '../src/wordCount.js';",
  '',
  "test('counts single-space separated words', () => {",
  "  assert.equal(countWords('one two three'), 3);",
  '});',
  '',
  "test('treats repeated spaces as one separator', () => {",
  "  assert.equal(countWords('one   two'), 2);",
  '});',
  '',
  "test('treats tabs and newlines as separators', () => {",
  "  assert.equal(countWords('one\\ttwo\\nthree'), 3);",
  '});',
  '',
  "test('ignores leading and trailing whitespace', () => {",
  "  assert.equal(countWords('  one two  '), 2);",
  '});',
  '',
  "test('reports no words for an empty or whitespace-only string', () => {",
  "  assert.equal(countWords(''), 0);",
  "  assert.equal(countWords('   '), 0);",
  '});',
  '',
  "test('rejects a non-string argument', () => {",
  '  assert.throws(() => countWords(42), TypeError);',
  '});',
  '',
].join('\n'));

git(['init', '--quiet', '--initial-branch=main'], fixture);
git(['config', 'user.email', 'proof@localhost'], fixture);
git(['config', 'user.name', 'Mission Mutation Proof'], fixture);
git(['add', '-A'], fixture);
git(['commit', '--quiet', '-m', 'word-count fixture with a failing focused check'], fixture);

const remotes = git(['remote'], fixture);
if (remotes) throw new Error(`fixture must have no remote, found: ${remotes}`);
const status = git(['status', '--porcelain', '--untracked-files=all'], fixture);
if (status) throw new Error(`fixture is not clean:\n${status}`);

// Fail-before evidence: the focused check must genuinely fail at baseline, or
// the proof would not show the mission fixing anything.
// `shell: true` because npm is a shim on Windows and cannot be spawned
// directly; without it the exit status is null and a spawn failure would be
// misread as the check failing.
const before = spawnSync('npm test', {
  cwd: fixture,
  encoding: 'utf8',
  windowsHide: true,
  shell: true,
});
if (before.error || before.status === null) {
  throw new Error(`could not run the focused check: ${before.error?.message ?? 'no exit status'}`);
}
const baselineCheckFailed = before.status !== 0;
if (!baselineCheckFailed) {
  throw new Error('the focused check passes at baseline; the fixture proves nothing');
}
// Assertion failures, not a missing module or a bad script.
if (!/ERR_ASSERTION/.test(`${before.stdout ?? ''}${before.stderr ?? ''}`)) {
  throw new Error(`the focused check failed without an assertion failure:\n${before.stdout}\n${before.stderr}`);
}

fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(
  path.join(dataDir, 'last-workspace.json'),
  `${JSON.stringify({ folder: fixture, updatedAt: new Date().toISOString() }, null, 2)}\n`,
  'utf8',
);

const info = {
  fixture,
  dataDir,
  baseline: git(['rev-parse', 'HEAD'], fixture),
  baselineCheckFailed,
  baselineCheckExitCode: before.status,
  intendedPath: 'src/wordCount.js',
  focusedCheck: 'npm run test',
  productHead: git(['rev-parse', 'HEAD'], repoRoot),
  productStatus: git(['status', '--porcelain', '--untracked-files=all'], repoRoot),
  preparedAt: new Date().toISOString(),
};
fs.writeFileSync(path.join(scratch, 'fixture.json'), `${JSON.stringify(info, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(info, null, 2));
