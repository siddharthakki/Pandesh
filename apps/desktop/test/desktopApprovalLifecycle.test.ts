import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openCoreDatabase } from '../../../core/db/openCore';
import type { CoreDatabase } from '../../../core/db/connection';
import { createConversation } from '../../../core/domain/conversations';
import { createAttempt, transitionAttempt, failAttempt } from '../../../core/domain/attempts';
import { createRequest } from '../../../core/domain/requests';
import { createApproval, getApproval } from '../../../core/domain/approvals';
import { listCapabilityActions } from '../../../core/domain/capabilityDispatch';
import { DesktopSession } from '../src/host/desktopSession';
import { projectMissionCockpit } from '../src/host/missionCockpit';
import type { DesktopActivityEvent } from '../src/host/missionCockpit';

describe('Complete approval lifecycle', () => {
  it('expires pending approvals when an attempt reaches a terminal state', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-lifecycle-'));
    const { db } = openCoreDatabase(path.join(dir, 'core.db'));
    try {
      const conv = createConversation(db, { mode: 'baat_kar', actor: 'test' });
      const request = createRequest(db, {
        clientId: 'test-client',
        currentMessage: 'Modify files',
        requestedMode: 'baat_kar',
        resolvedMode: 'baat_kar',
        routeReason: 'test',
        conversationId: conv.id,
        correlationId: conv.id,
        contextPolicy: { includeConversationHistory: true, includeProjectContext: false, includeRepositoryContext: false, includeGlobalStoryContext: false },
      });
      const attempt = createAttempt(db, { requestId: request.id, kind: 'baat_kar', actor: 'test' });
      transitionAttempt(db, attempt.id, { toStatus: 'running', actor: 'test' });
      transitionAttempt(db, attempt.id, { toStatus: 'waiting_for_approval', actor: 'test' });

      const approval = createApproval(db, {
        attemptId: attempt.id,
        kind: 'mutation',
        summary: { toolName: 'write_file', path: 'test.ts' },
        actor: 'test',
      });
      expect(approval.status).toBe('pending');

      // Now attempt fails or completes
      failAttempt(db, attempt.id, { failureReason: 'process killed', actor: 'test' });

      const reloaded = getApproval(db, approval.id);
      expect(reloaded.status).toBe('expired');

      // listCapabilityActions must report it as non-actionable
      const actionsSnapshot = listCapabilityActions(db, { correlationId: conv.id, clientId: 'test-client' });
      const action = actionsSnapshot.actions.find((a) => a.approvalId === approval.id);
      expect(action?.actionable).toBe(false);
      expect(action?.status).toBe('expired');
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('restores pending capability approvals across session reconnection', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-approval-reconnect-'));
    const session = new DesktopSession({ productRoot: process.cwd(), dataDir });
    const internal = session as unknown as {
      coreState: string;
      selectedConversationId: string;
      client: unknown;
      pending: { card: { approvalId: string }; envelope: { approvalId: string } } | undefined;
      restorePendingApproval: (convId: string) => Promise<void>;
    };

    internal.coreState = 'connected';
    internal.selectedConversationId = 'conv-restore-1';
    const mockActions = {
      attemptId: 'att-anchor',
      actions: [{
        approvalId: 'appr-restore-1',
        attemptId: 'att-anchor',
        kind: 'mutation' as const,
        status: 'pending' as const,
        actionable: true,
        toolName: 'write_file',
        arguments: { path: 'src/index.ts' },
        requestedAt: new Date().toISOString(),
        resolvedAt: null,
        resolution: null,
        expectedAttemptRevision: 1,
        expectedAttemptStatus: 'waiting_for_approval' as const,
        requestedActionDigest: 'digest-1',
        frozenContextHash: 'hash-1',
        revision: 1,
        presentation: null,
        outcome: 'pending' as const,
        invocation: null,
      }],
    };

    internal.client = {
      listCapabilityActions: vi.fn(async () => mockActions),
    };

    await internal.restorePendingApproval('conv-restore-1');
    expect(internal.pending).toBeDefined();
    expect(internal.pending?.card.approvalId).toBe('appr-restore-1');
    expect(session.snapshot().awaitingApproval).toBe(true);
    expect(session.snapshot().pendingApproval?.approvalId).toBe('appr-restore-1');

    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('never marks a task "Mission completed" while awaiting approval', () => {
    const events: DesktopActivityEvent[] = [
      { at: new Date(1000).toISOString(), kind: 'status', summary: 'Starting task', eventType: 'start' },
      { at: new Date(2000).toISOString(), kind: 'approval', summary: 'Waiting for mutation approval: write_file', eventType: 'approval_req' },
      { at: new Date(3000).toISOString(), kind: 'result', summary: 'Image Studio', text: 'Waiting for your approval to proceed' },
    ];

    const cockpit = projectMissionCockpit(events, {
      requestId: 'req-1',
      attemptId: 'att-1',
      running: false,
      terminal: false,
      pendingApproval: {
        approvalId: 'appr-1',
        gate: 'mutation',
        toolName: 'write_file',
        scope: 'write_file',
        paths: ['src/app.ts'],
        detail: 'Write file src/app.ts',
      },
      approvedApproval: null,
      startedAt: new Date(1000).toISOString(),
      nowMs: 4000,
    });

    expect(cockpit.terminal).toBe(false);
    expect(cockpit.authState).toBe('pending');
    expect(cockpit.checkpoints.some((cp) => cp.title === 'Mission completed')).toBe(false);
  });
});
