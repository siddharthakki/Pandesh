/**
 * Pure onboarding/readiness evaluation.
 *
 * This module answers the five questions a fresh user actually has —
 * "Is KarkeDikha ready? What is missing? What should I do next? Which local
 * model will Karke use? Is anything allowed to go to the cloud?" — by reusing
 * the exact production model-selection contract (`classifyTaskRequirements` +
 * `selectTaskModel` from `TaskModelSelection`) that a live Baat/Saath/Karke
 * turn already goes through. It never re-implements capability rules or
 * reliability scoring, and it performs no I/O: every fact it needs (local
 * inference provider reachability, installed-model candidates, cloud fallback configuration
 * state) is gathered by `OnboardingService` and passed in.
 */
import {
  RejectedTaskModelCandidate,
  TaskModelCandidate,
  TaskModelSelectionError,
  classifyTaskRequirements,
  selectTaskModel,
} from '../models/TaskModelSelection';
import type { CloudFallbackUnavailableReason } from '../providers/ProviderGateway';
import type { ReadinessVerdict } from '../../core/platform/readinessState';
import type { ModelRoutingPolicy } from '../config/ConfigSchema';
import type { CoreConnectionState } from '../core-client/ConnectionState';
import type { RuntimeCapabilityProfile, Tri } from '../runtimeProfile/RuntimeCapabilityProfile';
import type { BuildIdentity } from './BuildIdentity';

export type OnboardingModeId = 'baat_kar' | 'saath_kar' | 'karke_dikha';

export const ONBOARDING_MODES: readonly OnboardingModeId[] = ['baat_kar', 'saath_kar', 'karke_dikha'];

export interface ModeReadiness {
  mode: OnboardingModeId;
  label: string;
  ready: boolean;
  /** The model that would actually be selected for this mode right now, when ready. */
  model?: string;
  /** Human-facing reason: why it's ready, or what's missing and why. */
  reason: string;
  /** Installed models that were rejected for this mode's requirements (truthful, never invented). */
  rejectedInstalledModels: readonly RejectedTaskModelCandidate[];
  /**
   * True when `model` is technically viable but was selected below the
   * task's preferred reliability threshold (unproven/advisory evidence, not
   * a capability gap) — see `TaskModelSelectionResult.belowPreferredConfidence`.
   * Always false/undefined when `ready` is false.
   */
  belowPreferredConfidence?: boolean;
  /** `auto` = the existing selector chose; `manual` = the user pinned `manualModel` for this mode. */
  selection: 'auto' | 'manual';
  manualModel?: string;
  /**
   * Readable fallback order from the selector's own ranking: the chosen model first, then the capable
   * alternatives it would escalate to. Empty when the mode is not ready. Not a routing DSL — a view of the
   * ranking `selectTaskModel` already produced.
   */
  fallbackOrder: readonly string[];
}

export interface AdvancedSettingsSnapshot {
  context: { kind: 'auto' | 'manual'; tokens?: number };
  /** KarkeDikha's internal output budget. This is NOT the Ollama `num_predict` wire value. */
  outputReservation: { kind: 'auto' | 'manual'; tokens?: number };
  /** Core-run Ollama requests leave `num_predict` unset; the server's own limit applies. */
  wireOutputCap: 'not_sent';
  reasoning: 'auto';
  recoveryCeiling: { tokens: number; source: 'default' | 'env' };
}

/** One discovered model as Setup shows it. Everything here is observed or provider-reported, never assumed. */
export interface ModelSummary {
  name: string;
  state: 'ready' | 'unavailable';
  contextTokens?: number;
  contextProvenance?: string;
  reasoning: Tri;
  tools: Tri;
  structuredOutput: Tri;
  vision: Tri;
  /** `none`: no profile exists yet (unknown model, nothing rejected). */
  profileStatus: 'none' | RuntimeCapabilityProfile['source'];
  probedAt?: string;
  profile?: RuntimeCapabilityProfile;
}

