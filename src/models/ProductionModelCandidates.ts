/**
 * The ONE production candidate-building path for Baat/Saath/Karke model
 * selection. Extracted from `AgentPanel.selectModelForTask` so onboarding
 * readiness and the real execution path can never drift apart again — see
 * AI_OS_ARCHITECTURE.md's "Local-First Model Routing" section: "Automatic
 * selection ranks the models already configured for roles and reported
 * available by the active local provider." Configured role settings
 * (`ollama-agent.chatModel`, `ollama-agent.agentModel`, ...) are therefore
 * authoritative — an installed model that no setting names is not a usable
 * candidate for automatic selection, no matter how capable it is. Both
 * `AgentPanel` and `OnboardingService` must build candidates this exact same
 * way, or "Baat Kar READY" and "Baat Kar can actually submit" can disagree.
 */
import { Config } from '../config/Config';
import { ModelCapabilityRegistry, type ModelCapability, type ProbedModelMetadata } from './ModelCapabilityRegistry';
import { classifyTaskRequirements, selectTaskModel, type TaskModelCandidate, type TaskRequirements } from './TaskModelSelection';
import type { ModelRole } from '../providers/InferenceTypes';
import type { InferenceProvider, ModelInfo, ProviderType } from '../providers/ProviderTypes';
import { resolveModelContextLimit } from '../reliability/ModelDispatchPlanner';
import { deriveToolProtocol } from '../../core/domain/empiricalRouting';
import { modelIsResident } from '../providers/OllamaColdStart';
import type { QualificationEvidenceMap } from './QualificationEvidenceStore';

/**
 * Every settings-configured role mapping, exactly as production reads it —
 * `ollama-agent.model`/`chatModel` → chat, `agentModel`/`codingModel`/
 * `codingFallbackModel` → agent, `editModel` → edit, `reviewerModel` →
 * reviewer, `visionModel` → vision, `embeddingModel` → embedding,
 * `autocompleteModel` → autocomplete. A model absent from every one of these
 * settings has no configured role at all, regardless of whether it's
 * installed.
 *
 * `model`/`chatModel`/`agentModel`/`codingModel`/`codingFallbackModel`/
 * `editModel`/`reviewerModel` default to `""` ("Auto" — see Defaults.ts): an
 * empty setting names no model here, so it contributes nothing to this map.
 * It does NOT mean the role goes unfilled — see `unconfiguredAutoEligibleRoles`
 * and `buildProductionTaskModelCandidates`, which open that role to every
 * installed model instead, capability-gated by `selectTaskModel`.
 */
export function configuredModelRoles(): Map<string, Set<ModelRole>> {
  const roles = new Map<string, Set<ModelRole>>();
  const addRole = (model: string, role: ModelRole) => {
    if (!model) return;
    const current = roles.get(model) ?? new Set<ModelRole>();
    current.add(role);
    roles.set(model, current);
  };
  // Explicit settings only. The plain getters fall back to the Auto-resolved model for an unset role; reading
  // those here would turn a remembered Auto pick into a "configured" role and starve every other installed model.
  const explicit = Config.getExplicitRoleModels();
  addRole(explicit.model, 'chat');
  addRole(explicit.chat, 'chat');
  addRole(explicit.agent, 'agent');
  addRole(explicit.edit, 'edit');
  addRole(explicit.coding, 'agent');
  addRole(explicit.codingFallback, 'agent');
  addRole(explicit.reviewer, 'reviewer');
  addRole(Config.getVisionModel(), 'vision');
  addRole(Config.getEmbeddingModel(), 'embedding');
  addRole(Config.getAutocompleteModel(), 'autocomplete');
  return roles;
}

/**
 * Roles eligible for "Auto" capability-based expansion when nothing names a
 * model for them at all. `vision`/`embedding`/`autocomplete` are deliberately
 * excluded: each needs a specific, narrower capability (image input, an
 * embedding-only model, low-latency fill-in-middle) that generic chat/agent
 * capability checks don't gate for, so they keep an explicit named default
 * (see Defaults.ts) rather than opening to every installed model.
 */
