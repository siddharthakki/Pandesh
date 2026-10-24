import type { ModelRole } from '../providers/InferenceTypes';

/** Full capability record for one model. */
export interface ModelCapability {
  /** Canonical model identifier (e.g. "qwen3-coder:30b"). */
  model: string;
  /** Accepts chat/completions requests. */
  chat: boolean;
  /** Supports structured tool calls (function calling). */
  tools: boolean;
  /** Understands image inputs. */
  vision: boolean;
  /** Can produce embedding vectors. */
  embeddings: boolean;
  /** Reliable at returning well-formed JSON (structured output). */
  structuredOutput: boolean;
  /** Streaming responses work correctly with this model. */
  streaming: boolean;
  /** Context window in tokens; 0 = unknown/use provider default. */
  contextWindow: number;
  /** Max output tokens; 0 = use provider default. */
  outputLimit: number;
  /** True when the model is ONLY useful for embeddings; must never be used as a chat model. */
  embeddingOnly: boolean;
  /**
   * Roles this model is permitted to serve.
   * An empty array means "any non-embedding role" (default for unknown chat models).
   */
  allowedRoles: ModelRole[];
}

/** Positive values only; each field is absent when the provider did not report it. */
export interface ProbedModelMetadata {
  /** Context the serving runtime is actually configured with (Ollama num_ctx, llama.cpp n_ctx, vLLM max_model_len). */
  contextWindow?: number;
  /** Context the model declares/was trained for. */
  declaredContextWindow?: number;
  /** Total parameters. */
  parameterCount?: number;
  /** Capabilities the provider itself declares for the model (Ollama /api/show `capabilities`). Evidence only. */
  providerCapabilities?: readonly string[];
}

// ---------------------------------------------------------------------------
// Static knowledge table — covers the models shipped in DEFAULTS
// ---------------------------------------------------------------------------

type PartialCap = Omit<ModelCapability, 'model'>;