export type OverallReadiness = 'ready' | 'partially_ready' | 'not_ready';

/**
 * OrcaRouter as a manually selectable cloud provider. Reflects stored configuration only — opening Setup never
 * contacts the cloud. `verifiedModelCount` is set only when this session already listed the account's models.
 */
export interface OrcaRouterReadiness {
  configured: boolean;
  /** Key-free, safe to render directly. */
  summary: string;
  apiBase?: string;
  verifiedModelCount?: number;
}

/** One row of Setup's CAPABILITIES section, reported by the module that owns the capability. */
export interface CapabilityRow {
  name: string;
  status: 'ok' | 'off' | 'warn';
  detail: string;
  action?: { label: string; act: string };
}

/** One catalog provider as Setup shows it. Everything is stored configuration or this session's own observations. */
export interface CloudPoolProviderRow {
  id: string;
  displayName: string;
  connected: boolean;
  /** Connected providers the user switched off for the pool. */
  enabled: boolean;
  freeTierKind: 'recurring' | 'promotional' | 'trial' | 'paid' | 'unknown';
  freeTierNote?: string;
  paymentRequired: 'requiresPaymentMethod' | 'doesNotRequirePaymentMethod' | 'unknown';
  privacyWarning?: string;
  capabilityTags: string[];
  /** Host only (never a path or credential), for "api.groq.com". */
  host?: string;
  /** Known only after this session listed the provider's models. */
  modelCount?: number;
  freeCount?: number;
  quotaExhausted: boolean;
  error?: { kind: string; reason: string };
  requiresAccountId: boolean;
  lastVerifiedAt: string;
}

/** A model entry the Setup palette can browse. Same shape the chat composer's picker receives. */
export interface SetupModelEntry {
  name: string;
  label?: string;
  provider?: string;
  cloud?: true;
  providerName?: string;
  displayName?: string;
  modelId?: string;
  freeness?: string;
  vision?: boolean | 'unknown';
  tools?: boolean | 'unknown';
  coding?: boolean | 'unknown';
  contextWindow?: number;
}

/** The cloud pool: data-driven providers + the hard cost policy. Setup displays this truth; it never invents it. */
export interface CloudPoolReadiness {
  providers: readonly CloudPoolProviderRow[];
  /** Local-first is always on in this build; shown as a locked setting. */
  localFirst: true;
  /** "Use free cloud when needed": Auto may fall back to the pool when local cannot serve. */
  useFreeCloud: boolean;
  spendMode: 'FREE_ONLY' | 'BUDGETED' | 'UNRESTRICTED';
  /** FREE_ONLY: paid cloud is hard-blocked. */
  paidBlocked: boolean;
  allowCredits: boolean;
  catalogVersion: string;
  connectedCount: number;
  availableCount: number;
  exhaustedIds: readonly string[];
}

export interface CloudFallbackReadiness {
  policy: ModelRoutingPolicy;
  /** True only when policy + endpoint + model + stored credential are all present. */
  configured: boolean;
  reason?: CloudFallbackUnavailableReason;
  /** Human-facing one-line summary, safe to render directly (never includes the key). */
  summary: string;
  /** Configured endpoint (sanitized) and model, shown only when set; the API key is never carried here. */
  endpoint?: string;
  model?: string;
}

/**
 * The ACTIVE local inference provider (`ollama-agent.providerType`) — Ollama
 * or an OpenAI-compatible server such as llama.cpp, LM Studio or vLLM. Every
 * human-facing string derives from `providerType`/`label`; nothing here may
 * assume Ollama.
 */
export interface OnboardingProviderStatus {
  providerType: string;
  /** Human-facing provider name, e.g. "Ollama" or "OpenAI-compatible server". */
  label: string;
  apiBase?: string;
  reachable: boolean;
  detail: string;
  nextAction?: string;
}

