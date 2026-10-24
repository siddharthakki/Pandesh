import { Config, ResolvedConfigValue } from '../config/Config';
import {
  InferenceProvider,
  ModelInfo,
  ProviderChatOptions,
  ProviderResponseFormat,
  ProviderType,
} from '../providers/ProviderTypes';
import { ChatMessage, ToolDefinition } from '../tools/ToolTypes';
import { ContextBudgetPlanner, ContextPreflightResult } from './ContextBudget';
import {
  ContextLimitResolution,
  ModelProfile,
  ModelProfileRegistry,
  resolveContextLimit,
} from './ModelProfiles';
import { decideStructuredOutput, StructuredOutputDecision } from './StructuredOutput';
import { benchmarkForcedModel } from '../models/BenchmarkModel';

/**
 * model:test only: a forced model with no KKD profile is not held to the generic fallback profile's conservative
 * operational cap (a guess made for models KKD knows nothing about). It uses the context the provider declares for
 * it, capped so a very large declared window does not dominate a short benchmark run.
 */
export const BENCHMARK_FORCED_CONTEXT_CAP = 32_768;

/**
 * Minimum context window for Ollama image requests. Resolved here — before
 * preflight — so the limit approved by preflight is exactly the num_ctx sent
 * to the provider. Providers never adjust the window themselves.
 */
export const OLLAMA_VISION_MINIMUM_CONTEXT = 16_384;

/**
 * The user's explicit `ollama-agent.contextWindow`, or undefined when only the
 * built-in default applies (a default must not defeat provider/profile
 * detection). The one reading of that setting for both the model-selection
 * gate and the dispatch.
 */
export function explicitContextWindowOverride(): number | undefined {
  const setting = Config.getContextWindowSetting();
  return setting.explicitlyConfigured ? setting.value : undefined;
}

/**
 * THE context window a model will be dispatched with, shared verbatim by
 * `createSession` (the real request) and the model-selection gate
 * (`ProductionModelCandidates.resolveCandidateCapabilities`, which both
 * onboarding readiness and live task selection use), so a model is never
 * admitted or rejected for a window the dispatch will not actually use.
 * Precedence (see `resolveContextLimit`): explicit user override > provider
 * runtime context > profile operational limit > declared limit > 8K fallback.
 */
export function resolveModelContextLimit(input: {
  model: string;
  providerType: ProviderType;
  providerMetadata?: Pick<ModelInfo, 'contextWindow' | 'declaredContextWindow'>;
  userOverride?: number;
  hasImages?: boolean;
}): ContextLimitResolution {
  const resolvedProfile = ModelProfileRegistry.resolve(input.model, input.providerType);
  const benchmarkUnprofiled = resolvedProfile.fallback
    && benchmarkForcedModel() === input.model
    && input.userOverride === undefined
    && input.providerMetadata?.contextWindow === undefined
    && (input.providerMetadata?.declaredContextWindow ?? 0) > 0;
  const resolution = resolveContextLimit({
    model: input.model,
    profile: benchmarkUnprofiled ? { ...resolvedProfile, operationalContextLimit: undefined } : resolvedProfile,
    userOverride: input.userOverride,
    providerRuntimeLimit: input.providerMetadata?.contextWindow,
    declaredLimit: input.providerMetadata?.declaredContextWindow,
    visionMinimum:
      input.hasImages && input.providerType === 'ollama' ? OLLAMA_VISION_MINIMUM_CONTEXT : undefined,
  });
  return benchmarkUnprofiled && resolution.effectiveLimit > BENCHMARK_FORCED_CONTEXT_CAP
    ? { ...resolution, effectiveLimit: BENCHMARK_FORCED_CONTEXT_CAP }
    : resolution;
}

/**
 * One prepared model dispatch: profile, context-limit resolution, the exact
 * provider options that will be sent, the structured-output decision, and a
 * preflight function whose reserves match those options token-for-token.
 */
export interface ModelDispatchSession {
  profile: ModelProfile;
  limit: ContextLimitResolution;
  /** The exact options sent to the provider; never modified downstream. */
  options: ProviderChatOptions;
  structuredOutput: StructuredOutputDecision;
  preflight(messages: ChatMessage[], tools: ToolDefinition[]): ContextPreflightResult;
}

