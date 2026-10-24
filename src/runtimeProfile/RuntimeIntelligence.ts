import type { InferenceProvider, ProviderType } from '../providers/ProviderTypes';
import { ModelProfileRegistry } from '../reliability/ModelProfiles';
import { explicitContextWindowOverride, resolveModelContextLimit } from '../reliability/ModelDispatchPlanner';
import { ContractDecision, negotiateContract } from '../reliability/ContractNegotiator';
import {
  RuntimeCapabilityProfile,
  RuntimeIdentity,
  RuntimeProfileStore,
  conservativeProfile,
  makeIdentity,
  profileTtlMs,
} from './RuntimeCapabilityProfile';
import { ProbeOptions, probeRuntime } from './RuntimeProbe';

/**
 * RuntimeIntelligence: resolves "what can this model, behind this runtime, actually do" and hands the
 * ContractNegotiator's starting decision to the dispatch layer.
 *
 *   unknown model -> conservative profile -> bounded probe (cached) -> profile -> negotiated start -> execution
 *
 * An unknown model is never rejected here. If the probe cannot run or fails, the conservative profile is used and
 * the M46 reactive path (enforce on protocol failure, retry on empty completion) still applies.
 *
 * Off unless configured: probing sends real requests, so it is enabled by the extension host (or by
 * `OLLAMA_AGENT_RUNTIME_PROBE=1`), and unit tests with scripted providers never see extra calls.
 */

export interface RuntimeIntelligenceConfig {
  enabled: boolean;
  /** Path of the JSON cache; undefined keeps profiles in memory for the life of the process. */
  storePath?: string;
  /** Longest an unknown model's first dispatch waits for the probe before proceeding conservatively. */
  blockingBudgetMs?: number;
  probe?: ProbeOptions;
  log?: (message: string) => void;
}

export interface PreparedRuntime {
  profile: RuntimeCapabilityProfile;
  decision: ContractDecision;
  /** True when this call ran (or joined) a probe rather than reading the cache. */
  probed: boolean;
}

/** Minimum spacing between user-requested re-probes of one runtime. */
export const REPROBE_COOLDOWN_MS = 60_000;

export interface ReprobeResult {
  status: 'probed' | 'joined' | 'cooldown' | 'disabled';
  profile?: RuntimeCapabilityProfile;
  retryAfterMs?: number;
}

type LiveEvent =
  | 'empty_completion'
  | 'timeout'
  | 'stall'
  | 'recovered'
  | 'schema_helped'
  | 'schema_harmful';

export class RuntimeIntelligence {
  private static instance: RuntimeIntelligence | undefined;

  static get shared(): RuntimeIntelligence {
    return (RuntimeIntelligence.instance ??= new RuntimeIntelligence());
  }

  /** Replaces the shared instance; used by the extension host at activation and by tests. */
  static configureShared(config: RuntimeIntelligenceConfig): RuntimeIntelligence {
    RuntimeIntelligence.instance = new RuntimeIntelligence(config);
    return RuntimeIntelligence.instance;
  }

  static resetShared(): void {
    RuntimeIntelligence.instance = undefined;
    ModelProfileRegistry.clearNegotiation();
  }

  private config: RuntimeIntelligenceConfig;
  private store: RuntimeProfileStore;
  private readonly inFlight = new Map<string, Promise<RuntimeCapabilityProfile>>();
  /**
   * Resolves with the profile as soon as the probe has answered every question the negotiated START depends on (the
   * schema step, reasoning-off when it applies, and the prompt-only contract), or when the probe ends, whichever comes
   * first. The tools/continuation steps, the slowest ones, do not feed the start decision and keep running in the
   * background. A first dispatch for an unknown model waits on this, not on the whole probe.
   */
  private readonly firstUsable = new Map<string, Promise<RuntimeCapabilityProfile>>();
  private readonly live = new Map<string, RuntimeCapabilityProfile>();
  /** The runtime a model was last prepared on, so callers without a provider handle can still record evidence. */
  private readonly lastIdentity = new Map<string, RuntimeIdentity>();
  private readonly lastReprobe = new Map<string, number>();
  private clock: () => number = () => Date.now();

