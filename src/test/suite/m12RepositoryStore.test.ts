import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as sqlite3 from '@vscode/sqlite3';
import { RepositoryIndex } from '../../context/RepositoryIndex';

async function tmp(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-m12-store-'));
  await write(root, 'src/main.ts', 'export const main = 1;\n');
  return root;
}

async function write(root: string, relative: string, content: string): Promise<void> {
  const target = path.join(root, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, 'utf8');
}

function openDb(filename: string): Promise<sqlite3.Database> {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(filename, sqlite3.OPEN_READWRITE, error => error ? reject(error) : resolve(db));
  });
}

function get<T>(db: sqlite3.Database, sql: string, params?: unknown[]): Promise<T> {
  return new Promise((resolve, reject) => db.get(sql, params ?? [], (error, row) => error ? reject(error) : resolve(row as T)));
}

function all<T>(db: sqlite3.Database, sql: string, params?: unknown[]): Promise<T[]> {
  return new Promise((resolve, reject) => db.all(sql, params ?? [], (error, rows) => error ? reject(error) : resolve(rows as T[])));
}

function run(db: sqlite3.Database, sql: string, params?: unknown[]): Promise<void> {
  return new Promise((resolve, reject) => db.run(sql, params ?? [], error => error ? reject(error) : resolve()));
}

function close(db: sqlite3.Database): Promise<void> {
  return new Promise((resolve, reject) => db.close(error => error ? reject(error) : resolve()));
}

