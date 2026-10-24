import { frozenContextWindowEvidence } from '../models/ContextWindowEvidence';
import { deriveExecutionEconomy, type EconomyReliability, type ExecutionEconomyProfile } from './ExecutionEconomyProfile';

/**
 * Binds the pure economy policy to the extension's model-window resolution.
 *
 * The window comes from `frozenContextWindowEvidence`, the same resolution chain dispatch uses
 * (explicit override, provider runtime, profile). When that chain had nothing but its built-in
 * fallback no window is reported and the profile stays conservative rather than guessing.
 */
export function economyForModel(
  model: { provider?: string; model?: string } | undefined,
  evidence: { parameterBillions?: number; reliability?: EconomyReliability; resourcePressure: boolean },
): ExecutionEconomyProfile {
  const window = model?.model
    ? frozenContextWindowEvidence({ model: model.model, providerType: model.provider })
    : {};
  return deriveExecutionEconomy({
    contextWindow: { contextTokens: window.contextWindowTokens, source: window.contextWindowSource, maxOutputTokens: window.maxOutputTokens },
    parameterBillions: evidence.parameterBillions,
    reliability: evidence.reliability,
    resourcePressure: evidence.resourcePressure,
  });
}