export function providerDisplayName(providerType: string): string {
  return providerType === 'ollama' ? 'Ollama' : 'OpenAI-compatible server';
}

/**
 * Whether the KarkeDikha Core runtime — a separate process every Baat/Saath/
 * Karke submission genuinely requires (see `AgentPanel.sendToAgent` and
 * `submitKarkeDikhaRequest`, both of which reject outright with no Core
 * client) — is connected. Deliberately never conflated with provider/model
 * readiness: a machine can have a perfect local model and still be entirely
 * unable to run any mode if Core hasn't connected.
 */
export interface OnboardingCoreRuntimeStatus {
  connected: boolean;
  state: CoreConnectionState;
  detail?: string;
  /** Human-facing one-line summary, safe to render directly. */
  summary: string;
}

export interface OnboardingReadiness {
  overall: OverallReadiness;
  provider: OnboardingProviderStatus;
  coreRuntime: OnboardingCoreRuntimeStatus;
  installedModelCount: number;
  modes: readonly ModeReadiness[];
  /** The model Karke Dikha would use right now, or undefined when Karke isn't ready. */
  recommendedKarkeModel?: string;
  /** Provider-listed models that exist but don't meet Karke Dikha's requirements. */
  unsuitableModelNames: readonly string[];
  cloudFallback: CloudFallbackReadiness;
  orcaRouter?: OrcaRouterReadiness;
  /** The free-cloud pool and cost policy. Optional: a snapshot from an older path still renders. */
  cloudPool?: CloudPoolReadiness;
  /** Capabilities registered by platform modules (repository graph, skills, attachments, artifacts, browser…). */
  capabilityRows?: readonly CapabilityRow[];
  /** Models known this session (local + cached cloud), bounded; what the Setup model browser lists. */
  modelEntries?: readonly SetupModelEntry[];
  /** Can KarkeDikha do useful work right now? Distinct from `overall`, which is about the local provider and modes. */
  system?: ReadinessVerdict;
  /** Ollama only: a copyable `ollama pull <model>` suggestion when no installed model meets Karke's bar. Never auto-run. */
  pullCommandSuggestion?: string;
  /** Discovered models with their known capabilities and profile status. */
  models: readonly ModelSummary[];
  build?: BuildIdentity;
  advanced?: AdvancedSettingsSnapshot;
}

const MODE_LABELS: Record<OnboardingModeId, string> = {
  baat_kar: 'Baat Kar',
  saath_kar: 'Saath Kar',
  karke_dikha: 'Karke Dikha',
};

/**
 * Representative requirement hints for each mode. These mirror the mode
 * classification block in `AgentPanel.selectModelForTask` (repository
 * exploration / tool calling / file mutation / validation-repair per mode)
 * without depending on any specific goal text, since onboarding has none.
 * Karke Dikha's complexity is pinned at 'medium' as the representative bar —
 * a real task may classify higher or lower, but 'medium' is the same floor
 * `requiredReliability` uses for the bulk of everyday coding tasks.
 */
const MODE_HINTS: Record<OnboardingModeId, Parameters<typeof classifyTaskRequirements>[1]> = {
  baat_kar: {
    repositoryExploration: false,
    toolCalling: false,
    fileMutation: false,
    validationRepair: false,
    codingComplexity: 'none',
  },
  saath_kar: {
    repositoryExploration: true,
    toolCalling: true,
    fileMutation: false,
    validationRepair: false,
    codingComplexity: 'none',
  },
  karke_dikha: {
    repositoryExploration: true,
    toolCalling: true,
    fileMutation: true,
    validationRepair: true,
    codingComplexity: 'medium',
  },
};

/**
 * Model-capability readiness only — does not know about Core. Callers
 * (`evaluateOnboardingReadiness`) fold in `coreRuntime.connected` afterward,
 * since every mode genuinely needs both and the two must never be conflated
 * in how they're diagnosed.
 */
