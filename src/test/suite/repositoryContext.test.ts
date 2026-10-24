import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as sqlite3 from '@vscode/sqlite3';
import { RepositoryIndex } from '../../context/RepositoryIndex';
import { ContextSelector } from '../../context/ContextSelector';
import { RepositoryContextService } from '../../context/RepositoryContextService';

const execFileAsync = promisify(execFile);

async function write(root: string, relative: string, content: string): Promise<void> {
  const destination = path.join(root, relative);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, content, 'utf8');
}

function openDb(filename: string): Promise<sqlite3.Database> {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(filename, sqlite3.OPEN_READWRITE, error => error ? reject(error) : resolve(db));
  });
}

function dbGet<T>(db: sqlite3.Database, sql: string): Promise<T> {
  return new Promise((resolve, reject) => db.get(sql, (error, row) => error ? reject(error) : resolve(row as T)));
}

function dbRun(db: sqlite3.Database, sql: string): Promise<void> {
  return new Promise((resolve, reject) => db.run(sql, error => error ? reject(error) : resolve()));
}

function dbClose(db: sqlite3.Database): Promise<void> {
  return new Promise((resolve, reject) => db.close(error => error ? reject(error) : resolve()));
}

describe('repository intelligence', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-context-'));
    await write(root, '.gitignore', 'ignored/\n*.secret\n');
    await write(root, 'src/math.ts', [
      "import { clamp } from './util';",
      'export function add(a: number, b: number) { return clamp(a + b); }',
      '',
    ].join('\n'));
    await write(root, 'src/util.ts', 'export function clamp(value: number) { return Math.max(0, value); }\n');
    await write(root, 'src/math.test.ts', "import { add } from './math';\ntest('add', () => expect(add(1, 2)).toBe(3));\n");
    await write(root, 'package.json', JSON.stringify({ scripts: { test: 'vitest' } }, null, 2));
    await write(root, 'ignored/nope.ts', 'export const ignored = true;\n');
    await write(root, 'token.secret', 'secret');
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('builds an ignored-aware inventory with symbols, imports, dependencies, and tests', async () => {
    const index = new RepositoryIndex(root);
    const snapshot = await index.build(true);
    const paths = snapshot.files.map(file => file.path);
    expect(paths).toContain('src/math.ts');
    expect(paths).not.toContain('ignored/nope.ts');
    expect(paths).not.toContain('token.secret');
    expect(index.getStoragePath()).toMatch(/repository-intelligence\.sqlite$/);
    await expect(fs.stat(index.getStoragePath())).resolves.toEqual(expect.objectContaining({ size: expect.any(Number) }));

    const math = snapshot.files.find(file => file.path === 'src/math.ts');
    expect(math?.symbols).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'add', kind: 'function' }),
    ]));
    expect(math?.imports).toContain('./util');
    expect(math?.dependencies).toContain('src/util.ts');
    expect(math?.linkedTests).toContain('src/math.test.ts');
  });

  it('reports SQLite as the authoritative store', async () => {
    const service = new RepositoryContextService(root);
    const status = await service.rebuild();
    expect(status.storage.kind).toBe('sqlite');
    expect(status.storage.sqliteAvailable).toBe(true);
    expect(status.storage.path).toMatch(/repository-intelligence\.sqlite$/);
  });

  it('creates normalized schema, versioning, indexes, foreign keys, busy timeout, WAL, and FTS probe state', async () => {
    const index = new RepositoryIndex(root);
    await index.build(true);
    const db = await openDb(index.getStoragePath());
    try {
      await dbRun(db, 'PRAGMA foreign_keys = ON');
      await dbRun(db, 'PRAGMA busy_timeout = 5000');
      const migration = await dbGet<{ version: number }>(db, 'SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1');
      const fileIndex = await dbGet<{ name: string }>(db, "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_files_snapshot_path'");
      const symbolTable = await dbGet<{ name: string }>(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'symbols'");
      const fk = await dbGet<{ foreign_keys: number }>(db, 'PRAGMA foreign_keys');
      const busy = await dbGet<{ timeout: number }>(db, 'PRAGMA busy_timeout');
      const wal = await dbGet<{ journal_mode: string }>(db, 'PRAGMA journal_mode');
      const ftsTable = await dbGet<{ name?: string }>(db, "SELECT name FROM sqlite_master WHERE name = 'file_fts'");

      expect(migration.version).toBeGreaterThanOrEqual(3);
      expect(fileIndex.name).toBe('idx_files_snapshot_path');
      expect(symbolTable.name).toBe('symbols');
      expect(fk.foreign_keys).toBe(1);
      expect(busy.timeout).toBeGreaterThanOrEqual(5000);
      expect(['wal', 'delete']).toContain(wal.journal_mode.toLowerCase());
      expect(Boolean(ftsTable?.name)).toBe(index.isFts5Available());
    } finally {
      await dbClose(db);
    }
  });

  it('migrates legacy JSON once and renames it out of the active path', async () => {
    const legacyDir = path.join(root, '.ollama-agent', 'index');
    await fs.mkdir(legacyDir, { recursive: true });
    const legacyPath = path.join(legacyDir, 'repository-index.json');
    const now = new Date().toISOString();
    await fs.writeFile(legacyPath, JSON.stringify({
      schemaVersion: 2,
      workspaceRoot: root,
      identity: {
        repositoryRoot: root,
        branch: 'legacy',
        headCommit: 'legacy-head',
        worktree: path.join(root, '.git'),
        detached: false,
        schemaVersion: 2,
      },
      createdAt: now,
      updatedAt: now,
      state: 'ready',
      files: [],
      ignoredPatterns: [],
      truncated: false,
      statistics: { files: 0, symbols: 0, imports: 0, tests: 0, configs: 0, buildFiles: 0, markdown: 0, changedFiles: 0, deletedFiles: 0 },
      pins: ['src/math.ts'],
      exclusions: [],
    }), 'utf8');

    await new RepositoryIndex(root).build(true);
    await expect(fs.stat(`${legacyPath}.migrated`)).resolves.toBeTruthy();
    await expect(fs.stat(legacyPath)).rejects.toBeTruthy();
  });

  it('quarantines malformed legacy JSON instead of keeping it authoritative', async () => {
    const legacyDir = path.join(root, '.ollama-agent', 'index');
    await fs.mkdir(legacyDir, { recursive: true });
    const legacyPath = path.join(legacyDir, 'repository-index.json');
    await fs.writeFile(legacyPath, '{ malformed', 'utf8');

    await new RepositoryIndex(root).build(true);
    const files = await fs.readdir(legacyDir);
    expect(files.some(file => file.startsWith('repository-index.json.malformed-'))).toBe(true);
    expect(files).toContain('repository-intelligence.sqlite');
  });

  it('quarantines corrupt SQLite and rebuilds a usable database', async () => {
    const index = new RepositoryIndex(root);
    await fs.mkdir(path.dirname(index.getStoragePath()), { recursive: true });
    await fs.writeFile(index.getStoragePath(), 'not sqlite', 'utf8');

    const snapshot = await index.build(true);
    expect(snapshot.files.some(file => file.path === 'src/math.ts')).toBe(true);
    const files = await fs.readdir(path.dirname(index.getStoragePath()));
    expect(files.some(file => file.includes('.corrupt-'))).toBe(true);
  });

  it('keeps the prior committed index when a cancelled rebuild aborts before commit', async () => {
    const index = new RepositoryIndex(root);
    const first = await index.build(true);
    await write(root, 'src/cancelled.ts', 'export const cancelled = true;\n');
    const controller = new AbortController();
    controller.abort();

    await expect(index.build(true, controller.signal)).rejects.toThrow(/indexing_cancelled/);
    const recovered = await index.status();
    expect(recovered.updatedAt).toBe(first.updatedAt);
    expect(recovered.files.some(file => file.path === 'src/cancelled.ts')).toBe(false);
  });

  it('uses the TypeScript compiler API for TS and JS structure', async () => {
    await write(root, 'src/reexport.ts', [
      "import util = require('./util');",
      "export { clamp as limit } from './util';",
      'export default class Box { method() { return util; } }',
      'export const value = 1;',
    ].join('\n'));
    const snapshot = await new RepositoryIndex(root).build(true);
    const record = snapshot.files.find(file => file.path === 'src/reexport.ts');
    expect(record?.parseStatus).toBe('structural');
    expect(record?.imports).toEqual(expect.arrayContaining(['./util']));
    expect(record?.exports).toEqual(expect.arrayContaining(['limit', 'value']));
    expect(record?.symbols).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'Box', kind: 'class', exported: true }),
      expect.objectContaining({ name: 'value', kind: 'constant', exported: true }),
    ]));
  });

  it('isolates persisted snapshots by branch, commit, detached head, and worktree identity', async () => {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-git-context-'));
    const storagePath = path.join(repo, '.ollama-agent', 'index', 'shared.sqlite');
    const git = (args: string[], cwd = repo) => execFileAsync('git', args, { cwd, windowsHide: true });
    try {
      await git(['init']);
      await git(['config', 'user.email', 'm12@example.test']);
      await git(['config', 'user.name', 'M12 Test']);
      await write(repo, '.gitignore', '.ollama-agent/\n');
      await write(repo, 'src/main.ts', 'export const main = true;\n');
      await git(['add', '.']);
      await git(['commit', '-m', 'main']);
      const mainSnapshot = await new RepositoryIndex(repo, { storagePath }).build(true);

      await git(['checkout', '-b', 'feature/m12']);
      await write(repo, 'src/feature.ts', 'export const feature = true;\n');
      await git(['add', '.']);
      await git(['commit', '-m', 'feature']);
      const featureSnapshot = await new RepositoryIndex(repo, { storagePath }).build(true);

      await git(['checkout', mainSnapshot.identity.headCommit]);
      const detachedSnapshot = await new RepositoryIndex(repo, { storagePath }).build(true);

      const worktree = `${repo}-worktree`;
      await git(['worktree', 'add', worktree, 'feature/m12']);
      const worktreeSnapshot = await new RepositoryIndex(worktree, { storagePath }).build(true);

      expect(mainSnapshot.identity.branch).not.toBe(featureSnapshot.identity.branch);
      expect(mainSnapshot.identity.headCommit).not.toBe(featureSnapshot.identity.headCommit);
      expect(detachedSnapshot.identity.detached).toBe(true);
      expect(detachedSnapshot.identity.branch).toMatch(/^detached:/);
      expect(worktreeSnapshot.identity.worktree).not.toBe(featureSnapshot.identity.worktree);
      expect(featureSnapshot.files.some(file => file.path === 'src/feature.ts')).toBe(true);
      expect(mainSnapshot.files.some(file => file.path === 'src/feature.ts')).toBe(false);
      await fs.rm(worktree, { recursive: true, force: true });
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
      await fs.rm(`${repo}-worktree`, { recursive: true, force: true });
    }
  });

  it('selects explicit, dependency, changed, diagnostic, and linked-test context explainably', async () => {
    const snapshot = await new RepositoryIndex(root).build(true);
    const result = await new ContextSelector(root).select(snapshot, {
      query: 'Fix add in src/math.ts and update its test',
      role: 'validator',
      model: 'qwen3-coder:30b',
      tokenBudget: 2500,
      hints: {
        openFiles: ['src/math.ts'],
        changedFiles: ['src/util.ts'],
        diagnosticFiles: [{ path: 'src/math.ts', severity: 'error', message: 'bad return' }],
      },
    });

    expect(result.files.map(file => file.path)).toEqual(expect.arrayContaining([
      'src/math.ts',
      'src/util.ts',
      'src/math.test.ts',
    ]));
    const math = result.files.find(file => file.path === 'src/math.ts');
    expect(math?.reasons.map(reason => reason.reason)).toEqual(expect.arrayContaining([
      'explicit reference',
      'open in editor',
      'diagnostic error',
    ]));
    expect(result.diagnostics.estimatedTokens).toBeLessThanOrEqual(result.diagnostics.inputBudget);
    expect(result.prompt).toContain('Automatically selected repository context');
  });

  it('uses role-specific weighting', async () => {
    const snapshot = await new RepositoryIndex(root).build(true);
    const planner = await new ContextSelector(root).select(snapshot, {
      query: 'understand project setup', role: 'planner', model: 'qwen3-coder:30b', tokenBudget: 1000,
    });
    const validator = await new ContextSelector(root).select(snapshot, {
      query: 'verify add behavior', role: 'validator', model: 'qwen3-coder:30b', tokenBudget: 1000,
    });

    expect(planner.files.some(file => file.path === 'package.json')).toBe(true);
    expect(validator.files.some(file => file.path === 'src/math.test.ts')).toBe(true);
  });

  it('matches a hyphenated query to a PascalCase filename', async () => {
    await write(root, 'src/models/TaskModelSelection.ts', [
      'export function classifyTaskRequirements() { return {}; }',
      'export function selectTaskModel() { return "local"; }',
    ].join('\n'));
    await write(root, 'src/docs/SelectionGuide.ts', 'export const selectionGuide = true;\n');
    const snapshot = await new RepositoryIndex(root).build(true);

    const result = await new ContextSelector(root).select(snapshot, {
      query: 'Where is task-model selection implemented and what does it do?',
      role: 'reviewer',
      model: 'qwen3-coder:30b',
      tokenBudget: 700,
      maxFiles: 1,
    });

    expect(result.files.map(file => file.path)).toEqual(['src/models/TaskModelSelection.ts']);
    expect(result.diagnostics.queryTerms).toEqual(expect.arrayContaining(['task', 'model', 'selection']));
  });

  it('ranks strong query relevance ahead of unrelated changed and recent files', async () => {
    await write(root, 'src/models/TaskModelSelection.ts', 'export function selectTaskModel() { return "local"; }\n');
    const dirtyFiles: string[] = [];
    for (let index = 0; index < 12; index += 1) {
      const relative = `src/dirty/Unrelated${index}.ts`;
      dirtyFiles.push(relative);
      await write(root, relative, `export const unrelated${index} = \`${'x'.repeat(2400)}\`;\n`);
    }
    const snapshot = await new RepositoryIndex(root).build(true);

    const result = await new ContextSelector(root).select(snapshot, {
      query: 'Where is task-model selection implemented and what does it do?',
      role: 'reviewer',
      model: 'qwen3-coder:30b',
      tokenBudget: 512,
      hints: { changedFiles: dirtyFiles, recentFiles: dirtyFiles },
    });

    expect(result.files[0]?.path).toBe('src/models/TaskModelSelection.ts');
    expect(result.files.some(file => file.path === 'src/models/TaskModelSelection.ts')).toBe(true);
  });

  it.each([
    'repository-context',
    'RepositoryContext',
    'repository_context',
    'repository context',
  ])('normalizes generic identifier form %s', async query => {
    await write(root, 'src/context/RepositoryContextService.ts', 'export class RepositoryContextService {}\n');
    await write(root, 'src/context/RepositoryService.ts', 'export class RepositoryService {}\n');
    const snapshot = await new RepositoryIndex(root).build(true);

    const result = await new ContextSelector(root).select(snapshot, {
      query,
      role: 'reviewer',
      model: 'qwen3-coder:30b',
      tokenBudget: 512,
      maxFiles: 1,
    });

    expect(result.files[0]?.path).toBe('src/context/RepositoryContextService.ts');
  });

  it('uses changed and recent signals to break ties between equally relevant files', async () => {
    await write(root, 'src/alpha/RepositoryContextService.ts', 'export class RepositoryContextService {}\n');
    await write(root, 'src/beta/RepositoryContextService.ts', 'export class RepositoryContextService {}\n');
    const snapshot = await new RepositoryIndex(root).build(true);

    const result = await new ContextSelector(root).select(snapshot, {
      query: 'repository context service',
      role: 'reviewer',
      model: 'qwen3-coder:30b',
      tokenBudget: 512,
      maxFiles: 1,
      hints: {
        changedFiles: ['src/beta/RepositoryContextService.ts'],
        recentFiles: ['src/beta/RepositoryContextService.ts'],
      },
    });

    expect(result.files[0]?.path).toBe('src/beta/RepositoryContextService.ts');
    expect(result.files[0]?.reasons.map(reason => reason.reason)).toEqual(expect.arrayContaining([
      'Git changed file',
      'recently modified',
    ]));
  });

  it('keeps normalized relevance selection within the existing token budget', async () => {
    await write(root, 'src/context/RepositoryContextService.ts', `export class RepositoryContextService { value = \`${'x'.repeat(12000)}\`; }\n`);
    const snapshot = await new RepositoryIndex(root).build(true);

    const result = await new ContextSelector(root).select(snapshot, {
      query: 'repository-context service',
      role: 'reviewer',
      model: 'qwen3-coder:30b',
      tokenBudget: 512,
    });

    expect(result.files.some(file => file.path === 'src/context/RepositoryContextService.ts')).toBe(true);
    expect(result.diagnostics.inputBudget).toBe(512);
    expect(result.diagnostics.estimatedTokens).toBeLessThanOrEqual(result.diagnostics.inputBudget);
  });

  it('persists inspectable selection diagnostics', async () => {
    const service = new RepositoryContextService(root);
    const result = await service.build({
      query: 'change clamp utility',
      mode: 'agent',
      model: 'qwen3-coder:30b',
      tokenBudget: 1200,
      hints: { explicitFiles: ['src/util.ts'] },
      forceIndexRefresh: true,
    });
    const taskDir = path.join(root, '.ollama-agent', 'tasks', 'task-context');
    await service.persist(taskDir, result);

    const persisted = JSON.parse(await fs.readFile(path.join(taskDir, 'context-selection.json'), 'utf8'));
    expect(persisted.selectedFiles.some((file: { path: string }) => file.path === 'src/util.ts')).toBe(true);
    expect(persisted.diagnostics.queryTerms).toContain('clamp');
  });

  it('truncates large snippets to the provider-aware budget', async () => {
    await write(root, 'src/huge.ts', `export const huge = \`${'x'.repeat(30000)}\`;\n`);
    const snapshot = await new RepositoryIndex(root).build(true);
    const result = await new ContextSelector(root).select(snapshot, {
      query: 'fix src/huge.ts',
      role: 'implementer',
      model: 'mistral:7b',
      tokenBudget: 500,
      maxFiles: 2,
    });
    expect(result.diagnostics.estimatedTokens).toBeLessThanOrEqual(result.diagnostics.inputBudget);
    expect(result.files.find(file => file.path === 'src/huge.ts')?.truncated).toBe(true);
  });
});

