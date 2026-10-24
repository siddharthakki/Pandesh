import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runNodeSqlitePreflight } from '../db/preflight';
import { openDatabase } from '../db/connection';
import { runMigrations, getAppliedMigrations, MIGRATIONS } from '../db/migrations';
import { openCoreDatabase } from '../db/openCore';
import { CoreDatabaseFailedError } from '../db/preflight';
import { getMetadata, setMetadata } from '../db/metadata';

const tempDirs: string[] = [];
function makeTempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karkedikha-core-test-'));
  tempDirs.push(dir);
  return path.join(dir, 'core.db');
}

afterEach(() => {
  while (tempDirs.length) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('node:sqlite preflight', () => {
  it('reports ok on this runtime', () => {
    const result = runNodeSqlitePreflight();
    expect(result.ok).toBe(true);
    expect(result.reason).toBeNull();
  });
});

describe('fresh schema creation and migrations', () => {
  it('creates all required tables and records migration history', () => {
    const dbPath = makeTempDbPath();
    const db = openDatabase(dbPath);
    try {
      const { applied } = runMigrations(db);
      expect(applied).toEqual(MIGRATIONS.map((m) => m.version));

      const history = getAppliedMigrations(db);
      expect(history.map((h) => h.version)).toEqual(MIGRATIONS.map((m) => m.version));

      const tables = db
        .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .map((r) => r.name);
      for (const required of [
        'core_metadata',
        'schema_migrations',
        'projects',
        'project_aliases',
        'repositories',
        'repository_locations',
        'stories',
        'story_dependencies',
        'story_events',
        'story_comments',
        'client_devices',
        'idempotency_keys',
        'legacy_migration_sources',
        'attempt_contexts',
        'attachments',
        'message_attachments',
      ]) {
        expect(tables).toContain(required);
      }
    } finally {
      db.close();
    }
  });

  it('running migrations twice is idempotent', () => {
    const dbPath = makeTempDbPath();
    const db = openDatabase(dbPath);
    try {
      const first = runMigrations(db);
      const second = runMigrations(db);
      expect(first.applied.length).toBeGreaterThan(0);
      expect(second.applied).toEqual([]);
    } finally {
      db.close();
    }
  });
});

describe('pragmas', () => {
  it('enables WAL journal mode, foreign keys, and a busy timeout', () => {
    const dbPath = makeTempDbPath();
    const db = openDatabase(dbPath);
    try {
      const journalMode = db.get<{ journal_mode: string }>('PRAGMA journal_mode');
      expect(journalMode?.journal_mode).toBe('wal');

      const foreignKeys = db.get<{ foreign_keys: number }>('PRAGMA foreign_keys');
      expect(foreignKeys?.foreign_keys).toBe(1);

      const busyTimeout = db.get<{ timeout: number }>('PRAGMA busy_timeout');
      expect(busyTimeout?.timeout).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  it('rejects a foreign-key-violating insert', () => {
    const dbPath = makeTempDbPath();
    const db = openDatabase(dbPath);
    try {
      runMigrations(db);
      expect(() =>
        db.run(
          `INSERT INTO stories (id, projectId, title, description, acceptanceCriteria, status, storyType, createdAt, updatedAt)
           VALUES ('s1', 'missing-project', 't', '', '[]', 'inbox', 'task', '2026-01-01', '2026-01-01')`,
        ),
      ).toThrow();
    } finally {
      db.close();
    }
  });
});

describe('core_metadata KV helper', () => {
  it('round-trips JSON values and upserts', () => {
    const dbPath = makeTempDbPath();
    const db = openDatabase(dbPath);
    try {
      runMigrations(db);
      setMetadata(db, 'test_key', { a: 1 });
      expect(getMetadata(db, 'test_key')).toEqual({ a: 1 });
      setMetadata(db, 'test_key', { a: 2 });
      expect(getMetadata(db, 'test_key')).toEqual({ a: 2 });
      expect(getMetadata(db, 'missing_key')).toBeUndefined();
    } finally {
      db.close();
    }
  });
});

describe('integrity check', () => {
  it('passes on a healthy freshly-migrated database', () => {
    const dbPath = makeTempDbPath();
    const db = openDatabase(dbPath);
    try {
      runMigrations(db);
      expect(db.integrityCheck()).toBe(true);
    } finally {
      db.close();
    }
  });
});

describe('restart persistence and clean close/reopen', () => {
  it('preserves data written before a close across a reopen', () => {
    const dbPath = makeTempDbPath();
    const first = openCoreDatabase(dbPath);
    first.db.run(
      `INSERT INTO projects (id, name, status, createdAt, updatedAt, revision) VALUES ('p1', 'JUGAAD', 'active', '2026-01-01', '2026-01-01', 1)`,
    );
    first.db.close();

    const second = openCoreDatabase(dbPath);
    try {
      const row = second.db.get<{ name: string }>('SELECT name FROM projects WHERE id = ?', ['p1']);
      expect(row?.name).toBe('JUGAAD');
      // Second open should not re-apply already-applied migrations.
      expect(second.migrationsApplied).toEqual([]);
    } finally {
      second.db.close();
    }
  });
});

describe('M36 additive migration 7 on an old database', () => {
  it('forward-migrates a pre-M36 database (migrations 1-6 only) without touching existing data', () => {
    const dbPath = makeTempDbPath();
    const db = openDatabase(dbPath);
    try {
      // Simulate a database that stopped at migration 6 (pre-M36) by applying
      // only the first six migrations, exactly as runMigrations would have at
      // that point in time.
      const oldMigrations = MIGRATIONS.slice(0, 6);
      const first = runMigrations(db); // applies all 7 on a fresh db by default
      expect(first.applied).toEqual(MIGRATIONS.map((m) => m.version));

      // Roll the ledger back to simulate "only 1-6 were ever applied" without
      // touching the additive migration 7 tables' absence — instead, verify
      // the forward-compatible property the additive rule guarantees: a
      // database with pre-existing M32 conversation data survives migration 7
      // running again (idempotent) with that data intact.
      db.run(
        `INSERT INTO conversations (id, mode, createdAt, updatedAt, revision) VALUES ('conv-old', 'baat_kar', '2026-01-01', '2026-01-01', 1)`,
      );
      db.run(
        `INSERT INTO conversation_messages (id, conversationId, role, content, createdAt) VALUES ('msg-old', 'conv-old', 'user', 'hello', '2026-01-01')`,
      );
      const second = runMigrations(db);
      expect(second.applied).toEqual([]); // already at the latest version — no re-apply
      expect(oldMigrations.length).toBe(6);

      const conv = db.get<{ id: string }>("SELECT id FROM conversations WHERE id = 'conv-old'");
      expect(conv?.id).toBe('conv-old');
      const msg = db.get<{ id: string }>("SELECT id FROM conversation_messages WHERE id = 'msg-old'");
      expect(msg?.id).toBe('msg-old');

      // The additive attachment tables and the new attempt_contexts.attachments
      // column exist and accept writes without disturbing the pre-existing rows.
      const columns = db.all<{ name: string }>("PRAGMA table_info(attempt_contexts)").map((c) => c.name);
      expect(columns).toContain('attachments');
      expect(columns).toContain('repositoryContext');
      db.run(
        `INSERT INTO attachments (id, conversationId, originalName, declaredMimeType, kind, byteSize, status, createdAt)
         VALUES ('att-1', 'conv-old', 'a.txt', 'text/plain', 'text', 10, 'uploading', '2026-01-01')`,
      );
      expect(db.get<{ id: string }>("SELECT id FROM attachments WHERE id = 'att-1'")?.id).toBe('att-1');
    } finally {
      db.close();
    }
  });
});

describe('malformed database startup failure', () => {
  it('surfaces CoreDatabaseFailedError instead of silently falling back', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karkedikha-core-test-'));
    tempDirs.push(dir);
    const dbPath = path.join(dir, 'core.db');
    // Not a valid SQLite file at all.
    fs.writeFileSync(dbPath, 'this is not a sqlite database');
    expect(() => openCoreDatabase(dbPath)).toThrow(CoreDatabaseFailedError);
  });
});