export function evaluateModeReadiness(
  mode: OnboardingModeId,
  providerType: string,
  candidates: readonly TaskModelCandidate[],
): ModeReadiness {
  const requirements = classifyTaskRequirements('', MODE_HINTS[mode]);
  try {
    const selected = selectTaskModel({
      provider: providerType,
      candidates,
      requirements,
    });
    return {
      mode,
      label: MODE_LABELS[mode],
      ready: true,
      model: selected.selectedModel,
      selection: 'auto',
      fallbackOrder: [selected.selectedModel, ...selected.escalationCandidates.map(item => item.model)],
      // Technically viable but unproven (UNKNOWN != INCOMPATIBLE): still
      // truthfully READY — automatic selection already chose it — but the
      // caveat stays visible rather than reading identically to a
      // fully-proven pick.
      reason: selected.belowPreferredConfidence
        ? `${selected.suitabilitySummary} "${selected.selectedModel}" meets ${MODE_LABELS[mode]}'s technical requirements, but its reliability evidence is below the preferred threshold; automatic selection used it as the best available candidate.`
        : selected.suitabilitySummary,
      rejectedInstalledModels: onlyInstalled(selected.rejectedCandidates, candidates),
      belowPreferredConfidence: selected.belowPreferredConfidence,
    };
  } catch (error) {
    const rejected = error instanceof TaskModelSelectionError ? error.rejectedCandidates : [];
    const installedRejected = onlyInstalled(rejected, candidates);
    return {
      mode,
      label: MODE_LABELS[mode],
      ready: false,
      selection: 'auto',
      fallbackOrder: [],
      reason: modeUnreadyReason(mode, providerType, {
        missingConfiguredModel: findMissingConfiguredModel(rejected, candidates),
        advisoryOnly: installedRejected.find(r => r.hardReasons.length === 0 && r.advisoryReasons.length > 0),
      }),
      rejectedInstalledModels: installedRejected,
    };
  }
}

/**
 * Names the specific configured-but-not-installed model blocking this mode,
 * when that's the reason — distinguished from "no model configured at all"
 * or "installed models exist but none are capable enough". A candidate only
 * exists in the list at all because either it's installed or some setting
 * names it (see `buildProductionTaskModelCandidates`); one that's
 * `available: false` but has `configuredRoles` is exactly that case — a
 * setting like `ollama-agent.chatModel` points at a name the provider doesn't list.
 */
function findMissingConfiguredModel(
  rejected: readonly RejectedTaskModelCandidate[],
  candidates: readonly TaskModelCandidate[],
): string | undefined {
  const byModel = new Map(candidates.map(c => [c.model, c] as const));
  // Roles genuinely relevant to any mode's minimal requirement — excludes
  // 'embedding'/'autocomplete', which are never what a Baat/Saath/Karke
  // turn needs, so a missing embedding-only default (e.g. the package.json
  // default ollama-agent.embeddingModel) never gets blamed for a mode it
  // has nothing to do with.
  const relevantRoles = new Set(['chat', 'agent', 'edit', 'reviewer']);
  for (const r of rejected) {
    const candidate = byModel.get(r.model);
    if (candidate && !candidate.available && candidate.configuredRoles.some(role => relevantRoles.has(role))) {
      return r.model;
    }
  }
  return undefined;
}

/**
 * Combines a mode's model-capability readiness with Core runtime
 * connectivity — both are hard requirements for a real submission (see
 * `AgentPanel.sendToAgent` / `submitKarkeDikhaRequest`). When the model
 * layer is ready but Core isn't connected, the reason names Core
 * specifically rather than repeating the (irrelevant, already-true) model
 * suitability text — a user blocked on Core needs to know that, not be told
 * their model is fine.
 */