const KNOWN: Record<string, PartialCap> = {
  // Agent / coding models
  'qwen3-coder:30b': {
    chat: true, tools: true, vision: false, embeddings: false,
    structuredOutput: true, streaming: true, contextWindow: 40960, outputLimit: 0,
    embeddingOnly: false, allowedRoles: ['agent', 'chat', 'edit', 'reviewer'],
  },
  'qwen3-coder:7b': {
    chat: true, tools: true, vision: false, embeddings: false,
    structuredOutput: true, streaming: true, contextWindow: 32768, outputLimit: 0,
    embeddingOnly: false, allowedRoles: ['agent', 'chat', 'edit', 'reviewer'],
  },
  'qwen2.5-coder:32b': {
    chat: true, tools: true, vision: false, embeddings: false,
    structuredOutput: true, streaming: true, contextWindow: 32768, outputLimit: 0,
    embeddingOnly: false, allowedRoles: ['agent', 'chat', 'edit', 'reviewer'],
  },
  'qwen2.5-coder:14b': {
    chat: true, tools: true, vision: false, embeddings: false,
    structuredOutput: true, streaming: true, contextWindow: 32768, outputLimit: 0,
    embeddingOnly: false, allowedRoles: ['agent', 'chat', 'edit', 'reviewer'],
  },
  'qwen2.5-coder:7b': {
    chat: true, tools: true, vision: false, embeddings: false,
    structuredOutput: true, streaming: true, contextWindow: 32768, outputLimit: 0,
    embeddingOnly: false, allowedRoles: ['agent', 'chat', 'edit', 'reviewer'],
  },
  // Autocomplete-only small model — must not be used for agent/chat/edit
  'qwen2.5-coder:1.5b': {
    chat: true, tools: false, vision: false, embeddings: false,
    structuredOutput: false, streaming: true, contextWindow: 8192, outputLimit: 0,
    embeddingOnly: false, allowedRoles: ['autocomplete'],
  },
  // ---------------------------------------------------------------------
  // Live-proven local coding workers.
  //
  // Both entries below describe models that have passed a real governed
  // Karke Dikha coding acceptance on this product (proposal -> approval ->
  // mutation -> validation), and whose capability flags and context windows
  // were read from the provider's own model metadata rather than guessed
  // from the model name. They exist because the generic name-pattern
  // heuristic cannot see either fact.
  // ---------------------------------------------------------------------
  // Measured: family mistral3, parameter_size 24.0B, Q4_K_M,
  // declared context length 393216. Native structured output confirmed in
  // production governed coding runs.
  'devstral-small-2:latest': {
    chat: true, tools: true, vision: false, embeddings: false,
    structuredOutput: true, streaming: true, contextWindow: 393216, outputLimit: 0,
    embeddingOnly: false, allowedRoles: ['agent', 'chat', 'edit', 'reviewer'],
  },
  // Measured: family qwen35, parameter_size 27.3B, Q4_K_M, declared context
  // length 262144. Native Ollama JSON-schema structured output is active in
  // production governed coding runs.
  'qwen3.8:27b-mtp-q4_k_m': {
    chat: true, tools: true, vision: false, embeddings: false,
    structuredOutput: true, streaming: true, contextWindow: 262144, outputLimit: 0,
    embeddingOnly: false, allowedRoles: ['agent', 'chat', 'edit', 'reviewer'],
  },
  // Chat/reasoning models
  'qwen3:14b': {
    chat: true, tools: true, vision: false, embeddings: false,
    structuredOutput: true, streaming: true, contextWindow: 32768, outputLimit: 0,
    embeddingOnly: false, allowedRoles: ['chat', 'reviewer'],
  },
  'qwen3:8b': {
    chat: true, tools: true, vision: false, embeddings: false,
    structuredOutput: true, streaming: true, contextWindow: 32768, outputLimit: 0,
    embeddingOnly: false, allowedRoles: ['chat', 'reviewer'],
  },
  // Vision models
  'qwen2.5vl:7b': {
    chat: true, tools: false, vision: true, embeddings: false,
    structuredOutput: false, streaming: true, contextWindow: 16384, outputLimit: 0,
    embeddingOnly: false, allowedRoles: ['vision'],
  },
  'qwen2.5vl:72b': {
    chat: true, tools: false, vision: true, embeddings: false,
    structuredOutput: false, streaming: true, contextWindow: 32768, outputLimit: 0,
    embeddingOnly: false, allowedRoles: ['vision'],
  },
  'llava:7b': {
    chat: true, tools: false, vision: true, embeddings: false,
    structuredOutput: false, streaming: true, contextWindow: 4096, outputLimit: 0,
    embeddingOnly: false, allowedRoles: ['vision'],
  },
  // Llama models
  'llama3.1:8b': {
    chat: true, tools: true, vision: false, embeddings: false,
    structuredOutput: true, streaming: true, contextWindow: 32768, outputLimit: 0,
    embeddingOnly: false, allowedRoles: ['chat', 'agent', 'reviewer'],
  },
  'llama3.1:70b': {
    chat: true, tools: true, vision: false, embeddings: false,
    structuredOutput: true, streaming: true, contextWindow: 32768, outputLimit: 0,
    embeddingOnly: false, allowedRoles: ['chat', 'agent', 'reviewer'],
  },
  // Mistral — does not support native tool calls
  'mistral:7b': {
    chat: true, tools: false, vision: false, embeddings: false,
    structuredOutput: false, streaming: true, contextWindow: 8192, outputLimit: 0,
    embeddingOnly: false, allowedRoles: ['chat'],
  },
  // Embedding-only models
  'nomic-embed-text': {
    chat: false, tools: false, vision: false, embeddings: true,
    structuredOutput: false, streaming: false, contextWindow: 8192, outputLimit: 0,
    embeddingOnly: true, allowedRoles: ['embedding'],
  },
  'mxbai-embed-large': {
    chat: false, tools: false, vision: false, embeddings: true,
    structuredOutput: false, streaming: false, contextWindow: 512, outputLimit: 0,
    embeddingOnly: true, allowedRoles: ['embedding'],
  },
  'all-minilm': {
    chat: false, tools: false, vision: false, embeddings: true,
    structuredOutput: false, streaming: false, contextWindow: 256, outputLimit: 0,
    embeddingOnly: true, allowedRoles: ['embedding'],
  },
};

