/**
 * Model/profile-specific Ollama chat controls for Core.
 *
 * Not global defaults: omit a field to leave Ollama's model Modelfile /
 * server defaults in force. Explicit values are sent only when a profile
 * resolution or caller opts in. Estimated oversized prompts are refused;
 * this heuristic is not a tokenizer or a guarantee against server truncation.
 */
import type { ModelChatMessage, ModelToolDefinition } from './modelBackend';

export interface OllamaChatControls {
  /** When set, sent as options.num_ctx. When omitted, Ollama chooses. */
  numCtx?: number;
  /**
   * When set, sent as the top-level `think` field (Ollama thinking models).
   * When omitted, the model default applies. Only set after verifying the
   * runtime accepts the field for that model.
   */
  think?: boolean;
}

export interface OllamaChatControlResolution extends OllamaChatControls {
  profile: string | undefined;
  model: string;
  reason: string;
}

/** Rough character→token heuristic; tokenization and chat-template costs vary. */
export function estimatePromptTokens(input: {
  messages: readonly ModelChatMessage[];
  tools?: readonly ModelToolDefinition[];
}): number {
  let chars = 0;
  for (const message of input.messages) {
    chars += message.content.length;
    if (message.images?.length) {
      // Multimodal frames are large; charge a fixed reserve per image.
      chars += message.images.length * 4_000;
    }
  }
  if (input.tools?.length) {
    chars += JSON.stringify(input.tools).length;
  }
  return Math.ceil(chars / 4);
}

/**
 * Fail closed when the estimated prompt cannot fit the explicit context
 * window. Callers that omit numCtx skip this check (Ollama owns the slot).
 */
export function assertPromptFitsContext(input: {
  messages: readonly ModelChatMessage[];
  tools?: readonly ModelToolDefinition[];
  numCtx?: number;
  /** Tokens reserved for generation / tool JSON. */
  outputReserve?: number;
}): void {
  if (input.numCtx == null) return;
  const estimate = estimatePromptTokens(input);
  const reserve = Math.max(0, input.outputReserve ?? 512);
  const budget = input.numCtx - reserve;
  if (estimate > budget) {
    throw new Error(
      `prompt_exceeds_context: estimated ${estimate} tokens exceed num_ctx=${input.numCtx} `
      + `(reserve=${reserve}, budget=${budget}). Reduce context or raise the profile num_ctx; `
      + `Core refused this estimated oversized request before sending it.`,
    );
  }
}

/**
 * Resolve Ollama controls for a Core execution profile + model.
 *
 * Profile/model entries are filled only after measured probes. Until then
 * this returns omit-all (Ollama model defaults). Callers may pass
 * `overrides` for explicit experiments (e.g. footer 8K probe).
 */
export function resolveOllamaChatControls(input: {
  profile?: string;
  model: string;
  /** Explicit overrides from env or caller; win over profile table. */
  overrides?: OllamaChatControls;
}): OllamaChatControlResolution {
  const modelKey = input.model.trim().toLowerCase();
  const profile = input.profile;
  const fromProfile = profileTable(profile, modelKey);
  const envOverrides = envControlOverrides();
  const merged: OllamaChatControls = {
    ...fromProfile.controls,
    ...envOverrides,
    ...omitUndefined(input.overrides),
  };
  const reasonParts = [fromProfile.reason];
  if (hasAny(envOverrides)) reasonParts.push('env-override');
  if (input.overrides && hasAny(input.overrides)) reasonParts.push('caller-override');
  return {
    profile,
    model: input.model,
    reason: reasonParts.join('+'),
    ...merged,
  };
}

/**
 * Profile/model table. Empty controls = leave Ollama defaults.
 * Populated only after measured generation-speed / tool-call probes.
 */
function profileTable(
  _profile: string | undefined,
  _modelKey: string,
): { controls: OllamaChatControls; reason: string } {
  // Intentionally empty until footer/coding probes select verified defaults.
  // Do not silently cap every Core stream at 8K or disable thinking here.
  return { controls: {}, reason: 'omit:model-default' };
}

/** Optional env knobs for explicit experiments — never implicit global caps. */
function envControlOverrides(): OllamaChatControls {
  const controls: OllamaChatControls = {};
  const rawCtx = (process.env.KARKEDIKHA_OLLAMA_NUM_CTX ?? '').trim();
  if (/^\d+$/.test(rawCtx)) {
    controls.numCtx = Math.min(65_536, Math.max(512, Number(rawCtx)));
  }
  const thinkRaw = (process.env.KARKEDIKHA_OLLAMA_THINK ?? '').trim().toLowerCase();
  if (thinkRaw === '0' || thinkRaw === 'false' || thinkRaw === 'no') controls.think = false;
  if (thinkRaw === '1' || thinkRaw === 'true' || thinkRaw === 'yes') controls.think = true;
  return controls;
}

/** Default ceiling for AUTOMATIC truncation-recovery widening, whatever larger window a model advertises. */
export const OLLAMA_RECOVERY_NUM_CTX_CEILING_DEFAULT = 32_768;

