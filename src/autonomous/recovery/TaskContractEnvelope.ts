import { sha } from './AttemptJournal';
import { mutationProposalFingerprint } from './MutationReconciler';
import type { HostBoundCodingProposal } from '../../coding/WorkspaceMutation';

/**
 * Durable, versioned identity of what an approval actually authorizes.
 *
 * The digest covers the instruction revision, the exact operations (type, path,
 * content digest) and the approved validation commands. An approval recorded
 * against one digest can never be used to authorize a different contract: if
 * steering moved the revision or the proposal changed, the digests differ and
 * the stale approval is refused.
 */
export const TASK_CONTRACT_ENVELOPE_VERSION = 'm42.contract.v1' as const;

export function contractDigest(input: {
  instructionRevision: number;
  proposal: Pick<HostBoundCodingProposal, 'operations' | 'validationCommands'>;
}): string {
  const commands = input.proposal.validationCommands
    .map(command => JSON.stringify({ kind: command.kind, script: command.script ?? null, args: command.args ?? [] }))
    .sort()
    .join(';');
  return sha([
    TASK_CONTRACT_ENVELOPE_VERSION,
    String(input.instructionRevision),
    mutationProposalFingerprint(input.proposal),
    commands,
  ].join('|'));
}

export interface ContractRecord {
  gate: string;
  digest: string;
  instructionRevision: number;
  proposalFingerprint?: string;
}

/**
 * Verifies a restored (post-restart) approval against the contract recorded when
 * its gate opened. A missing record means a task created before M42, which is
 * accepted (its existing instruction-revision fences still apply); a present but
 * different digest is refused.
 */
export function verifyRestoredContract(
  records: readonly ContractRecord[],
  proposal: HostBoundCodingProposal,
  instructionRevision: number,
): { ok: true; legacy: boolean } | { ok: false; reason: string } {
  const fingerprint = mutationProposalFingerprint(proposal);
  const matching = records.filter(record => record.gate === 'proposal' && record.proposalFingerprint === fingerprint);
  if (matching.length === 0) {
    // Nothing recorded for THIS proposal. If contracts exist for other proposals the checkpoint
    // is not the one that was reviewed; otherwise this is a pre-M42 task.
    const recordedForProposalGate = records.some(record => record.gate === 'proposal');
    return recordedForProposalGate ? { ok: false, reason: 'restored_proposal_has_no_recorded_contract' } : { ok: true, legacy: true };
  }
  const latest = matching[matching.length - 1];
  const expected = contractDigest({ instructionRevision, proposal });
  return latest.digest === expected ? { ok: true, legacy: false } : { ok: false, reason: 'contract_digest_mismatch' };
}