/**
 * Success scores observed from real governed coding acceptance runs, keyed by
 * EXACT model name (lowercased) — never by prefix or family.
 *
 * This is the registry's only source of *observed* reliability, and it feeds
 * `TaskModelCandidate.reliability` ("Observed/configured success score"),
 * which `selectTaskModel` prefers over its name/capability heuristic. A model
 * absent from this table keeps the generic heuristic score unchanged, so a
 * sibling tag, a same-family model, or any unknown local model is never
 * promoted by these entries.
 *
 * Values are calibrated against the existing heuristic's own scale, in which a
 * 14-29B tool- and structured-output-capable chat model with no coding-specific
 * name scores 0.79, and a 30B purpose-built coder scores 0.92. Acceptance
 * evidence justifies scoring above the name-based guess for these two, and the
 * absence of broader benchmark evidence keeps them below the 30B-coder score.
 *
 * - qwen3.8:27b-mtp-q4_K_M (0.88): passed governed Karke coding acceptance with
 *   native Ollama JSON-schema structured output active in production — the
 *   exact capability the governed proposal contract depends on — at 27.3B with
 *   a ~41s warm request. Set at, not above, the strictest reliability floor:
 *   this rests on acceptance runs rather than broad benchmarking, and the model
 *   has a known cold-start risk.
 * - devstral-small-2:latest (0.84): passed governed Karke coding acceptance with
 *   native structured output at 24.0B. Scored below the entry above because the
 *   recorded acceptance evidence states explicitly that its PASS demonstrates
 *   the contract can succeed on that fixture and does not establish general
 *   model reliability.
 */
/**
 * Known-table keys that must match by EXACT model name only.
 *
 * `fromKnown` falls back to a family/tag prefix match for versioned keys,
 * which is right for the generic families in this table but wrong for the
 * live-proven worker entries: those describe two specific models verified by
 * real governed acceptance and by that model's own reported metadata. Without
 * this guard, a sibling quantization (e.g. `qwen3.8:27b-q4_K_M`) would silently
 * inherit a declared context length and pinned role list that were never
 * measured for it. Excluded models keep the name-pattern heuristic and their
 * own runtime probe, exactly as before these entries existed.
 */
const EXACT_ONLY_KNOWN = new Set<string>([
  'devstral-small-2:latest',
  'qwen3.8:27b-mtp-q4_k_m',
]);

const OBSERVED_RELIABILITY: Record<string, number> = {
  'devstral-small-2:latest': 0.84,
  'qwen3.8:27b-mtp-q4_k_m': 0.88,
};

/**
 * Models excluded from AUTOMATIC Karke selection on this machine, exact-name
 * only. This is a deliberate, reviewable, temporary policy decision — not a
 * capability fact — so it lives separately from OBSERVED_RELIABILITY above
 * rather than by deleting that acceptance evidence.
 *
 * `devstral-small-2:latest` (2026-09-08): `compareAutomaticPreference` in
 * TaskModelSelection.ts ranks capable candidates by cost (parameter count)
 * first, reliability second — so despite qwen3.8:27b-mtp-q4_K_M's measurably
 * higher observed reliability (0.88 vs 0.84), the smaller devstral-small-2
 * (24.0B vs 27.3B) was still being chosen automatically for ordinary
 * medium-complexity Karke Dikha work, purely on cost. A real Hands-off
 * Karke-on-Karke run automatically routed to devstral-small-2 this way and
 * the model call itself was cancelled after ~8 minutes with no completion
 * (see .acceptance-evidence and the M-dogfood session record) — inconclusive
 * on code quality, but real evidence this pairing needs more data before
 * cost alone decides between them again. Explicit user overrides still work
 * (see evaluateCandidate: this is an advisory reason, not a hard one) — only
 * automatic selection is restricted, and only for this one model.
 *
 * Revisit and remove once there is enough fresh acceptance evidence to trust
 * cost-based tie-breaking between these two again.
 */
