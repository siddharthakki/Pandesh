import type {
  ExecutionCapabilityRequirements,
  ModelSelectionEvidence,
  ResolvedMode,
} from '../shared/wireTypes';
import { AUTONOMOUS_MISSION_PROFILE } from '../runtime/missionLoop';
import { resolveContextWindowChain } from '../shared/contextBudget';
import type { InstalledModelsCatalog } from '../runtime/ollamaCatalog';
import { CoreError } from './errors';

export const AUTO_CHAT_MODEL = 'gemma4:12b';
export const AUTO_QUESTION_MODEL = 'jarvis-qwen3.8:27b-gsq';
export const AUTO_MUTATION_MODEL = 'qwen3.8:27b-mtp-q4_K_M';
export const AUTO_RECOVERY_MODEL = 'laguna-xs-2.1:latest';
export const AUTO_FALLBACK_MODEL = 'qwen2.5-coder:1.5b';

function routingKind(mode: ResolvedMode, profile?: string): 'chat' | 'question' | 'mutation' {
  if (mode === 'baat_kar') return 'chat';
  if (mode === 'karke_dikha' || profile === AUTONOMOUS_MISSION_PROFILE) return 'mutation';
  return 'question';
}

function chainFor(kind: ReturnType<typeof routingKind>): string[] {
  if (kind === 'chat') return [AUTO_CHAT_MODEL, AUTO_RECOVERY_MODEL, AUTO_FALLBACK_MODEL];
  if (kind === 'mutation') return [AUTO_MUTATION_MODEL, AUTO_RECOVERY_MODEL, AUTO_FALLBACK_MODEL];
  return [AUTO_QUESTION_MODEL, AUTO_MUTATION_MODEL, AUTO_RECOVERY_MODEL, AUTO_FALLBACK_MODEL];
}

function requirementsFor(
  mode: ResolvedMode,
  profile?: string,
): ExecutionCapabilityRequirements {
  const kind = routingKind(mode, profile);
  if (kind === 'chat') {
    return {
      readOnlyExplanation: true,
      repositoryExploration: false,
      toolCalling: false,
      fileModification: false,
      codingComplexity: 'none',
      contextRequirement: 'small',
      vision: false,
      validationAndRepair: false,
    };
  }
  if (kind === 'mutation') {
    return {
      readOnlyExplanation: false,
      repositoryExploration: true,
      toolCalling: true,
      fileModification: true,
      codingComplexity: 'medium',
      contextRequirement: 'large',
      vision: false,
      validationAndRepair: true,
    };
  }
  return {
    readOnlyExplanation: true,
    repositoryExploration: true,
    toolCalling: true,
    fileModification: false,
    codingComplexity: 'low',
    contextRequirement: 'medium',
    vision: false,
    validationAndRepair: false,
  };
}

/** Every model Auto routing may select or escalate to, for window introspection. */
export function autoRoutingCandidateModels(): string[] {
  return [...new Set([AUTO_CHAT_MODEL, AUTO_QUESTION_MODEL, AUTO_MUTATION_MODEL, AUTO_RECOVERY_MODEL, AUTO_FALLBACK_MODEL])];
}

export interface RouteModelOptions {
  /** The user's explicit context window; never raised above what the provider reported. */
  contextWindowOverrideTokens?: number;
}

/** Pure, deterministic request-kind routing over a Core-observed catalog. */
export function routeModel(
  resolvedMode: ResolvedMode,
  profile: string | undefined,
  catalog: InstalledModelsCatalog,
  options: RouteModelOptions = {},
): ModelSelectionEvidence {
  const kind = routingKind(resolvedMode, profile);
  const chain = chainFor(kind);
  const installed = new Set(catalog.models);
  const selectedModel = catalog.reachable
    ? chain.find((model) => installed.has(model))
    : AUTO_FALLBACK_MODEL;

  if (!selectedModel) {
    throw new CoreError(
      'invalid_request',
      `no installed Ollama model can serve '${kind}'; expected one of: ${chain.join(', ')}`,
    );
  }

  const candidates = chain.map((model, index) => {
    const available = catalog.reachable && installed.has(model);
    return {
      provider: 'ollama',
      model,
      available,
      capable: true,
      costRank: index + 1,
      rejectionReasons: available
        ? []
        : [catalog.reachable ? 'model is not installed' : 'Ollama catalog is unreachable'],
    };
  });
  const selectedIndex = chain.indexOf(selectedModel);
  const escalationCandidates = catalog.reachable
    ? chain.slice(selectedIndex + 1)
      .filter((model) => installed.has(model))
      .map((model) => ({ provider: 'ollama', model, reason: `Available recovery model for ${kind}` }))
    : [];

  // Frozen with the selection, with its provenance. When nothing resolved it,
  // the fields are omitted and Core records its conservative assumption.
  const window = resolveContextWindowChain({
    explicit: options.contextWindowOverrideTokens,
    provider: catalog.contextWindows?.[selectedModel],
  });
  const windowEvidence = window.source === 'assumed_default'
    ? {}
    : { contextWindowTokens: window.contextTokens, contextWindowSource: window.source };

  return {
    requiredCapabilities: requirementsFor(resolvedMode, profile),
    selectedProvider: 'ollama',
    selectedModel,
    selectionReason: catalog.reachable
      ? `Core selected the first installed model in the ${kind} preference chain.`
      : `Ollama catalog was unreachable; Core retained the historic local fallback for ${kind}.`,
    suitabilitySummary: catalog.reachable
      ? `Using local ${selectedModel} for ${kind}.`
      : `Catalog unavailable; execution will verify whether local fallback ${selectedModel} is reachable.`,
    userOverrode: false,
    candidates,
    escalationCandidates,
    routingPolicy: 'local-only',
    ...windowEvidence,
  };
}
