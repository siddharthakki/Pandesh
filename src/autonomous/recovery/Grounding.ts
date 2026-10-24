import * as fs from 'fs/promises';
import * as path from 'path';
import { sha256 } from '../../coding/WorkspaceMutation';
import { EvidenceManifest, normalizeEvidencePath } from './AttemptJournal';
import type { GroundingMissing } from './RecoveryTypes';

/**
 * Architectural grounding precondition.
 *
 * A proposal that replaces or deletes an existing file F is admissible only if
 * the manifest holds evidence describing F's CURRENT bytes at the CURRENT base
 * revision. This is enforced by the runtime, not requested from the model: a
 * model that skipped the read simply cannot get its proposal through.
 *
 * `create` operations need no read of the (absent) target. A `replace` needs a
 * complete read because its payload is a whole-file rewrite; a `delete` needs
 * any fresh read. A `replace` the host itself derived from exact anchored edits
 * is not a model-authored rewrite: every byte outside the anchors came from the
 * host's own read of the current file, so it is grounded exactly when that read's
 * digest still equals the current bytes (binding re-checks the same digest).
 */

export interface GroundingOperation {
  type: string;
  path: string;
  /** Host-assigned on a replace derived from an anchored edit: the digest of the on-disk bytes it was applied to. */
  editBaseSha256?: string;
}

export interface GroundingVerdict {
  ok: boolean;
  missing: GroundingMissing[];
}

export interface CurrentFileState {
  exists: boolean;
  contentHash?: string;
}

export type ReadCurrentFile = (relativePath: string) => Promise<CurrentFileState>;

export function workspaceFileReader(workspaceRoot: string): ReadCurrentFile {
  return async relativePath => {
    try {
      const bytes = await fs.readFile(path.resolve(workspaceRoot, normalizeEvidencePath(relativePath)));
      return { exists: true, contentHash: sha256(bytes) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') {
        return { exists: false };
      }
      throw error;
    }
  };
}

export async function checkProposalGrounding(input: {
  operations: readonly GroundingOperation[];
  manifest: EvidenceManifest;
  readCurrent: ReadCurrentFile;
  baseRevision?: string;
}): Promise<GroundingVerdict> {
  const missing: GroundingMissing[] = [];
  const seen = new Set<string>();
  for (const operation of input.operations) {
    if (operation.type !== 'replace' && operation.type !== 'delete') continue;
    const target = normalizeEvidencePath(operation.path);
    if (seen.has(target)) continue;
    seen.add(target);
    const current = await input.readCurrent(target);
    // An absent target has nothing to read; the snapshot binder owns that conflict.
    if (!current.exists || !current.contentHash) continue;
    if (operation.type === 'replace' && operation.editBaseSha256 && operation.editBaseSha256 === current.contentHash) continue;
    const admission = input.manifest.admit(
      target,
      { contentHash: current.contentHash, baseRevision: input.baseRevision },
      { requireFullRead: operation.type === 'replace' },
    );
    if (!admission.admitted && admission.reason) missing.push({ path: target, reason: admission.reason });
  }
  return { ok: missing.length === 0, missing };
}