const AUTO_ELIGIBLE_ROLES: readonly ModelRole[] = ['chat', 'agent', 'edit', 'reviewer'];

/**
 * Which of `AUTO_ELIGIBLE_ROLES` have zero model explicitly named for them
 * across every setting that feeds that role. A role stays "Auto" only when
 * *none* of its settings name a model — e.g. leaving `agentModel` empty but
 * setting `codingModel` still configures the `agent` role explicitly, so it
 * is not auto-expanded.
 */
export function unconfiguredAutoEligibleRoles(): Set<ModelRole> {
  const explicit = new Set<ModelRole>();
  for (const modelRoles of configuredModelRoles().values()) {
    for (const role of modelRoles) explicit.add(role);
  }
  return new Set(AUTO_ELIGIBLE_ROLES.filter(role => !explicit.has(role)));
}

/**
 * Maps a model name as written in a setting (or a per-turn override) to the
 * id the active provider lists and will be dispatched with. A name matches
 * only a listed id or an alias the provider itself published for that id
 * (llama.cpp `aliases`, Ollama's implicit `:latest`) — never a fuzzy or
 * case-folded guess. Unmatched names are returned unchanged, so a configured
 * model the provider does not have still surfaces as "not available".
 */
export function resolveProviderModelId(name: string, models: readonly ModelInfo[] | undefined): string {
  if (!models || models.some(item => item.name === name)) return name;
  return models.find(item => item.aliases?.includes(name))?.name ?? name;
}

/**
 * Resolves one candidate model's capability record, with `contextWindow` set
 * to exactly the window the real dispatch would use for it.
 *
 * Capability flags (chat, tools, vision, roles) come from
 * `ModelCapabilityRegistry` (known table, then name heuristic). The context
 * window does not: it is `resolveModelContextLimit`, the same function
 * `ModelDispatchPlanner.createSession` calls, fed the same provider metadata
 * (`InferenceProvider.getModelContextMetadata`) and the same explicit
 * override. Onboarding readiness, live task selection and dispatch therefore
 * share one resolved value; precedence is explicit override > provider
 * runtime context > profile operational limit > declared > 8K fallback.
 *
 * The raw probe is cached in the registry keyed by provider+model, so a model
 * probed earlier this session is never re-queried. A failed probe or one with
 * no positive values contributes nothing; it never invents a window. The
 * probe's parameter count is cached alongside as size evidence.
 */
export async function resolveCandidateCapabilities(
  provider: InferenceProvider,
  providerType: string,
  model: string,
  registry: ModelCapabilityRegistry,
  signal?: AbortSignal,
  /**
   * The user's explicit `ollama-agent.contextWindow`: pass
   * `explicitContextWindowOverride()`, exactly what dispatch uses. It is the
   * window every real request for this model is budgeted with, larger or
   * smaller than what the provider reports, so the gate uses it verbatim.
   */
  userOverrideContextWindow?: number,
  /**
   * The turn carries an image. Dispatch raises an Ollama request to the vision minimum before preflight, so the
   * candidate's window is measured with that same floor; otherwise a model dispatch would run fine is refused here.
   */
  hasImages?: boolean,
): Promise<ModelCapability> {
  if (!registry.hasProbedResult(model, providerType)) {
    const measured = await provider.getModelContextMetadata?.(model, signal).catch(() => undefined);
    const metadata: ProbedModelMetadata = {
      contextWindow: positive(measured?.contextWindow),
      declaredContextWindow: positive(measured?.declaredContextWindow),
      parameterCount: positive(measured?.parameterCount),
      ...(providerCapabilityList(measured) ? { providerCapabilities: providerCapabilityList(measured) } : {}),
    };
    if (metadata.contextWindow || metadata.declaredContextWindow || metadata.parameterCount || metadata.providerCapabilities) {
      registry.cacheProbedMetadata(model, providerType, metadata);
      // Other registry consumers (context selection, tool budgets) keep
      // reading the measured window through getCapabilities, as before.
      const measuredWindow = metadata.contextWindow ?? metadata.declaredContextWindow;
      if (measuredWindow) registry.cacheProbeResult(model, providerType, { contextWindow: measuredWindow });
    }
  }
  const capabilities = registry.getCapabilities(model, providerType);
  const limit = resolveModelContextLimit({
    model,
    providerType: providerType as ProviderType,
    providerMetadata: registry.getProbedMetadata(model, providerType),
    userOverride: userOverrideContextWindow,
    hasImages,
  });
  return { ...capabilities, contextWindow: limit.effectiveLimit };
}

