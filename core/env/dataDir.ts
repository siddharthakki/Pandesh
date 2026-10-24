import * as os from 'node:os';
import * as path from 'node:path';

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
