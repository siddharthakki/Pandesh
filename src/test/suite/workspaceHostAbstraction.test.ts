import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { discoverWorkspaceRoot, discoverWorkspaceDescriptor } from '../../workspace/WorkspaceDiscovery';
import { WorkspaceHostFactory, PlainFolderHost, GitWorktreeHost } from '../../workspace/WorkspaceHost';
import { discoverWorkspaceCapabilities } from '../../workspace/PolyglotDiscovery';

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd, windowsHide: true });
}

async function mkTemp(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe('M44.1 workspace discovery', () => {
  let gitRoot: string;
  let plainRoot: string;
  let emptyRoot: string;
  let nestedRoot: string;

  beforeEach(async () => {
    gitRoot = await mkTemp('oa-ws-git-');
    await fs.writeFile(path.join(gitRoot, 'README.md'), '# repo\n', 'utf8');
    await git(gitRoot, ['init']);
    await git(gitRoot, ['config', 'user.email', 'test@example.com']);
    await git(gitRoot, ['config', 'user.name', 'Test']);
    await git(gitRoot, ['add', '.']);
    await git(gitRoot, ['commit', '-m', 'init']);

    plainRoot = await mkTemp('oa-ws-plain-');
    await fs.writeFile(path.join(plainRoot, 'notes.txt'), 'hello\n', 'utf8');

    emptyRoot = await mkTemp('oa-ws-empty-');

    nestedRoot = path.join(gitRoot, 'subdir');
    await fs.mkdir(nestedRoot, { recursive: true });
  });

  afterEach(async () => {
    for (const dir of [gitRoot, plainRoot, emptyRoot]) {
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('classifies a Git repository root as "git"', async () => {
    const descriptor = await discoverWorkspaceRoot(gitRoot);
    expect(descriptor.kind).toBe('git');
    expect(descriptor.gitRoot).toBeTruthy();
  });

  it('classifies a non-empty non-Git folder as "plain"', async () => {
    const descriptor = await discoverWorkspaceRoot(plainRoot);
    expect(descriptor.kind).toBe('plain');
  });

  it('classifies an empty folder as "empty"', async () => {
    const descriptor = await discoverWorkspaceRoot(emptyRoot);
    expect(descriptor.kind).toBe('empty');
  });

  it('classifies a subfolder of a Git repository as "nested-git"', async () => {
    const descriptor = await discoverWorkspaceRoot(nestedRoot);
    expect(descriptor.kind).toBe('nested-git');
    expect(descriptor.parentRepoRoot).toBeTruthy();
  });

  it('builds a multi-root descriptor covering every folder, not just the first', async () => {
    const descriptor = await discoverWorkspaceDescriptor([{ path: gitRoot }, { path: plainRoot }, { path: emptyRoot }]);
    expect(descriptor?.roots).toHaveLength(3);
    expect(descriptor?.roots.map(root => root.kind)).toEqual(['git', 'plain', 'empty']);
    expect(descriptor?.primaryRoot.path).toBe(descriptor?.roots[0].path);
  });

  it('WorkspaceHostFactory picks GitWorktreeHost only for a real Git repo root', async () => {
    const gitDescriptor = await discoverWorkspaceRoot(gitRoot);
    expect(WorkspaceHostFactory.forRoot(gitDescriptor)).toBeInstanceOf(GitWorktreeHost);

    const plainDescriptor = await discoverWorkspaceRoot(plainRoot);
    expect(WorkspaceHostFactory.forRoot(plainDescriptor)).toBeInstanceOf(PlainFolderHost);

    const nestedDescriptor = await discoverWorkspaceRoot(nestedRoot);
    expect(WorkspaceHostFactory.forRoot(nestedDescriptor)).toBeInstanceOf(PlainFolderHost);
  });
});

describe('M44.1 PlainFolderHost', () => {
  let root: string;
  let host: PlainFolderHost;

  beforeEach(async () => {
    root = await mkTemp('oa-ws-plainhost-');
    host = new PlainFolderHost(root);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('creates a lease with plain-scope-lock isolation and no git fields', async () => {
    const lease = await host.createLease('task-a', ['src/**/*']);
    expect(lease.isolation).toBe('plain-scope-lock');
    expect(lease.status).toBe('active');
    expect(lease.worktreePath).toBe(lease.repositoryRoot);
  });

  it('rejects a second lease whose scope overlaps an active one', async () => {
    await host.createLease('task-a', ['**/*']);
    await expect(host.createLease('task-b', ['src/only.ts'])).rejects.toThrow(/overlap/);
  });

  it('allows a second lease once the first is marked inactive', async () => {
    await host.createLease('task-a', ['**/*']);
    await host.markStatus('task-a', 'completed');
    await expect(host.createLease('task-b', ['**/*'])).resolves.toMatchObject({ taskId: 'task-b' });
  });

  it('cleanup removes the lease from the manifest', async () => {
    await host.createLease('task-a', ['**/*']);
    await host.cleanup('task-a');
    expect(await host.listLeases()).toHaveLength(0);
  });

  it('seeds files directly into the live folder (no isolated copy exists)', async () => {
    await host.createLease('task-a', ['**/*'], undefined, [{ path: 'seeded.txt', content: 'seeded\n' }]);
    const content = await fs.readFile(path.join(root, 'seeded.txt'), 'utf8');
    expect(content).toBe('seeded\n');
  });
});

describe('M44.2 polyglot capability discovery', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkTemp('oa-ws-polyglot-');
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('detects node + python + docker signals and nested repos without requiring Git', async () => {
    await fs.writeFile(path.join(root, 'package.json'), '{}', 'utf8');
    await fs.writeFile(path.join(root, 'pnpm-lock.yaml'), '', 'utf8');
    await fs.mkdir(path.join(root, 'service'), { recursive: true });
    await fs.writeFile(path.join(root, 'service', 'requirements.txt'), 'flask\n', 'utf8');
    await fs.writeFile(path.join(root, 'Dockerfile'), 'FROM node\n', 'utf8');
    await fs.mkdir(path.join(root, 'tests'), { recursive: true });
    await fs.mkdir(path.join(root, 'vendored-repo', '.git'), { recursive: true });

    const capabilities = await discoverWorkspaceCapabilities({ path: root, kind: 'plain' });
    expect(capabilities.languages).toEqual(expect.arrayContaining(['node', 'python']));
    expect(capabilities.packageManagers).toContain('pnpm');
    expect(capabilities.hasDocker).toBe(true);
    expect(capabilities.testDirs).toContain('tests');
    expect(capabilities.nestedRepos).toHaveLength(1);
  });
});
