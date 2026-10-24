/**
 * Cloud spend policy and free-pool routing (host-neutral, JARVIS-reusable).
 *
 * FREE_ONLY is a HARD gate: a model is eligible only when it is positively known to
 * be free. Unknown and paid models are never eligible, whatever the pool order says.
 * When no eligible provider remains the decision is `blocked` with a truthful reason;
 * this module never returns a paid model under FREE_ONLY.
 */
import { LOCAL_PROVIDER_ID, modelKey, satisfiesRequirements, type ModelDescriptor, type ModelRequirements } from './modelCatalog';
import type { ProviderCatalog } from './providerCatalog';

export type CloudSpendMode = 'FREE_ONLY' | 'BUDGETED' | 'UNRESTRICTED';

export interface CloudSpendPolicy {
  mode: CloudSpendMode;
  /** FREE_ONLY only: also allow models classified trial/promotional (credit-limited, not recurring). Default false. */
  allowCredits?: boolean;
  /** BUDGETED data model; enforcement needs a billing source, which no provider here exposes yet. */
  perTaskUsd?: number;
  dailyUsd?: number;
  monthlyUsd?: number;
}

export const DEFAULT_SPEND_POLICY: CloudSpendPolicy = { mode: 'FREE_ONLY', allowCredits: false };

export function normalizeSpendMode(value: unknown): CloudSpendMode {
  return value === 'BUDGETED' || value === 'UNRESTRICTED' ? value : 'FREE_ONLY';
}

export type SpendVerdict = { allowed: true } | { allowed: false; reason: string };

/** Whether a single model may be used under the policy. Pure; no I/O. */
export function spendVerdict(policy: CloudSpendPolicy, model: Pick<ModelDescriptor, 'locality' | 'freeness' | 'displayName' | 'providerName'>): SpendVerdict {
  if (model.locality === 'local') return { allowed: true };
  if (policy.mode === 'UNRESTRICTED') return { allowed: true };
  if (policy.mode === 'FREE_ONLY') {
    if (model.freeness === 'free') return { allowed: true };
    if ((model.freeness === 'trial' || model.freeness === 'promotional') && policy.allowCredits) return { allowed: true };
    const why = model.freeness === 'paid' ? 'is a paid model'
      : model.freeness === 'trial' || model.freeness === 'promotional' ? `uses ${model.freeness} credits, which are not allowed under the free-only policy`
      : 'is not known to be free';
    return { allowed: false, reason: `${model.displayName} (${model.providerName}) ${why}. "Never incur paid usage" is on.` };
  }
  // BUDGETED: a model whose price is unknown cannot be bounded, so it is not eligible; known-free always is.
  if (model.freeness === 'free' || model.freeness === 'trial' || model.freeness === 'promotional') return { allowed: true };
  if (model.freeness === 'paid') {
    const hasBudget = [policy.perTaskUsd, policy.dailyUsd, policy.monthlyUsd].some(v => typeof v === 'number' && v > 0);
    return hasBudget ? { allowed: true } : { allowed: false, reason: `${model.displayName} is paid and no spending limit is configured.` };
  }
  return { allowed: false, reason: `${model.displayName} has unknown pricing, so it cannot be kept within a budget.` };
}

/** Remembers providers/models that returned a quota or rate-limit failure until the cooldown ends. */
export class QuotaTracker {
  private readonly until = new Map<string, number>();
  constructor(private readonly now: () => number = () => Date.now()) {}
  markExhausted(providerId: string, cooldownMs = 60 * 60_000): void { this.until.set(providerId, this.now() + cooldownMs); }
  isExhausted(providerId: string): boolean {
    const end = this.until.get(providerId);
    if (end === undefined) return false;
    if (this.now() >= end) { this.until.delete(providerId); return false; }
    return true;
  }
  clear(providerId?: string): void { if (providerId) this.until.delete(providerId); else this.until.clear(); }
  exhausted(): string[] { return [...this.until.keys()].filter(id => this.isExhausted(id)); }
}

export interface PoolInput {
  models: readonly ModelDescriptor[];
  connectedProviders: ReadonlySet<string>;
  catalog: ProviderCatalog;
  policy: CloudSpendPolicy;
  requirements?: ModelRequirements;
  quota?: QuotaTracker;
  /** Per-provider default/selected model id, tried first within that provider. */
  preferredModels?: Readonly<Record<string, string>>;
  /** Provider ids the user disabled for the pool. */
  disabledProviders?: ReadonlySet<string>;
}

