/**
 * What Core checks after a coding delegation (audit D12).
 *
 * M8: OpenCode fixed the bug, but Pandesh ran no tests afterwards, showed no diff ("Show me exactly what you changed"
 * was answered with one sentence) and left OpenCode's `.opencode/` folder untracked in the user's repository. The
 * model's word is not evidence, so after every delegation Core itself:
 *   1. reads `git status` / `git diff` — what really changed on disk;
 *   2. removes `.opencode/` only when this delegation created it and git does not track it (nothing else is deleted;
 *      other new files are reported);
 *   3. flags changed test files (a fix that edits tests to go green is not a fix);
 *   4. re-runs the project's own test command and reports its real exit code and tail.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runHardenedGit } from '../security/hardenedGit';

export interface CommandRun { code: number | null; stdout: string; stderr: string; timedOut: boolean }
export type CommandRunner = (command: string, cwd: string, timeoutMs: number, signal?: AbortSignal) => Promise<CommandRun>;

const MAX_DIFF_CHARS = 12_000;
const TEST_TIMEOUT_MS = 5 * 60_000;

/** Hardened git: a user's repository cannot run planted hooks, fsmonitor or external diff tools through these reads. */
function git(cwd: string, args: string[]): string | null {
  try {
    const r = runHardenedGit(args, { cwd, encoding: 'utf8', timeout: 10_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
    return r.status === 0 ? String(r.stdout ?? '') : null;
  } catch {
    return null;
  }
}

export function isGitRepository(dir: string): boolean {
  return git(dir, ['rev-parse', '--is-inside-work-tree'])?.trim() === 'true';
}

/** Untracked top-level paths before the delegation, so cleanup only touches what the delegation itself created. */
export function untrackedPaths(dir: string): Set<string> {
  const out = git(dir, ['status', '--porcelain', '--untracked-files=normal']) ?? '';
  return new Set(out.split(/\r?\n/).filter((l) => l.startsWith('?? ')).map((l) => l.slice(3).trim().replace(/\/$/, '')));
}

/**
 * A bounded record of the files in a folder that is not a git repository (path → size and mtime), so a delegation's
 * real effect can still be read from disk. Alpha review: in a plain folder the report said "Changed files: none"
 * both when OpenCode had created cat_garden.html and when it had printed a fake tool call and created nothing.
 */
export type FileSnapshot = Map<string, string>;
const SNAPSHOT_SKIP = new Set(['.git', '.opencode', 'node_modules', '.venv', '__pycache__', 'dist', 'build', 'out']);
const SNAPSHOT_MAX = 5_000;

export function snapshotFiles(dir: string): FileSnapshot {
  const out: FileSnapshot = new Map();
  const walk = (rel: string, depth: number) => {
    if (out.size >= SNAPSHOT_MAX || depth > 6) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.size >= SNAPSHOT_MAX) return;
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!SNAPSHOT_SKIP.has(e.name)) walk(child, depth + 1); continue; }
      if (!e.isFile()) continue;
      try { const st = fs.statSync(path.join(dir, child)); out.set(child, `${st.size}:${st.mtimeMs}`); } catch { /* vanished */ }
    }
  };
  walk('', 0);
  return out;
}

export function diffSnapshots(before: FileSnapshot, after: FileSnapshot): { created: string[]; modified: string[]; deleted: string[] } {
  const created: string[] = []; const modified: string[] = []; const deleted: string[] = [];
  for (const [p, sig] of after) { if (!before.has(p)) created.push(p); else if (before.get(p) !== sig) modified.push(p); }
  for (const p of before.keys()) if (!after.has(p)) deleted.push(p);
  return { created, modified, deleted };
}

/** True when the delegation left no trace on disk at all (nothing changed, created or deleted). */
export function delegationChangedNothing(v: DelegationVerification): boolean {
  return v.changedFiles.length === 0 && v.newUntracked.length === 0 && v.deletedFiles.length === 0;
}

