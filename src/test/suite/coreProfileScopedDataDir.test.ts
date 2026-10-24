import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import { createMockExtensionContext } from '../mocks/vscode';
import { CoreManager, resolveProfileScopedCoreDataDir } from '../../core-client/CoreManager';
import { resolvePaths } from '../../../core/env/dataDir';
import { getOrCreateCoreToken } from '../../core-client/tokenStore';
import type { CoreLauncher, LauncherOutcome } from '../../core-client/CoreLauncher';

/**
 * Defect 1 fix: one Core per VS Code profile, not one Core for the whole OS
 * user. `resolveProfileScopedCoreDataDir` anchors the Core data directory at
 * `context.globalStorageUri` — the same profile-scoped location
 * `getOrCreateCoreToken` already uses for the bearer token — so a Core's
 * dataDir and the token a window expects it to accept can never drift apart
 * the way they did against the OS-wide `%LOCALAPPDATA%\KarkeDikha` default.
 */

function fakeLauncher(outcomes: LauncherOutcome[]): { launcher: CoreLauncher; capturedOptions: unknown[] } {
  const capturedOptions: unknown[] = [];
  let call = 0;
  const launcher = {
    ensureCoreRunning: vi.fn(async () => {
      const outcome = outcomes[Math.min(call, outcomes.length - 1)];
      call += 1;
      return outcome;
    }),
    restartCore: vi.fn(async () => outcomes[outcomes.length - 1]),
  } as unknown as CoreLauncher;
  return { launcher, capturedOptions };
}

function contextWithGlobalStorage(fsPath: string) {
  return {
    ...createMockExtensionContext(),
    extensionUri: { fsPath: '/mock-extension' },
    globalStorageUri: { fsPath },
  };
}

describe('resolveProfileScopedCoreDataDir', () => {
  it('1. same profile resolves the same Core data directory across two independent CoreManagers', () => {
    const contextA1 = contextWithGlobalStorage('C:\\Users\\me\\AppData\\Roaming\\Code\\User\\globalStorage\\ollama-agent.ollama-agent');
    const contextA2 = contextWithGlobalStorage('C:\\Users\\me\\AppData\\Roaming\\Code\\User\\globalStorage\\ollama-agent.ollama-agent');

    const first = resolveProfileScopedCoreDataDir(contextA1, {});
    const second = resolveProfileScopedCoreDataDir(contextA2, {});

    expect(first).toBeDefined();
    expect(first).toBe(second);
  });

  it('2. different profiles resolve different Core data directories', () => {
    const profileA = contextWithGlobalStorage('C:\\Users\\me\\AppData\\Roaming\\Code\\User\\globalStorage\\ollama-agent.ollama-agent');
    const profileB = contextWithGlobalStorage('C:\\Users\\me\\AppData\\Roaming\\Code\\User\\profiles\\abc123\\globalStorage\\ollama-agent.ollama-agent');

    const dataDirA = resolveProfileScopedCoreDataDir(profileA, {});
    const dataDirB = resolveProfileScopedCoreDataDir(profileB, {});

    expect(dataDirA).not.toBe(dataDirB);
  });

  it('3. restarting (re-resolving) the same profile yields the same directory — deterministic, not random', () => {
    const context = contextWithGlobalStorage('C:\\Users\\me\\AppData\\Roaming\\Code\\User\\globalStorage\\ollama-agent.ollama-agent');
    const results = Array.from({ length: 5 }, () => resolveProfileScopedCoreDataDir(context, {}));
    expect(new Set(results).size).toBe(1);
  });

  it('4. an explicit KARKEDIKHA_DATA_DIR override takes strictly higher precedence', () => {
    const context = contextWithGlobalStorage('C:\\Users\\me\\AppData\\Roaming\\Code\\User\\globalStorage\\ollama-agent.ollama-agent');
    const result = resolveProfileScopedCoreDataDir(context, { KARKEDIKHA_DATA_DIR: 'C:\\isolated\\acceptance\\core-data' });
    // undefined here means "step aside" — CoreLauncher's own resolveDataDir()
    // then applies the env override exactly as it always has.
    expect(result).toBeUndefined();
  });

  it('6. different profiles can never collide: their discovery record files live at different paths entirely', () => {
    const profileA = contextWithGlobalStorage('C:\\Users\\me\\AppData\\Roaming\\Code\\User\\globalStorage\\ollama-agent.ollama-agent');
    const profileB = contextWithGlobalStorage('C:\\Users\\me\\AppData\\Roaming\\Code2\\User\\globalStorage\\ollama-agent.ollama-agent');

    const dataDirA = resolveProfileScopedCoreDataDir(profileA, {})!;
    const dataDirB = resolveProfileScopedCoreDataDir(profileB, {})!;
    const recordA = resolvePaths(dataDirA).discoveryRecordPath;
    const recordB = resolvePaths(dataDirB).discoveryRecordPath;

    expect(recordA).not.toBe(recordB);
    // Profile B's launcher probing its own discovery record can structurally
    // never read Profile A's live Core — different files, not different
    // in-memory state that could race.
    expect(path.dirname(recordA)).toBe(dataDirA);
    expect(path.dirname(recordB)).toBe(dataDirB);
  });
});

describe('CoreManager wires the profile-scoped data dir into CoreLauncherOptions', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.KARKEDIKHA_DATA_DIR;
  });

  it('passes the profile-scoped dataDir to the launcher when no override is set', async () => {
    delete process.env.KARKEDIKHA_DATA_DIR;
    let capturedDataDir: string | undefined = 'unset';
    const { launcher } = fakeLauncher([{ state: 'unavailable', detail: 'no core yet' }]);
    const context = contextWithGlobalStorage('C:\\Users\\me\\AppData\\Roaming\\Code\\User\\globalStorage\\ollama-agent.ollama-agent');
    const manager = new CoreManager(context as never, (options) => {
      capturedDataDir = options.dataDir;
      return launcher;
    });

    await manager.start();

    expect(capturedDataDir).toBe(path.join(context.globalStorageUri.fsPath, 'core-data'));
    manager.dispose();
  });

  it('4b. leaves dataDir undefined (deferring to CoreLauncher\'s own resolution) when KARKEDIKHA_DATA_DIR is set', async () => {
    process.env.KARKEDIKHA_DATA_DIR = 'C:\\isolated\\acceptance\\core-data';
    let capturedDataDir: string | undefined = 'unset';
    const { launcher } = fakeLauncher([{ state: 'unavailable', detail: 'no core yet' }]);
    const context = contextWithGlobalStorage('C:\\Users\\me\\AppData\\Roaming\\Code\\User\\globalStorage\\ollama-agent.ollama-agent');
    const manager = new CoreManager(context as never, (options) => {
      capturedDataDir = options.dataDir;
      return launcher;
    });

    await manager.start();

    expect(capturedDataDir).toBeUndefined();
    manager.dispose();
  });
});

describe('5. auth tokens remain profile-scoped', () => {
  it('the same profile\'s SecretStorage yields the same token across two CoreManager instances', async () => {
    const context = createMockExtensionContext();
    const tokenA = await getOrCreateCoreToken(context.secrets as never);
    const tokenB = await getOrCreateCoreToken(context.secrets as never);
    expect(tokenA).toBe(tokenB);
  });

  it('two different profiles\' independent SecretStorage instances generate different tokens', async () => {
    const profileA = createMockExtensionContext();
    const profileB = createMockExtensionContext();
    const tokenA = await getOrCreateCoreToken(profileA.secrets as never);
    const tokenB = await getOrCreateCoreToken(profileB.secrets as never);
    expect(tokenA).not.toBe(tokenB);
  });
});
