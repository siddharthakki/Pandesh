import { ProviderType } from '../providers/ProviderTypes';

export type ContextLimitProvenance =
  | 'user_override'
  | 'provider_runtime'
  | 'profile_operational'
  | 'profile_declared'
  | 'conservative_fallback';

export type TokenCountingStrategy = 'qwen' | 'llama' | 'mistral' | 'glm' | 'generic';
export type ToolProtocol = 'openai-tools' | 'qwen-xml' | 'json-envelope' | 'none';

export interface ModelProfile {
  id: string;
  family: string;
  providerKind?: ProviderType;
  match: RegExp;
  declaredContextLimit?: number;
  operationalContextLimit?: number;
  tokenizer: TokenCountingStrategy;
  toolProtocols: ToolProtocol[];
  structuredOutput: 'json_schema' | 'ollama_format' | 'unsupported';
  reasoningTags: string[];
  preferredTemperature: number;
  safeOutputReserve: number;
  safeRepairReserve: number;
  maxToolResultTokens: number;
  duplicateCallThreshold: number;
  compatibilityNotes: string[];
  fallback: boolean;
  /**
   * Set only on a profile that has verified BOTH that its provider honors a
   * native disable-thinking request AND that the model's own unconstrained
   * "thinking" tokens are not subject to `format`'s grammar (so they can
   * consume the entire output budget before any constrained content is
   * emitted — see the ornith-1.5-35b-a3b-local profile below). Absent
   * (default) for every other profile: no behavior change.
   */
  disableNativeThinking?: true;
}

