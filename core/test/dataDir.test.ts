import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { resolveDataDir, resolvePaths } from '../env/dataDir';

describe('resolveDataDir', () => {
  it('honors KARKEDIKHA_DATA_DIR override above all platform defaults', () => {
    const dir = resolveDataDir({ KARKEDIKHA_DATA_DIR: '/tmp/whatever', LOCALAPPDATA: 'C:\\Ignored' } as NodeJS.ProcessEnv);
    expect(dir).toBe(path.resolve('/tmp/whatever'));
  });

  it('uses %LOCALAPPDATA%\\KarkeDikha on win32', () => {
    if (process.platform !== 'win32') return;
    const dir = resolveDataDir({ LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local' } as NodeJS.ProcessEnv);
    expect(dir).toBe('C:\\Users\\test\\AppData\\Local\\KarkeDikha');
  });
});

describe('resolvePaths', () => {
  it('derives db/lock/discovery/log/backup paths under the data dir', () => {
    const paths = resolvePaths('C:\\data\\KarkeDikha');
    expect(paths.databasePath).toContain('core.db');
    expect(paths.lockFilePath).toContain('core.lock');
    expect(paths.discoveryRecordPath).toContain('core.json');
    expect(paths.logDir).toContain('logs');
    expect(paths.migrationBackupDir).toContain('migration-backups');
  });
});
