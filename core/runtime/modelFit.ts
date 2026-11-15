/**
 * Whether a local model will run well on this PC's GPU, as separate facts instead of one verdict.
 *
 * A single "fits / does not fit" hid four different things, so a model the owner had selected could read "Does not
 * fit". They are kept apart here:
 *   capacity     total graphics memory, and the budget Pandesh allows one model (total less room for the desktop)
 *   estimate     what the model needs: weights + context cache at a stated context size + runtime buffers
 *   available    graphics memory free right now (other loaded models and programs take some)
 *   readiness    what that means in practice, in words
 * A model that is loaded is not estimated at all: Ollama reports how much of it sits in graphics memory, and that
 * measured figure outranks every estimate.
 *
 * It estimates only from numbers Ollama and the GPU driver already report (read-only); it runs no model.
 */
import type { ModelMemoryProfile } from './ollamaModelInfo';

export type FitState =
  | 'on_gpu'          // loaded, all of it in graphics memory (measured)
  | 'partly_cpu'      // loaded, part of it runs on the CPU (measured)
  | 'fits'            // not loaded; fits the free graphics memory at Pandesh's context
  | 'fits_when_free'  // not loaded; fits the budget, but other things hold memory right now
  | 'spills'          // not loaded; too big at Pandesh's context, fits only a smaller one
  | 'too_large'       // not loaded; weights plus the smallest context do not fit
  | 'unknown';        // size or GPU not known

export interface FitLoaded { sizeBytes: number; vramBytes: number; contextLength?: number }
export interface FitGpu { totalBytes: number; freeBytes: number }

export interface ModelFitReport {
  state: FitState;
  /** Short label for a chip. */
  label: string;
  /** One sentence: what to expect. */
  summary: string;
  tone: 'ok' | 'muted' | 'warn';
  /** Total graphics memory; null without an NVIDIA GPU reading. */
  capacityBytes: number | null;
  /** Graphics memory one model may use (total less room for the desktop). */
  budgetBytes: number | null;
  /** Free right now. */
  availableBytes: number | null;
  weightsBytes: number | null;
  runtimeBytes: number;
  /** Estimated total at each context size tried; empty when unknown. */
  atContext: Array<{ ctx: number; cacheBytes: number; totalBytes: number; fitsBudget: boolean }>;
  /** The context size Pandesh runs this model at. */
  agentCtx: number;
  /** Largest tried context that fits the budget; null when none does. */
  maxFitCtx: number | null;
  /** Measured, for a loaded model. */
  measured: { sizeBytes: number; vramBytes: number; cpuShare: number; contextLength: number | null } | null;
  /** Plain statements of what is estimated or unknown. */
  uncertainty: string[];
}

export const RUNTIME_OVERHEAD_BYTES = 2 ** 30;
export const AGENT_CTX = 32_768;

const gb = (b: number) => `${(b / 1024 ** 3).toFixed(1)} GB`;
const ctxWord = (n: number) => `${Math.round(n / 1024)}K`;