const PROFILES: ModelProfile[] = [
  {
    id: 'qwen-coder-local',
    family: 'qwen-coder',
    match: /qwen(?:2\.5|3)?[-_ ]?coder|qwen.*coder/i,
    declaredContextLimit: 131072,
    operationalContextLimit: 32768,
    tokenizer: 'qwen',
    toolProtocols: ['openai-tools', 'qwen-xml', 'json-envelope'],
    structuredOutput: 'ollama_format',
    reasoningTags: ['think'],
    preferredTemperature: 0.2,
    safeOutputReserve: 4096,
    safeRepairReserve: 512,
    maxToolResultTokens: 4096,
    duplicateCallThreshold: 2,
    compatibilityNotes: ['Often supports larger advertised context than active Ollama num_ctx.'],
    fallback: false,
  },
  {
    id: 'qwen-vision-local',
    family: 'qwen-vision',
    match: /qwen.*(?:vl|vision)|qwenvl/i,
    declaredContextLimit: 32768,
    operationalContextLimit: 16384,
    tokenizer: 'qwen',
    toolProtocols: ['none'],
    structuredOutput: 'unsupported',
    reasoningTags: ['think'],
    preferredTemperature: 0.2,
    safeOutputReserve: 2048,
    safeRepairReserve: 0,
    maxToolResultTokens: 0,
    duplicateCallThreshold: 2,
    compatibilityNotes: ['Vision requests intentionally omit tools.'],
    fallback: false,
  },
  {
    // Qwen 3.5-architecture general (non-coder) local models, e.g.
    // `qwen3.6:27b`, `qwen3.8:27b-q4_K_M`, `qwen3.8:27b-mtp-q4_K_M` and
    // vendor-prefixed repacks such as
    // `orcarouter/Qwen3.8-27B-Uncensored:Q4_K_M`.
    //
    // `ollama_format` (not `json_schema`) is the truthful capability: native
    // JSON-schema `format` on the Ollama /api/chat path is what was measured
    // — every benchmarked run of these names returned a schema-conforming
    // CodingProposal (see .acceptance-evidence/karke-model-benchmark). No
    // OpenAI-compatible `response_format` behaviour was measured for them, so
    // that channel stays deferred by `decideStructuredOutput`.
    //
    // Deliberately matched narrowly to the verified 3.6/3.8 releases: an
    // unverified future Qwen release must fall back to the generic profile
    // rather than inherit a capability nobody measured. Declared below the
    // coder and vision profiles so `*-coder*` and `*-vl*` names keep theirs.
    id: 'qwen-general-local',
    family: 'qwen-general',
    match: /qwen[-_ ]?3\.(?:6|8)/i,
    declaredContextLimit: 262144,
    operationalContextLimit: 32768,
    tokenizer: 'qwen',
    toolProtocols: ['openai-tools', 'qwen-xml', 'json-envelope'],
    structuredOutput: 'ollama_format',
    reasoningTags: ['think'],
    preferredTemperature: 0.2,
    safeOutputReserve: 4096,
    safeRepairReserve: 512,
    maxToolResultTokens: 4096,
    duplicateCallThreshold: 2,
    compatibilityNotes: ['Native Ollama JSON-schema format verified for governed coding proposals.'],
    fallback: false,
  },
  {
    id: 'glm-coder-local',
    family: 'glm',
    match: /glm|codegeex/i,
    declaredContextLimit: 131072,
    operationalContextLimit: 32768,
    tokenizer: 'glm',
    toolProtocols: ['openai-tools', 'json-envelope'],
    structuredOutput: 'json_schema',
    reasoningTags: ['think'],
    preferredTemperature: 0.2,
    safeOutputReserve: 4096,
    safeRepairReserve: 512,
    maxToolResultTokens: 4096,
    duplicateCallThreshold: 2,
    compatibilityNotes: ['OpenAI-compatible servers vary in structured output support.'],
    fallback: false,
  },
  {
    id: 'llama-local',
    family: 'llama',
    match: /llama|codellama/i,
    declaredContextLimit: 32768,
    operationalContextLimit: 24576,
    tokenizer: 'llama',
    toolProtocols: ['openai-tools', 'json-envelope'],
    structuredOutput: 'json_schema',
    reasoningTags: [],
    preferredTemperature: 0.3,
    safeOutputReserve: 3072,
    safeRepairReserve: 384,
    maxToolResultTokens: 3072,
    duplicateCallThreshold: 2,
    compatibilityNotes: ['Conservative local profile for Llama-family coding models.'],
    fallback: false,
  },
  {
    id: 'mistral-devstral-local',
    family: 'mistral',
    match: /mistral|devstral|codestral/i,
    declaredContextLimit: 32768,
    operationalContextLimit: 24576,
    tokenizer: 'mistral',
    toolProtocols: ['openai-tools', 'json-envelope'],
    structuredOutput: 'json_schema',
    reasoningTags: [],
    preferredTemperature: 0.2,
    safeOutputReserve: 3072,
    safeRepairReserve: 384,
    maxToolResultTokens: 3072,
    duplicateCallThreshold: 2,
    compatibilityNotes: ['Prefer provider-confirmed limits when served through LM Studio.'],
    fallback: false,
  },
  {
    // Verified 2026-09-09 via standalone Ollama /api/chat probes against the
    // exact GGUF release matched below: a CodingProposal-schema `format`
    // request returned valid, schema-conforming JSON, and a separate
    // native-tool-call probe returned a well-formed `tool_calls` response.
    // Ollama's own `/api/tags` reports architecture family `qwen35moe` for
    // this model, hence the `qwen` tokenizer strategy below.
    //
    // Without this profile, `hf.co/ornith-ai/Ornith-1.5-35B-A3B-GGUF` fell to
    // GENERIC_LOCAL_PROFILE (`structuredOutput: 'unsupported'`), so
    // `decideStructuredOutput()` deferred (`profile_unsupported`) and
    // Ollama's native `format` was never attached to the real governed
    // request (confirmed live, att_144a4f36 / att_4ed6e277). Fixing that
    // alone did not resolve the real task: a follow-up investigation proved
    // (raw Ollama response fields `done_reason`/`eval_count`, normally
    // discarded by OllamaProvider's typed response — never exposed to
    // production) that this model's `thinking` tokens are NOT constrained by
    // `format`'s grammar. With thinking left enabled, a real 23K-character
    // repository-grounded prompt produced `done_reason:"length"`,
    // `thinkingLength:10837` and zero content — thinking alone exhausted the
    // entire 2457-token output budget before the constrained content region
    // was ever reached. With `think:false` (Ollama's existing, documented
    // native disable-thinking request) and every other setting held
    // constant, the identical request produced `done_reason:"stop"` and a
    // valid, schema-conforming CodingProposal using only 732 of 2457 tokens.
    // `disableNativeThinking` below requests exactly that, for this verified
    // model/provider combination only.
    //
    // Matched narrowly to the exact verified release only — an unmeasured
    // other Ornith release (e.g. a 1.0-9B build) must fall to the generic
    // profile like any other unmeasured name, the same discipline the
    // qwen-general-local profile above already follows. Scoped to
    // `providerKind: 'ollama'` because only the Ollama path was measured.
    id: 'ornith-1.5-35b-a3b-local',
    family: 'ornith',
    match: /hf\.co\/ornith-ai\/ornith-1\.5-35b-a3b/i,
    providerKind: 'ollama',
    declaredContextLimit: 262144,
    operationalContextLimit: 16384,
    tokenizer: 'qwen',
    toolProtocols: ['openai-tools'],
    structuredOutput: 'ollama_format',
    reasoningTags: ['think'],
    disableNativeThinking: true,
    preferredTemperature: 0.2,
    safeOutputReserve: 4096,
    safeRepairReserve: 512,
    maxToolResultTokens: 4096,
    duplicateCallThreshold: 2,
    compatibilityNotes: ['Native Ollama JSON-schema format verified for governed coding proposals; native tool-calling also verified but the governed dispatch paths that could use it never send tools.'],
    fallback: false,
  },
];

