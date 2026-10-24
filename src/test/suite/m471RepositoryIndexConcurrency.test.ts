import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as sqlite3 from '@vscode/sqlite3';
import { RepositoryIndex, RepositoryIndexBusyError } from '../../context/RepositoryIndex';
import { RepositoryContextService } from '../../context/RepositoryContextService';

/**
 * SQLITE_BUSY in repository intelligence. Two causes, both ownership/lock-discipline rather than "too slow":
 *
 *  1. Every connection ran schema DDL under BEGIN IMMEDIATE plus a create/drop FTS probe table, so even a pure read
 *     took the single writer lock and queued behind (or starved) any long write by another window or service.
 *  2. RepositoryContextService memoised the build promise, including a rejected one, so one transient busy failure
 *     was replayed to every later caller for the life of the service and wedged repository-aware turns.
 *
 * The tests hold a real external writer lock with a second connection, so they are deterministic rather than
 * timing-dependent stress runs.
 */

let root: string;
let storageDir: string;
let storage: string;

async function seed(): Promise<void> {
  for (let index = 0; index < 30; index += 1) {
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    await fs.writeFile(path.join(root, 'src', `m${index}.ts`), `export const v${index} = ${index};\n`, 'utf8');
  }
}

function openRaw(): Promise<sqlite3.Database> {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(storage, sqlite3.OPEN_READWRITE, error => error ? reject(error) : resolve(db));
  });
}
const exec = (db: sqlite3.Database, sql: string) => new Promise<void>((resolve, reject) => db.exec(sql, e => e ? reject(e) : resolve()));
const closeRaw = (db: sqlite3.Database) => new Promise<void>((resolve, reject) => db.close(e => e ? reject(e) : resolve()));

/** Holds the SQLite writer lock from an independent connection until released. */
async function holdWriterLock(): Promise<() => Promise<void>> {
  const db = await openRaw();
  await exec(db, 'PRAGMA busy_timeout = 0');
  await exec(db, 'BEGIN IMMEDIATE');
  return async () => { await exec(db, 'ROLLBACK'); await closeRaw(db); };
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe('repository index under concurrent access', () => {
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-repo-busy-'));
    // Outside the workspace, like the isolated acceptance setting, so the store is never indexed as source.
    storageDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-repo-busy-store-'));
    storage = path.join(storageDir, 'repository-intelligence.sqlite');
    await seed();
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    await fs.rm(storageDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('several services building and reading one store at once all succeed with the same result', async () => {
    const services = Array.from({ length: 4 }, () => new RepositoryIndex(root, { storagePath: storage }));
    const results = await Promise.all([
      ...services.map(service => service.build(true)),
      ...services.map(service => service.build(false)),
    ]);
    const counts = new Set(results.map(result => result.files.filter(file => !file.deleted).length));
    expect(counts.size).toBe(1);
    expect([...counts][0]).toBeGreaterThanOrEqual(30);
  });

  it('a read of an already-indexed store does not take or wait for the writer lock', async () => {
    await new RepositoryIndex(root, { storagePath: storage }).build(true);
    const release = await holdWriterLock();
    try {
      const reader = new RepositoryIndex(root, { storagePath: storage, busyTimeoutMs: 5000 });
      const started = Date.now();
      const snapshot = await reader.build(false);
      // Before the fix this blocked on BEGIN IMMEDIATE / the FTS probe DDL until the lock was released or timed out.
      expect(Date.now() - started).toBeLessThan(2500);
      expect(snapshot.files.length).toBeGreaterThanOrEqual(30);
    } finally {
      await release();
    }
  });

  it('a writer waits out a short lock and then succeeds', async () => {
    await new RepositoryIndex(root, { storagePath: storage }).build(true);
    const release = await holdWriterLock();
    const writer = new RepositoryIndex(root, { storagePath: storage, busyTimeoutMs: 5000 });
    const pending = writer.build(true);
    await sleep(400);
    await release();
    const snapshot = await pending;
    expect(snapshot.state).toBe('ready');
  });

  it('a lock held past the busy timeout fails fast with a typed busy error, and the same service recovers afterwards', async () => {
    await new RepositoryIndex(root, { storagePath: storage }).build(true);
    const release = await holdWriterLock();
    const writer = new RepositoryIndex(root, { storagePath: storage, busyTimeoutMs: 300 });
    const started = Date.now();
    const failure = await writer.build(true).then(() => undefined, (error: unknown) => error);
    expect(failure).toBeInstanceOf(RepositoryIndexBusyError);
    expect((failure as RepositoryIndexBusyError).code).toBe('repository_index_busy');
    expect(Date.now() - started).toBeLessThan(4000);
    await release();
    // Not wedged: the same instance works as soon as the lock is gone.
    expect((await writer.build(true)).state).toBe('ready');
  });
});

describe('RepositoryContextService does not memoise a failed index build', () => {
  it('retries the build after a transient failure instead of replaying the rejection', async () => {
    const service = new RepositoryContextService(os.tmpdir());
    const build = vi.fn()
      .mockRejectedValueOnce(new RepositoryIndexBusyError('locked'))
      .mockResolvedValueOnce({ state: 'ready', files: [] });
    (service as unknown as { index: { build: typeof build } }).index = { build } as never;
    const buildIndex = (force: boolean) => (service as unknown as { buildIndex(force: boolean): Promise<unknown> }).buildIndex(force);

    await expect(buildIndex(false)).rejects.toBeInstanceOf(RepositoryIndexBusyError);
    await sleep(0);
    await expect(buildIndex(false)).resolves.toMatchObject({ state: 'ready' });
    expect(build).toHaveBeenCalledTimes(2);
    // A successful build is still cached.
    await buildIndex(false);
    expect(build).toHaveBeenCalledTimes(2);
  });
});
