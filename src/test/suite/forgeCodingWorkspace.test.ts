import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { WorkspaceInspectionTools, classifyGitGrepResult } from '../../coding/WorkspaceInspection';

describe('Forge coding workspace inspection tools', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-coding-inspect-'));
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    await fs.writeFile(path.join(root, 'src', 'a.ts'), 'export const alpha = 1;\n');
    await fs.writeFile(path.join(root, 'src', 'b.bin'), Buffer.from([0, 1, 2]));
    await fs.mkdir(path.join(root, 'node_modules'), { recursive: true });
    await fs.writeFile(path.join(root, 'node_modules', 'skip.ts'), 'secret');
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('lists, reads and searches bounded text files while excluding cache directories', async () => {
    const tools = new WorkspaceInspectionTools(root, { maxFiles: 10, maxReadBytes: 1000, maxSearchResults: 1 });
    const files = await tools.listFiles();
    expect(files.map(file => file.path)).toContain('src/a.ts');
    expect(files.map(file => file.path)).not.toContain('node_modules/skip.ts');
    const file = await tools.readTextFile('src/a.ts');
    expect(file.fingerprint).toMatch(/^sha256:/);
    const found = await tools.searchText('alpha');
    expect(found.ok).toBe(true);
    if (found.ok) expect(found.matches).toHaveLength(1);
  });

  it('search finds a tracked file beyond the listFiles preview cap', async () => {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile);
    for (let index = 0; index < 12; index += 1) {
      await fs.writeFile(path.join(root, `early-${index}.txt`), `early ${index}\n`);
    }
    await fs.mkdir(path.join(root, 'zzz'), { recursive: true });
    await fs.writeFile(path.join(root, 'zzz', 'target.ts'), 'export const NEEDLE = 1;\n');
    await run('git', ['init'], { cwd: root, windowsHide: true });
    await run('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=test', 'add', '-A'], { cwd: root, windowsHide: true });
    await run('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=test', 'commit', '-m', 'seed'], { cwd: root, windowsHide: true });
    const tools = new WorkspaceInspectionTools(root, { maxFiles: 5, maxReadBytes: 10_000, maxSearchResults: 20 });
    const listed = await tools.listFiles();
    expect(listed.length).toBe(5);
    expect(listed.map(file => file.path)).not.toContain('zzz/target.ts');
    const hits = await tools.searchText('NEEDLE');
    expect(hits.ok).toBe(true);
    if (hits.ok) {
      expect(hits.matches.some(hit => hit.path === 'zzz/target.ts' && hit.text.includes('NEEDLE'))).toBe(true);
    }
  });

  it('treats git grep timeout as a search failure, not a genuine zero-match', () => {
    expect(classifyGitGrepResult({ stdout: '', exitCode: 1 })).toBe('ok');
    expect(classifyGitGrepResult({ stdout: '', exitCode: 0 })).toBe('ok');
    expect(classifyGitGrepResult({ stdout: '', exitCode: 1, timedOut: true })).toBe('timed_out');
    expect(classifyGitGrepResult({ stdout: '', exitCode: -1, timedOut: true })).toBe('timed_out');
    expect(classifyGitGrepResult({ stdout: '', exitCode: 128, spawnError: true })).toBe('unavailable');
    expect(classifyGitGrepResult({ stdout: '', exitCode: 128 })).toBe('unavailable');
  });

  it('reports a genuine empty git grep as ok with zero matches', async () => {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile);
    await run('git', ['init'], { cwd: root, windowsHide: true });
    await run('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=test', 'add', '-A'], { cwd: root, windowsHide: true });
    await run('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=test', 'commit', '-m', 'seed'], { cwd: root, windowsHide: true });
    const tools = new WorkspaceInspectionTools(root);
    const miss = await tools.searchText('THIS_SUBSTRING_DOES_NOT_EXIST_ANYWHERE');
    expect(miss).toEqual({ ok: true, matches: [], source: 'git' });
  });

  it('rejects binary, outside-workspace and cancelled reads', async () => {
    const tools = new WorkspaceInspectionTools(root);
    await expect(tools.readTextFile('src/b.bin')).rejects.toThrow('binary_file_rejected');
    await expect(tools.readTextFile('../outside.ts')).rejects.toThrow('path_traversal_rejected');
    const abort = new AbortController();
    abort.abort();
    await expect(tools.listFiles(abort.signal)).rejects.toThrow('cancelled');
  });

  it('rejects symlink escapes when the platform supports symlinks', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-coding-outside-'));
    try {
      await fs.writeFile(path.join(outside, 'escape.ts'), 'outside');
      await fs.symlink(outside, path.join(root, 'src', 'escape'), 'junction');
      const tools = new WorkspaceInspectionTools(root);
      await expect(tools.listFiles()).rejects.toThrow('path_outside_workspace');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EPERM') {
        throw error;
      }
    } finally {
      await fs.rm(outside, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});