function applyCoreRuntimeToMode(mode: ModeReadiness, coreRuntime: OnboardingCoreRuntimeStatus): ModeReadiness {
  if (!mode.ready || coreRuntime.connected) {
    return mode;
  }
  return {
    ...mode,
    ready: false,
    reason: `${coreRuntime.summary} ${mode.label} needs the KarkeDikha Core runtime, not just a capable model.`,
  };
}

function onlyInstalled(
  rejected: readonly RejectedTaskModelCandidate[],
  candidates: readonly TaskModelCandidate[],
): RejectedTaskModelCandidate[] {
  const installed = new Set(candidates.filter(c => c.available).map(c => c.model));
  return rejected.filter(r => installed.has(r.model));
}

interface ModeUnreadyFacts {
  missingConfiguredModel?: string;
  /**
   * An installed, configured model with NO hard incompatibility that automatic
   * selection still declined for advisory reasons only (reliability evidence
   * below the task's floor, or a per-machine automatic-selection exclusion).
   * It is capable but unproven — never reported as "incapable".
   */
  advisoryOnly?: RejectedTaskModelCandidate;
}

function modeUnreadyReason(mode: OnboardingModeId, providerType: string, facts: ModeUnreadyFacts): string {
  const provider = providerDisplayName(providerType);
  const ollama = providerType === 'ollama';
  if (facts.missingConfiguredModel) {
    return `${MODE_LABELS[mode]} is configured to use "${facts.missingConfiguredModel}", `
      + (ollama ? 'which is not installed. ' : `which the ${provider} does not list. `)
      + (ollama
        ? 'Install it with Ollama, or point the matching ollama-agent.*Model setting at an installed model.'
        : 'Load it on that server, or point the matching ollama-agent.*Model setting at a model the server lists.');
  }
  if (facts.advisoryOnly) {
    return `"${facts.advisoryOnly.model}" meets ${MODE_LABELS[mode]}'s technical requirements, but automatic selection `
      + `declined it: ${facts.advisoryOnly.advisoryReasons.join(' ')} `
      + 'Selecting it explicitly for a task is still allowed.';
  }
  switch (mode) {
    case 'baat_kar':
      return ollama
        ? 'No installed local model can hold a conversation yet. Install a chat-capable model with Ollama.'
        : `No model listed by the ${provider} can hold a conversation yet. Load a chat-capable model on it.`;
    case 'saath_kar':
      return `No model listed by the ${provider} supports the repository exploration Saath Kar needs.`;
    case 'karke_dikha':
      return `No local model currently meets Karke Dikha's requirements. The ${provider} is reachable, but none of the `
        + 'models it lists support the capabilities needed for autonomous coding.';
  }
}

export interface EvaluateOnboardingReadinessInput {
  providerType: string;
  provider: OnboardingProviderStatus;
  coreRuntime: OnboardingCoreRuntimeStatus;
  /** Every configured model, resolved with real capabilities, whether or not it's installed. Empty when the provider is unreachable. */
  candidates: readonly TaskModelCandidate[];
  cloudFallback: CloudFallbackReadiness;
  /** A copyable pull-command suggestion, computed by the orchestrator from the product's own existing default model — never invented here. */
  pullCommandSuggestion?: string;
  /** Runtime profiles by model name for the active provider/endpoint; absent = none known. */
  profiles?: ReadonlyMap<string, RuntimeCapabilityProfile>;
  build?: BuildIdentity;
  advanced?: AdvancedSettingsSnapshot;
}

const triFrom = (value: boolean): Tri => (value ? 'yes' : 'no');

/**
 * Discovered models only — a candidate that is merely named by a setting but not listed by the provider is shown
 * as unavailable, never dropped. Embedding-only models are omitted: they can never serve a mode.
 */