export function assessFit(input: { profile?: ModelMemoryProfile; gpu: FitGpu | null; budgetBytes?: number; loaded?: FitLoaded; embedding?: boolean }): ModelFitReport {
  const { profile, gpu, loaded } = input;
  const budget = input.budgetBytes ?? null;
  const atContext = (profile?.kvByCtx ?? []).map((k) => {
    const totalBytes = (profile?.weightsBytes ?? 0) + k.bytes + RUNTIME_OVERHEAD_BYTES;
    return { ctx: k.ctx, cacheBytes: k.bytes, totalBytes, fitsBudget: budget !== null && totalBytes <= budget };
  });
  const base = {
    capacityBytes: gpu?.totalBytes ?? null, budgetBytes: budget, availableBytes: gpu?.freeBytes ?? null,
    weightsBytes: profile?.weightsBytes ?? null, runtimeBytes: RUNTIME_OVERHEAD_BYTES, atContext, agentCtx: AGENT_CTX,
    maxFitCtx: [...atContext].reverse().find((c) => c.fitsBudget)?.ctx ?? null,
  };
  const uncertainty: string[] = [];
  if (profile?.basis === 'rule_of_thumb') uncertainty.push('This model\'s attention layout was not reported, so its context cache is a rough guess (a quarter of the weights at 32K).');
  else if (profile) uncertainty.push('The context cache is calculated from the model\'s reported layout at full precision; Ollama\'s own settings (cache quantization, flash attention) can lower it and its real use can differ by a few GB.');
  if (!gpu) uncertainty.push('No NVIDIA GPU reading, so graphics-memory capacity is unknown.');
  if (gpu && gpu.freeBytes < gpu.totalBytes * 0.5) uncertainty.push('Free memory changes as programs open and close, so this can differ a minute from now.');

  if (input.embedding) return { ...base, state: 'unknown', label: 'Embeddings', summary: 'An embedding model is used for search, not for chat.', tone: 'muted', measured: null, uncertainty: [] };

  if (loaded && loaded.sizeBytes > 0) {
    const cpuShare = Math.max(0, 1 - loaded.vramBytes / loaded.sizeBytes);
    const measured = { ...loaded, cpuShare, contextLength: loaded.contextLength ?? null };
    const ctxNote = loaded.contextLength ? ` at ${ctxWord(loaded.contextLength)} context` : '';
    return cpuShare < 0.02
      ? { ...base, state: 'on_gpu', label: 'Loaded on the GPU', summary: `Measured by Ollama: all ${gb(loaded.sizeBytes)} is in graphics memory${ctxNote}.`, tone: 'ok', measured, uncertainty: [] }
      : { ...base, state: 'partly_cpu', label: `Loaded, ${Math.round(cpuShare * 100)}% on the CPU`, summary: `Measured by Ollama: ${gb(loaded.vramBytes)} of ${gb(loaded.sizeBytes)} is in graphics memory${ctxNote}; the rest runs on the CPU, which is slower.`, tone: 'warn', measured, uncertainty: [] };
  }

  if (!profile || !atContext.length || budget === null) {
    return { ...base, state: 'unknown', label: 'Fit unknown', summary: 'Not enough is reported to estimate whether this model fits the graphics memory.', tone: 'muted', measured: null, uncertainty };
  }
  const agent = atContext.find((c) => c.ctx === AGENT_CTX) ?? atContext[atContext.length - 1];
  const need = `${gb(agent.totalBytes)} at ${ctxWord(agent.ctx)} context (weights ${gb(profile.weightsBytes)} + cache ${gb(agent.cacheBytes)} + runtime ${gb(RUNTIME_OVERHEAD_BYTES)})`;
  if (agent.fitsBudget) {
    const free = gpu?.freeBytes ?? null;
    return free !== null && agent.totalBytes > free
      ? { ...base, state: 'fits_when_free', label: 'Fits when memory is free', summary: `Needs about ${need}. That is within the ${gb(budget)} budget, but only ${gb(free)} is free now.`, tone: 'muted', measured: null, uncertainty }
      : { ...base, state: 'fits', label: 'Fits the GPU', summary: `Needs about ${need}, within the ${gb(budget)} budget.`, tone: 'ok', measured: null, uncertainty };
  }
  if (base.maxFitCtx !== null) {
    return { ...base, state: 'spills', label: `Fits only up to ${ctxWord(base.maxFitCtx)} context`, summary: `Needs about ${need}, over the ${gb(budget)} budget, so at Pandesh's context part of it would run on the CPU and load slowly. It fits at up to ${ctxWord(base.maxFitCtx)}.`, tone: 'warn', measured: null, uncertainty };
  }
  return { ...base, state: 'too_large', label: 'Too large for this GPU', summary: `Even the smallest context needs ${gb(atContext[0].totalBytes)}, over the ${gb(budget)} budget.`, tone: 'warn', measured: null, uncertainty };
}
