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
  return null;
}

const TEST_FILE = /(^|\/)(?:tests?|__tests__|spec)\/|\.(?:test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]+\.py$|_test\.(?:py|go)$/i;

export interface DelegationVerification {
  changedFiles: string[];
  newUntracked: string[];
  testFilesChanged: string[];
  removed: string[];
  diff: string;
  diffTruncated: boolean;
  test: { command: string; code: number | null; timedOut: boolean; tail: string } | null;
  notes: string[];
}

export async function verifyDelegation(dir: string, before: Set<string>, run: CommandRunner, signal?: AbortSignal): Promise<DelegationVerification> {
  const notes: string[] = [];
  const removed: string[] = [];
  if (!isGitRepository(dir)) notes.push('the folder is not a git repository, so the exact change cannot be shown as a diff');

  // Cleanup first, so the reported status is what the user is left with.
  const after = untrackedPaths(dir);
  if (after.has('.opencode') && !before.has('.opencode')) {
    const target = path.join(dir, '.opencode');
    try {
      fs.rmSync(target, { recursive: true, force: true });
      removed.push('.opencode/');
    } catch (err) {
      notes.push(`.opencode/ was created by OpenCode and could not be removed: ${(err as Error).message}`);
    }
  }

  const status = git(dir, ['status', '--porcelain', '--untracked-files=normal']) ?? '';
  const lines = status.split(/\r?\n/).filter(Boolean);
  const changedFiles = lines.filter((l) => !l.startsWith('?? ')).map((l) => l.slice(3).trim());
  const newUntracked = lines.filter((l) => l.startsWith('?? ')).map((l) => l.slice(3).trim()).filter((p) => !before.has(p.replace(/\/$/, '')));
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
    test = { command, code: r.code, timedOut: r.timedOut, tail };
  }
  return { changedFiles, newUntracked, testFilesChanged, removed, diff, diffTruncated, test, notes };
}

/** The verified report appended to the reply: the diff from git and the test run from Core, not the model's summary. */
export function renderDelegationReport(v: DelegationVerification): string {
  const parts: string[] = ['**Verified by Pandesh after OpenCode finished** (read from git and a real test run, not from the model):'];
  parts.push(v.changedFiles.length ? `- Changed files: ${v.changedFiles.map((f) => `\`${f}\``).join(', ')}` : '- Changed files: none — no tracked file was changed.');
  if (v.newUntracked.length) parts.push(`- New untracked files left in the folder: ${v.newUntracked.map((f) => `\`${f}\``).join(', ')}`);
  if (v.removed.length) parts.push(`- Removed OpenCode's own working folder: ${v.removed.map((f) => `\`${f}\``).join(', ')}`);
  if (v.testFilesChanged.length) parts.push(`- **Warning:** test files were changed (${v.testFilesChanged.map((f) => `\`${f}\``).join(', ')}); check that the fix does not just change the tests.`);
  if (v.test) {
    const verdict = v.test.timedOut ? 'TIMED OUT' : v.test.code === 0 ? 'PASSED' : `FAILED (exit ${v.test.code ?? 'none'})`;
    parts.push(`- Tests re-run by Pandesh: \`${v.test.command}\` → **${verdict}**`);
    if (v.test.tail) parts.push(`\n\`\`\`text\n${v.test.tail}\n\`\`\``);
  }
  for (const note of v.notes) parts.push(`- Note: ${note}`);
  if (v.diff.trim()) parts.push(`\n\`\`\`diff\n${v.diff.trimEnd()}\n\`\`\``);
  return parts.join('\n');
}