describe('strong-identifier grounding', () => {
  let repo: string;
  const git = (args: string[], cwd: string) => execFileAsync('git', args, { cwd, windowsHide: true });

  beforeEach(async () => {
    repo = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-grounding-'));
    await git(['init'], repo);
    await git(['config', 'user.email', 'grounding@example.test'], repo);
    await git(['config', 'user.name', 'Grounding Test'], repo);
  });

  afterEach(async () => {
    await fs.rm(repo, { recursive: true, force: true });
  });

  async function commitAll(message: string): Promise<void> {
    await git(['add', '.'], repo);
    await git(['commit', '-m', message], repo);
  }

  it('prioritizes the file defining an exact identifier named in the task over generic word-overlap files', async () => {
    await write(repo, 'src/service/deliveryRuntime.ts', [
      "import { emit } from './wire';",
      'export async function approveDelivery(taskId: string): Promise<void> { emit(taskId); }',
      '',
    ].join('\n'));
    await write(repo, 'src/service/wire.ts', 'export function emit(id: string) { return id; }\n');
    // A decoy with heavy plain-word overlap ("delivery" appears many times)
    // but no declared `approveDelivery` symbol and no literal occurrence of
    // it either — generic ranking alone tends to favor volume like this.
    await write(repo, 'src/noise/deliveryWords.ts', Array.from(
      { length: 12 },
      (_, i) => `export function deliveryNote${i}() { return 'delivery delivery delivery'; }`,
    ).join('\n'));
    await commitAll('seed');

    const result = await new RepositoryContextService(repo).build({
      query: 'approveDelivery seems to mishandle a failure classification; investigate.',
      mode: 'agent',
      role: 'implementer',
      model: 'qwen3-coder:30b',
      tokenBudget: 4000,
    });

    const defining = result.files.find(file => file.path === 'src/service/deliveryRuntime.ts');
    expect(defining).toBeDefined();
    expect(defining?.reasons.map(reason => reason.reason)).toContain('explicit reference');
    const noise = result.files.find(file => file.path === 'src/noise/deliveryWords.ts');
    expect(defining!.score).toBeGreaterThan(noise?.score ?? 0);
  });

  it('prioritizes the exact repository occurrence of an error/classification token that is not a declared symbol', async () => {
    await write(repo, 'src/errors/classification.ts', [
      "export const WORKSPACE_CONFLICT = 'workspace_delivery_conflict';",
      "export function classify(): string { return WORKSPACE_CONFLICT; }",
      '',
    ].join('\n'));
    await write(repo, 'src/unrelated/topic.ts', 'export const unrelated = true;\n');
    await commitAll('seed');

    const result = await new RepositoryContextService(repo).build({
      query: 'Why is workspace_delivery_conflict later reported as a generic runtime_error?',
      mode: 'agent',
      role: 'implementer',
      model: 'qwen3-coder:30b',
      tokenBudget: 4000,
    });

    const hit = result.files.find(file => file.path === 'src/errors/classification.ts');
    expect(hit).toBeDefined();
    expect(hit?.reasons.map(reason => reason.reason)).toContain('explicit reference');
  });

  it('finds a grounded identifier outside src/**, e.g. under core/**', async () => {
    await write(repo, 'core/domain/deliveryGate.ts', 'export function approveCoreDelivery(id: string) { return id; }\n');
    await commitAll('seed');

    const result = await new RepositoryContextService(repo).build({
      query: 'approveCoreDelivery looks wrong, please investigate.',
      mode: 'agent',
      role: 'implementer',
      model: 'qwen3-coder:30b',
      tokenBudget: 4000,
    });

    const hit = result.files.find(file => file.path === 'core/domain/deliveryGate.ts');
    expect(hit?.reasons.map(reason => reason.reason)).toContain('explicit reference');
  });

  it('leaves ordinary requests with no strong identifiers on today\'s ranking, untouched by grounding', async () => {
    await write(repo, 'src/totals.ts', 'export function computeTotal(values: number[]) { return values.reduce((a, b) => a + b, 0); }\n');
    await commitAll('seed');

    const result = await new RepositoryContextService(repo).build({
      query: 'please fix the totals calculation and add a helpful comment',
      mode: 'agent',
      role: 'implementer',
      model: 'qwen3-coder:30b',
      tokenBudget: 4000,
    });

    expect(result.files.some(file => file.reasons.some(reason => reason.reason === 'explicit reference'))).toBe(false);
  });

  it('keeps context bounds enforced even when several distinct grounded files are large', async () => {
    await write(repo, 'src/one/approveDelivery.ts', `export function approveDelivery() { return '${'x'.repeat(6000)}'; }\n`);
    await write(repo, 'src/two/rejectDelivery.ts', `export function rejectDelivery() { return '${'y'.repeat(6000)}'; }\n`);
    await commitAll('seed');

    const result = await new RepositoryContextService(repo).build({
      query: 'approveDelivery and rejectDelivery both need review.',
      mode: 'agent',
      role: 'implementer',
      model: 'qwen3-coder:30b',
      tokenBudget: 4000,
    });

    expect(result.diagnostics.estimatedTokens).toBeLessThanOrEqual(result.diagnostics.inputBudget);
  });

  it('does not let a hallucinated identifier dominate or corrupt selection', async () => {
    await write(repo, 'src/real.ts', 'export function realHelper() { return true; }\n');
    await commitAll('seed');

    const result = await new RepositoryContextService(repo).build({
      query: 'totallyFakeNonExistentSymbolZzz does not exist anywhere in this repository.',
      mode: 'agent',
      role: 'implementer',
      model: 'qwen3-coder:30b',
      tokenBudget: 4000,
    });

    expect(result.files.some(file => file.reasons.some(reason => reason.reason === 'explicit reference'))).toBe(false);
    expect(result.diagnostics.estimatedTokens).toBeLessThanOrEqual(result.diagnostics.inputBudget);
  });
});