const AUTOMATIC_SELECTION_EXCLUDED = new Set<string>([
  'devstral-small-2:latest',
]);

// Name-pattern heuristics for unknown models
const EMBEDDING_PATTERNS = [
  /embed/i, /rerank/i, /^all-minilm/i, /^bge-/i, /^e5-/i, /^gte-/i, /^jina-embed/i,
];
const VISION_PREFIXES = [
  'llava', 'bakllava', 'moondream', 'minicpm-v', 'qwen2-vl', 'qwen2.5vl',
  'llama3.2-vision', 'gemma3', 'mistral-small3.2',
];
const NO_TOOLS_PATTERNS = [
  /^mistral:/i, /^phi3:/i, /^gemma:/i, /^gemma2:/i, /^tinyllama/i,
];

// ---------------------------------------------------------------------------
// ModelCapabilityRegistry
// ---------------------------------------------------------------------------

export class ModelCapabilityRegistry {
  private static instance: ModelCapabilityRegistry | null = null;

  /** Runtime-probed results (keyed by "providerType:model"). */
  private readonly runtimeCache = new Map<string, Partial<ModelCapability>>();

  /**
   * Raw provider-reported model metadata from the runtime probe (keyed by
   * "providerType:model"): runtime vs declared context kept distinct, so the
   * candidate gate can resolve context through the same precedence the real
   * dispatch uses, plus the total parameter count (size evidence, not a
   * capability flag).
   */
  private readonly probedMetadata = new Map<string, ProbedModelMetadata>();

  /** User-supplied overrides (set via config or tests). */
  private readonly overrides = new Map<string, Partial<ModelCapability>>();

  static getInstance(): ModelCapabilityRegistry {
    if (!ModelCapabilityRegistry.instance) {
      ModelCapabilityRegistry.instance = new ModelCapabilityRegistry();
    }
    return ModelCapabilityRegistry.instance;
  }

  /** Reset singleton — useful in tests. */
  static resetInstance(): void {
    ModelCapabilityRegistry.instance = null;
  }

  /** Register an explicit capability override for a model (highest priority). */
  setOverride(model: string, caps: Partial<ModelCapability>): void {
    this.overrides.set(model.toLowerCase(), caps);
  }

  /** Store a runtime-probed result for a model. */
  cacheProbeResult(model: string, providerType: string, caps: Partial<ModelCapability>): void {
    this.runtimeCache.set(`${providerType}:${model.toLowerCase()}`, caps);
  }

  /** Store the raw provider-reported metadata a runtime probe returned. */
  cacheProbedMetadata(model: string, providerType: string, metadata: ProbedModelMetadata): void {
    this.probedMetadata.set(`${providerType}:${model.toLowerCase()}`, metadata);
  }

  /** Raw provider-reported metadata, or undefined when never probed (or nothing was reported). */
  getProbedMetadata(model: string, providerType: string): ProbedModelMetadata | undefined {
    return this.probedMetadata.get(`${providerType}:${model.toLowerCase()}`);
  }

  /**
   * True when a runtime probe result is already cached for this model, so a
   * caller (e.g. AgentPanel.selectModelForTask) can skip re-querying the
   * provider — the same cache backs getCapabilities(), so once probed here a
   * model's measured context window is reused for the rest of the session.
   */
  hasProbedResult(model: string, providerType: string): boolean {
    const key = `${providerType}:${model.toLowerCase()}`;
    return this.runtimeCache.has(key) || this.probedMetadata.has(key);
  }

