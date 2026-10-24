import { openDatabase, type CoreDatabase } from './connection';
import { runMigrations } from './migrations';
import { CoreDatabaseFailedError } from './preflight';

export interface OpenCoreDatabaseResult {
  db: CoreDatabase;
  migrationsApplied: number[];
}

/**
 * Single entry point the Core process uses to get a ready-to-use database:
 * preflight -> open -> pragmas -> migrations -> integrity check. Throws
 * CoreDatabaseFailedError with a diagnostic reason on any failure; callers
 * must surface `database_failed` rather than falling back to anything else.
 */
export function openCoreDatabase(databasePath: string): OpenCoreDatabaseResult {
  let db: CoreDatabase;
  try {
    db = openDatabase(databasePath);
  } catch (err) {
    if (err instanceof CoreDatabaseFailedError) throw err;
    throw new CoreDatabaseFailedError(`failed to open database at ${databasePath}: ${(err as Error).message}`);
  }

  try {
    const { applied } = runMigrations(db);
    if (!db.integrityCheck()) {
      throw new CoreDatabaseFailedError(`SQLite integrity_check failed for database at ${databasePath}`);
    }
    return { db, migrationsApplied: applied };
  } catch (err) {
    db.close();
    if (err instanceof CoreDatabaseFailedError) throw err;
    throw new CoreDatabaseFailedError(`failed during migration/integrity check: ${(err as Error).message}`);
  }
}
