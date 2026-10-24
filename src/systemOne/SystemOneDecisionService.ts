/**
 * System-One decision control plane — SHADOW MODE ONLY.
 *
 * Flow: KKD's deterministic routing decision is made first and is always the
 * effective one. When (and only when) the user has explicitly enabled this in
 * shadow mode, the same turn is also sent to a configured SystemOneProvider
 * (Ollaya by default); its advice is compared and appended to a
 * workspace-local telemetry file. Nothing here can alter routing, and every
 * failure (provider down, timeout, bad JSON, non-loopback endpoint, unknown
 * provider) is swallowed so KKD behaves exactly as if this module did not
 * exist.
 *
 * This service knows nothing vendor-specific — see OllayaProvider.ts for the
 * one file that talks to a concrete wire format.
 */
import * as fs from 'fs';
import * as path from 'path';
import { ACTIVE_DECISION_TYPES, DECISION_CONTRACTS, INTENT_TO_MODE } from './decisionContracts';
import { isLoopbackEndpoint } from './loopback';
import { OllayaProvider } from './OllayaProvider';
import type { SystemOneDecisionRequest, SystemOneDecisionResponse, SystemOneProvider, SystemOneSettings } from './types';

export type { SystemOneMode, SystemOneSettings } from './types';
export { isLoopbackEndpoint };

export type KkdMode = 'chat' | 'agent' | 'autonomous';

export interface ShadowObservation {
  text: string;
  deterministicMode: KkdMode;
  conversationId?: string;
  requestId?: string;
  previousAssistant?: string;
}

export interface ShadowAdvice {
  intent: string | null;
  mappedMode: KkdMode | null;
  followUp: string | null;
  confidence: number | null;
  latencyMs: number;
  provider: string;
  model: string | null;
}

export function shadowActive(settings: SystemOneSettings): boolean {
  return settings.enabled === true && settings.mode === 'shadow' && isLoopbackEndpoint(settings.endpoint);
}

function buildProvider(settings: SystemOneSettings, fetchImpl?: typeof fetch): SystemOneProvider {
  if (settings.provider === 'ollaya' || !settings.provider) {
    return new OllayaProvider(settings.endpoint, fetchImpl);
  }
  return {
    name: settings.provider,
    decide: async (request: SystemOneDecisionRequest): Promise<SystemOneDecisionResponse> => ({
      decisions: {},
      provider: settings.provider,
      model: request.model ?? null,
      latencyMs: 0,
      error: `unknown System-One provider: ${settings.provider}`,
    }),
  };
}

export class SystemOneDecisionService {
  constructor(
    private readonly getSettings: () => SystemOneSettings,
    private readonly telemetryPath: () => string | undefined,
    private readonly providerFactory: (settings: SystemOneSettings) => SystemOneProvider = buildProvider,
  ) {}

  /** Fire-and-forget: never rejects, never blocks or changes routing. */
  observe(observation: ShadowObservation): void {
    void this.observeAsync(observation).catch(() => undefined);
  }

  async observeAsync(observation: ShadowObservation): Promise<ShadowAdvice | undefined> {
    let settings: SystemOneSettings;
    try { settings = this.getSettings(); } catch { return undefined; }
    if (!shadowActive(settings)) return undefined;

    const provider = this.providerFactory(settings);
    const request: SystemOneDecisionRequest = {
      context: (observation.previousAssistant ? `Previous assistant message: ${observation.previousAssistant.slice(0, 1500)}\n` : '')
        + `Latest user message: ${observation.text.slice(0, 4000)}`,
      questions: Object.fromEntries(ACTIVE_DECISION_TYPES.map(type => [type, DECISION_CONTRACTS[type]])),
      model: settings.model,
      timeoutMs: settings.timeoutMs,
      correlation: { conversationId: observation.conversationId, requestId: observation.requestId },
    };

    const response: SystemOneDecisionResponse = await provider.decide(request).catch((error: unknown) => ({
      decisions: {},
      provider: provider.name,
      model: settings.model,
      latencyMs: 0,
      error: error instanceof Error ? error.message : String(error),
    }));

    const intent = response.decisions.intent?.value ?? null;
    const advice: ShadowAdvice = {
      intent,
      mappedMode: intent ? INTENT_TO_MODE[intent] ?? null : null,
      followUp: response.decisions.follow_up?.value ?? null,
      confidence: response.decisions.intent?.confidence ?? null,
      latencyMs: response.latencyMs,
      provider: response.provider,
      model: response.model,
    };

    this.record(observation, advice, response.error);
    return response.error ? undefined : advice;
  }

  private record(observation: ShadowObservation, advice: ShadowAdvice, error: string | undefined): void {
    try {
      const file = this.telemetryPath();
      if (!file) return;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, `${JSON.stringify({
        at: new Date().toISOString(),
        conversationId: observation.conversationId ?? null,
        requestId: observation.requestId ?? null,
        textPreview: observation.text.slice(0, 160),
        effectiveDecision: observation.deterministicMode,
        effectiveSource: 'deterministic',
        systemOne: {
          provider: advice.provider,
          model: advice.model,
          intent: advice.intent,
          mappedMode: advice.mappedMode,
          followUp: advice.followUp,
          confidence: advice.confidence,
        },
        agrees: error ? null : advice.mappedMode === observation.deterministicMode,
        latencyMs: advice.latencyMs,
        error: error ?? null,
      })}\n`, 'utf8');
    } catch {
      /* telemetry is best-effort */
    }
  }
}