export interface ModelDispatchSessionInput {
  model: string;
  provider: InferenceProvider;
  /** Whether tool definitions will be sent with this dispatch. */
  toolsActive: boolean;
  /** Whether any message carries image payloads. */
  hasImages: boolean;
  /** Response format requested by the caller (e.g. governed coding plans). */
  requestedResponseFormat?: ProviderResponseFormat;
  /** Explicit request to disable a model's native thinking/reasoning for this dispatch. */
  requestedNativeThinking?: false;
  signal?: AbortSignal;
  /** Original repository root for resource-scoped VS Code configuration. */
  configWorkspaceRoot?: string;
}

/**
 * Computes the single authoritative output allowance for one dispatch.
 *
 * The returned value is both the amount preflight reserves and the exact
 * number sent to the provider (Ollama `num_predict`, OpenAI-compatible
 * `max_tokens`) — they can never diverge because both read this one value.
 *
 * - An explicitly configured positive `maxOutputTokens` is honored up to the
 *   safe cap; invalid/zero/default configuration falls back to the profile's
 *   safe output reserve.
 * - The cap is 15% of the effective context (never below 512 tokens so tiny
 *   contexts still allow a usable completion; preflight then decides whether
 *   the combined budget fits).
 */
export function computeEffectiveMaxOutputTokens(
  configured: ResolvedConfigValue,
  profile: ModelProfile,
  effectiveContextLimit: number,
): number {
  const explicit =
    configured.explicitlyConfigured &&
    Number.isFinite(configured.value) &&
    configured.value > 0
      ? Math.floor(configured.value)
      : undefined;
  const requested = explicit ?? Math.max(1, Math.floor(profile.safeOutputReserve));
  const cap = Math.max(512, Math.floor(effectiveContextLimit * 0.15));
  return Math.max(1, Math.min(requested, cap));
}

/** Explicit temperature (including an intentional 0) wins; otherwise the profile preference. */
export function resolveTemperature(configured: ResolvedConfigValue, profile: ModelProfile): number {
  return configured.explicitlyConfigured && Number.isFinite(configured.value)
    ? configured.value
    : profile.preferredTemperature;
}

/**
 * The one shared preflight/dispatch-preparation service (Blocker 2). Every
 * production model-execution path — AgentLoop, Forge governed execution and
 * the role runner — prepares its dispatch here so profile resolution,
 * context-limit provenance, output reserves, vision minimums and the
 * structured-output decision are identical everywhere.
 */
export class ModelDispatchPlanner {
  static async createSession(input: ModelDispatchSessionInput): Promise<ModelDispatchSession> {
    const providerType = input.provider.providerType;
    const profile = ModelProfileRegistry.resolve(input.model, providerType);
    const providerMetadata = await input.provider
      .getModelContextMetadata?.(input.model, input.signal)
      .catch(() => undefined);

    const limit = resolveModelContextLimit({
      model: input.model,
      providerType,
      providerMetadata,
      // Only an explicit user setting is a user_override; the built-in
      // default must not defeat provider/profile detection (Blocker 3).
      userOverride: explicitContextWindowOverride(),
      hasImages: input.hasImages,
    });

    const maxOutputTokens = computeEffectiveMaxOutputTokens(
      Config.getMaxOutputTokensSetting(),
      profile,
      limit.effectiveLimit,
    );
    const structuredOutput = decideStructuredOutput({
      profile,
      providerType,
      toolsActive: input.toolsActive,
      hasImages: input.hasImages,
      requestedFormat: input.requestedResponseFormat,
    });

    const disableNativeThinking = input.requestedNativeThinking === false || profile.disableNativeThinking;
    const options: ProviderChatOptions = {
      model: input.model,
      contextWindow: limit.effectiveLimit,
      maxOutputTokens,
      temperature: resolveTemperature(Config.getTemperatureSetting(), profile),
      timeoutMs: Config.getRequestTimeoutMs(input.configWorkspaceRoot),
      ...(structuredOutput.active && structuredOutput.format
        ? { responseFormat: structuredOutput.format }
        : {}),
      ...(disableNativeThinking ? { nativeThinking: false } : {}),
    };

    const budgetPlanner = new ContextBudgetPlanner();
    return {
      profile,
      limit,
      options,
      structuredOutput,
      preflight: (messages, tools) => ({
        ...budgetPlanner.preflight({
          messages,
          tools,
          profile,
          limit,
          maxOutputTokens: options.maxOutputTokens,
        }),
        structuredOutput,
      }),
    };
  }
}