/**
 * Conservative fallback for unknown models.
 *
 * Scope note (intentional and documented): every `ProviderType` in this
 * repository is a local-first deployment — `'ollama'` and
 * `'openai-compatible'` (LM Studio or another locally hosted OpenAI-protocol
 * server, see ProviderGateway). There is no cloud/frontier provider kind, so
 * this 8K conservative fallback can only ever constrain unknown *local*
 * models. If a genuinely remote provider kind is ever added to
 * `ProviderType`, it must ship with its own profiles (matched via
 * `ModelProfile.providerKind`) so this fallback does not constrain it.
 * Provider-runtime metadata (`provider_runtime`) always outranks this
 * fallback's operational limit.
 */
export const GENERIC_LOCAL_PROFILE: ModelProfile = {
  id: 'generic-openai-compatible-local',
  family: 'generic-local',
  match: /.*/,
  declaredContextLimit: 8192,
  operationalContextLimit: 8192,
  tokenizer: 'generic',
  toolProtocols: ['openai-tools', 'json-envelope'],
  structuredOutput: 'unsupported',
  reasoningTags: ['think'],
  preferredTemperature: 0.3,
  safeOutputReserve: 2048,
  safeRepairReserve: 256,
  maxToolResultTokens: 2048,
  duplicateCallThreshold: 2,
  compatibilityNotes: ['Fallback profile: context and token counts are conservative estimates.'],
  fallback: true,
};

export class ModelProfileRegistry {
  /**
   * Profiles are matched on both the model name and, when a profile declares
   * `providerKind`, the provider kind — a profile scoped to one provider kind
   * never captures another provider's models.
   */
  static resolve(model: string, providerKind: ProviderType): ModelProfile {
    const profile = PROFILES.find(item => item.match.test(model) && (!item.providerKind || item.providerKind === providerKind));
    if (profile) return profile;
    // M46: an unknown model gets the conservative fallback, but recovery may have observed that
    // schema-constrained decoding is worth trying for it. Never applied to a profile that says so explicitly.
    const key = `${providerKind}/${model}`;
    const observed = ModelProfileRegistry.observedStructuredOutput.get(key) ?? ModelProfileRegistry.negotiated.get(key)?.structuredOutput;
    const reasoningOff = ModelProfileRegistry.negotiated.get(key)?.reasoningOff === true;
    // Enforcing the schema also switches the model's native reasoning channel off: a thinking model's reasoning tokens
    // are not bound by the schema and can consume the whole output budget, returning an empty completion (measured
    // live on gemma4:12b: done_reason=length, 38k chars of thinking, zero content; think:false answered in 296 tokens).
    if (observed) return { ...GENERIC_LOCAL_PROFILE, structuredOutput: observed, disableNativeThinking: true };
    // M47: the ContractNegotiator may switch native reasoning off on its own (a runtime that returned empty completions
    // but never needed the schema); that changes only the decoding, not the contract.
    return reasoningOff ? { ...GENERIC_LOCAL_PROFILE, disableNativeThinking: true } : GENERIC_LOCAL_PROFILE;
  }

  private static readonly negotiated = new Map<string, { structuredOutput?: ModelProfile['structuredOutput']; reasoningOff: boolean }>();

  /**
   * M47: the ContractNegotiator's starting decision for an unknown (fallback-profile) model on this provider. Held apart
   * from `observedStructuredOutput` so that M46's reactive enforce/release cycle inside a task keeps working
   * unchanged: releasing an enforcement clears only what the recovery controller set, and the next negotiation
   * re-derives the start from the (now updated) capability profile. Never applied to a model with a static profile.
   */
  static applyNegotiation(model: string, providerKind: ProviderType, decision: { schemaEnforced: boolean; reasoningOff: boolean }): boolean {
    const known = PROFILES.some(item => item.match.test(model) && (!item.providerKind || item.providerKind === providerKind));
    const key = `${providerKind}/${model}`;
    if (known || (!decision.schemaEnforced && !decision.reasoningOff)) {
      ModelProfileRegistry.negotiated.delete(key);
      return false;
    }
    ModelProfileRegistry.negotiated.set(key, {
      ...(decision.schemaEnforced ? { structuredOutput: providerKind === 'ollama' ? 'ollama_format' as const : 'json_schema' as const } : {}),
      reasoningOff: decision.reasoningOff || decision.schemaEnforced,
    });
    return true;
  }

