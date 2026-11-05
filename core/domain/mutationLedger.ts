/**
 * The durable mutation ledger â€” restart-safe, exactly-once workspace edits.
 *
 * THE PROBLEM
 * -----------
 * A workspace edit is replay-sensitive. If the process dies between the
 * write and the completion record, the next run sees "an approved mutation
 * that has not been confirmed" and must decide what to do. Two wrong
 * answers are possible and both are bad:
 *
 *   - replay it: the edit is applied twice (for a whole-file replacement
 *     that is usually harmless, for an append or a generated file it is
 *     not);
 *   - refuse it and lose the work: the task can never be completed without
 *     a human.
 *
 * Neither is acceptable, and guessing from the prose is not acceptable
 * either.
 *
 * THE ANSWER
 * ----------
 * The WORKSPACE is the source of truth for whether a write landed. This
 * ledger records the INTENTION durably, before the write, together with the
 * exact pre-image and result identity:
 *
 *   - `baselineSha256` â€” the pre-image the edit was computed against
 *     (`absent` for a file that did not exist yet);
 *   - `resultSha256` â€” the exact content the edit produces.
 *
 * When the same edit is dispatched again (a restart, a resumed approval, a
 * retried step) the ledger and the file together decide:
 *
 *   - the file already hashes to `resultSha256` â†’ the write LANDED.
 *     The edit is a no-op: it is reported as already applied and nothing is
 *     written again. This is the idempotent path.
 *   - the file still hashes to `baselineSha256` â†’ the write did NOT land.
 *     It is safe to apply it.
 *   - the file hashes to NEITHER â†’ the workspace moved on in a way this
 *     proposal does not explain. The outcome is UNCERTAIN, and an uncertain
 *     side effect is NEVER replayed automatically. The caller is told.
 *
 * The last case is the same safety the Extension Host already applies
 * through `mutationOutcomeUncertain` (`src/agent/TaskRecovery.ts`): a
 * mutation whose outcome is unknown is not repeated on the hope that it
 * worked. Here it is enforced in Core, at the moment of the write, so the
 * uncertain state can never be written twice.
 */
import * as crypto from 'node:crypto';
import type { CoreDatabase } from '../db/connection';

/** The identity of a file that does not exist yet. */
export const ABSENT_FILE_SHA256 = 'absent';

export type MutationLedgerStatus = 'proposed' | 'applied';

export interface MutationLedgerRow {
  fingerprint: string;
  attemptId: string;
  toolName: string;
  path: string;
  baselineSha256: string;
  resultSha256: string;
  status: MutationLedgerStatus;
  recordedAt: string;
  completedAt: string | null;
}

/**
 * The identity of one mutation: same tool, same target, same pre-image,
 * same result. Two dispatches with the same fingerprint are the SAME
 * mutation, whether they are minutes or a restart apart.
 */
export function mutationFingerprint(input: {
  toolName: string;
  path: string;
  baselineSha256: string;
  resultSha256: string;
}): string {
  return crypto.createHash('sha256')
    .update([input.toolName, input.path, input.baselineSha256, input.resultSha256].join('\n'))
    .digest('hex');
}

/**
 * Records the INTENTION to mutate, before the mutation happens.
 *
 * A newer proposal for the same (tool, path) supersedes the older one:
 * only one of them can ever be applied, because both were computed against
 * the same pre-image.
 */
export function recordMutationIntent(
  db: CoreDatabase,
  input: {
    attemptId: string;
    toolName: string;
    path: string;
    baselineSha256: string;
    resultSha256: string;
    at?: string;
  },
): MutationLedgerRow {
  const fingerprint = mutationFingerprint(input);
  const recordedAt = input.at ?? new Date().toISOString();
  db.run(
    `INSERT INTO mutation_ledger (fingerprint, attemptId, toolName, path, baselineSha256, resultSha256, status, recordedAt, completedAt)
     VALUES (?, ?, ?, ?, ?, ?, 'proposed', ?, NULL)
     ON CONFLICT(fingerprint) DO UPDATE SET attemptId = excluded.attemptId, recordedAt = excluded.recordedAt`,
    [fingerprint, input.attemptId, input.toolName, input.path, input.baselineSha256, input.resultSha256, recordedAt],
  );
  return {
    fingerprint,
    attemptId: input.attemptId,
    toolName: input.toolName,
    path: input.path,
    baselineSha256: input.baselineSha256,
    resultSha256: input.resultSha256,
    status: 'proposed',
    recordedAt,
    completedAt: null,
  };
}

/** Marks a recorded mutation as applied. */
export function markMutationApplied(db: CoreDatabase, fingerprint: string, at?: string): void {
  db.run(
    "UPDATE mutation_ledger SET status = 'applied', completedAt = ? WHERE fingerprint = ?",
    [at ?? new Date().toISOString(), fingerprint],
  );
}


/**
 * The recorded mutation that produced this exact content at one of these
 * paths.
 *
 * This is how a completed write is recognised AFTER it happened: the file on
 * disk now hashes to the result the ledger recorded, so that row is the one
 * that was applied.
 */
export function findMutationByResult(
  db: CoreDatabase,
  toolName: string,
  paths: readonly string[],
  resultSha256: string,
): MutationLedgerRow | null {
  if (paths.length === 0) return null;
  const placeholders = paths.map(() => '?').join(',');
  const row = db.get<{
    fingerprint: string; attemptId: string; toolName: string; path: string;
    baselineSha256: string; resultSha256: string; status: MutationLedgerStatus;
    recordedAt: string; completedAt: string | null;
  }>(
    `SELECT fingerprint, attemptId, toolName, path, baselineSha256, resultSha256, status, recordedAt, completedAt FROM mutation_ledger
     WHERE toolName = ? AND resultSha256 = ? AND path IN (${placeholders}) ORDER BY recordedAt DESC LIMIT 1`,
    [toolName, resultSha256, ...paths],
  );
  return row ? { ...row } : null;
}

/** The decision a repeated mutation gets. */
export type MutationReplayDecision =
  /** The write did not land: it is safe to apply it. */
  | 'apply'
  /** The write landed: repeating it would be a duplicate edit. */
  | 'already_applied'
  /** The workspace moved on in a way this proposal does not explain. */
  | 'uncertain';

/**
 * The three-way decision, from the identities alone.
 *
 * This is the single rule both the ledger and the writer obey:
 *
 *   - the file already hashes to the RESULT -> the write landed. It is a
 *     no-op: report it and write nothing again;
 *   - the file still hashes to the BASELINE -> the write never landed. It is
 *     safe to apply it;
 *   - the file hashes to NEITHER -> the outcome is UNCERTAIN, and an
 *     uncertain side effect is NEVER replayed automatically.
 *
 * `currentSha256` is null when the file could not be read at all: that is
 * uncertainty too.
 */
export function decideMutationOutcome(input: {
  baselineSha256: string;
  resultSha256: string;
  currentSha256: string | null;
}): MutationReplayDecision {
  if (input.currentSha256 === null) return 'uncertain';
  if (input.currentSha256 === input.resultSha256) return 'already_applied';
  if (input.currentSha256 === input.baselineSha256) return 'apply';
  return 'uncertain';
}