describe('M12 SQLite repository store', () => {
  let roots: string[] = [];

  afterEach(async () => {
    for (const root of roots) await fs.rm(root, { recursive: true, force: true });
    roots = [];
  });

  it('creates a SQLite file with schema tables, indexes, busy timeout, WAL, and FTS state', async () => {
    const root = await tmp(); roots.push(root);
    const index = new RepositoryIndex(root);
    await index.build(true);
    const header = await fs.readFile(index.getStoragePath(), { encoding: 'utf8', flag: 'r' });
    expect(header.slice(0, 16)).toBe('SQLite format 3\0');

    const db = await openDb(index.getStoragePath());
    try {
      await run(db, 'PRAGMA foreign_keys = ON');
      const migration = await get<{ version: number }>(db, 'SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1');
      const tables = await get<{ count: number }>(db, "SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name IN ('snapshots','files','symbols','imports','exports','dependencies','linked_tests')");
      const indexes = await get<{ count: number }>(db, "SELECT count(*) AS count FROM sqlite_master WHERE type = 'index' AND name IN ('idx_snapshots_identity','idx_files_snapshot_path','idx_symbols_file_name','idx_imports_file')");
      const fk = await get<{ foreign_keys: number }>(db, 'PRAGMA foreign_keys');
      await run(db, 'PRAGMA busy_timeout = 5000');
      const busy = await get<{ timeout: number }>(db, 'PRAGMA busy_timeout');
      const wal = await get<{ journal_mode: string }>(db, 'PRAGMA journal_mode');
      const fts = await get<{ name?: string }>(db, "SELECT name FROM sqlite_master WHERE name = 'file_fts'");
      const ftsColumns = await all<{ name: string }>(db, 'PRAGMA table_info(file_fts)');
      expect(migration.version).toBe(3);
      expect(tables.count).toBe(7);
      expect(indexes.count).toBe(4);
      expect(fk.foreign_keys).toBe(1);
      expect(busy.timeout).toBeGreaterThanOrEqual(5000);
      expect(['wal', 'delete']).toContain(wal.journal_mode.toLowerCase());
      expect(Boolean(fts?.name)).toBe(index.isFts5Available());
      if (index.isFts5Available()) {
        expect(ftsColumns.map(column => column.name)).toEqual(['path', 'symbols', 'relationships', 'searchable_text', 'summary', 'content_hash']);
      }
    } finally {
      await close(db);
    }
  });

  it('indexes bounded privacy-filtered repository content in FTS beyond path and summary', async () => {
    const root = await tmp(); roots.push(root);
    await write(root, 'src/error.ts', [
      'export function raiseLater() {',
      '  const code = 1;',
      "  throw new Error('NEBULA_WIDGET_MISSING');",
      '}',
    ].join('\n'));
    await write(root, 'docs/guide.md', '# Guide\n\nThe operator should follow the lunar checklist before release.\n');
    await write(root, 'config/app.json', '{\n  "featureNebulaSwitch": true\n}\n');
    await write(root, 'package.json', JSON.stringify({
      name: 'aurora-command-suite',
      scripts: { verify: 'vitest run --reporter dot' },
      devDependencies: { vitest: '^1.0.0' },
    }, null, 2));
    await write(root, 'src/error.test.ts', [
      'const first = 1;',
      "test('reports the missing nebula widget clearly', () => { expect(first).toBe(1); });",
    ].join('\n'));
    await write(root, 'src/commented.ts', [
      'const first = 1;',
      '// calibration phrase alpha beta',
      'export const commented = first;',
    ].join('\n'));
    await write(root, 'token.secret', 'NEBULA_PRIVATE_TOKEN=keep-out\n');
    await write(root, 'src/generated/hidden.ts', 'export const generated = "SHOULD_NOT_INDEX_GENERATED_TEXT";\n');

    const index = new RepositoryIndex(root);
    const snapshot = await index.build(true);
    if (!index.isFts5Available()) return;

    const byPath = new Map(snapshot.files.map(file => [file.path, file.summary]));
    expect(byPath.get('src/error.ts')).not.toContain('NEBULA_WIDGET_MISSING');
    expect(byPath.get('docs/guide.md')).not.toContain('lunar checklist');
    expect(byPath.get('config/app.json')).not.toContain('featureNebulaSwitch');
    expect(byPath.get('package.json')).not.toContain('aurora-command-suite');
    expect(byPath.get('src/error.test.ts')).not.toContain('missing nebula widget');
    expect(byPath.get('src/commented.ts')).not.toContain('calibration phrase');

    const db = await openDb(index.getStoragePath());
    try {
      const find = (term: string) => all<{ path: string }>(db, 'SELECT path FROM file_fts WHERE file_fts MATCH ? ORDER BY path', [term]);
      expect((await find('"NEBULA_WIDGET_MISSING"')).map(row => row.path)).toEqual(['src/error.ts']);
      expect((await find('"lunar checklist"')).map(row => row.path)).toEqual(['docs/guide.md']);
      expect((await find('featureNebulaSwitch')).map(row => row.path)).toEqual(['config/app.json']);
      expect((await find('"aurora-command-suite" OR vitest')).map(row => row.path)).toContain('package.json');
      expect((await find('"missing nebula widget"')).map(row => row.path)).toEqual(['src/error.test.ts']);
      expect((await find('"calibration phrase"')).map(row => row.path)).toEqual(['src/commented.ts']);
      expect(await find('NEBULA_PRIVATE_TOKEN')).toEqual([]);
      expect(await find('SHOULD_NOT_INDEX_GENERATED_TEXT')).toEqual([]);
    } finally {
      await close(db);
    }
  });

  it('enforces foreign keys and rolls back failed transactions', async () => {
    const root = await tmp(); roots.push(root);
    const index = new RepositoryIndex(root);
    await index.build(true);
    const db = await openDb(index.getStoragePath());
    try {
      await run(db, 'PRAGMA foreign_keys = ON');
      await expect(run(db, "INSERT INTO files(snapshot_id,path,absolute_path,extension,language,size,modified_at,is_test,is_config,is_generated,summary,stale,deleted) VALUES (999,'x','x','.ts','typescript',1,1,0,0,0,'x',0,0)")).rejects.toThrow();
      const before = await get<{ count: number }>(db, 'SELECT count(*) AS count FROM snapshots');
      await run(db, 'BEGIN IMMEDIATE');
      await run(db, "INSERT INTO snapshots(workspace_root,branch,head_commit,worktree,detached,created_at,updated_at,state,ignored_patterns,truncated,pins,exclusions,statistics) VALUES ('r','b','h','w',0,'n','n','ready','[]',0,'[]','[]','{}')");
      await run(db, 'ROLLBACK');
      const after = await get<{ count: number }>(db, 'SELECT count(*) AS count FROM snapshots');
      expect(after.count).toBe(before.count);
    } finally {
      await close(db);
    }
  });

  it('persists prepared CRUD data after close and reopen', async () => {
    const root = await tmp(); roots.push(root);
    const first = await new RepositoryIndex(root).build(true);
    expect(first.files.some(file => file.path === 'src/main.ts')).toBe(true);
    const reopened = await new RepositoryIndex(root).build(false);
    expect(reopened.files.map(file => file.path)).toContain('src/main.ts');
  });

  it('migrates legacy JSON idempotently and quarantines malformed JSON', async () => {
    const root = await tmp(); roots.push(root);
    const legacyDir = path.join(root, '.ollama-agent', 'index');
    await fs.mkdir(legacyDir, { recursive: true });
    const legacyPath = path.join(legacyDir, 'repository-index.json');
    const now = new Date().toISOString();
    await fs.writeFile(legacyPath, JSON.stringify({
      schemaVersion: 2, workspaceRoot: root,
      identity: { repositoryRoot: root, branch: 'legacy', headCommit: 'legacy', worktree: path.join(root, '.git'), detached: false, schemaVersion: 2 },
      createdAt: now, updatedAt: now, state: 'ready', files: [], ignoredPatterns: [], truncated: false,
      statistics: { files: 0, symbols: 0, imports: 0, tests: 0, configs: 0, buildFiles: 0, markdown: 0, changedFiles: 0, deletedFiles: 0 },
      pins: ['src/main.ts'], exclusions: [],
    }), 'utf8');
    await new RepositoryIndex(root).build(true);
    await new RepositoryIndex(root).build(true);
    await expect(fs.stat(`${legacyPath}.migrated`)).resolves.toBeTruthy();
    await expect(fs.stat(legacyPath)).rejects.toBeTruthy();

    const badRoot = await tmp(); roots.push(badRoot);
    const badDir = path.join(badRoot, '.ollama-agent', 'index');
    await fs.mkdir(badDir, { recursive: true });
    await fs.writeFile(path.join(badDir, 'repository-index.json'), '{ nope', 'utf8');
    await new RepositoryIndex(badRoot).build(true);
    expect((await fs.readdir(badDir)).some(file => file.startsWith('repository-index.json.malformed-'))).toBe(true);
  });

  it('quarantines corrupt bytes and rejects unknown newer schema rows', async () => {
    const root = await tmp(); roots.push(root);
    const index = new RepositoryIndex(root);
    await fs.mkdir(path.dirname(index.getStoragePath()), { recursive: true });
    await fs.writeFile(index.getStoragePath(), Buffer.from([1, 2, 3, 4, 5]));
    await index.build(true);
    expect((await fs.readdir(path.dirname(index.getStoragePath()))).some(file => file.includes('.corrupt-'))).toBe(true);

    const db = await openDb(index.getStoragePath());
    try {
      await run(db, 'INSERT OR REPLACE INTO schema_migrations(version, applied_at) VALUES (99, ?)', [new Date().toISOString()]);
      const newer = await get<{ version: number }>(db, 'SELECT max(version) AS version FROM schema_migrations');
      expect(newer.version).toBe(99);
    } finally {
      await close(db);
    }
    await expect(new RepositoryIndex(root).build(false)).rejects.toThrow(/index_schema_mismatch/);
  });
});
