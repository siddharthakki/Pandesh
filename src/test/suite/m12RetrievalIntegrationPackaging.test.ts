import { describe, it, expect, afterEach } from 'vitest';
import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { RepositoryIndex } from '../../context/RepositoryIndex';
import { ContextSelector } from '../../context/ContextSelector';
import { RepositoryContextService } from '../../context/RepositoryContextService';

const execFileAsync = promisify(execFile);

async function write(root: string, relative: string, content: string): Promise<void> {
  const target = path.join(root, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, 'utf8');
}

async function fixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-m12-retrieval-'));
  await write(root, '.gitignore', '.ollama-agent/\n');
  await write(root, 'src/service.ts', "import { repo } from './repo';\nexport function loadUser() { throw new Error('USER_MISSING'); }\nexport const service = repo;\n");
  await write(root, 'src/repo.ts', 'export const repo = { find: () => 1 };\n');
  await write(root, 'src/service.test.ts', "import { loadUser } from './service';\ntest('loadUser', () => expect(loadUser).toThrow);\n");
  await write(root, 'README.md', 'loadUser troubleshooting USER_MISSING\n');
  return root;
}

async function readOptional(filePath: string): Promise<Buffer | undefined> {
  try {
    return await fs.readFile(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function rootVsixFiles(repoRoot: string): Promise<string[]> {
  return (await fs.readdir(repoRoot))
    .filter(name => name.toLowerCase().endsWith('.vsix'))
    .sort();
}

async function run(command: string, args: string[], cwd: string, timeout = 120_000): Promise<void> {
  // Node's child_process tightened Windows .cmd/.bat spawning to require an
  // explicit shell (spawning them directly now throws EINVAL); every command
  // this test invokes on Windows resolves to a .cmd shim (npm.cmd, vsce.cmd).
  // The command output is intentionally not evidence: this test verifies the
  // produced VSIX and its extracted runtime. `execFile` retains all stdout
  // and stderr until exit; Windows packaging can emit an unbounded stream and
  // made the isolated Vitest worker exhaust its heap after assertions passed.
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      shell: process.platform === 'win32' && command.toLowerCase().endsWith('.cmd'),
      stdio: 'ignore',
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${command} timed out after ${timeout}ms`));
    }, timeout);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with code ${code ?? 'null'}${signal ? ` (signal ${signal})` : ''}`));
    });
  });
}

function sha256(value: Buffer | undefined): string | null {
  return value ? crypto.createHash('sha256').update(value).digest('hex') : null;
}

