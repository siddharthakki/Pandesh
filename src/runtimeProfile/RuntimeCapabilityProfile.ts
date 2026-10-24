import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';
import type { ProviderType } from '../providers/ProviderTypes';

/**
 * RuntimeCapabilityProfile: what one model, behind one runtime, actually does, learned by observing it.
 *
 * A model name is a weak predictor of behaviour. The same weights behave differently under Ollama, llama.cpp,
 * vLLM, LM Studio or a cloud gateway, and a different context or endpoint changes the answer again. The profile is
 * therefore keyed by model + provider + endpoint + the runtime configuration that changes behaviour, and every
 * field says what was observed, not what the name suggests. `unknown` is a first-class answer: an unknown model is
 * never rejected for having no entry, it is run conservatively and probed.
 */

export type Tri = 'yes' | 'no' | 'unknown';

/** Continuation after a tool result: the native path Spark-class models can stall on. */
export type ContinuationHealth = 'healthy' | 'stalls' | 'unsupported' | 'unknown';

export interface RuntimeIdentity {
  model: string;
  providerType: ProviderType;
  /** Base URL of the backend without credentials, or `local-default` when the provider does not expose one. */
  endpoint: string;
  /**
   * Runtime configuration that changes behaviour: the user-configured context window, output cap, and (when the
   * provider states one) the model's `modifiedAt`, so re-pulling a model invalidates what was learned about it.
   */
  configFingerprint: string;
}

export interface RuntimeCapabilityProfile {
  schemaVersion: 1;
  key: string;
  identity: RuntimeIdentity;
  /** `conservative`: nothing observed yet. `probe`: bounded probe ran. `observed`: refined by live behaviour. */
  source: 'conservative' | 'probe' | 'observed';
  createdAt: string;
  probedAt?: string;
  /** Effective/served context window in tokens, and where the number came from. */
  contextWindow?: { tokens: number; provenance: string };
  structuredSchema: Tri;
  nativeTools: Tri;
  postToolContinuation: ContinuationHealth;
  reasoning: {
    /** The model emits a separate reasoning channel that can consume the output budget. */
    supported: Tri;
    /** The provider honoured an explicit disable-reasoning request. */
    canDisable: Tri;
    levels?: string[];
  };
  /** A completed reply with no text under default decoding (reasoning ate the budget). */
  emptyCompletion: 'observed' | 'not_observed' | 'unknown';
  cancellation: Tri;
  /** A trivial JSON contract was followed with no decoder enforcing it. */
  promptOnlyContract: Tri;
  /**
   * Learned from live work, not from the probe: did enforcing the response schema clear a protocol failure
   * (`yes`) or fail to (`no`)? `unknown` until a real task decided it.
   */
  schemaEnforcementHelps: Tri;
  /** Largest completion the probe or live use actually saw, in tokens (estimated from characters). */
  practicalOutputTokens?: number;
  latencyMs?: number;
  tokensPerSecond?: number;
  /** Live counters kept by ProviderHealthController; never reasoning-failure counters. */
  providerHealth: { timeouts: number; stalls: number; emptyCompletions: number; recovered: number };
  /**
   * False while the probe has answered only some of its questions (it was cut short, or the runtime stopped
   * answering). A partial profile is real evidence and is used at once, but it is not trusted for the full TTL and
   * the probe resumes from the steps it has not completed. Absent means complete (profiles written before this
   * field existed were complete by construction).
   */
  complete?: boolean;
  /** Probe steps already answered, so a resumed probe never repeats them. */
  completedSteps?: ProbeStepId[];
  /** Short human-readable notes on what each conclusion rests on. Content-free. */
  evidence: string[];
}

export type ProbeStepId = 'schema' | 'reasoning_off' | 'prompt_only' | 'tools';

export function normalizeEndpoint(endpoint: string | undefined): string {
  if (!endpoint) return 'local-default';
  try {
    const url = new URL(endpoint);
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return endpoint.replace(/\/+$/, '');
  }
}

export function fingerprintConfig(parts: Record<string, string | number | undefined>): string {
  const canonical = Object.keys(parts).sort().map(name => `${name}=${parts[name] ?? ''}`).join(';');
  return createHash('sha256').update(canonical).digest('hex').slice(0, 12);
}

export function runtimeKey(identity: RuntimeIdentity): string {
  return createHash('sha256')
    .update(JSON.stringify([identity.model, identity.providerType, identity.endpoint, identity.configFingerprint]))
    .digest('hex')
    .slice(0, 24);
}

export function makeIdentity(input: {
  model: string;
  providerType: ProviderType;
  endpoint?: string;
  contextOverride?: number;
  maxOutputOverride?: number;
  modelModifiedAt?: string;
}): RuntimeIdentity {
  return {
    model: input.model,
    providerType: input.providerType,
    endpoint: normalizeEndpoint(input.endpoint),
    configFingerprint: fingerprintConfig({
      ctx: input.contextOverride,
      out: input.maxOutputOverride,
      modified: input.modelModifiedAt,
    }),
  };
}

