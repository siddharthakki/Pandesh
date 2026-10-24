import { describe, expect, it } from 'vitest';
import { evaluateOnboardingReadiness } from '../../onboarding/OnboardingReadiness';
import { ModelCapabilityRegistry } from '../../models/ModelCapabilityRegistry';
import { TaskModelCandidate } from '../../models/TaskModelSelection';

/**
 * Pure onboarding/readiness logic, exercised through the same production
 * capability/selection contract (`ModelCapabilityRegistry` + `TaskModelSelection`)
 * a live Baat/Saath/Karke turn uses — no fabricated capability table.
 */

const ANY_USABLE_ROLE = ['agent', 'chat', 'edit', 'reviewer'] as const;

const CORE_CONNECTED = { connected: true, state: 'connected' as const, summary: 'KarkeDikha Core is connected.' };
const CORE_STARTING = { connected: false, state: 'starting' as const, summary: 'KarkeDikha Core is starting.' };
const CORE_AUTH_FAILED = {
  connected: false,
  state: 'authentication_failed' as const,
  summary: 'KarkeDikha Core is running under a different session\'s credentials.',
};

function candidate(model: string, overrides: Partial<TaskModelCandidate> = {}): TaskModelCandidate {
  const registry = ModelCapabilityRegistry.getInstance();
  return {
    provider: 'ollama',
    model,
    available: true,
    capabilities: registry.getCapabilities(model, 'ollama'),
    configuredRoles: [...ANY_USABLE_ROLE],
    reliability: registry.getObservedReliability(model),
    ...overrides,
  };
}

