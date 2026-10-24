import {
  buildFailureFingerprint,
  derivePatchFootprint,
  type FailureFingerprint,
  type FailureSemantics,
  type PatchDelta,
} from '../../autonomy/FailureFingerprint';
import type { JournalState } from './AttemptJournal';
import type { StageOutcome } from './RecoveryTypes';

/**
 * M46: gives a failed {@link StageOutcome} its semantic identity.
 *
 * The classifier already produced the facts; this adds the patch footprint (from
 * the mutations the journal recorded during the pass) and folds everything into one
 * {@link FailureFingerprint}. The result rides on the journaled `outcome` record, so
 * a restart sees the same history without recomputation.
 */
export interface OutcomeFingerprintInput {
  journalState: Readonly<Pick<JournalState, 'mutation'>>;
  /** Number of mutation entries the journal held when this pass began. */
  entriesAtPassStart: number;
  /** Symbols implicated by the failure, when repository intelligence could name them. */
  symbols?: readonly string[];
}

export function withFailureFingerprint(outcome: StageOutcome, input: OutcomeFingerprintInput): StageOutcome {
  if (outcome.ok) return outcome;
  const semantics = outcome.facts.validationFailures
    .map(failure => failure.semantic)
    .filter((item): item is FailureSemantics => item !== undefined);

  const entries = input.journalState.mutation?.entries ?? [];
  const passEntries = entries.slice(input.entriesAtPassStart).filter(entry => (entry.deltas?.length ?? 0) > 0);
  const latest: readonly PatchDelta[] | undefined = passEntries[passEntries.length - 1]?.deltas;
  const previous: readonly PatchDelta[] | undefined = passEntries.length >= 2
    ? passEntries[passEntries.length - 2].deltas
    : entries.slice(0, input.entriesAtPassStart).filter(entry => (entry.deltas?.length ?? 0) > 0).pop()?.deltas;
  const patch = latest ? derivePatchFootprint(latest, previous) : undefined;

  const files = semantics.length > 0
    ? outcome.facts.validationFailures.flatMap(failure => failure.namedPaths)
    : [...outcome.facts.groundingMissing.map(item => item.path), ...outcome.facts.proposalPaths];
  const fingerprint: FailureFingerprint = buildFailureFingerprint({
    semantics,
    subcode: outcome.subcode ?? outcome.cause,
    failureHash: outcome.fingerprints.failure,
    files,
    symbols: input.symbols,
    patch,
    actions: `read:${outcome.facts.filesRead.length};mutations:${passEntries.length};mutated:${outcome.facts.mutated ? 1 : 0}`,
    evidence: outcome.fingerprints.evidence,
  });
  return { ...outcome, failureFingerprint: fingerprint };
}