/** The profile of a runtime nothing is known about: every capability unknown, nothing rejected. */
export function conservativeProfile(identity: RuntimeIdentity, now: Date = new Date()): RuntimeCapabilityProfile {
  return {
    schemaVersion: 1,
    key: runtimeKey(identity),
    identity,
    source: 'conservative',
    createdAt: now.toISOString(),
    structuredSchema: 'unknown',
    nativeTools: 'unknown',
    postToolContinuation: 'unknown',
    reasoning: { supported: 'unknown', canDisable: 'unknown' },
    emptyCompletion: 'unknown',
    cancellation: 'unknown',
    promptOnlyContract: 'unknown',
    schemaEnforcementHelps: 'unknown',
    providerHealth: { timeouts: 0, stalls: 0, emptyCompletions: 0, recovered: 0 },
    evidence: ['no observation yet: conservative profile'],
  };
}

/** How long a probed profile is trusted before it is probed again. */
export const PROFILE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
/**
 * How long a PARTIAL profile (probe cut short, or the runtime stopped answering) is used as it stands before the
 * probe is allowed to resume. Short on purpose: a profile that learned nothing must not stand in for 14 days.
 */
export const PARTIAL_PROFILE_TTL_MS = 10 * 60 * 1000;

/** The freshness window that applies to this profile. */
export function profileTtlMs(profile: RuntimeCapabilityProfile): number {
  return profile.complete === false ? PARTIAL_PROFILE_TTL_MS : PROFILE_TTL_MS;
}

interface StoreFile {
  schemaVersion: 1;
  profiles: Record<string, RuntimeCapabilityProfile>;
}

/**
 * Restart-safe cache of profiles: one small JSON file, written atomically (temp file + rename) so a crash never
 * leaves a half-written store. A corrupt or unreadable store is treated as empty, never as an error: the profile
 * is a cache of observations, and losing it costs one bounded re-probe.
 */
export class RuntimeProfileStore {
  private cache: Map<string, RuntimeCapabilityProfile> | undefined;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string | undefined,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private async load(): Promise<Map<string, RuntimeCapabilityProfile>> {
    if (this.cache) return this.cache;
    const map = new Map<string, RuntimeCapabilityProfile>();
    if (this.filePath) {
      try {
        const parsed = JSON.parse(await fs.readFile(this.filePath, 'utf8')) as Partial<StoreFile>;
        if (parsed.schemaVersion === 1 && parsed.profiles && typeof parsed.profiles === 'object') {
          for (const [key, profile] of Object.entries(parsed.profiles)) {
            if (profile?.schemaVersion === 1 && profile.key === key) map.set(key, profile);
          }
        }
      } catch {
        // missing or corrupt: start empty
      }
    }
    this.cache = map;
    return map;
  }

  /** The stored profile for this identity, or undefined when absent or past its TTL. */
  async get(identity: RuntimeIdentity): Promise<RuntimeCapabilityProfile | undefined> {
    const profile = await this.getAny(identity);
    if (!profile) return undefined;
    if (profile.probedAt && this.now().getTime() - Date.parse(profile.probedAt) > profileTtlMs(profile)) return undefined;
    return profile;
  }

  /** The stored profile whatever its age: a stale partial profile is still the right base for a resumed probe. */
  async getAny(identity: RuntimeIdentity): Promise<RuntimeCapabilityProfile | undefined> {
    return (await this.load()).get(runtimeKey(identity));
  }

  async put(profile: RuntimeCapabilityProfile): Promise<void> {
    const map = await this.load();
    map.set(profile.key, profile);
    await this.flush(map);
  }

  /** Every stored profile (TTL ignored: callers that display, rather than trust, a profile want to see stale ones too). */
  async list(): Promise<RuntimeCapabilityProfile[]> {
    return [...(await this.load()).values()];
  }

  /** Forget the profile of exactly this runtime identity; other configurations of the same model are untouched. */
  async forget(identity: RuntimeIdentity): Promise<boolean> {
    const map = await this.load();
    const removed = map.delete(runtimeKey(identity));
    if (removed) await this.flush(map);
    return removed;
  }

  /** Forget everything learned about a model, across every runtime it was seen on. */
  async invalidateModel(model: string): Promise<number> {
    const map = await this.load();
    let removed = 0;
    for (const [key, profile] of [...map]) {
      if (profile.identity.model === model) { map.delete(key); removed++; }
    }
    if (removed > 0) await this.flush(map);
    return removed;
  }

  private flush(map: Map<string, RuntimeCapabilityProfile>): Promise<void> {
    const filePath = this.filePath;
    if (!filePath) return Promise.resolve();
    const body: StoreFile = { schemaVersion: 1, profiles: Object.fromEntries(map) };
    this.writeChain = this.writeChain.then(async () => {
      try {
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        const temp = `${filePath}.${process.pid}.tmp`;
        await fs.writeFile(temp, JSON.stringify(body), 'utf8');
        await fs.rename(temp, filePath);
      } catch {
        // A cache that cannot be written is still a working in-memory cache.
      }
    });
    return this.writeChain;
  }
}