describe('evaluateOnboardingReadiness', () => {
  it('A. reports READY when a live-proven coding worker is installed', () => {
    const candidates = [candidate('qwen3.8:27b-mtp-q4_k_m')];
    const result = evaluateOnboardingReadiness({
      providerType: 'ollama',
      provider: { providerType: 'ollama', label: 'Ollama', reachable: true, detail: 'Ollama is running and reachable.' },
      coreRuntime: CORE_CONNECTED,
      candidates,
      cloudFallback: { policy: 'local-only', configured: false, summary: 'Off.' },
    });

    expect(result.overall).toBe('ready');
    expect(result.provider.reachable).toBe(true);
    expect(result.recommendedKarkeModel).toBe('qwen3.8:27b-mtp-q4_k_m');
    expect(result.modes.every(m => m.ready)).toBe(true);
    expect(result.cloudFallback.policy).toBe('local-only');
    expect(result.pullCommandSuggestion).toBeUndefined();
  });

  it('B. reports NOT READY for every mode when Ollama is unreachable, with no fake recommendation', () => {
    const result = evaluateOnboardingReadiness({
      providerType: 'ollama',
      provider: { providerType: 'ollama', label: 'Ollama', reachable: false, detail: 'Ollama could not be reached.', nextAction: 'Start Ollama and verify ollama-agent.apiBase.' },
      coreRuntime: CORE_CONNECTED,
      candidates: [],
      cloudFallback: { policy: 'local-only', configured: false, summary: 'Off.' },
    });

    expect(result.overall).toBe('not_ready');
    expect(result.recommendedKarkeModel).toBeUndefined();
    expect(result.modes.every(m => !m.ready)).toBe(true);
    for (const mode of result.modes) {
      expect(mode.reason).toContain('Ollama');
    }
  });

  it('C. NOT READY with a useful recommendation when only an unsuitable model is installed', () => {
    // A small, tools-capable chat model: usable for Baat, but well below
    // Karke's reliability/complexity bar (see TaskModelSelection.requiredReliability).
    const candidates = [candidate('qwen2.5-coder:1.5b')];
    const result = evaluateOnboardingReadiness({
      providerType: 'ollama',
      provider: { providerType: 'ollama', label: 'Ollama', reachable: true, detail: 'Ollama is running and reachable.' },
      coreRuntime: CORE_CONNECTED,
      candidates,
      cloudFallback: { policy: 'local-only', configured: false, summary: 'Off.' },
      pullCommandSuggestion: 'ollama pull qwen3-coder:30b',
    });

    const baat = result.modes.find(m => m.mode === 'baat_kar')!;
    const karke = result.modes.find(m => m.mode === 'karke_dikha')!;
    expect(baat.ready).toBe(false); // qwen2.5-coder:1.5b is autocomplete-only per the registry.
    expect(karke.ready).toBe(false);
    expect(result.overall).toBe('not_ready');
    expect(karke.reason).toMatch(/Karke Dikha|installed models/i);
    expect(result.pullCommandSuggestion).toBe('ollama pull qwen3-coder:30b');
  });

  it('D. Baat is fully ready while Karke is ready-but-unproven, when capability differences make that truthful (UNKNOWN != INCOMPATIBLE)', () => {
    // A generic chat model (heuristic-classified: chat + tools, no coding
    // specialization, low parameter count) — comfortably enough for Baat,
    // and technically viable (no hard capability gap) but below Karke's
    // preferred reliability bar. It is the only configured candidate, so
    // automatic selection uses it as the best available fallback rather than
    // reporting Karke as unusable outright.
    const candidates = [candidate('llama3.1:8b')];
    const result = evaluateOnboardingReadiness({
      providerType: 'ollama',
      provider: { providerType: 'ollama', label: 'Ollama', reachable: true, detail: 'Ollama is running and reachable.' },
      coreRuntime: CORE_CONNECTED,
      candidates,
      cloudFallback: { policy: 'local-only', configured: false, summary: 'Off.' },
    });

    const baat = result.modes.find(m => m.mode === 'baat_kar')!;
    const karke = result.modes.find(m => m.mode === 'karke_dikha')!;
    expect(baat.ready).toBe(true);
    expect(baat.belowPreferredConfidence).toBeFalsy();
    expect(karke.ready).toBe(true);
    expect(karke.model).toBe('llama3.1:8b');
    expect(karke.belowPreferredConfidence).toBe(true);
    expect(karke.reason).toMatch(/below the preferred threshold/);
    expect(result.overall).toBe('ready');
    // Selected, not rejected: it must never appear as "unsuitable" while it
    // is simultaneously the model Karke would actually use.
    expect(result.unsuitableModelNames).not.toContain('llama3.1:8b');
  });

  it('E. cloud fallback off is reported plainly and never marked configured', () => {
    const result = evaluateOnboardingReadiness({
      providerType: 'ollama',
      provider: { providerType: 'ollama', label: 'Ollama', reachable: true, detail: 'Ollama is running and reachable.' },
      coreRuntime: CORE_CONNECTED,
      candidates: [candidate('qwen3.8:27b-mtp-q4_k_m')],
      cloudFallback: { policy: 'local-only', configured: false, summary: 'Off. Repository and task content stays on this machine.' },
    });

    expect(result.cloudFallback.configured).toBe(false);
    expect(result.cloudFallback.policy).toBe('local-only');
    expect(result.cloudFallback.summary).toMatch(/stays on this machine/i);
  });

  it('F. cloud fallback requested-but-incomplete never reports configured', () => {
    const result = evaluateOnboardingReadiness({
      providerType: 'ollama',
      provider: { providerType: 'ollama', label: 'Ollama', reachable: true, detail: 'Ollama is running and reachable.' },
      coreRuntime: CORE_CONNECTED,
      candidates: [candidate('qwen3.8:27b-mtp-q4_k_m')],
      cloudFallback: {
        policy: 'local-first-cloud-fallback',
        configured: false,
        reason: 'credential_missing',
        summary: 'Requested, but no API key is stored. Local-only until configured.',
      },
    });

    expect(result.cloudFallback.configured).toBe(false);
    expect(result.cloudFallback.reason).toBe('credential_missing');
  });

  it('G. cloud fallback fully configured is reported as configured, without ever carrying the secret value', () => {
    const result = evaluateOnboardingReadiness({
      providerType: 'ollama',
      provider: { providerType: 'ollama', label: 'Ollama', reachable: true, detail: 'Ollama is running and reachable.' },
      coreRuntime: CORE_CONNECTED,
      candidates: [candidate('qwen3.8:27b-mtp-q4_k_m')],
      cloudFallback: {
        policy: 'local-first-cloud-fallback',
        configured: true,
        summary: 'On — gpt-4o-mini via https://cloud.example.invalid/v1. Used only after a recoverable local failure.',
      },
    });

    expect(result.cloudFallback.configured).toBe(true);
    expect(JSON.stringify(result.cloudFallback)).not.toMatch(/sk-|api[-_]?key/i);
  });

  it('I. a perfect local model is not enough on its own — Core disconnected blocks every mode, truthfully naming Core, not the model', () => {
    const candidates = [candidate('qwen3.8:27b-mtp-q4_k_m')];
    const result = evaluateOnboardingReadiness({
      providerType: 'ollama',
      provider: { providerType: 'ollama', label: 'Ollama', reachable: true, detail: 'Ollama is running and reachable.' },
      coreRuntime: CORE_AUTH_FAILED,
      candidates,
      cloudFallback: { policy: 'local-only', configured: false, summary: 'Off.' },
    });

    expect(result.overall).not.toBe('ready');
    expect(result.modes.every(m => !m.ready)).toBe(true);
    for (const mode of result.modes) {
      expect(mode.reason).toMatch(/Core/);
    }
    // The model recommendation itself stays truthful about the model layer —
    // it's Core, not the model, that's blocking.
    expect(result.recommendedKarkeModel).toBe('qwen3.8:27b-mtp-q4_k_m');
  });

  it('J. Core "starting" is reported as transient, not a permanent failure', () => {
    const candidates = [candidate('qwen3.8:27b-mtp-q4_k_m')];
    const result = evaluateOnboardingReadiness({
      providerType: 'ollama',
      provider: { providerType: 'ollama', label: 'Ollama', reachable: true, detail: 'Ollama is running and reachable.' },
      coreRuntime: CORE_STARTING,
      candidates,
      cloudFallback: { policy: 'local-only', configured: false, summary: 'Off.' },
    });

    expect(result.coreRuntime.connected).toBe(false);
    expect(result.coreRuntime.state).toBe('starting');
    const baat = result.modes.find(m => m.mode === 'baat_kar')!;
    expect(baat.ready).toBe(false);
    expect(baat.reason).toMatch(/starting/i);
    expect(baat.reason).not.toMatch(/failed|error|unavailable/i);
  });

  it('K. once Core connects, mode readiness reflects it without any other input changing', () => {
    const candidates = [candidate('qwen3.8:27b-mtp-q4_k_m')];
    const base = {
      providerType: 'ollama' as const,
      provider: { providerType: 'ollama', label: 'Ollama', reachable: true, detail: 'Ollama is running and reachable.' },
      candidates,
      cloudFallback: { policy: 'local-only' as const, configured: false, summary: 'Off.' },
    };
    const beforeConnect = evaluateOnboardingReadiness({ ...base, coreRuntime: CORE_STARTING });
    const afterConnect = evaluateOnboardingReadiness({ ...base, coreRuntime: CORE_CONNECTED });

    expect(beforeConnect.overall).not.toBe('ready');
    expect(afterConnect.overall).toBe('ready');
  });
});
