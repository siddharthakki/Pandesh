/**
 * Host-neutral system readiness verdict.
 *
 * Readiness answers "can KarkeDikha do useful work right now?" — not "is Ollama running?". A machine whose local
 * provider is down but which has a usable connected free cloud provider is READY — CLOUD, never NOT READY.
 */
export type SystemReadiness = 'READY' | 'READY_CLOUD' | 'LIMITED' | 'NEEDS_ATTENTION';

export interface ReadinessInputs {
  /** The Core runtime process every mode needs. */
  core: 'connected' | 'starting' | 'unavailable';
  /** Local provider reachable AND at least one local model can serve some mode. */
  localUsable: boolean;
  localReachable: boolean;
  /** Connected + enabled cloud providers (credentials present). */
  cloudConnected: number;
  /** Of those, how many are not currently quota-exhausted. */
  cloudAvailable: number;
  /** "Use free cloud when needed": Auto may fall back to the pool. */
  useFreeCloud: boolean;
}

export interface ReadinessVerdict {
  state: SystemReadiness;
  /** Short badge text. */
  badge: string;
  /** One-line summary under the title. */
  subline: string;
  /** Longer message for the Compute section, when something needs explaining. */
  message?: string;
  /** Machine-readable reasons for tests and diagnostics. */
  reasons: string[];
}

export function computeSystemReadiness(input: ReadinessInputs): ReadinessVerdict {
  const reasons: string[] = [];
  const cloudNote = input.cloudConnected > 0
    ? `Free cloud available (${input.cloudAvailable} of ${input.cloudConnected})`
    : 'No cloud connected';

  if (input.core === 'unavailable') {
    return { state: 'NEEDS_ATTENTION', badge: 'NEEDS ATTENTION', subline: 'KarkeDikha Core runtime is not running', message: 'The Core runtime is required for every mode. Re-check setup or restart the window.', reasons: ['core_unavailable'] };
  }
  if (input.core === 'starting') {
    return { state: 'LIMITED', badge: 'STARTING', subline: 'Core runtime is starting', reasons: ['core_starting'] };
  }

  if (input.localUsable) {
    if (input.cloudConnected > 0 && input.cloudAvailable === 0) reasons.push('cloud_exhausted');
    return {
      state: 'READY',
      badge: 'READY',
      subline: input.cloudConnected > 0 ? `Local-first • ${cloudNote}` : 'Local-first • No cloud connected',
      reasons: ['local_usable', ...reasons],
    };
  }

  // Local cannot serve.
  if (input.cloudAvailable > 0 && input.useFreeCloud) {
    return {
      state: 'READY_CLOUD',
      badge: 'READY — CLOUD',
      subline: `Local unavailable • ${cloudNote}`,
      message: 'Local inference is unavailable. KarkeDikha can continue using connected free cloud providers.',
      reasons: ['local_unavailable', 'cloud_pool_usable'],
    };
  }
  if (input.cloudAvailable > 0 && !input.useFreeCloud) {
    return {
      state: 'LIMITED',
      badge: 'LIMITED',
      subline: 'Local unavailable • Cloud connected but not enabled for Auto',
      message: 'Local inference is unavailable. Cloud providers are connected, but "Use free cloud when needed" is off. Pick a cloud model manually or turn it on.',
      reasons: ['local_unavailable', 'cloud_not_enabled'],
    };
  }
  if (input.cloudConnected > 0) {
    return {
      state: 'LIMITED',
      badge: 'LIMITED',
      subline: 'Local unavailable • Free quota exhausted',
      message: 'Every connected free provider has used its quota. Tasks cannot continue without enabling another provider or allowing paid cloud; KarkeDikha will not charge silently.',
      reasons: ['local_unavailable', 'cloud_exhausted'],
    };
  }
  return {
    state: 'NEEDS_ATTENTION',
    badge: 'NEEDS ATTENTION',
    subline: input.localReachable ? 'No usable model' : 'No usable model provider',
    message: input.localReachable
      ? 'The local provider is running but has no model that can serve KarkeDikha. Install a model or connect free cloud.'
      : 'No usable model provider is currently available.',
    reasons: ['no_provider'],
  };
}
