/**
 * Repeated-identical-failure detection.
 *
 * A model that keeps failing the same way is wasting the budget of the
 * attempt it is in: each retry costs an inference, spends context, and — on
 * a mutating tool — risks a second side effect. The benchmark showed
 * exactly this shape: an edit whose anchor never resolved was attempted
 * again and again while the workspace never changed.
 *
 * The tracker is deliberately NOT a duplicate-call detector. A duplicate
 * CALL is already covered by the loop-progress policy
 * (`core/runtime/loopProgress.ts`): the same call at the same workspace
 * revision is not re-run. What this tracker catches is the case the loop
 * progress policy cannot see: DIFFERENT calls that fail the SAME way.
 *
 *   - attempt 1: `propose_text_edit` on `a.ts`, anchor not found
 *   - attempt 2: `propose_text_edit` on `a.ts`, anchor not found (the find
 *     text was reworded, so the call signature differs and the duplicate
 *     policy does not fire)
 *
 * The unit of comparison is the TARGET plus the failure CATEGORY: the same
 * tool against the same target, failing the same way. A success clears the
 * record, and so does a change in the workspace revision — either is
 * evidence that a fresh attempt could behave differently.
 *
 * Pure: no I/O, no clock. The executor owns every side effect, and the
 * counters live in the persisted loop-progress state, so a restart does not
 * forget that the same edit already failed three times.
 */

/** The maximum number of identical failures tolerated before the retry is refused. */
export const DEFAULT_MAX_IDENTICAL_FAILURES = 3;

/** How many distinct targets are remembered. */
export const MAX_TRACKED_FAILURE_SCOPES = 64;

/** One recorded failure streak, keyed by the target it applies to. */
export interface IdenticalFailureRecord {
  /** How many times this target failed the same way. */
  count: number;
  /** The stable result category of the last failure. */
  category: string;
}

/** The persisted counters. */
export type IdenticalFailureState = Record<string, IdenticalFailureRecord>;

/** Normalizes one argument value into a stable, comparable shape. */
function normalizeValue(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value.trim().replace(/\s+/g, ' '));
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `[${value.map(normalizeValue).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${key}:${normalizeValue(item)}`);
    return `{${entries.join(',')}}`;
  }
  return String(value);
}

/**
 * The scope of a tool call: the thing the call acts ON.
 *
 * For file tools that is the path; for a command it is the command line;
 * for anything else it is the whole normalized argument set. Two calls with
 * the same scope act on the same thing, so a failure of one is evidence
 * about the other.
 */
export function failureScopeKey(input: { toolName: string; arguments?: Record<string, unknown> }): string {
  const args = input.arguments ?? {};
  const pathValue = args.path;
  if (typeof pathValue === 'string' && pathValue.trim() !== '') {
    return `${input.toolName}|path:${normalizeValue(pathValue)}`;
  }
  const commandValue = args.command;
  if (typeof commandValue === 'string' && commandValue.trim() !== '') {
    return `${input.toolName}|command:${normalizeValue(commandValue)}`;
  }
  const keys = Object.keys(args).sort();
  const parts = keys.map((key) => {
    const value = normalizeValue(args[key]);
    return `${key}=${value.length > 240 ? `${value.slice(0, 240)}…` : value}`;
  });
  return `${input.toolName}|args:${parts.join('&')}`;
}

export interface IdenticalFailureVerdict {
  /** True when this failure has now been seen too often and must not be retried. */
  exhausted: boolean;
  /** How many times this exact failure has been seen, including this one. */
  count: number;
  /** The category of the recorded failure, when there is one. */
  category?: string;
  /** The message to show the model when the retry is refused. */
  message?: string;
}

/** The state a caller starts from. */
export function emptyIdenticalFailureState(): IdenticalFailureState {
  return {};
}

function refusalMessage(toolName: string, category: string, count: number): string {
  return `STOPPED: ${toolName} failed ${count} times in a row on the same target with the same result (${category}) `
    + 'and the workspace has not changed. Retrying the same way again cannot succeed. Change the approach: read the current file again, '
    + 'choose a different anchor or file, or use propose_file_change with the complete file content.';
}

/**
 * Records one failure and returns the updated state plus the verdict.
 *
 * The state is returned rather than mutated so it can live in a persisted
 * state object.
 */
export function noteIdenticalFailure(
  state: IdenticalFailureState | undefined,
  input: { toolName: string; resultCategory: string; arguments?: Record<string, unknown> },
  maxIdenticalFailures: number = DEFAULT_MAX_IDENTICAL_FAILURES,
): { state: IdenticalFailureState; verdict: IdenticalFailureVerdict } {
  const scope = failureScopeKey(input);
  const existing = state?.[scope];
  // A different category is a different failure: the streak restarts.
  const count = existing && existing.category === input.resultCategory ? existing.count + 1 : 1;
  const next: IdenticalFailureState = { ...(state ?? {}) };
  const keys = Object.keys(next);
  if (keys.length >= MAX_TRACKED_FAILURE_SCOPES && next[scope] === undefined) {
    delete next[keys[0]];
  }
  next[scope] = { count, category: input.resultCategory };
  return {
    state: next,
    verdict: {
      exhausted: count >= maxIdenticalFailures,
      count,
      category: input.resultCategory,
      ...(count >= maxIdenticalFailures ? { message: refusalMessage(input.toolName, input.resultCategory, count) } : {}),
    },
  };
}

/**
 * The verdict for a call that has NOT run yet: has this target already
 * failed the same way too many times?
 */
export function peekIdenticalFailure(
  state: IdenticalFailureState | undefined,
  input: { toolName: string; arguments?: Record<string, unknown> },
  maxIdenticalFailures: number = DEFAULT_MAX_IDENTICAL_FAILURES,
): IdenticalFailureVerdict {
  if (!state) return { exhausted: false, count: 0 };
  const scope = failureScopeKey(input);
  const record = state[scope];
  if (!record || record.count < maxIdenticalFailures) {
    return { exhausted: false, count: record?.count ?? 0, ...(record ? { category: record.category } : {}) };
  }
  return {
    exhausted: true,
    count: record.count,
    category: record.category,
    message: refusalMessage(input.toolName, record.category, record.count),
  };
}

/** A success clears the record of that exact target. */
export function clearIdenticalFailure(
  state: IdenticalFailureState | undefined,
  input: { toolName: string; arguments?: Record<string, unknown> },
): IdenticalFailureState | undefined {
  if (!state) return undefined;
  const scope = failureScopeKey(input);
  if (!(scope in state)) return state;
  const next = { ...state };
  delete next[scope];
  return Object.keys(next).length > 0 ? next : undefined;
}
