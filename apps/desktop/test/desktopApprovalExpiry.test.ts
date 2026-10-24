/**
 * An approval card must never stay on screen as if it were still actionable
 * after Core retired the request (nobody answered it). The card is cleared and
 * the desktop says what actually happened: nothing was approved.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DesktopSession } from '../src/host/desktopSession';
import type { RuntimeEventRecord } from '../../../../core/shared/wireTypes';

interface EmittedEvent {
  kind: string;
  summary?: string;
}

function sessionWithPendingApproval(dataDir: string) {
  const host = new DesktopSession({ productRoot: process.cwd(), dataDir });
  const events: EmittedEvent[] = [];
  const internal = host as unknown as {
    folder: string | null;
    coreState: string;
    active: unknown;
    pending: unknown;
    emit: (event: EmittedEvent) => void;
    handleRuntimeEvent: (event: RuntimeEventRecord) => Promise<void>;
  };
  internal.folder = 'C:\\Projects\\fixture-repo';
  internal.coreState = 'connected';
  internal.active = {
    attemptId: 'att-1', requestId: 'req-1', conversationId: 'conv-1', goal: 'g', tokenBuffer: '', terminal: false,
  };
  internal.pending = {
    card: { approvalId: 'appr-1', gate: 'mutation', toolName: 'web_research', scope: 'search the web', paths: [], detail: 'search the web' },
    envelope: {
      approvalId: 'appr-1', attemptId: 'att-1', expectedAttemptRevision: 1,
      expectedAttemptStatus: 'waiting_for_approval', requestedActionDigest: 'd', frozenContextHash: 'h',
    },
  };
  internal.emit = (event: EmittedEvent) => { events.push(event); };
  return { host, events, internal };
}

function expiredEvent(approvalId: string): RuntimeEventRecord {
  return {
    sequence: 1,
    id: 'revt-1',
    domain: 'approval',
    entityId: approvalId,
    eventType: 'approval_expired',
    actor: 'core:executor',
    clientId: null,
    metadata: { reason: 'no answer was recorded before the request stopped waiting' },
    createdAt: new Date().toISOString(),
    resultingRevision: 2,
  } as unknown as RuntimeEventRecord;
}

describe('an expired approval clears the desktop card', () => {
  it('drops the pending card and states that nothing was approved', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-approval-expired-'));
    const { host, events, internal } = sessionWithPendingApproval(dataDir);

    await internal.handleRuntimeEvent(expiredEvent('appr-1'));

    expect(internal.pending).toBeUndefined();
    const status = events.find((event) => event.kind === 'status');
    expect(status?.summary).toMatch(/expired/i);
    expect(status?.summary).toMatch(/nothing was approved/i);
    expect(status?.summary).not.toMatch(/denied|refused/i);
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('leaves an unrelated approval alone', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-approval-expired-other-'));
    const { host, events, internal } = sessionWithPendingApproval(dataDir);

    await internal.handleRuntimeEvent(expiredEvent('appr-other'));

    expect(internal.pending).toBeDefined();
    expect(events.filter((event) => event.kind === 'status')).toHaveLength(0);
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
});
