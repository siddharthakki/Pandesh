import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { CodingValidationRunner, projectWorktreeDependencies } from '../../coding/ValidationRunner';

async function git(cwd: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('git', args, { cwd, shell: false, windowsHide: true });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`git ${args.join(' ')} failed: ${stderr}`)));
  });
}

describe('CodingValidationRunner worktree dependencies', () => {
  let parent: string;
  let repositoryRoot: string;
  let worktreeRoot: string;

  beforeEach(async () => {
    parent = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-validation-deps-'));
    repositoryRoot = path.join(parent, 'repository');
    worktreeRoot = path.join(parent, 'worktree');
    await fs.mkdir(repositoryRoot, { recursive: true });
    // Tracked files only: package.json (with a real "test" script) and the
    // test's own entry point. Both land in the isolated worktree via the
    // normal git checkout, exactly like a real task worktree.
    await fs.writeFile(path.join(repositoryRoot, 'package.json'), JSON.stringify({
      name: 'validation-fixture',
      scripts: { compile: 'tsc -p ./', test: 'node run-test.js' },
    }));
    await fs.writeFile(path.join(repositoryRoot, 'package-lock.json'), JSON.stringify({ name: 'validation-fixture', lockfileVersion: 3, packages: {} }));
    await fs.writeFile(path.join(repositoryRoot, '.gitignore'), 'node_modules/\n');
    await fs.writeFile(
      path.join(repositoryRoot, 'run-test.js'),
      "const dep = require('fixture-dep');\n"
      + "if (dep !== 'fixture-value') { console.error('dependency mismatch: ' + dep); process.exit(1); }\n"
      + "require('fs').writeFileSync('npm-test-ran.marker', dep);\n"
      + 'process.exit(0);\n',
    );
    await git(repositoryRoot, ['init']);
    await git(repositoryRoot, ['config', 'user.email', 'validation@example.invalid']);
    await git(repositoryRoot, ['config', 'user.name', 'Validation Fixture']);
    await git(repositoryRoot, ['add', '.']);
    await git(repositoryRoot, ['commit', '-m', 'init']);
    // Untracked (gitignored) installed-dependency snapshot: exists only in
    // the source checkout, exactly like a real node_modules tree.
    await fs.mkdir(path.join(repositoryRoot, 'node_modules'), { recursive: true });
    await fs.writeFile(path.join(repositoryRoot, 'node_modules', 'dependency-marker.txt'), 'shared');
    await fs.mkdir(path.join(repositoryRoot, 'node_modules', 'typescript', 'bin'), { recursive: true });
    await fs.writeFile(
      path.join(repositoryRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
      "const fs = require('fs');\n"
      + "fs.writeFileSync('tsc-ran.marker', JSON.stringify(process.argv.slice(2)));\n"
      + 'process.exit(0);\n',
    );
    await fs.mkdir(path.join(repositoryRoot, 'node_modules', 'fixture-dep'), { recursive: true });
    await fs.writeFile(path.join(repositoryRoot, 'node_modules', 'fixture-dep', 'package.json'), JSON.stringify({ name: 'fixture-dep', main: 'index.js' }));
    await fs.writeFile(path.join(repositoryRoot, 'node_modules', 'fixture-dep', 'index.js'), "module.exports = 'fixture-value';\n");
    await git(repositoryRoot, ['worktree', 'add', '-b', 'validation-worktree', worktreeRoot, 'HEAD']);
  });

  afterEach(async () => {
    await fs.rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it('temporarily copies matching dependencies into an isolated worktree', async () => {
    const release = await projectWorktreeDependencies(worktreeRoot);
    const projectedRoot = path.join(worktreeRoot, 'node_modules');

    await expect(fs.readFile(path.join(projectedRoot, 'dependency-marker.txt'), 'utf8')).resolves.toBe('shared');
    const projectedStat = await fs.lstat(projectedRoot);
    expect(projectedStat.isDirectory()).toBe(true);
    expect(projectedStat.isSymbolicLink()).toBe(false);

    await fs.writeFile(path.join(projectedRoot, 'dependency-marker.txt'), 'isolated');
    await expect(fs.readFile(path.join(repositoryRoot, 'node_modules', 'dependency-marker.txt'), 'utf8')).resolves.toBe('shared');

    await release();
    await expect(fs.lstat(projectedRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.readFile(path.join(repositoryRoot, 'node_modules', 'dependency-marker.txt'), 'utf8')).resolves.toBe('shared');
  });

  it('reports the exact validation command before it starts', async () => {
    const started: Array<{ command: string; index: number; total: number }> = [];
    const runner = new CodingValidationRunner(worktreeRoot, 10_000, {
      onCommandStarted: (command, index, total) => started.push({ command, index, total }),
    });

    const results = await runner.runAll([{ kind: 'git-status-short' }]);

    expect(started).toEqual([{ command: 'git status --short', index: 1, total: 1 }]);
    expect(results[0]).toEqual(expect.objectContaining({ command: 'git status --short', exitCode: 0, timedOut: false }));
  });

  it('refuses dependency projection when the primary lockfile differs', async () => {
    await fs.writeFile(path.join(repositoryRoot, 'package-lock.json'), JSON.stringify({
      name: 'validation-fixture',
      lockfileVersion: 3,
      packages: { '': { name: 'validation-fixture' } },
    }));

    const release = await projectWorktreeDependencies(worktreeRoot);

    await expect(fs.lstat(path.join(worktreeRoot, 'node_modules'))).rejects.toMatchObject({ code: 'ENOENT' });
    await release();
  });

  it('projects dependencies when the primary package.json is dirty but lockfiles still match', async () => {
    await fs.writeFile(path.join(repositoryRoot, 'package.json'), JSON.stringify({
      name: 'validation-fixture',
      scripts: { compile: 'tsc -p ./', test: 'node run-test.js' },
      contributes: { commands: [{ command: 'unrelated.dirty' }] },
    }));

    const runner = new CodingValidationRunner(worktreeRoot, 10_000);
    const results = await runner.runAll([{ kind: 'tsc-no-emit' }]);

    expect(results[0].exitCode).toBe(0);
    expect(results[0].command).toBe('npx tsc --noEmit --pretty false');
    await expect(fs.lstat(path.join(worktreeRoot, 'node_modules'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  // Test A — executes workspace-local TypeScript through the projected
  // dependency snapshot: the exact "npx tsc --noEmit --pretty false"
  // validation command that failed in the dogfood run.
  it('executes workspace-local TypeScript inside the isolated worktree using the projected snapshot', async () => {
    const runner = new CodingValidationRunner(worktreeRoot, 10_000);
    const results = await runner.runAll([{ kind: 'tsc-no-emit' }]);

    expect(results[0].exitCode).toBe(0);
    expect(results[0].command).toBe('npx tsc --noEmit --pretty false');
    const markerArgs = JSON.parse(await fs.readFile(path.join(worktreeRoot, 'tsc-ran.marker'), 'utf8'));
    expect(markerArgs).toEqual(['--noEmit', '--pretty', 'false']);
    // The source checkout's own tsc script is untouched, and the projected
    // copy is gone once validation finishes.
    await expect(fs.readFile(path.join(repositoryRoot, 'node_modules', 'typescript', 'bin', 'tsc'), 'utf8')).resolves.toContain('tsc-ran.marker');
    await expect(fs.lstat(path.join(worktreeRoot, 'node_modules'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  // Test B — npm test resolves dependencies from the projected snapshot.
  it('resolves dependencies for npm test through the projected snapshot', async () => {
    const runner = new CodingValidationRunner(worktreeRoot, 10_000);
    const results = await runner.runAll([{ kind: 'npm-test' }]);

    expect(results[0].exitCode).toBe(0);
    await expect(fs.readFile(path.join(worktreeRoot, 'npm-test-ran.marker'), 'utf8')).resolves.toBe('fixture-value');
    await expect(fs.lstat(path.join(worktreeRoot, 'node_modules'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  // Test C — the source checkout's installed dependencies are never mutated
  // by validation running against the isolated worktree's copy.
  it('never mutates the source checkout node_modules while validation runs', async () => {
    const release = await projectWorktreeDependencies(worktreeRoot);
    await fs.writeFile(path.join(worktreeRoot, 'node_modules', 'dependency-marker.txt'), 'mutated-in-worktree');
    await expect(fs.readFile(path.join(repositoryRoot, 'node_modules', 'dependency-marker.txt'), 'utf8')).resolves.toBe('shared');
    await release();
  });

  // Test D — worktree cleanup (WorktreeManager's own worktree removal) is
  // unaffected: the dependency projection is released independently, before
  // any WorktreeManager cleanup runs, and never touches the source tree.
  it('cleanup of the isolated worktree never removes source dependencies', async () => {
    const release = await projectWorktreeDependencies(worktreeRoot);
    await release();
    await fs.rm(worktreeRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    await expect(fs.readFile(path.join(repositoryRoot, 'node_modules', 'dependency-marker.txt'), 'utf8')).resolves.toBe('shared');
  });

  // Test F — the task's OWN proposed manifest edit (not the main checkout's)
  // must also refuse reuse of the old snapshot: a proposal that changes
  // package.json/lockfile must never validate against stale dependencies.
  it('refuses dependency projection when the task worktree itself has changed the manifest', async () => {
    await fs.writeFile(path.join(worktreeRoot, 'package.json'), JSON.stringify({ name: 'validation-fixture', scripts: { compile: 'tsc -p ./', test: 'node run-test.js', extra: 'true' } }));

    const release = await projectWorktreeDependencies(worktreeRoot);

    await expect(fs.lstat(path.join(worktreeRoot, 'node_modules'))).rejects.toMatchObject({ code: 'ENOENT' });
    // The source checkout's manifest is untouched by the refusal.
    await expect(fs.readFile(path.join(repositoryRoot, 'package.json'), 'utf8')).resolves.toContain('validation-fixture');
    await release();
  });

  // Test H — the projection is released even when a validation command is
  // cancelled mid-run, so a non-happy-path exit never leaves the projected
  // snapshot (a real directory tree on Windows, not a reparse point) behind.
  it('releases the projected snapshot even when validation is cancelled', async () => {
    await fs.writeFile(path.join(repositoryRoot, 'package.json'), JSON.stringify({
      name: 'validation-fixture',
      scripts: { compile: 'tsc -p ./', test: 'node run-test.js', slow: 'node -e "setTimeout(()=>{},5000)"' },
    }));
    await fs.writeFile(path.join(worktreeRoot, 'package.json'), await fs.readFile(path.join(repositoryRoot, 'package.json'), 'utf8'));

    const runner = new CodingValidationRunner(worktreeRoot, 10_000);
    const abort = new AbortController();
    abort.abort();
    await expect(runner.runAll([{ kind: 'npm-script', script: 'slow' }], abort.signal)).rejects.toThrow('cancelled');
    await expect(fs.lstat(path.join(worktreeRoot, 'node_modules'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('CodingValidationRunner worktree dependencies — no source snapshot (Test G)', () => {
  let parent: string;
  let repositoryRoot: string;
  let worktreeRoot: string;

  beforeEach(async () => {
    parent = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-validation-nodeps-'));
    repositoryRoot = path.join(parent, 'repository');
    worktreeRoot = path.join(parent, 'worktree');
    await fs.mkdir(repositoryRoot, { recursive: true });
    await fs.writeFile(path.join(repositoryRoot, 'package.json'), JSON.stringify({ name: 'no-deps-fixture', scripts: { compile: 'tsc -p ./' } }));
    await fs.writeFile(path.join(repositoryRoot, '.gitignore'), 'node_modules/\n');
    await git(repositoryRoot, ['init']);
    await git(repositoryRoot, ['config', 'user.email', 'validation@example.invalid']);
    await git(repositoryRoot, ['config', 'user.name', 'Validation Fixture']);
    await git(repositoryRoot, ['add', '.']);
    await git(repositoryRoot, ['commit', '-m', 'init']);
    // Deliberately no node_modules anywhere — including the source checkout.
    await git(repositoryRoot, ['worktree', 'add', '-b', 'no-deps-worktree', worktreeRoot, 'HEAD']);
  });

  afterEach(async () => {
    await fs.rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it('keeps the truthful validation-tool-unavailable result when the source checkout has no node_modules either', async () => {
    const runner = new CodingValidationRunner(worktreeRoot, 10_000);
    const results = await runner.runAll([{ kind: 'tsc-no-emit' }]);

    expect(results[0].exitCode).toBeNull();
    expect(results[0].output).toMatch(/validation-tool-unavailable: workspace-local TypeScript is not installed\./);
    await expect(fs.lstat(path.join(worktreeRoot, 'node_modules'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
