import { describe, expect, it } from 'vitest';
import type { CapabilityActionRestoreEntry } from '../../../core/shared/wireTypes';
import {
  requireMatchingPending,
  selectActionableApproval,
  toApprovalEnvelope,
  toCapabilityResolveInput,
  toDesktopApprovalCard,
} from '../src/host/desktopApproval';
import { DESKTOP_CHANNELS, RENDERER_VISIBLE_KEYS } from '../src/ipc';

function action(overrides: Partial<CapabilityActionRestoreEntry> = {}): CapabilityActionRestoreEntry {
  return {
    approvalId: 'appr_1',
    attemptId: 'att_anchor',
    kind: 'mutation',
    status: 'pending',
    actionable: true,
    toolName: 'propose_file_change',
    arguments: { path: 'note.txt', content: 'hello\n' },
    requestedAt: '2026-09-11T10:00:00.000Z',
    resolvedAt: null,
    resolution: null,
    expectedAttemptRevision: 4,
    expectedAttemptStatus: 'waiting_for_approval',
    requestedActionDigest: 'digest-abc',
    frozenContextHash: 'hash-xyz',
    revision: 1,
    presentation: {
      kind: 'write_file_diff',
      path: 'note.txt',
      diff: '--- a/note.txt\n+++ b/note.txt\n@@ -1 +1 @@\n-old\n+hello\n',
    },
    outcome: 'pending',
    invocation: null,
    ...overrides,
  };
}

describe('desktop approval mapping', () => {
  it('selects only the pending actionable Core gate', () => {
    const selected = selectActionableApproval([
      action({ approvalId: 'appr_old', actionable: false, status: 'approved', outcome: 'approved' }),
      action({ approvalId: 'appr_live' }),
    ]);
    expect(selected?.approvalId).toBe('appr_live');
    expect(selectActionableApproval([action({ actionable: false, status: 'rejected' })])).toBeNull();
  });

  it('renders a Gmail draft as readable mail, not raw JSON, and says it is not sent', () => {
    const card = toDesktopApprovalCard(action({
      toolName: 'gmail_create_draft',
      arguments: { to: ['a@example.com'], subject: 'Hi', bodyText: 'Body text' },
      presentation: {},
    }));
    expect(card.detail).toContain('will NOT be sent');
    expect(card.detail).toContain('To: a@example.com');
    expect(card.detail).toContain('Subject: Hi');
    expect(card.detail).toContain('Body text');
    expect(card.detail).not.toContain('{');
  });

  it('renders the frozen mission envelope as the authorization card', () => {
    const card = toDesktopApprovalCard(action({
      toolName: 'authorize_mission',
      arguments: { digest: 'sha256:abc', attemptId: 'att_mission' },
      presentation: {
        cardText: 'Repository: reading-list\nDenied: push, network\nEnvelope digest: sha256:abc',
        digest: 'sha256:abc',
      },
    }));
    expect(card.toolName).toBe('authorize_mission');
    expect(card.scope).toBe('Authorize autonomous mission');
    expect(card.detail).toContain('Repository: reading-list');
    expect(card.detail).toContain('Denied: push, network');
    expect(card.detail).toContain('Envelope digest: sha256:abc');
  });

  it('shows the Core gate and write scope without inventing paths', () => {
    const card = toDesktopApprovalCard(action());
    expect(card.gate).toBe('mutation');
    expect(card.toolName).toBe('propose_file_change');
    expect(card.scope).toBe('propose_file_change note.txt');
    expect(card.paths).toEqual(['note.txt']);
    expect(card.detail).toContain('+++ b/note.txt');
    expect(card.detail).not.toContain('digest-abc');
    expect(card.detail).not.toContain('hash-xyz');
  });

  it('approve payload relays the frozen Core envelope and only sets resolution', () => {
    const envelope = toApprovalEnvelope(action());
    const approved = toCapabilityResolveInput(envelope, 'approved');
    expect(approved).toEqual({
      approvalId: 'appr_1',
      attemptId: 'att_anchor',
      expectedAttemptRevision: 4,
      expectedAttemptStatus: 'waiting_for_approval',
      requestedActionDigest: 'digest-abc',
      frozenContextHash: 'hash-xyz',
      resolution: 'approved',
    });
  });

  it('reject uses the same Core envelope and does not widen the gate', () => {
    const envelope = toApprovalEnvelope(action({
      expectedAttemptRevision: 7,
      requestedActionDigest: 'digest-reject',
      frozenContextHash: 'hash-reject',
    }));
    const rejected = toCapabilityResolveInput(envelope, 'rejected');
    const approved = toCapabilityResolveInput(envelope, 'approved');
    expect(rejected.resolution).toBe('rejected');
    expect(approved.resolution).toBe('approved');
    expect(rejected.requestedActionDigest).toBe(approved.requestedActionDigest);
    expect(rejected.frozenContextHash).toBe(approved.frozenContextHash);
    expect(rejected.expectedAttemptRevision).toBe(7);
    expect(rejected.attemptId).toBe('att_anchor');
  });

  it('refuses a resolve that does not match the pending Core approval', () => {
    const pending = toApprovalEnvelope(action());
    expect(() => requireMatchingPending(null, 'appr_1')).toThrow(/no pending Core approval/);
    expect(() => requireMatchingPending(pending, 'appr_other')).toThrow(/does not match/);
    expect(requireMatchingPending(pending, 'appr_1').approvalId).toBe('appr_1');
  });
});

describe('desktop approval IPC contract', () => {
  it('keeps approval resolve on a host channel and omits secrets from the snapshot', () => {
    expect(DESKTOP_CHANNELS.resolveApproval).toBe('desktop:resolveApproval');
    expect(DESKTOP_CHANNELS.continueTask).toBe('desktop:continueTask');
    expect(RENDERER_VISIBLE_KEYS).toContain('pendingApproval');
    expect(RENDERER_VISIBLE_KEYS.join(',')).not.toMatch(/token|digest|frozenContextHash|authorization/i);
  });
});