/** The project's own test command, from its manifest; null when none can be determined. */
export function detectTestCommand(dir: string): string | null {
  const pkgPath = path.join(dir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { scripts?: Record<string, string> };
      const test = pkg.scripts?.test;
      if (test && !/no test specified/i.test(test)) return 'npm test';
    } catch { /* unreadable manifest: fall through */ }
    if (fs.existsSync(path.join(dir, 'test')) || fs.existsSync(path.join(dir, 'tests'))) return 'node --test';
  }
  if (fs.existsSync(path.join(dir, 'pyproject.toml')) || fs.existsSync(path.join(dir, 'pytest.ini')) || fs.existsSync(path.join(dir, 'setup.cfg'))) return 'python -m pytest -q';
  if (fs.existsSync(path.join(dir, 'Cargo.toml'))) return 'cargo test';
  if (fs.existsSync(path.join(dir, 'go.mod'))) return 'go test ./...';
  // Alpha e2e T4: a plain folder with calculator.py + test_calculator.py had tests nobody ran. The standard library's
  // unittest runs them without pytest or a manifest.
  try {
    if (fs.readdirSync(dir).some((f) => /^test_[^\/]*\.py$|^[^\/]*_test\.py$/i.test(f))) return 'python -m unittest discover -v -p "*test*.py"';
  } catch { /* unreadable folder: no command */ }
  return null;
}

const TEST_FILE = /(^|\/)(?:tests?|__tests__|spec)\/|\.(?:test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]+\.py$|_test\.(?:py|go)$/i;

export interface DelegationVerification {
  changedFiles: string[];
  newUntracked: string[];
  testFilesChanged: string[];
  /** Files that disappeared (only known for a plain folder, from the snapshot). */
  deletedFiles: string[];
  /** Whether the changes were read from git or from a before/after snapshot of a plain folder. */
  source: 'git' | 'snapshot';
  removed: string[];
  diff: string;
  diffTruncated: boolean;
  /** coversChanges: false when no test file was written by this delegation or names a changed module (the tests in
   * the folder are about other work; their result says nothing about this change). */
  test: { command: string; code: number | null; timedOut: boolean; tail: string; coversChanges: boolean } | null;
  notes: string[];
}

export async function verifyDelegation(dir: string, before: Set<string>, run: CommandRunner, signal?: AbortSignal, beforeSnapshot?: FileSnapshot): Promise<DelegationVerification> {
  const notes: string[] = [];
  const removed: string[] = [];
  const inGit = isGitRepository(dir);
  if (!inGit) notes.push('the folder is not a git repository, so changes were read from the files on disk and no line diff can be shown');

  // Cleanup first, so the reported status is what the user is left with.
  // A plain folder has no untracked list: whether .opencode/ exists now is the evidence (the caller passes whether it
  // existed before), so OpenCode's leftovers are removed there too (alpha e2e T4).
  const after = inGit ? untrackedPaths(dir) : new Set(fs.existsSync(path.join(dir, '.opencode')) ? ['.opencode'] : []);
  if (after.has('.opencode') && !before.has('.opencode')) {
    const target = path.join(dir, '.opencode');
    try {
      fs.rmSync(target, { recursive: true, force: true });
      removed.push('.opencode/');
    } catch (err) {
      notes.push(`.opencode/ was created by OpenCode and could not be removed: ${(err as Error).message}`);
    }
  }

  let changedFiles: string[];
  let newUntracked: string[];
  let deletedFiles: string[] = [];
  if (!inGit && beforeSnapshot) {
    const d = diffSnapshots(beforeSnapshot, snapshotFiles(dir));
    changedFiles = d.modified;
    newUntracked = d.created;
    deletedFiles = d.deleted;
  } else {
    const status = git(dir, ['status', '--porcelain', '--untracked-files=normal']) ?? '';
    const lines = status.split(/\r?\n/).filter(Boolean);
    changedFiles = lines.filter((l) => !l.startsWith('?? ')).map((l) => l.slice(3).trim());
    newUntracked = lines.filter((l) => l.startsWith('?? ')).map((l) => l.slice(3).trim()).filter((p) => !before.has(p.replace(/\/$/, '')));
  }
  const testFilesChanged = [...changedFiles, ...newUntracked].filter((p) => TEST_FILE.test(p.replace(/\\/g, '/')));
  const fullDiff = git(dir, ['diff', '--no-color', '--no-ext-diff']) ?? '';
  const diffTruncated = fullDiff.length > MAX_DIFF_CHARS;
  const diff = diffTruncated ? `${fullDiff.slice(0, MAX_DIFF_CHARS)}\n… (diff truncated)` : fullDiff;

  let test: DelegationVerification['test'] = null;
  const command = detectTestCommand(dir);
  if (!command) {
    notes.push('no test command could be determined from the project files, so no tests were re-run');
  } else if (!signal?.aborted) {
    const r = await run(command, dir, TEST_TIMEOUT_MS, signal);
    const tail = `${r.stdout}\n${r.stderr}`.trim().split(/\r?\n/).slice(-15).join('\n');
    test = { command, code: r.code, timedOut: r.timedOut, tail, coversChanges: testsCoverChanges(dir, [...changedFiles, ...newUntracked]) };
    if (!test.coversChanges) notes.push('the tests that ran do not cover the files this task created or changed (they are about other work in the folder), so they do not verify this change');
  }
  return { changedFiles, newUntracked, testFilesChanged, deletedFiles, source: !inGit && beforeSnapshot ? 'snapshot' : 'git', removed, diff, diffTruncated, test, notes };
}