  /** True when the negotiator started this model's dispatches with the provider schema enforced. */
  static hasNegotiatedSchema(model: string, providerKind: ProviderType): boolean {
    return ModelProfileRegistry.negotiated.get(`${providerKind}/${model}`)?.structuredOutput !== undefined;
  }

  static clearNegotiation(): void {
    ModelProfileRegistry.negotiated.clear();
  }

  private static readonly observedStructuredOutput = new Map<string, ModelProfile['structuredOutput']>();

  /**
   * M46: records, for an unknown (fallback-profile) model only, that the recovery controller chose to try
   * constrained decoding. The backend (Ollama `format`) enforces the schema, not the model, so this needs no
   * knowledge of the model family. It is a strategy for the next dispatch, not a permanent capability claim.
   */
  static observeStructuredOutput(model: string, providerKind: ProviderType, capability: ModelProfile['structuredOutput']): boolean {
    const known = PROFILES.some(item => item.match.test(model) && (!item.providerKind || item.providerKind === providerKind));
    if (known) return false;
    ModelProfileRegistry.observedStructuredOutput.set(`${providerKind}/${model}`, capability);
    return true;
  }

  static clearObservedStructuredOutput(model?: string, providerKind?: ProviderType): void {
    if (model && providerKind) ModelProfileRegistry.observedStructuredOutput.delete(`${providerKind}/${model}`);
    else ModelProfileRegistry.observedStructuredOutput.clear();
  }

  /** True when the model has only the fallback profile and constrained decoding is available on the backend. */
  static canTryConstrainedOutput(model: string, providerKind: ProviderType): boolean {
    if (providerKind !== 'ollama') return false;
    const profile = ModelProfileRegistry.resolve(model, providerKind);
    return profile.fallback && profile.structuredOutput === 'unsupported';
  }

  static all(): ModelProfile[] {
    return [...PROFILES, GENERIC_LOCAL_PROFILE];
  }
}

export interface ContextLimitResolution {
  model: string;
  profileId: string;
  effectiveLimit: number;
  declaredLimit?: number;
  providerRuntimeLimit?: number;
  /** Present only when the user explicitly configured a context override. */
  userOverride?: number;
  operationalLimit?: number;
  provenance: ContextLimitProvenance;
  estimated: boolean;
  fallback: boolean;
  /**
   * True when a vision minimum raised the effective limit above the base
   * resolution. Resolved here — before preflight — so the value approved by
   * preflight is exactly the value sent to the provider (num_ctx).
   */
  visionMinimumApplied: boolean;
}

export function resolveContextLimit(input: {
  model: string;
  profile: ModelProfile;
  /** Only pass a value the user explicitly configured — never a built-in default. */
  userOverride?: number;
  providerRuntimeLimit?: number;
  declaredLimit?: number;
  /**
   * Minimum context required for image requests (provider-kind specific).
   * Applied here so no provider may silently change the window later.
   */
  visionMinimum?: number;
}): ContextLimitResolution {
  const positive = (value: number | undefined): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
  const userOverride = positive(input.userOverride);
  const providerRuntimeLimit = positive(input.providerRuntimeLimit);
  const operationalLimit = positive(input.profile.operationalContextLimit);
  const declaredLimit = positive(input.declaredLimit) ?? positive(input.profile.declaredContextLimit);

  let effectiveLimit = GENERIC_LOCAL_PROFILE.operationalContextLimit ?? 8192;
  let provenance: ContextLimitProvenance = 'conservative_fallback';
  if (userOverride) {
    effectiveLimit = userOverride;
    provenance = 'user_override';
  } else if (providerRuntimeLimit) {
    effectiveLimit = providerRuntimeLimit;
    provenance = 'provider_runtime';
  } else if (operationalLimit) {
    effectiveLimit = operationalLimit;
    provenance = 'profile_operational';
  } else if (declaredLimit) {
    effectiveLimit = declaredLimit;
    provenance = 'profile_declared';
  }

  const visionMinimum = positive(input.visionMinimum);
  const visionMinimumApplied = visionMinimum !== undefined && effectiveLimit < visionMinimum;
  if (visionMinimumApplied && visionMinimum !== undefined) {
    effectiveLimit = visionMinimum;
  }

  return {
    model: input.model,
    profileId: input.profile.id,
    effectiveLimit,
    declaredLimit,
    providerRuntimeLimit,
    userOverride,
    operationalLimit,
    provenance,
    estimated: provenance !== 'provider_runtime' && provenance !== 'user_override',
    fallback: input.profile.fallback,
    visionMinimumApplied,
  };
}
