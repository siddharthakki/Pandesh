/**
 * Which discovered free cloud models may be chosen automatically, and for what (host-neutral, pure).
 *
 * This is NOT a second router. It produces the `eligibility` predicate and requirements that the existing
 * `rankPool`/`decidePool` in cloudRouting.ts already rank, so FREE_ONLY, quota cooldowns and catalog priorities keep
 * working exactly as before. Every rule fails closed:
 *  - private content never goes to the cloud, whatever is configured;
 *  - the provider must be approved by the user for automatic routing AND hold a key;
 *  - the model must be verified free by Pandesh itself (registry `verified_free`), not merely listed upstream;
 *  - restricted (trial/credit/card/training/paid-only) and unavailable models are never automatic;
 *  - each task class needs its own qualification pass: chat does not imply coding, tools or JSON.
 */
import type { ModelDescriptor, ModelRequirements } from './modelCatalog';
import { decidePool, DEFAULT_SPEND_POLICY, type CloudSpendPolicy, type PoolDecision, type QuotaTracker } from './cloudRouting';
import type { ProviderCatalog } from './providerCatalog';
import type { RegistryProvider, RegistryStatus } from './freeModelRegistry';

export type TaskClass = 'chat' | 'research' | 'coding' | 'structured' | 'tools' | 'long_context';
export type PrivacyClass = 'public' | 'private';

/** The parts of a qualification record routing needs (see runtime/modelQualification.ts). */
export interface QualificationSummary {
  suiteVersion: string;
  ranAt: string;
  capabilities: { chat: boolean; coding: boolean; tools: boolean; structuredOutput: boolean; longContext: boolean };
}

export interface RoutingPreferences {
  /** Providers the user approved for AUTOMATIC selection and rate-limit fallback. Empty by default. */
  autoProviders: string[];
  /** Providers the user switched off entirely (never selected, even manually through Auto). */
  disabledProviders: string[];
  /** Prefer these provider ids first (user ordering); others follow catalog priority. */
  preferredOrder: string[];
  /** Fall back to another approved free model when the chosen one is rate-limited. Default true. */
  fallbackOnRateLimit: boolean;
}

export const DEFAULT_ROUTING_PREFERENCES: RoutingPreferences = { autoProviders: [], disabledProviders: [], preferredOrder: [], fallbackOnRateLimit: true };

export function normalizeRoutingPreferences(raw: unknown): RoutingPreferences {
  const value = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const ids = (list: unknown) => Array.isArray(list) ? [...new Set(list.filter((id): id is string => typeof id === 'string' && /^[a-z0-9][a-z0-9-]{1,48}$/.test(id)))] : [];
  return {
    autoProviders: ids(value.autoProviders),
    disabledProviders: ids(value.disabledProviders),
    preferredOrder: ids(value.preferredOrder),
    fallbackOnRateLimit: value.fallbackOnRateLimit !== false,
  };
}

export interface EligibilityFacts {
  privacy: PrivacyClass;
  task: TaskClass;
  preferences: RoutingPreferences;
  /** Providers Core currently holds a key for. */
  credentialedProviders: ReadonlySet<string>;
  registry: ReadonlyMap<string, RegistryProvider>;
  qualifications: ReadonlyMap<string, QualificationSummary>;
}

export function qualificationKey(providerId: string, modelId: string): string {
  return `${providerId}::${modelId}`;
}

const TASK_NEEDS: Record<TaskClass, { capability: keyof QualificationSummary['capabilities']; label: string }> = {
  chat: { capability: 'chat', label: 'basic response' },
  research: { capability: 'chat', label: 'basic response' },
  coding: { capability: 'coding', label: 'coding' },
  structured: { capability: 'structuredOutput', label: 'structured JSON output' },
  tools: { capability: 'tools', label: 'tool-call schema compliance' },
  long_context: { capability: 'longContext', label: 'long-context recall' },
};

