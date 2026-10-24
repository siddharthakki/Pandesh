import type { ModelSelectionEvidence } from '../../core/shared/wireTypes';
import { normalizeContextWindow, type ContextWindowSource } from '../../core/shared/contextBudget';
import type { ProviderType } from '../providers/ProviderTypes';
import { explicitContextWindowOverride, resolveModelContextLimit } from '../reliability/ModelDispatchPlanner';
import type { ContextLimitProvenance } from '../reliability/ModelProfiles';
import { ModelCapabilityRegistry } from './ModelCapabilityRegistry';

/** Provenance recorded with a frozen window, in the shared resolution order. */
const SOURCE_BY_PROVENANCE: Record<Exclude<ContextLimitProvenance, 'conservative_fallback'>, ContextWindowSource> = {
  user_override: 'explicit_config',
  provider_runtime: 'router_metadata',
  profile_operational: 'catalog_metadata',
  profile_declared: 'catalog_metadata',
};

export type FrozenContextWindowEvidence = Pick<
  ModelSelectionEvidence,
  'contextWindowTokens' | 'contextWindowSource' | 'maxOutputTokens'
>;

/**
 * The window to freeze into a model selection, with its provenance. It is the
 * value `resolveModelContextLimit` yields for dispatch, fed the same probed
 * provider metadata and explicit override. When that resolution had to fall
 * back to its built-in default, nothing is frozen: Core then records its own
 * conservative assumption instead of a window this side never actually knew.
 */
export function frozenContextWindowEvidence(input: {
  model: string;
  providerType?: string;
  maxOutputTokens?: number;
}): FrozenContextWindowEvidence {
  const providerType: ProviderType = input.providerType === 'openai-compatible' ? 'openai-compatible' : 'ollama';
  const limit = resolveModelContextLimit({
    model: input.model,
    providerType,
    providerMetadata: ModelCapabilityRegistry.getInstance().getProbedMetadata(input.model, providerType),
    userOverride: explicitContextWindowOverride(),
  });
  const maxOutputTokens = input.maxOutputTokens !== undefined && input.maxOutputTokens > 0
    ? Math.floor(input.maxOutputTokens)
    : undefined;
  const evidence: FrozenContextWindowEvidence = maxOutputTokens !== undefined ? { maxOutputTokens } : {};
  if (limit.provenance === 'conservative_fallback') return evidence;
  const window = normalizeContextWindow({
    contextTokens: limit.effectiveLimit,
    source: SOURCE_BY_PROVENANCE[limit.provenance],
  });
  return { ...evidence, contextWindowTokens: window.contextTokens, contextWindowSource: window.source };
}