  constructor(config: RuntimeIntelligenceConfig = { enabled: process.env.OLLAMA_AGENT_RUNTIME_PROBE === '1', storePath: process.env.OLLAMA_AGENT_RUNTIME_PROFILE_STORE }) {
    this.config = config;
    this.store = new RuntimeProfileStore(config.storePath);
  }

  /** Test seam for the re-probe cooldown. */
  setClock(clock: () => number): void {
    this.clock = clock;
  }

  get enabled(): boolean {
    return this.config.enabled;
  }

  identityFor(provider: InferenceProvider, model: string, extra: { contextOverride?: number; maxOutputOverride?: number; modelModifiedAt?: string } = {}): RuntimeIdentity {
    return makeIdentity({ model, providerType: provider.providerType, endpoint: provider.endpoint, ...extra });
  }

  /** The cached profile, if any, without probing. */
  async peek(identity: RuntimeIdentity): Promise<RuntimeCapabilityProfile | undefined> {
    const live = this.live.get(identityKey(identity));
    // A partial profile is used while fresh; once past its short TTL it no longer stands in for a finished probe, so
    // the next `prepare` resumes the probe (the stored copy is the resume base).
    if (live && !(live.complete === false && live.probedAt && this.clock() - Date.parse(live.probedAt) > profileTtlMs(live))) return live;
    return this.store.get(identity);
  }

  /**
   * The newest known profile for a model on a provider, whatever configuration fingerprint it was learned under.
   * For display (Setup): a profile learned before the user changed an unrelated setting is still the best evidence
   * available. Dispatch decisions keep using the exact-identity `peek`.
   */
  async findForModel(providerType: ProviderType, model: string): Promise<RuntimeCapabilityProfile | undefined> {
    const matches = [...this.live.values(), ...(await this.store.list())]
      .filter(profile => profile.identity.providerType === providerType && profile.identity.model === model);
    const stamp = (profile: RuntimeCapabilityProfile) => Date.parse(profile.probedAt ?? profile.createdAt) || 0;
    return matches.sort((a, b) => stamp(b) - stamp(a))[0];
  }

  async prepare(
    provider: InferenceProvider,
    model: string,
    options: { contextOverride?: number; maxOutputOverride?: number; signal?: AbortSignal } = {},
  ): Promise<PreparedRuntime | undefined> {
    if (!this.config.enabled) return undefined;
    let modifiedAt: string | undefined;
    let metadata: Awaited<ReturnType<NonNullable<InferenceProvider['getModelContextMetadata']>>>;
    try {
      metadata = await provider.getModelContextMetadata?.(model, options.signal);
      modifiedAt = metadata?.modifiedAt;
    } catch {
      metadata = undefined;
    }
    // The window the real dispatch will use, so the probe never makes the runtime reload the model.
    const limit = resolveModelContextLimit({ model, providerType: provider.providerType, providerMetadata: metadata, userOverride: options.contextOverride ?? explicitContextWindowOverride() });
    const identity = this.identityFor(provider, model, { ...options, modelModifiedAt: modifiedAt });
    const key = identityKey(identity);
    this.lastIdentity.set(`${provider.providerType}|${model}`, identity);
    let profile = await this.peek(identity);
    let probed = false;
    // A partial profile is used as it stands (it is real evidence) but, once it is older than its short TTL, the
    // probe resumes from the steps it has not answered; `peek` already returned undefined for a stale one.
    if (!profile) {
      probed = true;
      const running = this.probeOnce(provider, identity, options.signal, { contextWindow: limit.effectiveLimit, contextProvenance: limit.provenance });
      const known = isKnownStaticModel(model, provider.providerType);
      if (known) {
        // A statically profiled model does not need the answer to start: learn it in the background.
        profile = conservativeProfile(identity);
      } else {
        // An unknown model's first dispatch waits only for the probe steps the negotiated start depends on (schema,
        // reasoning-off, prompt-only contract), never for the whole probe: the tools/continuation steps keep running
        // and are persisted and applied as they land. The blocking budget still bounds even that wait.
        const budget = this.config.blockingBudgetMs ?? 45_000;
        profile = await Promise.race([
          this.firstUsable.get(key) ?? running,
          new Promise<RuntimeCapabilityProfile>(resolve => setTimeout(() => resolve(conservativeProfile(identity)), budget).unref?.()),
        ]);
        if (profile.source === 'conservative') this.config.log?.(`runtime_probe still running for ${model}; continuing conservatively`);
        else if (profile.complete === false) this.config.log?.(`runtime_probe partial for ${model} (${profile.completedSteps?.join(', ') ?? 'no steps'}); continuing on the partial profile`);
      }
    }
    this.live.set(key, profile);
    return this.negotiateAndApply(provider.providerType, model, profile);
  }