export function requirementsForTask(task: TaskClass): ModelRequirements {
  if (task === 'tools') return { tools: true };
  if (task === 'structured') return { structuredOutput: true };
  if (task === 'long_context') return { minContext: 32_000 };
  return {};
}

export type Eligibility = { ok: true } | { ok: false; reason: string };

function modelStatus(provider: RegistryProvider | undefined, modelId: string): { status: RegistryStatus; reasons: string[] } | undefined {
  const model = provider?.models.find(m => m.modelId.toLowerCase() === modelId.toLowerCase());
  return model ? { status: model.status, reasons: model.statusReasons } : undefined;
}

/** Whether one cloud model may be chosen automatically for this task. */
export function cloudModelEligibility(d: Pick<ModelDescriptor, 'provider' | 'modelId' | 'locality'>, facts: EligibilityFacts): Eligibility {
  if (d.locality === 'local') return { ok: true };
  if (facts.privacy === 'private') return { ok: false, reason: 'private content stays on this PC; cloud models are never used for it' };
  const p = facts.preferences;
  if (p.disabledProviders.includes(d.provider)) return { ok: false, reason: 'you switched this provider off' };
  if (!p.autoProviders.includes(d.provider)) return { ok: false, reason: 'not approved by you for automatic routing' };
  if (!facts.credentialedProviders.has(d.provider)) return { ok: false, reason: 'pending setup: no API key is stored for this provider' };
  const provider = facts.registry.get(d.provider);
  const status = modelStatus(provider, d.modelId);
  if (!status) return { ok: false, reason: 'not in the verified registry yet; refresh discovery and verify the provider' };
  if (status.status !== 'verified_free') return { ok: false, reason: `registry status is ${status.status}${status.reasons[0] ? ` (${status.reasons[0]})` : ''}` };
  const q = facts.qualifications.get(qualificationKey(d.provider, d.modelId));
  if (!q) return { ok: false, reason: 'not qualified yet; run "Test" for this model' };
  const need = TASK_NEEDS[facts.task];
  if (!q.capabilities[need.capability]) return { ok: false, reason: `failed or did not run the ${need.label} qualification test` };
  return { ok: true };
}

export interface FreeRouteInput {
  models: readonly ModelDescriptor[];
  catalog: ProviderCatalog;
  facts: EligibilityFacts;
  quota?: QuotaTracker;
  policy?: CloudSpendPolicy;
  exclude?: ReadonlySet<string>;
}

/**
 * Picks the best eligible free cloud model through the existing pool ranking. Under `private` it is always blocked:
 * the caller runs locally. Preferred order from the user beats catalog priority.
 */
export function routeFreeCloud(input: FreeRouteInput): PoolDecision {
  const { facts } = input;
  if (facts.privacy === 'private') {
    return { kind: 'blocked', reason: 'Private content stays on this PC. Pandesh uses a local model and never a cloud one for it.', rejected: [], exhaustedProviders: [] };
  }
  const preferred = new Map(facts.preferences.preferredOrder.map((id, index) => [id, index]));
  const models = input.models.filter(d => d.locality === 'cloud' && !input.exclude?.has(`${d.provider}::${d.modelId}`));
  const decision = decidePool({
    models,
    connectedProviders: facts.credentialedProviders,
    catalog: input.catalog,
    policy: input.policy ?? DEFAULT_SPEND_POLICY,
    requirements: requirementsForTask(facts.task),
    quota: input.quota,
    disabledProviders: new Set(facts.preferences.disabledProviders),
    eligibility: d => cloudModelEligibility(d, facts),
    rankAdjust: d => (preferred.has(d.provider) ? -1000 + preferred.get(d.provider)! * 10 : 0),
  });
  if (decision.kind === 'blocked' && facts.preferences.autoProviders.length === 0) {
    return { ...decision, reason: 'No provider is approved for automatic routing. Approve one under Free models, or pick a model yourself.' };
  }
  return decision;
}
