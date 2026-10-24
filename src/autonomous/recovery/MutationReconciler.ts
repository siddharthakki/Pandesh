import * as fs from 'fs/promises';
import * as path from 'path';
import { sha256, type HostBoundCodingProposal } from '../../coding/WorkspaceMutation';
import { sha } from './AttemptJournal';

/**
 * Exactly-once support for mutation across restarts.
 *
 * Given the exact host-bound proposal that was being applied, decide from the
 * bytes on disk whether the worktree is at its PRE state (safe to apply),
 * its POST state (must never be applied again) or something else (fail
 * closed). This never mutates anything.
 */
export type MutationReconciliation =
  | { state: 'applied'; detail: string[] }
  | { state: 'not_applied'; detail: string[] }
  | { state: 'mixed'; detail: string[] };

type OperationState = 'pre' | 'post' | 'either' | 'other';

async function currentHash(workspaceRoot: string, relativePath: string): Promise<string | null> {
  try {
    return sha256(await fs.readFile(path.resolve(workspaceRoot, relativePath)));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw error;
  }
}

export async function reconcileMutation(workspaceRoot: string, proposal: HostBoundCodingProposal): Promise<MutationReconciliation> {
  const states: OperationState[] = [];
  const detail: string[] = [];
  for (const operation of proposal.operations) {
    const current = await currentHash(workspaceRoot, operation.path);
    const pre = operation.snapshot.state === 'exists' ? operation.snapshot.sha256 : null;
    const post = operation.type === 'delete'
      ? null
      : sha256(Buffer.from(operation.content ?? '', 'utf8'));
    let state: OperationState;
    if (current === pre && current === post) state = 'either';
    else if (current === post) state = 'post';
    else if (current === pre) state = 'pre';
    else state = 'other';
    states.push(state);
    detail.push(`${operation.path}=${state}`);
  }
  if (states.includes('other')) return { state: 'mixed', detail };
  const hasPre = states.includes('pre');
  const hasPost = states.includes('post');
  if (hasPre && hasPost) return { state: 'mixed', detail };
  if (hasPost) return { state: 'applied', detail };
  if (hasPre) return { state: 'not_applied', detail };
  // Every operation is a no-op (pre === post): nothing to apply or undo.
  return { state: 'applied', detail };
}

/** Post-mutation content digests per operation path (null = absent), for the `applied` journal marker. */
export async function postMutationHashes(workspaceRoot: string, proposal: HostBoundCodingProposal): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {};
  for (const operation of proposal.operations) {
    out[operation.path] = await currentHash(workspaceRoot, operation.path);
  }
  return out;
}

/** Stable identity of a bound proposal's mutating content (used to tie `started`/`applied` markers). */
export function mutationProposalFingerprint(proposal: Pick<HostBoundCodingProposal, 'operations'>): string {
  return sha(proposal.operations
    .map(operation => `${operation.type}:${operation.path.replace(/\\/g, '/')}:${sha(operation.content ?? '')}`)
    .sort()
    .join('\n'));
}

// ── Restart planning ────────────────────────────────────────────────────────

export type ResumePlan =
  /** Nothing was applied (or the journal is empty): run the normal governed flow. */
  | { kind: 'fresh' }
  /** The mutation is on disk. Never apply it again; validate the composed result. */
  | { kind: 'resume_validation'; proposal: HostBoundCodingProposal; detail: string[] }
  /** On-disk state matches neither the pre nor the post state. Fail closed. */
  | { kind: 'uncertain'; detail: string[] };

/**
 * The approved proposal plus every later (repair) mutation, later operations
 * overriding earlier ones per path. This is the state the worktree should be in
 * and what validation must run against.
 */
export function composeMutationHistory(
  entries: ReadonlyArray<{ proposal?: HostBoundCodingProposal }>,
): HostBoundCodingProposal | undefined {
  const withProposal = entries.filter((entry): entry is { proposal: HostBoundCodingProposal } => entry.proposal !== undefined);
  if (withProposal.length === 0) return undefined;
  const base = withProposal[0].proposal;
  const normalize = (value: string): string => value.replace(/\\/g, '/');
  const byPath = new Map(base.operations.map(operation => [normalize(operation.path), operation]));
  for (const entry of withProposal.slice(1)) {
    for (const operation of entry.proposal.operations) {
      const key = normalize(operation.path);
      const approved = byPath.get(key);
      // A repair changes CONTENT only: the approved operation keeps its type and pre-mutation
      // snapshot (a created file stays a `create` of an absent path), exactly as the executor's
      // in-run repair loop treats it. Only a genuinely new path or a delete replaces the entry.
      byPath.set(key, approved && operation.type !== 'delete'
        ? { ...approved, content: operation.content }
        : operation);
    }
  }
  // The approved validation commands stay authoritative; repairs never change them.
  return { ...base, operations: [...byPath.values()] };
}

export async function planResumeAfterRestart(
  workspaceRoot: string,
  history: { entries: Array<{ phase: 'started' | 'applied'; proposal?: HostBoundCodingProposal }>; validationCompleted: boolean } | undefined,
): Promise<ResumePlan> {
  if (!history || history.entries.length === 0) return { kind: 'fresh' };
  const entries = history.entries;
  const appliedEntries = entries.filter(entry => entry.phase === 'applied');
  const lastPending = entries[entries.length - 1].phase === 'started' ? entries[entries.length - 1] : undefined;

  if (appliedEntries.length === 0) {
    // Only the first mutation was ever started.
    const first = entries[0].proposal;
    if (!first) return { kind: 'uncertain', detail: ['mutation_started_without_proposal'] };
    const reconciled = await reconcileMutation(workspaceRoot, first);
    if (reconciled.state === 'not_applied') return { kind: 'fresh' };
    if (reconciled.state === 'applied') return { kind: 'resume_validation', proposal: first, detail: reconciled.detail };
    return { kind: 'uncertain', detail: reconciled.detail };
  }

  const appliedSoFar = composeMutationHistory(appliedEntries.map(entry => ({ proposal: proposalFor(entries, entry) })));
  if (!appliedSoFar) return { kind: 'uncertain', detail: ['applied_mutation_without_proposal'] };
  if (lastPending?.proposal) {
    const withPending = composeMutationHistory([...appliedEntries.map(entry => ({ proposal: proposalFor(entries, entry) })), { proposal: lastPending.proposal }]);
    const landed = withPending ? await reconcileMutation(workspaceRoot, withPending) : undefined;
    if (withPending && landed?.state === 'applied') return { kind: 'resume_validation', proposal: withPending, detail: ['pending_repair_landed', ...landed.detail] };
  }
  const reconciled = await reconcileMutation(workspaceRoot, appliedSoFar);
  if (reconciled.state === 'applied') return { kind: 'resume_validation', proposal: appliedSoFar, detail: reconciled.detail };
  return { kind: 'uncertain', detail: reconciled.detail };
}

function proposalFor(
  entries: ReadonlyArray<{ phase: 'started' | 'applied'; proposal?: HostBoundCodingProposal }>,
  entry: { proposal?: HostBoundCodingProposal },
): HostBoundCodingProposal | undefined {
  return entry.proposal ?? entries.find(candidate => candidate.proposal !== undefined)?.proposal;
}
