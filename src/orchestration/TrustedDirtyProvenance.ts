import * as crypto from 'crypto';

/**
 * Unified Conversation V1 — narrow trusted-dirty policy.
 *
 * Karke Dikha's delivery is a strict fast-forward-only merge that refuses to
 * touch a workspace with any tracked uncommitted change (LocalDeliveryService's
 * `workspace_dirty` precondition) — necessary, because Core cannot otherwise
 * know whether that dirty state is safe to build on top of. This module
 * defines the ONE narrow exception: a dirty path is "trusted" only when it is
 * durably, cryptographically attributable to an approved Saath Kar mutation
 * from the SAME conversation, with current bytes still byte-identical to
 * what was approved. Nothing is inferred from filenames, timing, or trust in
 * the caller — every path is independently verified against Core's own
 * approval records. Anything that doesn't verify — a foreign/manual edit, a
 * rejected proposal, a different conversation's approval, or bytes that have
 * since moved — fails closed, exactly as the unmodified `workspace_dirty`
 * block already does.
 *
 * Pure and side-effect-free: callers supply already-fetched approval records
 * and a file reader, so this is independently unit-testable without git or
 * Core.
 */

/** One approved (or rejected/pending) Saath Kar file-mutation, as durably
 * recorded by Core's M38 governed capability dispatch
 * (core/domain/capabilityDispatch.ts) — never invented or inferred. */
export interface ApprovedFileMutationRecord {
  approvalId: string;
  path: string;
  content: string;
  resolvedAt: string;
  status: 'approved' | 'rejected' | 'pending';
  /** The Core conversationId the owning capability-dispatch attempt belongs to. */
  conversationId: string;
}

export interface TrustedDirtyPath {
  path: string;
  sha256: string;
  approvalId: string;
  content: string;
}

export type TrustedDirtyVerification =
  | { trusted: true; paths: TrustedDirtyPath[] }
  | { trusted: false; reason: string };

export function sha256Hex(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

export function verifyTrustedDirtyProvenance(input: {
  conversationId: string;
  /** Workspace-relative paths git reports as tracked-and-dirty right now. */
  dirtyTrackedPaths: string[];
  /** Reads a tracked-dirty path's current on-disk content; null if unreadable. */
  readCurrentFile: (path: string) => string | null;
  approvedMutations: ApprovedFileMutationRecord[];
}): TrustedDirtyVerification {
  if (input.dirtyTrackedPaths.length === 0) return { trusted: true, paths: [] };

  const byPath = new Map<string, ApprovedFileMutationRecord[]>();
  for (const mutation of input.approvedMutations) {
    // Only an actually-approved mutation from THIS conversation is even a
    // candidate — a rejected proposal must never count as provenance (Step
    // 4.D), and another conversation's approval must never authorize
    // absorption into this one (Step 4.E), no matter how the bytes compare.
    if (mutation.status !== 'approved') continue;
    if (mutation.conversationId !== input.conversationId) continue;
    const list = byPath.get(mutation.path) ?? [];
    list.push(mutation);
    byPath.set(mutation.path, list);
  }
  for (const list of byPath.values()) list.sort((a, b) => (a.resolvedAt < b.resolvedAt ? 1 : -1));

  const trusted: TrustedDirtyPath[] = [];
  for (const trackedPath of input.dirtyTrackedPaths) {
    const candidates = byPath.get(trackedPath);
    if (!candidates || candidates.length === 0) {
      return { trusted: false, reason: `"${trackedPath}" is dirty but has no approved same-conversation Saath Kar mutation` };
    }
    const current = input.readCurrentFile(trackedPath);
    if (current === null) {
      return { trusted: false, reason: `"${trackedPath}" could not be read to verify its provenance` };
    }
    const currentHash = sha256Hex(current);
    // Most-recent-first: if the user re-approved a further Saath edit to the
    // same path, the newest approval is the canonical "what should be true
    // now" — but any exact byte match among this conversation's approvals is
    // sound provenance (still exactly what the user approved), so search all.
    const match = candidates.find((mutation) => sha256Hex(mutation.content) === currentHash);
    if (!match) {
      return {
        trusted: false,
        reason: `"${trackedPath}"'s current bytes do not match its approved same-conversation Saath Kar mutation (modified afterward, or a different unapproved edit)`,
      };
    }
    trusted.push({ path: trackedPath, sha256: currentHash, approvalId: match.approvalId, content: match.content });
  }
  return { trusted: true, paths: trusted };
}
