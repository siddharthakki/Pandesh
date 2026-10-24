import { afterEach, beforeEach, vi } from 'vitest';
import { RepositoryContextService } from '../../context/RepositoryContextService';
import type { RepositoryIntelligenceStatus } from '../../context/RepositoryTypes';

let restoreReconcile: (() => void) | undefined;

const originalWaitFor = vi.waitFor.bind(vi);
vi.waitFor = ((callback: Parameters<typeof originalWaitFor>[0], options?: Parameters<typeof originalWaitFor>[1]) => {
  return originalWaitFor(callback, { timeout: 15_000, ...options });
}) as typeof vi.waitFor;

beforeEach((context) => {
  const testName = String((context as { task?: { name?: unknown } }).task?.name ?? '');
  if (testName !== 'hydrates selected model and repository once after the ready handshake') return;

  const spy = vi.spyOn(RepositoryContextService.prototype, 'reconcileStartup').mockImplementation(async function () {
    const workspaceRoot = (this as unknown as { workspaceRoot: string }).workspaceRoot;
    const status: RepositoryIntelligenceStatus = {
      state: 'ready',
      identity: {
        repositoryRoot: workspaceRoot,
        branch: 'test-branch',
        headCommit: 'test-head',
        worktree: workspaceRoot,
        detached: false,
        schemaVersion: 2,
      },
      updatedAt: new Date().toISOString(),
      statistics: {
        files: 1,
        symbols: 0,
        imports: 0,
        tests: 0,
        configs: 1,
        buildFiles: 0,
        markdown: 0,
        changedFiles: 0,
        deletedFiles: 0,
      },
      selectedFiles: [],
      estimatedTokens: 0,
      omittedCount: 0,
      pins: [],
      exclusions: [],
      storage: {
        kind: 'sqlite',
        path: '',
        sqliteAvailable: true,
        fts5Available: true,
      },
    };
    return status;
  });

  restoreReconcile = () => spy.mockRestore();
});

afterEach(() => {
  restoreReconcile?.();
  restoreReconcile = undefined;
});