/** Automatic recovery ceiling; KARKEDIKHA_OLLAMA_RECOVERY_MAX_NUM_CTX overrides it. Never affects explicit num_ctx settings. */
export function ollamaRecoveryNumCtxCeiling(): { tokens: number; source: 'default' | 'env' } {
  const raw = (process.env.KARKEDIKHA_OLLAMA_RECOVERY_MAX_NUM_CTX ?? '').trim();
  if (/^\d+$/.test(raw) && Number(raw) >= 512) return { tokens: Number(raw), source: 'env' };
  return { tokens: OLLAMA_RECOVERY_NUM_CTX_CEILING_DEFAULT, source: 'default' };
}

function omitUndefined(controls?: OllamaChatControls): OllamaChatControls {
  if (!controls) return {};
  const next: OllamaChatControls = {};
  if (controls.numCtx != null) next.numCtx = controls.numCtx;
  if (controls.think != null) next.think = controls.think;
  return next;
}

function hasAny(controls: OllamaChatControls): boolean {
  return controls.numCtx != null || controls.think != null;
}

/**
 * Ollama silently truncates an over-long prompt from the front (keeping only
 * system messages and the newest turns), which can drop the current user
 * query entirely — the server then rejects the request with "no user query
 * found in messages". When no explicit num_ctx was resolved and the estimated
 * prompt would not fit a conservative server default, size num_ctx to the
 * prompt instead (bucketed to limit model reloads). Small prompts keep the
 * omit-all model-default behaviour. Above the ceiling Core fails explicitly
 * rather than emitting a request Ollama would truncate.
 */
export const OLLAMA_ASSUMED_DEFAULT_NUM_CTX = 4_096;
export const OLLAMA_IMPLICIT_NUM_CTX_BUCKETS = [8_192, 16_384, 32_768, 65_536, 131_072] as const;

export function resolveImplicitNumCtx(input: {
  messages: readonly ModelChatMessage[];
  tools?: readonly ModelToolDefinition[];
  numCtx?: number;
  /** Tokens the model still has to write; defaults to the historic 2,048. */
  outputReserveTokens?: number;
  /** The model's frozen window: an implicit num_ctx never exceeds it. */
  maxContextTokens?: number;
}): number | undefined {
  if (input.numCtx != null) return input.numCtx;
  // The chars/4 heuristic under-counts code and chat-template overhead.
  const needed = Math.ceil(estimatePromptTokens(input) * 1.3) + (input.outputReserveTokens ?? 2_048);
  if (needed <= OLLAMA_ASSUMED_DEFAULT_NUM_CTX) return undefined;
  const bucket = OLLAMA_IMPLICIT_NUM_CTX_BUCKETS.find((size) => size >= needed)
    ?? OLLAMA_IMPLICIT_NUM_CTX_BUCKETS[OLLAMA_IMPLICIT_NUM_CTX_BUCKETS.length - 1];
  return input.maxContextTokens != null ? Math.min(bucket, input.maxContextTokens) : bucket;
}

/** Build the Ollama /api/chat fields for resolved controls (only set keys). */
export function ollamaPayloadControls(controls: OllamaChatControls): {
  think?: boolean;
  options?: { num_ctx: number };
} {
  const payload: { think?: boolean; options?: { num_ctx: number } } = {};
  if (controls.think != null) payload.think = controls.think;
  if (controls.numCtx != null) payload.options = { num_ctx: controls.numCtx };
  return payload;
}

export const BENCHMARK_SEED_ENV = 'KKD_BENCHMARK_SEED';
export const BENCHMARK_TEMPERATURE_ENV = 'KKD_BENCHMARK_TEMPERATURE';

/**
 * Benchmark-only reproducibility controls (scripts/model-bench --seed / --temperature). Set only on the bench's
 * own Golden child process; absent or unparsable means the field is omitted and product inference is untouched.
 */
export function benchmarkSamplingOptions(env: NodeJS.ProcessEnv = process.env): { seed?: number; temperature?: number } {
  const out: { seed?: number; temperature?: number } = {};
  const seed = env[BENCHMARK_SEED_ENV]?.trim();
  const temperature = env[BENCHMARK_TEMPERATURE_ENV]?.trim();
  if (seed && /^-?\d+$/.test(seed)) out.seed = Number(seed);
  if (temperature && Number.isFinite(Number(temperature))) out.temperature = Number(temperature);
  return out;
}

/** The values that actually went on the wire to Ollama. `null` = the field was omitted (Ollama/Modelfile default applies). */
export interface OllamaSentValues {
  numCtx: number | null;
  /** The output cap sent as options.num_predict; null when not sent, so the effective cap is the server's own. */
  numPredict: number | null;
  think: boolean | null;
}

/** Read the sent values back off the final /api/chat payload, not from the higher-level selection that produced it. */
export function sentValuesFromPayload(payload: { think?: unknown; options?: { num_ctx?: unknown; num_predict?: unknown } }): OllamaSentValues {
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    numCtx: num(payload.options?.num_ctx),
    numPredict: num(payload.options?.num_predict),
    think: typeof payload.think === 'boolean' ? payload.think : null,
  };
}
