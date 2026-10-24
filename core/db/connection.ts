import * as fs from 'node:fs';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { runNodeSqlitePreflight, CoreDatabaseFailedError } from './preflight';

export interface CoreDatabase {
  readonly raw: DatabaseSync;
  run(sql: string, params?: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get<T = Record<string, unknown>>(sql: string, params?: unknown[]): T | undefined;
  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[];
  exec(sql: string): void;
  transaction<T>(fn: () => T): T;
  integrityCheck(): boolean;
  close(): void;
}

/**
 * Opens the Core's SQLite database with the production pragmas required by
 * M31: WAL journaling, foreign keys enabled, and a busy timeout so
 * concurrent connections (multiple Core-internal callers, never multiple
 * processes — the singleton protocol prevents that) don't spuriously fail
 * under load.
 */
export function openDatabase(databasePath: string, opts?: { busyTimeoutMs?: number }): CoreDatabase {
  const preflight = runNodeSqlitePreflight();
  if (!preflight.ok) {
    throw new CoreDatabaseFailedError(preflight.reason ?? 'node:sqlite preflight failed');
  }

  fs.mkdirSync(path.dirname(databasePath), { recursive: true });

  let raw: DatabaseSync;
  try {
    raw = new DatabaseSync(databasePath, { enableForeignKeyConstraints: true });
    const busyTimeoutMs = opts?.busyTimeoutMs ?? 5000;
    raw.exec(`PRAGMA journal_mode = WAL;`);
    raw.exec(`PRAGMA foreign_keys = ON;`);
    raw.exec(`PRAGMA busy_timeout = ${busyTimeoutMs};`);
  } catch (err) {
    try {
      raw!.close();
    } catch {
      /* best-effort cleanup of a partially-opened handle */
    }
    throw new CoreDatabaseFailedError(`failed to open database at ${databasePath}: ${(err as Error).message}`);
  }

  let closed = false;
  let transactionDepth = 0;

  const db: CoreDatabase = {
    raw,
    run(sql: string, params: unknown[] = []) {
      const stmt = raw.prepare(sql);
      return stmt.run(...params);
    },
    get<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
      const stmt = raw.prepare(sql);
      return stmt.get(...params) as T | undefined;
    },
    all<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
      const stmt = raw.prepare(sql);
      return stmt.all(...params) as T[];
    },
    exec(sql: string) {
      raw.exec(sql);
    },
    // Reentrant: a domain function composing several other transaction-wrapped
    // domain functions (e.g. submitRequest = classify + createRequest +
    // createAttempt, all atomically) must not attempt a nested `BEGIN` — SQLite
    // rejects that outright. Only the outermost call opens/commits the real
    // transaction; inner calls just run `fn()` inside it. A failure at any
    // depth still throws up to the outermost caller, which rolls back the
    // whole thing — there is no partial-commit path.
    transaction<T>(fn: () => T): T {
      if (transactionDepth > 0) {
        transactionDepth++;
        try {
          return fn();
        } finally {
          transactionDepth--;
        }
      }
      transactionDepth = 1;
      raw.exec('BEGIN IMMEDIATE');
      try {
        const result = fn();
        raw.exec('COMMIT');
        return result;
      } catch (err) {
        try {
          raw.exec('ROLLBACK');
        } catch {
          /* ignore rollback failure after an already-failed transaction */
        }
        throw err;
      } finally {
        transactionDepth = 0;
      }
    },
    integrityCheck(): boolean {
      const row = db.get<{ integrity_check: string }>('PRAGMA integrity_check');
      return row?.integrity_check === 'ok';
    },
    close() {
      if (closed) return;
      closed = true;
      try {
        raw.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      } catch {
        /* best-effort checkpoint on close */
      }
      raw.close();
    },
  };

  return db;
}
