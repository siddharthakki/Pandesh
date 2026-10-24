/**
 * Verifies the embedded Node runtime actually supports `node:sqlite` before
 * any Core startup touches the real database. This is defensive diagnostics
 * for an unsupported/ancient VS Code install (see docs/m31-*.md compatibility
 * floor) — a supported install (VS Code >= 1.100) is expected to always pass
 * this. On failure the Core must report `database_failed` and exit; it must
 * never fall back to a JSON store.
 */

export interface PreflightResult {
  ok: boolean;
  nodeVersion: string;
  reason: string | null;
}

export function runNodeSqlitePreflight(): PreflightResult {
  const nodeVersion = process.version;
  let sqliteModule: typeof import('node:sqlite');
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    sqliteModule = require('node:sqlite');
  } catch (err) {
    return {
      ok: false,
      nodeVersion,
      reason: `node:sqlite is not available in this runtime (Node ${nodeVersion}). node:sqlite requires Node >= 22.13.0. err=${(err as Error).message}`,
    };
  }

  try {
    const { DatabaseSync } = sqliteModule;
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE preflight_probe (id INTEGER PRIMARY KEY)');
    db.exec('DROP TABLE preflight_probe');
    db.close();
  } catch (err) {
    return {
      ok: false,
      nodeVersion,
      reason: `node:sqlite loaded but failed a basic open/exec/close probe: ${(err as Error).message}`,
    };
  }

  return { ok: true, nodeVersion, reason: null };
}

export class CoreDatabaseFailedError extends Error {
  constructor(public readonly diagnosticReason: string) {
    super(`database_failed: ${diagnosticReason}`);
    this.name = 'CoreDatabaseFailedError';
  }
}
