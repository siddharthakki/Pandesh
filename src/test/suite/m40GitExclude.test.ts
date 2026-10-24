import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { ensureGitExclude } from '../../util/ensureGitExclude';

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync('git', args, { cwd, windowsHide: true, maxBuffer: 1024 * 1024 });
  return result.stdout;
}

async function initGit(root: string): Promise<void> {
  await fs.writeFile(path.join(root, 'README.md'), '# M40 exclude test\n', 'utf8');
  for (const args of [
    ['init'],
    ['config', 'user.email', 'test@example.com'],
    ['config', 'user.name', 'Test'],
    ['add', '.'],
    ['commit', '-m', 'init'],
  ]) {
    await git(root, args);
  }
}

describe('M40 ensureGitExclude', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-m40-exclude-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('creates .git/info/exclude with .ollama-agent/ in a fresh real git repo', async () => {
    await initGit(root);
    await ensureGitExclude(root);
    const contents = await fs.readFile(path.join(root, '.git', 'info', 'exclude'), 'utf8');
    expect(contents.split(/\r?\n/).map(line => line.trim())).toContain('.ollama-agent/');
  });

  it('does not duplicate the line when called twice', async () => {
    await initGit(root);
    await ensureGitExclude(root);
    await ensureGitExclude(root);
    const contents = await fs.readFile(path.join(root, '.git', 'info', 'exclude'), 'utf8');
    const occurrences = contents.split(/\r?\n/).filter(line => line.trim() === '.ollama-agent/').length;
    expect(occurrences).toBe(1);
  });

  it('preserves any pre-existing exclude content and appends the new line', async () => {
    await initGit(root);
    await fs.mkdir(path.join(root, '.git', 'info'), { recursive: true });
    await fs.writeFile(path.join(root, '.git', 'info', 'exclude'), '*.local\n', 'utf8');
    await ensureGitExclude(root);
    const contents = await fs.readFile(path.join(root, '.git', 'info', 'exclude'), 'utf8');
    expect(contents).toContain('*.local');
    expect(contents.split(/\r?\n/).map(line => line.trim())).toContain('.ollama-agent/');
  });

  it('keeps files under an existing .ollama-agent/ directory out of git status --porcelain', async () => {
    await initGit(root);
    await fs.mkdir(path.join(root, '.ollama-agent'), { recursive: true });
    await fs.writeFile(path.join(root, '.ollama-agent', 'state.json'), '{}', 'utf8');
    await ensureGitExclude(root);
    const status = await git(root, ['status', '--porcelain']);
    expect(status).not.toContain('.ollama-agent');
  });

  it('is a no-op outside a git repository (no .git directory) and never throws', async () => {
    await expect(ensureGitExclude(root)).resolves.toBeUndefined();
    const exists = await fs.stat(path.join(root, '.git')).then(() => true, () => false);
    expect(exists).toBe(false);
  });

  it('never throws even if the logger callback itself throws while handling a real failure', async () => {
    await initGit(root);
    // Force a genuine failure path: make `.git/info` an ordinary file so
    // `mkdir(infoDir, { recursive: true })` cannot create the directory.
    await fs.rm(path.join(root, '.git', 'info'), { recursive: true, force: true }).catch(() => undefined);
    await fs.writeFile(path.join(root, '.git', 'info'), 'not a directory', 'utf8');
    await expect(ensureGitExclude(root, () => {
      throw new Error('logger exploded');
    })).resolves.toBeUndefined();
  });

  it('does not modify .gitignore', async () => {
    await initGit(root);
    await fs.writeFile(path.join(root, '.gitignore'), 'node_modules/\n', 'utf8');
    await ensureGitExclude(root);
    const gitignore = await fs.readFile(path.join(root, '.gitignore'), 'utf8');
    expect(gitignore).toBe('node_modules/\n');
  });
});