describe('M12 retrieval, integration, git isolation, and packaged runtime', () => {
  let roots: string[] = [];

  afterEach(async () => {
    for (const root of roots) await fs.rm(root, { recursive: true, force: true });
    roots = [];
  });

  it('retrieves exact symbols, filenames, paths, error messages, dependencies, tests, pins, exclusions, stale filtering, and bounded omissions deterministically', async () => {
    const root = await fixture(); roots.push(root);
    const index = new RepositoryIndex(root);
    await index.build(true);
    await index.pin('README.md');
    await index.exclude('src/repo.ts');
    await index.updateChangedFiles(['README.md']);
    expect(index.isFts5Available()).toBeTypeOf('boolean');
    expect(await index.searchSymbols('loadUser')).toEqual(expect.arrayContaining([
      expect.objectContaining({ file: 'src/service.ts' }),
    ]));

    await fs.rm(path.join(root, 'src/repo.ts'));
    const withDeleted = await index.updateChangedFiles(['src/repo.ts']);
    const result = await new ContextSelector(root).select(withDeleted, {
      query: 'Fix USER_MISSING in src/service.ts loadUser',
      role: 'validator',
      model: 'qwen3-coder:30b',
      tokenBudget: 900,
      maxFiles: 3,
      hints: { diagnosticFiles: [{ path: 'src/service.ts', severity: 'error', message: 'USER_MISSING' }] },
    });
    expect(result.files.map(file => file.path)).toEqual(['README.md', 'src/service.ts', 'src/service.test.ts']);
    expect(result.files.find(file => file.path === 'README.md')?.reasons.map(reason => reason.reason)).toContain('user pinned');
    expect(result.files.some(file => file.path === 'src/repo.ts')).toBe(false);
    expect(result.diagnostics.rejectedFiles.some(file => file.reason === 'max file count reached')).toBe(true);
    expect(result.diagnostics.omittedCount).toBeGreaterThan(0);
  });

  it('feeds RepositoryContextService and persists safe Forge evidence fields', async () => {
    const root = await fixture(); roots.push(root);
    const service = new RepositoryContextService(root);
    const result = await service.build({
      query: 'Fix src/service.ts USER_MISSING',
      mode: 'agent',
      model: 'qwen3-coder:30b',
      tokenBudget: 1400,
      forceIndexRefresh: true,
    });
    expect(result.prompt).toContain('Automatically selected repository context');
    expect(result.files.map(file => file.path)).toContain('src/service.ts');
    const status = await service.status();
    expect(status.storage.kind).toBe('sqlite');
    expect(status.statistics.files).toBeGreaterThan(0);
    expect(status.selectedFiles).toEqual([]);

    const taskDir = path.join(root, '.ollama-agent', 'tasks', 'm12');
    await service.persist(taskDir, result);
    const persisted = JSON.parse(await fs.readFile(path.join(taskDir, 'context-selection.json'), 'utf8')) as {
      selectedFiles: Array<{ path: string; reasons: Array<{ reason: string }> }>;
      diagnostics: { packageHash: string };
    };
    expect(persisted.selectedFiles[0].path).not.toMatch(/[A-Za-z]:\\/);
    expect(persisted.selectedFiles[0].reasons.length).toBeGreaterThan(0);
    expect(persisted.diagnostics.packageHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('isolates branch, commit, detached head, separate worktree, and identical content hashes', async () => {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-m12-git-')); roots.push(repo);
    const git = (args: string[], cwd = repo) => execFileAsync('git', args, { cwd, windowsHide: true });
    await git(['init']);
    await git(['config', 'user.email', 'm12@example.test']);
    await git(['config', 'user.name', 'M12']);
    await write(repo, '.gitignore', '.ollama-agent/\n');
    await write(repo, 'src/same.ts', 'export const same = true;\n');
    await git(['add', '.']); await git(['commit', '-m', 'main']);
    const main = await new RepositoryIndex(repo).build(true);
    await git(['checkout', '-b', 'other']);
    await write(repo, 'src/other.ts', 'export const same = true;\n');
    await git(['add', '.']); await git(['commit', '-m', 'other']);
    const other = await new RepositoryIndex(repo).build(true);
    await git(['checkout', main.identity.headCommit]);
    const detached = await new RepositoryIndex(repo).build(true);
    const worktree = `${repo}-wt`; roots.push(worktree);
    await git(['worktree', 'add', worktree, 'other']);
    const wt = await new RepositoryIndex(worktree).build(true);
    expect(main.identity.branch).not.toBe(other.identity.branch);
    expect(main.identity.headCommit).not.toBe(other.identity.headCommit);
    expect(detached.identity.detached).toBe(true);
    expect(wt.identity.worktree).not.toBe(other.identity.worktree);
    expect(other.files.find(file => file.path === 'src/same.ts')?.contentHash).toBe(other.files.find(file => file.path === 'src/other.ts')?.contentHash);
    expect(other.files.find(file => file.path === 'src/other.ts')?.path).toBe('src/other.ts');
  });

  it('packages into a test-owned temporary directory and loads runtime dependencies without repository-local fallback', async () => {
    const repoRoot = path.resolve(__dirname, '..', '..', '..');
    const rootArtifact = path.join(repoRoot, 'karkedikha-win32-x64.vsix');
    const rootArtifactBefore = await readOptional(rootArtifact);
    const rootVsixBefore = await rootVsixFiles(repoRoot);

    const packageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-m12-package-output-'));
    roots.push(packageRoot);
    const vsixPath = path.join(packageRoot, 'karkedikha-win32-x64.vsix');
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    // Call the JavaScript CLI directly. The Windows `.cmd` shim starts an
    // unattached shell when called from a Vitest fork, so its output keeps
    // accumulating in that worker while the package command is in flight.
    const vsce = path.join(repoRoot, 'node_modules', '@vscode', 'vsce', 'vsce');

    await run(npm, ['run', 'compile'], repoRoot);
    await run(process.execPath, [path.join(repoRoot, 'esbuild.js'), '--production'], repoRoot);
    await run(process.execPath, [path.join(repoRoot, 'esbuild.core.js'), '--production'], repoRoot);
    await run(process.execPath, [vsce, 'package', '--target', 'win32-x64', '--out', vsixPath], repoRoot, 180_000);

    expect((await fs.stat(vsixPath)).isFile()).toBe(true);
    const rootArtifactAfter = await readOptional(rootArtifact);
    // Compare the exact artifact bytes without asking Vitest to recursively
    // diff two 70+ MB Buffers (its rich diff path retains multi-GiB state).
    expect(sha256(rootArtifactAfter)).toBe(sha256(rootArtifactBefore));
    expect(await rootVsixFiles(repoRoot)).toEqual(rootVsixBefore);

    const extractRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-m12-packaged-vsix-'));
    roots.push(extractRoot);
    const expandedRoot = path.join(extractRoot, 'expanded');
    await fs.mkdir(expandedRoot, { recursive: true });

    if (process.platform === 'win32') {
      // Expand-Archive refuses a .vsix extension outright ("only .zip is
      // supported") even though a VSIX is a plain zip — stage a .zip-named
      // copy first.
      const zipAlias = path.join(extractRoot, 'karkedikha-win32-x64.zip');
      await fs.copyFile(vsixPath, zipAlias);
      const psQuote = (value: string) => `'${value.replace(/'/g, "''")}'`;
      await run('powershell', ['-NoProfile', '-Command', `$ErrorActionPreference = 'Stop'; Expand-Archive -LiteralPath ${psQuote(zipAlias)} -DestinationPath ${psQuote(expandedRoot)} -Force`], extractRoot, 60_000);
    } else {
      await run('unzip', ['-q', vsixPath, '-d', expandedRoot], extractRoot, 60_000);
    }

    const extensionRoot = path.join(expandedRoot, 'extension');
    const bundlePath = path.join(extensionRoot, 'out', 'extension.js');
    expect((await fs.stat(bundlePath)).isFile()).toBe(true);
    const bundleSource = await fs.readFile(bundlePath, 'utf8');
    expect(bundleSource).toContain('proposalConsumption');
    expect(bundleSource).toContain('forge.invocation.runFixedMultiAgentGraph');
    expect(bundleSource).toContain('FixedMultiAgentGraph');

    // Approval-card DOM ownership (inline placement, resolved-history) lives
    // solely in chat-autonomous.js — chat-sidebar-ui.js must ship without it.
    const packagedAutonomous = await fs.readFile(path.join(extensionRoot, 'media', 'chat-autonomous.js'), 'utf8');
    expect(packagedAutonomous).toContain("const timeline = document.getElementById('autonomous-timeline')");
    expect(packagedAutonomous).toContain('timeline.appendChild(card)');
    expect(packagedAutonomous).toContain("waiting_for_delivery_approval: 'waiting'");
    expect(packagedAutonomous).toContain('Review the inline approval card below to continue.');
    expect(packagedAutonomous).toContain("card.dataset.inlineApprovalState = 'resolved'");

    const packagedSidebar = await fs.readFile(path.join(extensionRoot, 'media', 'chat-sidebar-ui.js'), 'utf8');
    expect(packagedSidebar).not.toContain('autonomous-timeline');
    expect(packagedSidebar).not.toContain('proposal-approval-card');
    expect(packagedSidebar).not.toContain('mutation-approval-card');
    expect(packagedSidebar).not.toContain('delivery-approval-card');

    const graphSmokeScript = `
const assert = require('assert');
const Module = require('module');
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'vscode') {
    return {
      workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback, inspect: () => undefined }) },
      Uri: { file: value => ({ fsPath: value }) },
      EventEmitter: class { event = () => ({ dispose() {} }); fire() {}; dispose() {} },
      Disposable: { from: (...items) => ({ dispose: () => items.forEach(item => item && item.dispose && item.dispose()) }) },
    };
  }
  return originalLoad.apply(this, arguments);
};
const bundle = require(${JSON.stringify(bundlePath)});
assert.strictEqual(typeof bundle.activate, 'function');
assert.strictEqual(typeof bundle.deactivate, 'function');
console.log('M13_BUNDLE_LOADED_OK');
`;
    const graphSmoke = await execFileAsync(process.execPath, ['-e', graphSmokeScript], {
      cwd: extractRoot,
      env: { ...process.env, NODE_PATH: '' },
      windowsHide: true,
      timeout: 60_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    expect(graphSmoke.stdout).toContain('M13_BUNDLE_LOADED_OK');

    const sqlitePackagePath = path.join(extensionRoot, 'node_modules', '@vscode', 'sqlite3');
    const nativeBinaryPath = path.join(sqlitePackagePath, 'build', 'Release', 'vscode-sqlite3.node');
    expect((await fs.stat(nativeBinaryPath)).isFile()).toBe(true);
    // Both bundles are self-contained except `vscode` and the native sqlite3 module (esbuild.js externals), so the
    // package ships sqlite3's runtime files and no other dependency tree. TypeScript is compiled into
    // out/extension.js (RepositoryIndex imports it statically); a loose node_modules/typescript would be dead weight.
    expect((await fs.readdir(path.join(extensionRoot, 'node_modules'))).sort()).toEqual(['@vscode']);
    expect((await fs.readdir(path.join(extensionRoot, 'node_modules', '@vscode'))).sort()).toEqual(['sqlite3']);
    expect(bundleSource).toContain('createSourceFile');

    const smokeScript = `
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const repoNodeModules = ${JSON.stringify(path.join(repoRoot, 'node_modules'))};
const sqlitePackagePath = ${JSON.stringify(sqlitePackagePath)};
const nativeBinaryPath = ${JSON.stringify(nativeBinaryPath)};
assert(!module.paths.some(p => path.resolve(p) === path.resolve(repoNodeModules)));
for (const id of ['@vscode/sqlite3', 'typescript']) {
  try { require.resolve(id); throw new Error(id + ' unexpectedly resolved'); }
  catch (error) { if (error && error.code !== 'MODULE_NOT_FOUND') throw error; }
}
assert(fs.existsSync(nativeBinaryPath));
const sqlite = require(sqlitePackagePath);
const opened = (filename, mode) => new Promise((resolve, reject) => {
  const db = new sqlite.Database(filename, mode, error => error ? reject(error) : resolve(db));
});
const run = (db, sql, params) => new Promise((resolve, reject) => db.run(sql, params || [], error => error ? reject(error) : resolve()));
const get = (db, sql, params) => new Promise((resolve, reject) => db.get(sql, params || [], (error, row) => error ? reject(error) : resolve(row)));
const close = db => new Promise((resolve, reject) => db.close(error => error ? reject(error) : resolve()));
(async () => {
  const dbPath = path.join(os.tmpdir(), 'oa-m12-packaged-' + process.pid + '.sqlite');
  try { fs.unlinkSync(dbPath); } catch {}
  let db = await opened(dbPath, sqlite.OPEN_READWRITE | sqlite.OPEN_CREATE);
  await run(db, 'CREATE TABLE packaged_check (id INTEGER PRIMARY KEY, label TEXT NOT NULL)');
  await run(db, 'INSERT INTO packaged_check(label) VALUES (?)', ['from-extracted-vsix']);
  await close(db);
  db = await opened(dbPath, sqlite.OPEN_READONLY);
  const row = await get(db, 'SELECT label FROM packaged_check WHERE id = 1');
  await close(db);
  assert.deepStrictEqual(row, { label: 'from-extracted-vsix' });
  const usedRepoLocal = Object.keys(require.cache).some(file => path.resolve(file).startsWith(path.resolve(repoNodeModules) + path.sep));
  assert.strictEqual(usedRepoLocal, false);
  try { fs.unlinkSync(dbPath); } catch {}
  console.log('PACKAGED_SQLITE_OK');
  console.log('LOCAL_REPOSITORY_NODE_MODULES_USED=false');
})().catch(error => { console.error(error && error.stack || error); process.exit(1); });
`;
    const smoke = await execFileAsync(process.execPath, ['-e', smokeScript], {
      cwd: extractRoot,
      env: { ...process.env, NODE_PATH: '' },
      windowsHide: true,
      timeout: 60_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    expect(smoke.stdout).toContain('PACKAGED_SQLITE_OK');
    expect(smoke.stdout).toContain('LOCAL_REPOSITORY_NODE_MODULES_USED=false');
  }, 300_000);
});