export interface PoolCandidate { descriptor: ModelDescriptor; key: string; rank: number }

export type PoolDecision =
  | { kind: 'selected'; candidate: PoolCandidate; alternatives: PoolCandidate[] }
  | { kind: 'blocked'; reason: string; rejected: Array<{ key: string; reason: string }>; exhaustedProviders: string[] };

/** Ranks connected, policy-eligible, requirement-satisfying cloud models. Never returns a model the policy forbids. */
export function rankPool(input: PoolInput): { candidates: PoolCandidate[]; rejected: Array<{ key: string; reason: string }>; exhaustedProviders: string[] } {
  const rejected: Array<{ key: string; reason: string }> = [];
  const exhaustedProviders = new Set<string>();
  const candidates: PoolCandidate[] = [];
  for (const d of input.models) {
    if (d.locality !== 'cloud') continue;
    const key = modelKey(d);
    if (!input.connectedProviders.has(d.provider)) { rejected.push({ key, reason: 'provider not connected' }); continue; }
    if (input.disabledProviders?.has(d.provider)) { rejected.push({ key, reason: 'provider disabled for the pool' }); continue; }
    if (input.quota?.isExhausted(d.provider)) { exhaustedProviders.add(d.provider); rejected.push({ key, reason: 'free quota exhausted' }); continue; }
    const verdict = spendVerdict(input.policy, d);
    if (!verdict.allowed) { rejected.push({ key, reason: verdict.reason }); continue; }
    const fit = satisfiesRequirements(d, input.requirements ?? {});
    if (!fit.ok) { rejected.push({ key, reason: fit.reasons.join('; ') }); continue; }
    const priority = input.catalog.get(d.provider)?.fallbackPriority ?? 100;
    const preferred = input.preferredModels?.[d.provider] === d.modelId ? -50 : 0;
    const quality = (d.tools === true ? -5 : 0) + (d.coding === true ? -3 : 0) + (d.contextWindow ? -Math.min(3, d.contextWindow / 100_000) : 0);
    candidates.push({ descriptor: d, key, rank: priority + preferred + quality });
  }
  candidates.sort((a, b) => a.rank - b.rank || a.key.localeCompare(b.key));
  return { candidates, rejected, exhaustedProviders: [...exhaustedProviders] };
}

export function decidePool(input: PoolInput): PoolDecision {
  const { candidates, rejected, exhaustedProviders } = rankPool(input);
  if (candidates.length > 0) return { kind: 'selected', candidate: candidates[0], alternatives: candidates.slice(1, 6) };
  const connected = [...input.connectedProviders];
  let reason: string;
  if (connected.length === 0) reason = 'No cloud provider is connected.';
  else if (exhaustedProviders.length > 0 && input.policy.mode === 'FREE_ONLY') {
    reason = `Free quota is exhausted on ${exhaustedProviders.join(', ')} and no other connected free provider can take this task. KarkeDikha will not switch to paid usage; enable another provider or allow paid cloud to continue.`;
  } else if (input.policy.mode === 'FREE_ONLY') {
    reason = 'No connected provider offers a model that is known to be free and fits this task. KarkeDikha will not switch to paid usage.';
  } else reason = 'No connected provider offers a model that fits this task.';
  return { kind: 'blocked', reason, rejected, exhaustedProviders };
}

export interface FallbackPolicy {
  localFirst: boolean;
  useFreeCloud: boolean;
  spend: CloudSpendPolicy;
}

export const DEFAULT_FALLBACK_POLICY: FallbackPolicy = { localFirst: true, useFreeCloud: true, spend: DEFAULT_SPEND_POLICY };

/** Detects provider responses that mean "quota/rate exhausted" rather than a bug. */
export function isQuotaFailure(status: number | undefined, message: string): boolean {
  if (status === 429 || status === 402) return true;
  return /quota|rate.?limit|insufficient (credits|funds)|credit(s)? (exhausted|balance)|too many requests|free.*(limit|exhaust)/i.test(message);
}

export { LOCAL_PROVIDER_ID };