  /**
   * User-requested re-probe (Setup > Re-probe). Bounded on purpose: a probe that is already running is joined
   * rather than duplicated, and a runtime probed within `REPROBE_COOLDOWN_MS` is reported as cooling down instead
   * of re-running six requests against a possibly large model. A completed re-probe replaces the cached profile.
   */
  async reprobe(
    provider: InferenceProvider,
    model: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<ReprobeResult> {
    if (!this.config.enabled) return { status: 'disabled' };
    let metadata: Awaited<ReturnType<NonNullable<InferenceProvider['getModelContextMetadata']>>>;
    try {
      metadata = await provider.getModelContextMetadata?.(model, options.signal);
    } catch {
      metadata = undefined;
    }
    const limit = resolveModelContextLimit({ model, providerType: provider.providerType, providerMetadata: metadata, userOverride: explicitContextWindowOverride() });
    const identity = this.identityFor(provider, model, { modelModifiedAt: metadata?.modifiedAt });
    const key = identityKey(identity);
    const joined = this.inFlight.get(key);
    if (joined) return { status: 'joined', profile: await joined };
    const last = this.lastReprobe.get(key);
    const now = this.clock();
    if (last !== undefined && now - last < REPROBE_COOLDOWN_MS) {
      return { status: 'cooldown', retryAfterMs: REPROBE_COOLDOWN_MS - (now - last), profile: await this.peek(identity) };
    }
    this.lastReprobe.set(key, now);
    this.live.delete(key);
    await this.store.forget(identity).catch(() => undefined);
    this.lastIdentity.set(`${provider.providerType}|${model}`, identity);
    const profile = await this.probeOnce(provider, identity, options.signal, { contextWindow: limit.effectiveLimit, contextProvenance: limit.provenance });
    return { status: 'probed', profile };
  }

  private probeOnce(provider: InferenceProvider, identity: RuntimeIdentity, signal: AbortSignal | undefined, window: { contextWindow: number; contextProvenance: string }): Promise<RuntimeCapabilityProfile> {
    const key = identityKey(identity);
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    let releaseFirst: (profile: RuntimeCapabilityProfile) => void = () => undefined;
    this.firstUsable.set(key, new Promise<RuntimeCapabilityProfile>(resolve => { releaseFirst = resolve; }));
    const run = (async () => {
      // Resume from whatever an earlier, interrupted probe already learned instead of asking it all again.
      const earlier = await this.store.getAny(identity).catch(() => undefined);
      const base = earlier && earlier.complete === false && earlier.completedSteps?.length ? earlier : conservativeProfile(identity);
      // A resumed probe that already holds the start-relevant answers has a usable profile before it asks anything.
      if (base.completedSteps?.includes('prompt_only')) releaseFirst(base);
      const result = await probeRuntime(provider, base, {
        ...this.config.probe,
        ...window,
        signal,
        onProgress: async partial => {
          // Persist and apply every answered step now: a probe cut short must still leave a usable profile.
          this.live.set(key, partial);
          await this.store.put(partial).catch(() => undefined);
          this.negotiateAndApply(provider.providerType, identity.model, partial);
          if (partial.completedSteps?.includes('prompt_only')) releaseFirst(partial);
        },
      });
      releaseFirst(result);
      this.live.set(key, result);
      await this.store.put(result).catch(() => undefined);
      // A late probe can refine the start of the next dispatch.
      this.negotiateAndApply(provider.providerType, identity.model, result);
      this.config.log?.(`runtime_profile ${identity.model}@${identity.endpoint} ${result.evidence.join('; ')}`);
      return result;
    })().finally(() => {
      this.inFlight.delete(key);
      this.firstUsable.delete(key);
    });
    this.inFlight.set(key, run);
    return run;
  }

  private negotiateAndApply(providerType: ProviderType, model: string, profile: RuntimeCapabilityProfile): PreparedRuntime {
    const decision = negotiateContract(profile);
    ModelProfileRegistry.applyNegotiation(model, providerType, {
      schemaEnforced: decision.interaction === 'provider_schema',
      reasoningOff: decision.reasoning === 'disabled',
    });
    return { profile, decision, probed: profile.source === 'probe' };
  }

  /** Live evidence about one runtime, folded into its profile and cache. Never touches semantic failure counts. */
  async record(provider: InferenceProvider, model: string, event: LiveEvent): Promise<void> {
    await this.recordFor(provider.providerType, model, event, this.identityFor(provider, model));
  }

  /** Same as `record` for callers that know only the provider type and model name (the recovery supervisor). */
  async recordByModel(providerType: ProviderType, model: string, event: LiveEvent): Promise<void> {
    const identity = this.lastIdentity.get(`${providerType}|${model}`);
    if (!identity) return;
    await this.recordFor(providerType, model, event, identity);
  }

  private async recordFor(providerTypeArg: ProviderType, model: string, event: LiveEvent, identity: RuntimeIdentity): Promise<void> {
    if (!this.config.enabled) return;
    const profile = (await this.peek(identity)) ?? conservativeProfile(identity);
    const next: RuntimeCapabilityProfile = {
      ...profile,
      source: profile.source === 'conservative' ? 'observed' : profile.source,
      reasoning: { ...profile.reasoning },
      providerHealth: { ...profile.providerHealth },
      evidence: [...profile.evidence].slice(-12),
    };
    switch (event) {
      case 'empty_completion':
        next.providerHealth.emptyCompletions += 1;
        next.emptyCompletion = 'observed';
        next.reasoning.supported = 'yes';
        break;
      case 'timeout': next.providerHealth.timeouts += 1; break;
      case 'stall': next.providerHealth.stalls += 1; break;
      case 'recovered': next.providerHealth.recovered += 1; break;
      case 'schema_helped':
        next.schemaEnforcementHelps = 'yes';
        if (next.structuredSchema === 'unknown') next.structuredSchema = 'yes';
        break;
      case 'schema_harmful':
        next.schemaEnforcementHelps = 'no';
        break;
    }
    next.evidence.push(`live: ${event}`);
    this.live.set(identityKey(identity), next);
    await this.store.put(next).catch(() => undefined);
    if (event === 'schema_harmful' || event === 'schema_helped' || event === 'empty_completion') {
      this.negotiateAndApply(providerTypeArg, model, next);
    }
  }
}

function identityKey(identity: RuntimeIdentity): string {
  return `${identity.providerType}|${identity.endpoint}|${identity.model}|${identity.configFingerprint}`;
}

function isKnownStaticModel(model: string, providerType: ProviderType): boolean {
  return !ModelProfileRegistry.resolve(model, providerType).fallback;
}
