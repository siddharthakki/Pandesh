import { describe, expect, it } from 'vitest';
import { verifyTrustedDirtyProvenance, type ApprovedFileMutationRecord } from '../../orchestration/TrustedDirtyProvenance';

const CONVERSATION = 'conv-1';
const OTHER_CONVERSATION = 'conv-2';

function approval(overrides: Partial<ApprovedFileMutationRecord> = {}): ApprovedFileMutationRecord {
  return {
    approvalId: 'appr-1',
    path: 'src/users.js',
    content: 'approved content\n',
    resolvedAt: '2026-01-01T00:00:00.000Z',
    status: 'approved',
    conversationId: CONVERSATION,
    ...overrides,
  };
}

describe('verifyTrustedDirtyProvenance (Unified Conversation V1 Step 4)', () => {
  it('A. same-conversation trusted dirty: current bytes exactly match an approved Saath mutation', () => {
    const result = verifyTrustedDirtyProvenance({
      conversationId: CONVERSATION,
      dirtyTrackedPaths: ['src/users.js'],
      readCurrentFile: () => 'approved content\n',
      approvedMutations: [approval()],
    });
    expect(result.trusted).toBe(true);
    if (result.trusted) {
      expect(result.paths).toHaveLength(1);
      expect(result.paths[0].path).toBe('src/users.js');
      expect(result.paths[0].approvalId).toBe('appr-1');
    }
  });

  it('B. a foreign dirty file with no approved mutation blocks', () => {
    const result = verifyTrustedDirtyProvenance({
      conversationId: CONVERSATION,
      dirtyTrackedPaths: ['src/users.js', 'src/unrelated-manual-edit.js'],
      readCurrentFile: (path) => (path === 'src/users.js' ? 'approved content\n' : 'a manual edit nobody approved\n'),
      approvedMutations: [approval()],
    });
    expect(result.trusted).toBe(false);
    if (!result.trusted) expect(result.reason).toContain('unrelated-manual-edit.js');
  });

  it('C. the approved file was modified again by hand afterward: bytes no longer match, blocks', () => {
    const result = verifyTrustedDirtyProvenance({
      conversationId: CONVERSATION,
      dirtyTrackedPaths: ['src/users.js'],
      readCurrentFile: () => 'approved content\nPLUS a manual edit\n',
      approvedMutations: [approval()],
    });
    expect(result.trusted).toBe(false);
    if (!result.trusted) expect(result.reason).toContain('src/users.js');
  });

  it('D. a rejected proposal is never trusted provenance, even with byte-identical content', () => {
    const result = verifyTrustedDirtyProvenance({
      conversationId: CONVERSATION,
      dirtyTrackedPaths: ['src/users.js'],
      readCurrentFile: () => 'approved content\n',
      approvedMutations: [approval({ status: 'rejected' })],
    });
    expect(result.trusted).toBe(false);
    if (!result.trusted) expect(result.reason).toContain('no approved same-conversation');
  });

  it('E. an approved mutation from a DIFFERENT conversation does not authorize absorption', () => {
    const result = verifyTrustedDirtyProvenance({
      conversationId: CONVERSATION,
      dirtyTrackedPaths: ['src/users.js'],
      readCurrentFile: () => 'approved content\n',
      approvedMutations: [approval({ conversationId: OTHER_CONVERSATION })],
    });
    expect(result.trusted).toBe(false);
  });

  it('a clean workspace (no dirty tracked paths) trusts vacuously with an empty path list', () => {
    const result = verifyTrustedDirtyProvenance({
      conversationId: CONVERSATION,
      dirtyTrackedPaths: [],
      readCurrentFile: () => null,
      approvedMutations: [],
    });
    expect(result).toEqual({ trusted: true, paths: [] });
  });

  it('matches against any prior approved mutation for the same path, not only the most recent', () => {
    // The user approved an edit, then approved a further edit, but the
    // dirty bytes on disk still happen to equal the EARLIER approval (e.g. a
    // revert) — still sound provenance, since it's still exactly something
    // the user explicitly approved in this conversation.
    const result = verifyTrustedDirtyProvenance({
      conversationId: CONVERSATION,
      dirtyTrackedPaths: ['src/users.js'],
      readCurrentFile: () => 'first approved content\n',
      approvedMutations: [
        approval({ approvalId: 'appr-1', content: 'first approved content\n', resolvedAt: '2026-01-01T00:00:00.000Z' }),
        approval({ approvalId: 'appr-2', content: 'second approved content\n', resolvedAt: '2026-01-02T00:00:00.000Z' }),
      ],
    });
    expect(result.trusted).toBe(true);
    if (result.trusted) expect(result.paths[0].approvalId).toBe('appr-1');
  });
});
