import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { changeScopeIsCommittable, excludeRuntimeInternalPaths, fingerprintReviewedDiff, reconcileChangeScope } from '../../coding/ChangeScopeReconciliation';

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, windowsHide: true });
  return stdout;
}

async function initGit(root: string): Promise<void> {
  for (const args of [
    ['init'],
    ['config', 'user.email', 'test@example.com'],
    ['config', 'user.name', 'Test'],
    ['config', 'core.quotepath', 'false'],
  ]) {
    await git(root, args);
  }
}

describe('ChangeScopeReconciliation — Phase 5 findings / Phase 7 pre-commit gate', () => {
  it('approved-only changes pass', () => {
    const result = reconcileChangeScope(['src/A.ts', 'src/B.ts'], ['src/A.ts', 'src/B.ts']);
    expect(result.unexpected).toEqual([]);
    expect(result.missingExpected).toEqual([]);
    expect(changeScopeIsCommittable(result)).toBe(true);
  });

  it('an unexpected file blocks commit', () => {
    const result = reconcileChangeScope(['src/A.ts'], ['src/A.ts', 'src/Sneaky.ts']);
    expect(result.unexpected).toEqual(['src/Sneaky.ts']);
    expect(changeScopeIsCommittable(result)).toBe(false);
  });

  it('a missing expected file is reported without blocking commit by itself', () => {
    const result = reconcileChangeScope(['src/A.ts', 'src/B.ts'], ['src/A.ts']);
    expect(result.missingExpected).toEqual(['src/B.ts']);
    expect(changeScopeIsCommittable(result)).toBe(true);
  });

  it('normalizes backslashes and leading ./ so approved/actual paths compare equal', () => {
    const result = reconcileChangeScope(['src\\A.ts'], ['./src/A.ts']);
    expect(result.approved).toEqual(['src/A.ts']);
    expect(result.unexpected).toEqual([]);
  });

  it('deduplicates repeated paths', () => {
    const result = reconcileChangeScope(['src/A.ts', 'src/A.ts'], ['src/A.ts', 'src/A.ts']);
    expect(result.approved).toEqual(['src/A.ts']);
  });

  it('excludeRuntimeInternalPaths drops the runtime state dir but nothing that merely resembles it', () => {
    // M32 packaged-dogfood regression: the repository-analyst stage writes
    // .ollama-agent/index/repository-intelligence.sqlite into the bound
    // worktree, which must not register as an unexpected scope violation.
    expect(excludeRuntimeInternalPaths([
      'hello.txt',
      '.ollama-agent/index/repository-intelligence.sqlite',
      '.ollama-agent',
      '.\\.ollama-agent\\tasks\\state.json',
      'src/.ollama-agent-lookalike.ts',
      '.ollama-agent-cache/file.txt',
      '.ollama-agent.txt',
      'nested/.ollama-agent/file.txt',
    ])).toEqual([
      'hello.txt',
      'src/.ollama-agent-lookalike.ts',
      '.ollama-agent-cache/file.txt',
      '.ollama-agent.txt',
      'nested/.ollama-agent/file.txt',
    ]);
  });
});

describe('fingerprintReviewedDiff — Phase 7 reviewed-diff integrity (real Git)', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-diff-fingerprint-'));
    await fs.writeFile(path.join(root, 'a.ts'), 'export const a = 1;\n');
    await initGit(root);
    await git(root, ['add', '.']);
    await git(root, ['commit', '-m', 'init']);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('is stable for an unchanged diff (same content re-fingerprinted matches)', async () => {
    await fs.writeFile(path.join(root, 'a.ts'), 'export const a = 2;\n');
    const diff1 = await git(root, ['diff', 'HEAD']);
    const diff2 = await git(root, ['diff', 'HEAD']);
    expect(fingerprintReviewedDiff(diff1)).toBe(fingerprintReviewedDiff(diff2));
  });

  it('detects a modification to an already-approved file made after the diff was fingerprinted', async () => {
    await fs.writeFile(path.join(root, 'a.ts'), 'export const a = 2;\n');
    const reviewed = fingerprintReviewedDiff(await git(root, ['diff', 'HEAD']));

    await fs.writeFile(path.join(root, 'a.ts'), 'export const a = 999; // tampered\n');
    const actual = fingerprintReviewedDiff(await git(root, ['diff', 'HEAD']));

    expect(actual).not.toBe(reviewed);
  });

  it('detects a deletion made after the diff was fingerprinted', async () => {
    await fs.writeFile(path.join(root, 'a.ts'), 'export const a = 2;\n');
    const reviewed = fingerprintReviewedDiff(await git(root, ['diff', 'HEAD']));

    await fs.rm(path.join(root, 'a.ts'));
    const actual = fingerprintReviewedDiff(await git(root, ['diff', 'HEAD']));

    expect(actual).not.toBe(reviewed);
  });

  it('detects a rename made after the diff was fingerprinted', async () => {
    await fs.writeFile(path.join(root, 'a.ts'), 'export const a = 2;\n');
    const reviewed = fingerprintReviewedDiff(await git(root, ['diff', 'HEAD']));

    await fs.rename(path.join(root, 'a.ts'), path.join(root, 'renamed.ts'));
    const actual = fingerprintReviewedDiff(await git(root, ['diff', 'HEAD']));

    expect(actual).not.toBe(reviewed);
  });

  it('handles paths with spaces and unicode characters', async () => {
    const oddDir = path.join(root, 'nested dir', 'ünïcödé');
    await fs.mkdir(oddDir, { recursive: true });
    await fs.writeFile(path.join(oddDir, 'ünïcödé file.ts'), 'export const x = 1;\n');
    const diff = await git(root, ['diff', 'HEAD']);
    // Untracked files never show up in `git diff HEAD`; this confirms the
    // fingerprint call itself does not throw on odd path bytes flowing through
    // `git status`/`git diff` output, and remains stable across calls.
    expect(fingerprintReviewedDiff(diff)).toBe(fingerprintReviewedDiff(diff));

    await git(root, ['add', '.']);
    const diffAfterAdd = await git(root, ['diff', '--cached', 'HEAD']);
    expect(diffAfterAdd).toContain('ünïcödé file.ts');
    expect(fingerprintReviewedDiff(diffAfterAdd)).toHaveLength(64);
  });
});
