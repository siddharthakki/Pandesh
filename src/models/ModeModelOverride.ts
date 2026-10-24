import { benchmarkForcedModel } from './BenchmarkModel';

/**
 * The ONE explicit-model decision for a new request. Auto means no explicit model: the only sources of an
 * override are the model the user visibly picked for this turn (the chat model dropdown) and, for model:test
 * only, the benchmark runner's forced model. No persisted setting (historical per-mode models, role models)
 * can become an override here, so a stale or uninstalled name can never leak into execution while the UI says Auto.
 */
export function effectiveModelOverride(perTurnOverride: string | undefined): string | undefined {
  // A benchmark-forced model (model:test only) is an explicit choice for every mode, so Auto's reliability
  // floor, registry scores and preference ranking never decide whether the candidate may be measured.
  return perTurnOverride?.trim() || benchmarkForcedModel() || undefined;
}
