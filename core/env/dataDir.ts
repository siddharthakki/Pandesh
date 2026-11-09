import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * The comparable form of a data directory: absolute, symlinks and 8.3 short
 * names resolved where the directory exists, no trailing separator, and
 * case-folded on Windows (whose file system is case-insensitive).
 */
export function canonicalDataDir(dir: string): string {
  let resolved = path.resolve(dir);
  try {
    resolved = fs.realpathSync.native(resolved);
  } catch {
    // A directory that does not exist (yet) is compared by its resolved path.
  }
  resolved = resolved.replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * True when both paths name the same Pandesh profile. A Core, its lock file,
 * its database claim and its process records all belong to one data
 * directory: a copied profile has the same files in a different directory, so
 * it is a different profile and must never act on the original's Core.
 */
export function sameDataDir(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return canonicalDataDir(a) === canonicalDataDir(b);
}

/**
 * Resolves the OS-appropriate global data directory for the KarkeDikha Core.
 * `KARKEDIKHA_DATA_DIR` overrides everything else and exists solely so tests
 * and the integration harness can point the Core at an isolated temp
 * directory instead of the real per-user location.
 */
export function resolveDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.KARKEDIKHA_DATA_DIR;
  if (override && override.trim().length > 0) {
    return path.resolve(override);
  }

  if (process.platform === 'win32') {
    const localAppData = env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(localAppData, 'KarkeDikha');
  }

  const xdgDataHome = env.XDG_DATA_HOME;
  if (xdgDataHome && xdgDataHome.trim().length > 0) {
    return path.join(xdgDataHome, 'karkedikha');
  }
  return path.join(os.homedir(), '.local', 'share', 'karkedikha');
}

export function resolvePaths(dataDir: string) {
  return {
    dataDir,
    databasePath: path.join(dataDir, 'core.db'),
    lockFilePath: path.join(dataDir, 'core.lock'),
    discoveryRecordPath: path.join(dataDir, 'core.json'),
    logDir: path.join(dataDir, 'logs'),
    migrationBackupDir: path.join(dataDir, 'migration-backups'),
  };
}
