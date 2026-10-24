/**
 * Bounded Auto-mode recovery (host-neutral, deterministic).
 *
 * Auto may move a failed attempt to the next ELIGIBLE model; Manual never does (an exact selection is exact).
 * Eligibility is decided BEFORE ranking: generative, requirement-compatible (context/output/tools), provider reachable,
 * spend-policy allowed, and not cooled down for the failure fingerprint that just occurred. A reroute only happens
 * before any mutation was applied and at most `maxReroutes` times, so it can never duplicate a side effect or loop.
 */
import { LOCAL_PROVIDER_ID, modelKey, satisfiesRequirements, type ModelDescriptor, type ModelRequirements } from './modelCatalog';
import { rankPool, spendVerdict, type CloudSpendPolicy, type QuotaTracker } from './cloudRouting';
import type { ProviderCatalog } from './providerCatalog';

export type FailureFingerprint = 'model_output_truncated' | 'timeout' | 'provider_unavailable' | 'protocol_failure' | 'model_capability_unsupported';

/**
 * The provider refused the request itself because the model cannot serve it (`"x" does not support chat`, unsupported
 * endpoint/capability, incompatible generation protocol). Provider-neutral wording; no model names appear here.
 */
export const CAPABILITY_UNSUPPORTED_PATTERN = /model_capability_unsupported|does not support (?:chat|generate|generation|completions?|tools?|thinking|vision|images?)|unsupported (?:endpoint|capabilit(?:y|ies)|api)|(?:endpoint|capabilit(?:y|ies)) (?:is )?(?:not supported|unsupported)|incompatible (?:\w+ )?(?:generation )?protocol|\bnot (?:a )?chat(?:-| )?(?:capable|model)\b/i;

/** Maps a terminal failure reason to a reroutable fingerprint; anything else is not an Auto-recoverable model failure. */
export function classifyFailureFingerprint(reason: string): FailureFingerprint | undefined {
  const text = String(reason ?? '');
  if (CAPABILITY_UNSUPPORTED_PATTERN.test(text)) return 'model_capability_unsupported';
  if (/model_output_truncated|token\/context limit|output limit/i.test(text)) return 'model_output_truncated';
  if (/\btimed? ?out\b|timeout|deadline exceeded|ETIMEDOUT/i.test(text)) return 'timeout';
  if (/provider_unavailable|ECONNREFUSED|ENOTFOUND|unreachable|model .*not found|503|502|connection (?:refused|reset)/i.test(text)) return 'provider_unavailable';
  if (/protocol|tool[- ]call|tool_protocol|malformed (?:tool|json)|invalid tool|unparseable/i.test(text)) return 'protocol_failure';
  return undefined;
}

/** Remembers (model, fingerprint) pairs that just failed so Auto does not bounce straight back to them. */
export class FailureCooldowns {
  private readonly until = new Map<string, number>();
  constructor(private readonly now: () => number = () => Date.now()) {}
  record(key: string, fingerprint: FailureFingerprint, ttlMs = 15 * 60_000): void { this.until.set(`${key}|${fingerprint}`, this.now() + ttlMs); }
  isCooled(key: string, fingerprint: FailureFingerprint): boolean {
    const id = `${key}|${fingerprint}`;
    const end = this.until.get(id);
    if (end === undefined) return false;
    if (this.now() >= end) { this.until.delete(id); return false; }
    return true;
  }
  /** A model that is reachable again (e.g. local provider back) is released immediately. */
  release(key: string): void { for (const id of [...this.until.keys()]) if (id.startsWith(`${key}|`)) this.until.delete(id); }
}

export interface RerouteInput {
  selection: 'auto' | 'manual';
  failureReason: string;
  /** True once any mutation was applied; rerouting after a side effect could duplicate it. */
  mutationApplied: boolean;
  failedModelKey: string;
  reroutesSoFar: number;
  maxReroutes?: number;
  models: readonly ModelDescriptor[];
  /** Local model keys the local provider currently serves. Empty when the local provider disappeared. */
  reachableLocalKeys: ReadonlySet<string>;
  connectedProviders: ReadonlySet<string>;
  catalog: ProviderCatalog;
  policy: CloudSpendPolicy;
  quota?: QuotaTracker;
  requirements?: ModelRequirements;
  cooldowns: FailureCooldowns;
  localFirst?: boolean;
}

export type RerouteDecision =
  | { kind: 'reroute'; next: ModelDescriptor; key: string; fingerprint: FailureFingerprint; reason: string }
  | { kind: 'none'; reason: string; fingerprint?: FailureFingerprint };

export const DEFAULT_MAX_REROUTES = 2;

export function planAutoReroute(input: RerouteInput): RerouteDecision {
  if (input.selection === 'manual') return { kind: 'none', reason: 'Manual selection is exact; KarkeDikha never substitutes a different model.' };
  const fingerprint = classifyFailureFingerprint(input.failureReason);
  if (!fingerprint) return { kind: 'none', reason: 'The failure is not a recoverable model failure.' };
  if (input.mutationApplied) return { kind: 'none', fingerprint, reason: 'A mutation was already applied; rerouting could duplicate it.' };
  if ((input.reroutesSoFar) >= (input.maxReroutes ?? DEFAULT_MAX_REROUTES)) return { kind: 'none', fingerprint, reason: 'The bounded reroute limit was reached.' };
  input.cooldowns.record(input.failedModelKey, fingerprint);

  const eligible = (d: ModelDescriptor): boolean => {
    const key = modelKey(d);
    if (key === input.failedModelKey || input.cooldowns.isCooled(key, fingerprint)) return false;
    if (!satisfiesRequirements(d, input.requirements ?? {}).ok) return false;
    if (d.locality === 'local') return d.provider === LOCAL_PROVIDER_ID && input.reachableLocalKeys.has(key);
    return false;
  };
  const local = input.models.filter(eligible).sort((a, b) => a.displayName.localeCompare(b.displayName));
  const cloud = rankPool({
    models: input.models.filter(d => d.locality === 'cloud' && modelKey(d) !== input.failedModelKey && !input.cooldowns.isCooled(modelKey(d), fingerprint)),
    connectedProviders: input.connectedProviders, catalog: input.catalog, policy: input.policy, requirements: input.requirements, quota: input.quota,
  }).candidates.map(candidate => candidate.descriptor).filter(d => spendVerdict(input.policy, d).allowed);
  const ordered = input.localFirst === false ? [...cloud, ...local] : [...local, ...cloud];
  const next = ordered[0];
  if (!next) return { kind: 'none', fingerprint, reason: 'No other eligible model is available (policy, reachability, capability and cooldowns considered).' };
  return { kind: 'reroute', next, key: modelKey(next), fingerprint, reason: `${fingerprint} on ${input.failedModelKey}; rerouting to ${modelKey(next)} (reroute ${input.reroutesSoFar + 1}).` };
}
