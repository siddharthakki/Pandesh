import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DesktopSession } from '../src/host/desktopSession';

/**
 * Recovery audit finding #4: restoreActiveTask() is now also called when a
 * tray-hidden window reopens (main.ts's showJarvisWindow), not just at boot.
 * That reuse is only safe because the method is idempotent — a no-op when
 * something is already actively tracked, and side-effect-free when nothing
 * is resumable. These tests pin exactly that contract.
 */
describe('DesktopSession.restoreActiveTask', () => {
  function sessionWithFolder(dataDir: string): DesktopSession {
    const host = new DesktopSession({ productRoot: process.cwd(), dataDir });
    const internal = host as unknown as { folder: string | null; coreState: string };
    internal.folder = 'C:\\Projects\\fixture-repo';
    internal.coreState = 'connected';
    return host;
  }

  it('is a no-op that never queries Core when an attempt is already active', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-rehydrate-'));
    const host = sessionWithFolder(dataDir);
    const getWorkspaceAttemptRehydration = vi.fn();
    const internal = host as unknown as { client: unknown; active: unknown };
    internal.client = { getWorkspaceAttemptRehydration };
    internal.active = { attemptId: 'att-1', requestId: 'req-1', conversationId: 'conv-1', goal: 'g', tokenBuffer: '', terminal: false };

    await host.restoreActiveTask();
    expect(getWorkspaceAttemptRehydration).not.toHaveBeenCalled();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('restores a resumable attempt from Core into the active task', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-rehydrate-resume-'));
    const host = sessionWithFolder(dataDir);
    const getWorkspaceAttemptRehydration = vi.fn(async () => ({
      workspaceRoot: 'C:\\Projects\\fixture-repo',
      attempts: [{
        attempt: { id: 'att-resumed', status: 'running', startedAt: '2026-09-18T00:00:00.000Z', createdAt: '2026-09-18T00:00:00.000Z' },
        request: { id: 'req-resumed', conversationId: 'conv-resumed', currentMessage: 'continue the refactor' },
        context: { taskInput: 'continue the refactor' },
        approvals: [],
        events: [],
        recovery: 'safely_resumable',
      }],
    }));
    const internal = host as unknown as { client: unknown };
    internal.client = { getWorkspaceAttemptRehydration };

    const snapshot = await host.restoreActiveTask();
    expect(getWorkspaceAttemptRehydration).toHaveBeenCalledWith('C:\\Projects\\fixture-repo');
    expect(snapshot.attemptId).toBe('att-resumed');
    expect(snapshot.task).toBe('continue the refactor');
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('does not restore an attempt classified terminal or requiring reconciliation', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-rehydrate-terminal-'));
    const host = sessionWithFolder(dataDir);
    const getWorkspaceAttemptRehydration = vi.fn(async () => ({
      workspaceRoot: 'C:\\Projects\\fixture-repo',
      attempts: [{
        attempt: { id: 'att-dead', status: 'failed', startedAt: '2026-09-18T00:00:00.000Z', createdAt: '2026-09-18T00:00:00.000Z' },
        request: { id: 'req-dead', conversationId: 'conv-dead', currentMessage: 'x' },
        context: { taskInput: 'x' },
        approvals: [],
        events: [],
        recovery: 'terminal',
      }],
    }));
    const internal = host as unknown as { client: unknown };
    internal.client = { getWorkspaceAttemptRehydration };

    const snapshot = await host.restoreActiveTask();
    expect(snapshot.attemptId).toBeNull();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('returns the plain snapshot without querying Core when no workspace is selected', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-rehydrate-nofolder-'));
    const host = new DesktopSession({ productRoot: process.cwd(), dataDir });
    const getWorkspaceAttemptRehydration = vi.fn();
    const internal = host as unknown as { client: unknown; coreState: string };
    internal.client = { getWorkspaceAttemptRehydration };
    internal.coreState = 'connected';

    await host.restoreActiveTask();
    expect(getWorkspaceAttemptRehydration).not.toHaveBeenCalled();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
});