  /**
   * Returns full capability record for a model.
   * Priority: explicit override > known table > name-pattern heuristic > safe default.
   */
  getCapabilities(model: string, providerType?: string): ModelCapability {
    const key = model.toLowerCase();
    const base = this.fromKnown(key) ?? this.fromHeuristics(model);
    const probed = providerType ? (this.runtimeCache.get(`${providerType}:${key}`) ?? {}) : {};
    const overridden = this.overrides.get(key) ?? {};

    return { ...base, ...probed, ...overridden, model };
  }

  /**
   * Observed success score for a model with real governed acceptance evidence,
   * or undefined when none exists. Exact-name lookup only — see
   * OBSERVED_RELIABILITY. Callers pass this straight through as
   * `TaskModelCandidate.reliability`; undefined leaves the selector's existing
   * heuristic score untouched.
   */
  getObservedReliability(model: string): number | undefined {
    return OBSERVED_RELIABILITY[model.toLowerCase()];
  }

  /**
   * True when this model must never be chosen by AUTOMATIC selection on this
   * machine — see AUTOMATIC_SELECTION_EXCLUDED. Exact-name lookup only, so a
   * sibling tag never inherits the exclusion. Does not affect an explicit
   * user override, which TaskModelSelection.evaluateCandidate treats as an
   * advisory (not hard) reason precisely so an override can still bypass it.
   */
  isAutomaticSelectionExcluded(model: string): boolean {
    return AUTOMATIC_SELECTION_EXCLUDED.has(model.toLowerCase());
  }

  supportsTools(model: string, providerType?: string): boolean {
    return this.getCapabilities(model, providerType).tools;
  }

  supportsVision(model: string, providerType?: string): boolean {
    return this.getCapabilities(model, providerType).vision;
  }

  isEmbeddingOnly(model: string, providerType?: string): boolean {
    return this.getCapabilities(model, providerType).embeddingOnly;
  }

  /**
   * Returns true if this model is permitted to serve the given role.
   * Models with an empty allowedRoles list are permitted for any non-embedding role.
   */
  isAllowedForRole(model: string, role: ModelRole, providerType?: string): boolean {
    const caps = this.getCapabilities(model, providerType);
    if (caps.embeddingOnly && role !== 'embedding') { return false; }
    if (caps.allowedRoles.length === 0) { return true; }
    return caps.allowedRoles.includes(role);
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private fromKnown(keyLower: string): ModelCapability | null {
    // Exact match first
    const exact = KNOWN[keyLower];
    if (exact) { return { ...exact, model: keyLower }; }

    // Prefix match for versioned keys (e.g. "qwen3-coder:30b-instruct-q4_k_m").
    // Exact-only entries never participate — see EXACT_ONLY_KNOWN.
    for (const [k, v] of Object.entries(KNOWN)) {
      if (EXACT_ONLY_KNOWN.has(k)) { continue; }
      if (keyLower.startsWith(k.split(':')[0] + ':') && k.includes(':')) {
        const tag = k.split(':')[1];
        if (keyLower.split(':')[1]?.startsWith(tag.split('-')[0])) {
          return { ...v, model: keyLower };
        }
      }
    }
    return null;
  }

  private fromHeuristics(model: string): ModelCapability {
    const lower = model.toLowerCase();
    const baseName = lower.split(':')[0];

    const isEmbedding = EMBEDDING_PATTERNS.some((p) => p.test(lower));
    const isVision = VISION_PREFIXES.some((p) => baseName.startsWith(p));
    const noTools = isEmbedding || isVision || NO_TOOLS_PATTERNS.some((p) => p.test(lower));

    return {
      model,
      chat: !isEmbedding,
      tools: !noTools,
      vision: isVision,
      embeddings: isEmbedding,
      structuredOutput: !isEmbedding && !isVision,
      streaming: !isEmbedding,
      contextWindow: 8192,
      outputLimit: 0,
      embeddingOnly: isEmbedding,
      allowedRoles: isEmbedding
        ? ['embedding']
        : isVision
          ? ['vision']
          : [],
    };
  }
}
