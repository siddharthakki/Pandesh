/**
 * Whether a validation result still describes the workspace as it is NOW.
 *
 * A validation is evidence about ONE revision of the workspace. An approved
 * edit that lands AFTER the validation ran makes that evidence stale: the
 * suite that passed was run against different bytes, so it cannot be used to
 * report the later state as verified. This is the rule that keeps "the task
 * is done" honest: the full tier that backs the completion decision has to
 * have run against the FINAL revision.
 *
 * THE WORKSPACE REVISION
 * ----------------------
 * The revision is the number of workspace-CHANGING invocations that succeeded
 * on the attempt:
 *
 *   - an approved `propose_file_change` / `propose_text_edit` write that
 *     landed, and
 *   - a shell command that demonstrably changes files.
 *
 * A read, a refused write, a validation-only command (`npm test`, `tsc
 * --noEmit`) and a write that was already applied change nothing, so they do
 * not move the revision: re-running the suite after them would only repeat
 * the same answer.
 *
 * Pure: no I/O, no clock, no database. The executor owns the recorded
 * invocations; this module only decides what they mean.
 */
import { isFileChangingShellCommand } from '../domain/mutationPolicy';

/** The workspace tools whose approved execution writes to the workspace. */
export const WORKSPACE_WRITE_TOOLS: ReadonlySet<string> = new Set(['propose_file_change', 'propose_text_edit']);

/** The result category of a write that was already present in the file. */
export const ALREADY_APPLIED_CATEGORY = 'mutation_already_applied';

/** One recorded tool invocation, reduced to what the freshness rule needs. */
export interface RecordedInvocation {
  toolName: string;
  status: string;
  /** The shell command, for `run_command`. */
  command?: string;
  /** The stable result category, when the invocation recorded one. */
  resultCategory?: string;
}

/**
 * Whether this invocation demonstrably changed the workspace.
 *
 * A write that was already applied is a VERIFIED no-op: the file already
 * held the proposed content, so the workspace did not move and the revision
 * must not move either.
 */
export function changesWorkspace(invocation: RecordedInvocation): boolean {
  if (invocation.status !== 'succeeded') return false;
  if (invocation.resultCategory === ALREADY_APPLIED_CATEGORY) return false;
  if (WORKSPACE_WRITE_TOOLS.has(invocation.toolName)) return true;
  if (invocation.toolName === 'run_command') return isFileChangingShellCommand(invocation.command ?? '');
  return false;
}

/** The workspace revision: how many workspace-changing invocations landed. */
export function workspaceRevision(invocations: readonly RecordedInvocation[]): number {
  return invocations.reduce(
    (count, invocation) => (changesWorkspace(invocation) ? count + 1 : count),
    0,
  );
}

/** A recorded full-tier validation, with the workspace revision it covered. */
export interface RecordedFullValidation {
  /** The workspace revision the full tier ran against. */
  revision: number;
  /** Whether the gates passed. */
  passed: boolean;
  /** The summary of what ran. */
  summary: string;
  /** The gate commands that actually ran. */
  gates: string[];
}

/**
 * Whether a recorded full-tier validation still describes the current
 * workspace revision.
 *
 * A validation from an EARLIER revision is stale and says nothing about the
 * current state; one from the CURRENT revision is the evidence the
 * completion decision needs. A record without a revision covers nothing:
 * the safest reading of an unreadable record is that it proves nothing.
 */
export function fullValidationCovers(
  recorded: RecordedFullValidation | undefined,
  currentRevision: number,
): boolean {
  return recorded !== undefined && recorded.revision === currentRevision;
}

/**
 * Whether a recorded full-tier validation ran the whole gate set the
 * completion decision needs.
 *
 * A workspace that declares no cheap gate runs the full tier after every
 * edit as a SUBSTITUTE, and that substitute runs a single gate. It is
 * evidence about the current revision, but it is not the whole full tier —
 * so it cannot stand in for the completion run, which must cover every full
 * gate the workspace declares.
 */
export function coversFullGateSet(recorded: RecordedFullValidation | undefined, expected: readonly string[]): boolean {
  if (!recorded) return false;
  const ran = new Set(recorded.gates);
  return expected.every((command) => ran.has(command));
}
