/**
 * Rejecting an approval refuses one action; it does not end the attempt. Pi keeps running, tells the model the action
 * was not done, and writes the reply. The host must not declare the turn "cancelled" (and open the composer for the next
 * message) while Core is still finishing it — that let the next, unrelated message see the declined request unanswered
 * and propose it again (observed in the packaged app).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DesktopSession } from '../src/host/desktopSession';

type Internals = {
  client: unknown;
  active: Record<string, unknown> | undefined;
  pending: unknown;
  lastTurnOutcome: string | null;
  coreState: string;
};

let dataDir: string;
let host: DesktopSession;

function arm(attemptStatus: string) {
  const internal = host as unknown as Internals;
  internal.client = {
    resolveCapabilityApproval: async () => ({}),
    getAttempt: async () => ({ id: 'att-1', status: attemptStatus }),
    listCapabilityActions: async () => ({ actions: [] }),
    getConversationMessages: async () => ({ messages: [] }),
  };
  internal.active = { attemptId: 'att-1', requestId: 'req-1', conversationId: 'conv-1', goal: 'Delete old-draft.txt', tokenBuffer: '', terminal: false };
  internal.pending = {
    card: { approvalId: 'appr-1', gate: 'mutation', toolName: 'run_checks', scope: '', paths: [], detail: 'del old-draft.txt' },
    envelope: { approvalId: 'appr-1', attemptId: 'att-1', expectedAttemptRevision: 3, expectedAttemptStatus: 'waiting_for_approval', requestedActionDigest: 'd', frozenContextHash: 'h' },
  };
  internal.lastTurnOutcome = null;
  internal.coreState = 'connected';
  return internal;
}

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'panda-reject-turn-'));
  host = new DesktopSession({ productRoot: process.cwd(), dataDir });
});
afterEach(() => { fs.rmSync(dataDir, { recursive: true, force: true }); });

describe('rejecting an approval', () => {
  it('leaves the turn running while Core is still finishing the attempt', async () => {
    const internal = arm('running');
    await host.resolvePending('appr-1', 'rejected');
    expect(internal.active?.terminal).toBe(false);
    expect(internal.lastTurnOutcome).not.toBe('cancelled');
  });

  it('finishes the turn with Core\'s own outcome when Core has already settled it', async () => {
    const internal = arm('failed');
    await host.resolvePending('appr-1', 'rejected');
    expect(internal.active?.terminal).toBe(true);
    expect(internal.lastTurnOutcome).toBe('failed');
  });
});