/**
 * Real-world challenge T14: a task board was "verified" by the expense tracker's tests in the same folder. Tests cover a
 * change when this change wrote a test file, or when an existing test file names a changed source module.
 */
export function testsCoverChanges(dir: string, touched: string[]): boolean {
  const norm = touched.map((f) => f.replace(/\\/g, '/').replace(/\/$/, ''));
  if (norm.some((f) => TEST_FILE.test(f))) return true;
  const modules = norm.filter((f) => /\.(?:py|[cm]?[jt]sx?)$/i.test(f)).map((f) => path.basename(f).replace(/\.[^.]+$/, '').toLowerCase()).filter((m) => m.length >= 2);
  if (modules.length === 0) return false;
  const tests = [...snapshotFiles(dir).keys()].filter((f) => TEST_FILE.test(f.replace(/\\/g, '/'))).slice(0, 200);
  return tests.some((t) => {
    let text = '';
    try { text = fs.readFileSync(path.join(dir, t), 'utf8').slice(0, 200_000).toLowerCase(); } catch { return false; }
    return modules.some((m) => new RegExp(`\\b${m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(text));
  });
}

/** The verified report appended to the reply: the diff from git and the test run from Core, not the model's summary. */
export function renderDelegationReport(v: DelegationVerification): string {
  const parts: string[] = [];
  const list = (files: string[]) => files.map((f) => `\`${f}\``).join(', ');
  if (v.source === 'snapshot') {
    parts.push('**Verified by Pandesh after OpenCode finished** (read from the files on disk, not from the model):');
    if (delegationChangedNothing(v)) parts.push('- **No file was created, changed or deleted.** Whatever the reply above says, OpenCode did not produce a file.');
    if (v.newUntracked.length) parts.push(`- Created: ${list(v.newUntracked)}`);
    if (v.changedFiles.length) parts.push(`- Modified: ${list(v.changedFiles)}`);
    if (v.deletedFiles.length) parts.push(`- Deleted: ${list(v.deletedFiles)}`);
  } else {
    parts.push('**Verified by Pandesh after OpenCode finished** (read from git and a real test run, not from the model):');
    parts.push(v.changedFiles.length ? `- Changed files: ${list(v.changedFiles)}` : '- Changed files: none — no tracked file was changed.');
    if (v.newUntracked.length) parts.push(`- New untracked files left in the folder: ${list(v.newUntracked)}`);
  }
  if (v.removed.length) parts.push(`- Removed OpenCode's own working folder: ${v.removed.map((f) => `\`${f}\``).join(', ')}`);
  if (v.testFilesChanged.length) parts.push(`- **Warning:** test files were changed (${v.testFilesChanged.map((f) => `\`${f}\``).join(', ')}); check that the fix does not just change the tests.`);
  if (v.test) {
    const verdict = v.test.timedOut ? 'TIMED OUT' : v.test.code === 0 ? 'PASSED' : `FAILED (exit ${v.test.code ?? 'none'})`;
    parts.push(`- Tests re-run by Pandesh: \`${v.test.command}\` → **${verdict}**${v.test.coversChanges ? '' : ' — **but these tests do not cover the new or changed files, so this change is untested**'}`);
    if (v.test.tail) parts.push(`\n\`\`\`text\n${v.test.tail}\n\`\`\``);
  }
  for (const note of v.notes) parts.push(`- Note: ${note}`);
  if (v.diff.trim()) parts.push(`\n\`\`\`diff\n${v.diff.trimEnd()}\n\`\`\``);
  return parts.join('\n');
}
