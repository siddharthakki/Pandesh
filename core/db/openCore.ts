import * as fs from 'node:fs';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase, type CoreDatabase } from './connection';
import { appliedSchemaVersion, LATEST_SCHEMA_VERSION, runMigrations } from './migrations';
import { CoreDatabaseFailedError } from './preflight';

export interface OpenCoreDatabaseResult {
  db: CoreDatabase;
  migrationsApplied: number[];
  /** The verified copy taken before this open migrated an existing database, if it did. */
  preMigrationBackup?: string;
}

export interface OpenCoreDatabaseOptions {
  /** Where pre-migration backups go; default `<database folder>/migration-backups`. */
  backupDir?: string;
  /** How many pre-migration backups to keep (newest first). Default 3. */
  keepBackups?: number;
}

/**
 * Single entry point the Core process uses to get a ready-to-use database:
 * preflight -> open -> pragmas -> (verified backup when an existing database
 * is about to be migrated) -> migrations -> integrity check. Throws
 * CoreDatabaseFailedError with a diagnostic reason on any failure; callers
 * must surface `database_failed` rather than falling back to anything else.
 */
export function openCoreDatabase(databasePath: string, options: OpenCoreDatabaseOptions = {}): OpenCoreDatabaseResult {
  let db: CoreDatabase;
  try {
    db = openDatabase(databasePath);
  } catch (err) {
    if (err instanceof CoreDatabaseFailedError) throw err;
    throw new CoreDatabaseFailedError(`failed to open database at ${databasePath}: ${(err as Error).message}`);
  }

  try {
    let preMigrationBackup: string | undefined;
    const recorded = appliedSchemaVersion(db);
    // Build 161 audit: an existing database was migrated with no copy of the schema it had. Every upgrade path —
    // installer, in-app update, a copied build — now leaves a verified backup that matches the previous build.
    if (recorded > 0 && recorded < LATEST_SCHEMA_VERSION) {
      preMigrationBackup = backupBeforeMigration(
        db,
        options.backupDir ?? path.join(path.dirname(databasePath), 'migration-backups'),
        recorded,
        options.keepBackups ?? 3,
      );
    }
    const { applied } = runMigrations(db);
    if (!db.integrityCheck()) {
      throw new CoreDatabaseFailedError(`SQLite integrity_check failed for database at ${databasePath}`);
    }
    return { db, migrationsApplied: applied, ...(preMigrationBackup ? { preMigrationBackup } : {}) };
  } catch (err) {
    db.close();
    if (err instanceof CoreDatabaseFailedError) throw err;
    throw new CoreDatabaseFailedError(`failed during migration/integrity check: ${(err as Error).message}`);
  }
}

/**
 * A consistent, verified copy of the database at its current schema (SQLite `VACUUM INTO` reads one snapshot). Throws
 * when the copy cannot be made or verified: a schema change never runs without a way back.
 */
function backupBeforeMigration(db: CoreDatabase, dir: string, schema: number, keep: number): string {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, `core-schema${schema}-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
    db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
    const copy = new DatabaseSync(target, { readOnly: true });
    try {
      const check = Object.values(copy.prepare('PRAGMA quick_check').get() as Record<string, unknown>)[0];
      if (check !== 'ok') throw new Error(`the copy failed its integrity check (${String(check)})`);
      const copied = Number((copy.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number }).v);
      if (copied !== schema) throw new Error(`the copy has schema ${copied}, expected ${schema}`);
    } finally {
      copy.close();
    }
    const backups = fs.readdirSync(dir).filter((name) => /^core-schema\d+-.+\.db$/.test(name)).sort().reverse();
    for (const old of backups.slice(Math.max(1, keep))) fs.rmSync(path.join(dir, old), { force: true });
    return target;
  } catch (err) {
    throw new CoreDatabaseFailedError(
      `could not take a verified backup before upgrading the database from schema ${schema}: ${(err as Error).message}. Nothing was migrated.`,
    );
  }
}