function providerCapabilityList(info: ModelInfo | undefined): readonly string[] | undefined {
  const list = info?.metadata?.capabilities;
  return Array.isArray(list) && list.every(item => typeof item === 'string') && list.length > 0 ? (list as string[]) : undefined;
}

function positive(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

export interface BuildProductionCandidatesInput {
  provider: InferenceProvider;
  providerType: string;
  /** Model names the provider actually reports as installed (`provider.listModels()`). */
  availableModelNames: readonly string[];
  /**
   * The full `provider.listModels()` entries, when the caller has them. Used
   * only to resolve configured names through provider-published aliases (see
   * `resolveProviderModelId`); omitted, names must match listed ids exactly.
   */
  availableModels?: readonly ModelInfo[];
  /** An explicit per-turn override, if any — included as a candidate even when not otherwise configured/installed, exactly like AgentPanel does, so selectTaskModel can classify why it is or isn't usable. */
  modelOverride?: string;
  /** The user's own explicit `ollama-agent.contextWindow`, when configured — see `resolveCandidateCapabilities`. */
  userOverrideContextWindow?: number;
  /** Real benchmark evidence by exact lowercased model name. Absent or partial evidence is neutral, never a refusal. */
  qualificationEvidence?: QualificationEvidenceMap;
  /** Models the provider reports as loaded right now (`listResidentModels`); undefined when it could not say. */
  residentModels?: readonly string[];
  /** The turn (or a continued earlier turn) carries an image; see `resolveCandidateCapabilities`. */
  hasImages?: boolean;
}

/**
 * Builds the exact candidate set `selectTaskModel` evaluates in production:
 * every configured-role model name, unioned with every installed model name
 * (so an installed-but-unconfigured model still appears — truthfully marked
 * with no configured roles — rather than vanishing silently), each with its
 * real measured/known capabilities and observed reliability. Configured names
 * are first resolved to the provider's own listed id, so a setting naming a
 * provider-published alias attaches its role to the model actually served.
 */
export async function buildProductionTaskModelCandidates(
  input: BuildProductionCandidatesInput,
): Promise<TaskModelCandidate[]> {
  const availableNames = new Set(input.availableModelNames);
  const roles = new Map<string, Set<ModelRole>>();
  const explicitlyConfigured = new Set<string>();
  for (const [name, modelRoles] of configuredModelRoles()) {
    const id = resolveProviderModelId(name, input.availableModels);
    // A configured name the provider no longer lists is a stale preference, not a candidate: it must neither
    // appear in Auto nor count as "configuring" its role (which would starve every installed model of that role).
    if (!availableNames.has(id)) continue;
    roles.set(id, new Set([...(roles.get(id) ?? []), ...modelRoles]));
    explicitlyConfigured.add(id);
  }
  // Auto (unset) roles: when no INSTALLED model is configured for a role,
  // every installed model becomes eligible for it instead of the role going
  // unfilled — selectTaskModel's existing capability/reliability checks still
  // gate what's actually usable. This is what lets a fresh install, or one
  // carrying settings that name a since-removed model, reach a usable model.
  const configuredInstalledRoles = new Set<ModelRole>([...roles.values()].flatMap(set => [...set]));
  const autoRoles = new Set(AUTO_ELIGIBLE_ROLES.filter(role => !configuredInstalledRoles.has(role)));
  if (autoRoles.size > 0) {
    for (const name of availableNames) {
      const current = roles.get(name) ?? new Set<ModelRole>();
      for (const role of autoRoles) current.add(role);
      roles.set(name, current);
    }
  }
  const allNames = new Set([...availableNames, ...roles.keys()]);
  if (input.modelOverride) allNames.add(resolveProviderModelId(input.modelOverride, input.availableModels));
  const registry = ModelCapabilityRegistry.getInstance();
  return Promise.all(
    [...allNames].map(async model => {
      const capabilities = await resolveCandidateCapabilities(input.provider, input.providerType, model, registry, undefined, input.userOverrideContextWindow, input.hasImages);
      const probed = registry.getProbedMetadata(model, input.providerType);
      const parameterCount = probed?.parameterCount;
      return {
        provider: input.providerType,
        model,
        available: availableNames.has(model),
        capabilities,
        configuredRoles: [...(roles.get(model) ?? [])],
        // Observed success score for models with real governed acceptance
        // evidence. Exact-name lookup: undefined for every other model, which
        // leaves the selector's existing heuristic score untouched.
        reliability: registry.getObservedReliability(model),
        automaticSelectionExcluded: registry.isAutomaticSelectionExcluded(model),
        explicitlyConfigured: explicitlyConfigured.has(model),
        ...(parameterCount ? { parameterBillions: parameterCount / 1e9 } : {}),
        ...(probed?.providerCapabilities ? { providerCapabilities: probed.providerCapabilities } : {}),
        // M49.2: native calling is not the only compatible tool protocol; see deriveToolProtocol.
        toolProtocol: deriveToolProtocol({ nativeToolCalling: capabilities.tools, providerCapabilities: probed?.providerCapabilities }),
        ...(input.qualificationEvidence?.get(model.toLowerCase()) ? { qualification: input.qualificationEvidence.get(model.toLowerCase()) } : {}),
        ...(input.residentModels
          ? { resident: modelIsResident({ models: input.residentModels.map(name => ({ name })) }, model) === true }
          : {}),
      };
    }),
  );
}

/** Baseline requirements used only to find A viable model per role for
 * `resolveAutoRoleDefaults` — deliberately lighter than any real task's
 * requirements (see `AgentPanel.selectModelForTask`), so this never rejects a
 * model real task selection would have accepted. */
function roleBaselineRequirements(role: 'chat' | 'agent' | 'edit' | 'reviewer'): TaskRequirements {
  switch (role) {
    case 'agent':
      return classifyTaskRequirements('', { repositoryExploration: true, toolCalling: true, fileMutation: true, validationRepair: false, codingComplexity: 'low' });
    case 'edit':
      return classifyTaskRequirements('', { repositoryExploration: false, toolCalling: false, fileMutation: true, validationRepair: false, codingComplexity: 'low' });
    case 'reviewer':
      return classifyTaskRequirements('', { repositoryExploration: true, toolCalling: false, fileMutation: false, validationRepair: true, codingComplexity: 'none' });
    case 'chat':
    default:
      return classifyTaskRequirements('', { repositoryExploration: false, toolCalling: false, fileMutation: false, validationRepair: false, codingComplexity: 'none' });
  }
}

/**
 * Best-effort per-role Auto selection from an already-built candidate set —
 * feeds `ResolvedModelDefaults` (see Config.ts) so synchronous callers that
 * predate discovery-based routing still get a real installed model instead
 * of an empty string once discovery has run at least once this session. Never
 * throws: a role with no viable candidate yet is simply omitted, never
 * fabricated.
 */
export function resolveAutoRoleDefaults(candidates: readonly TaskModelCandidate[]): Partial<Record<'chat' | 'agent' | 'edit' | 'reviewer', string>> {
  const provider = candidates[0]?.provider;
  if (!provider) return {};
  const result: Partial<Record<'chat' | 'agent' | 'edit' | 'reviewer', string>> = {};
  for (const role of ['chat', 'agent', 'edit', 'reviewer'] as const) {
    try {
      const selection = selectTaskModel({ provider, candidates, requirements: roleBaselineRequirements(role) });
      result[role] = selection.selectedModel;
    } catch {
      // No candidate viable for this role yet — leave unresolved rather than guessing.
    }
  }
  return result;
}
