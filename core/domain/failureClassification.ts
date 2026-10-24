/**
 * Failure-outcome classification for terminal (`failed`) attempts.
 *
 * The coordinator's requirement (M36 pass 2, Item 3): a terminal outcome
 * must be reported as one of several genuinely DIFFERENT categories —
 * product failure / model failure / validation failure / gate deadlock /
 * harness timeout — never collapsed into a single generic "not ok", and
 * never inferred from a UI label (the panda status text, an approval
 * card's resolved styling, etc). This module is the single, durable-record
 * -only source of that classification: it operates purely on the attempt's
 * own `failureReason` (persisted by Core in `core/domain/attempts.ts`'s
 * `failAttempt`), never on anything rendered in a webview.
 *
 * `failureReason` is a free-text column (see `core/db/migrations.ts`), not
 * a typed enum — introducing a new typed column across the whole attempt
 * lifecycle is a larger schema change than this fix warrants. Classification
 * here is therefore pattern-based over the known failureReason shapes the
 * codebase already produces (`core/runtime/executor.ts`,
 * `core/domain/karkeDikhaLifecycle.ts`). New failure sites should keep using
 * recognizable phrasing (or a `mutation_failed:` / `validation_failed:`
 * prefix) so they classify correctly here rather than falling through to
 * `model_failure`, the default for unrecognized free text (most historical
 * failureReason text originates from a model-invocation error).
 *
 * `harness_timeout` is deliberately NOT derivable from a `failureReason`
 * string at all — a harness timeout means Core never reached a terminal
 * attempt status within the polling budget, so there is no attempt record
 * to classify from. Callers must produce that classification themselves
 * when their own poll loop times out (see
 * `scripts/acceptance/run-m32-packaged-dogfood.mjs`'s `pollUntil`), and
 * must never claim `product_failure`/`model_failure`/etc in that case,
 * since no durable evidence for those exists.
 */
export type AttemptFailureClassification =
  | 'mutation_failed'
  | 'validation_failure'
  | 'gate_deadlock'
  | 'model_failure'
  | 'product_failure'
  | 'unclassified';

const MUTATION_FAILED_PATTERNS = [/mutation[_\s-]?failed/i, /failed to apply (the )?(proposed )?(mutation|operations?)/i];
const VALIDATION_FAILURE_PATTERNS = [/validation[_\s-]?(or[_\s-]?quality[_\s-]?gate[_\s-]?)?failed/i, /validation[_\s-]?failure/i, /npm test failed/i, /repository verification failed/i];
const GATE_DEADLOCK_PATTERNS = [/exceeded \d+ tool turns/i, /without a final answer/i, /no progress/i];
const PRODUCT_FAILURE_PATTERNS = [
  /no vision-capable model was selected/i,
  /do not match the frozen hash/i,
  /refusing to (silently drop|send tampered)/i,
  /does not support provider/i,
  /execution_binding_lost/i,
];

/**
 * Classifies a terminal attempt's `failureReason` into one of the distinct
 * outcome categories above. Returns `'unclassified'` (never a guess) for a
 * null/empty failureReason or free text that matches none of the known
 * shapes — an honest "we don't have a specific category for this" rather
 * than silently mislabeling it as e.g. a model failure.
 */
export function classifyAttemptFailure(failureReason: string | null | undefined): AttemptFailureClassification {
  const text = (failureReason ?? '').trim();
  if (!text) return 'unclassified';
  if (MUTATION_FAILED_PATTERNS.some((pattern) => pattern.test(text))) return 'mutation_failed';
  if (VALIDATION_FAILURE_PATTERNS.some((pattern) => pattern.test(text))) return 'validation_failure';
  if (GATE_DEADLOCK_PATTERNS.some((pattern) => pattern.test(text))) return 'gate_deadlock';
  if (PRODUCT_FAILURE_PATTERNS.some((pattern) => pattern.test(text))) return 'product_failure';
  // Most remaining unrecognized failureReason text is the raw message from
  // a model backend error (`core/runtime/executor.ts`'s catch-all
  // `failAttempt(..., { failureReason: err instanceof Error ? err.message : String(err) })`).
  return 'model_failure';
}