export function summarizeModels(
  candidates: readonly TaskModelCandidate[],
  profiles: ReadonlyMap<string, RuntimeCapabilityProfile> = new Map(),
): ModelSummary[] {
  return candidates
    .filter(candidate => !candidate.capabilities.embeddingOnly)
    .map((candidate): ModelSummary => {
      const profile = profiles.get(candidate.model);
      const capability = candidate.capabilities;
      // An observed profile outranks the name-based registry guess: it is what this runtime actually did.
      const merge = (observed: Tri | undefined, guessed: boolean): Tri =>
        observed && observed !== 'unknown' ? observed : triFrom(guessed);
      return {
        name: candidate.model,
        state: candidate.available ? 'ready' : 'unavailable',
        contextTokens: capability.contextWindow > 0 ? capability.contextWindow : profile?.contextWindow?.tokens,
        contextProvenance: profile?.contextWindow?.provenance,
        reasoning: profile?.reasoning.supported ?? 'unknown',
        tools: merge(profile?.nativeTools, capability.tools),
        structuredOutput: merge(profile?.structuredSchema, capability.structuredOutput),
        // Same authority production selection uses (TaskModelSelection, requirements.vision): a provider declaration
        // (Ollama /api/show `capabilities`) decides. Without one the static record can grant it, but its silence is
        // "unknown", never a claimed "no".
        vision: candidate.providerCapabilities
          ? triFrom(candidate.providerCapabilities.includes('vision'))
          : capability.vision ? 'yes' : 'unknown',
        profileStatus: profile ? profile.source : 'none',
        probedAt: profile?.probedAt,
        profile,
      };
    })
    .sort((a, b) => Number(b.state === 'ready') - Number(a.state === 'ready') || a.name.localeCompare(b.name));
}

export function evaluateOnboardingReadiness(input: EvaluateOnboardingReadinessInput): OnboardingReadiness {
  const installedModelCount = new Set(input.candidates.filter(c => c.available).map(c => c.model)).size;

  if (!input.provider.reachable) {
    const modes: ModeReadiness[] = ONBOARDING_MODES.map(mode => ({
      mode,
      label: MODE_LABELS[mode],
      ready: false,
      reason: `${MODE_LABELS[mode]} needs the configured local model provider (${input.provider.label}), which could not be reached.`,
      rejectedInstalledModels: [],
      selection: 'auto' as const,
      fallbackOrder: [],
    }));
    return {
      overall: 'not_ready',
      provider: input.provider,
      coreRuntime: input.coreRuntime,
      installedModelCount: 0,
      modes,
      unsuitableModelNames: [],
      cloudFallback: input.cloudFallback,
      pullCommandSuggestion: input.pullCommandSuggestion,
      models: [],
      build: input.build,
      advanced: input.advanced,
    };
  }

  const modelModes = ONBOARDING_MODES.map(mode =>
    evaluateModeReadiness(mode, input.providerType, input.candidates));
  const modes = modelModes.map(mode => applyCoreRuntimeToMode(mode, input.coreRuntime));
  const karkeModel = modelModes.find(m => m.mode === 'karke_dikha')!;
  const karke = modes.find(m => m.mode === 'karke_dikha')!;
  const allReady = modes.every(m => m.ready);
  const anyReady = modes.some(m => m.ready);
  const overall: OverallReadiness = allReady ? 'ready' : anyReady ? 'partially_ready' : 'not_ready';

  const unsuitableModelNames = [...new Set(karkeModel.rejectedInstalledModels.map(r => r.model))];

  return {
    overall,
    provider: input.provider,
    coreRuntime: input.coreRuntime,
    installedModelCount,
    modes,
    // The model recommendation is truthful about which model Karke would
    // pick regardless of Core's current connectivity (a fact about the
    // model layer) — but `karke.ready` above still correctly requires Core.
    recommendedKarkeModel: karkeModel.ready ? karkeModel.model : undefined,
    unsuitableModelNames,
    cloudFallback: input.cloudFallback,
    pullCommandSuggestion: karkeModel.ready ? undefined : input.pullCommandSuggestion,
    models: summarizeModels(input.candidates, input.profiles),
    build: input.build,
    advanced: input.advanced,
  };
}
