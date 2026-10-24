/**
 * Benchmark model qualification (scripts/model-bench) forces one discovered generative model for a run.
 * The runner sets this variable only for its own Golden child process, so normal selection is untouched
 * when it is absent. Hard incompatibilities (unavailable, no chat, embedding-only, context below the task
 * minimum, required tools/vision unsupported) still reject the model through the explicit-override path.
 */
export const BENCHMARK_FORCED_MODEL_ENV = 'KKD_BENCHMARK_FORCED_MODEL';

export function benchmarkForcedModel(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env[BENCHMARK_FORCED_MODEL_ENV]?.trim();
  return value ? value : undefined;
}
