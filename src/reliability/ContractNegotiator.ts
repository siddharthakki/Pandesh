import type { ContractMode } from './ContractEnforcement';
import { adaptiveSchemaEnabled } from './ContractEnforcement';
import type { RuntimeCapabilityProfile } from '../runtimeProfile/RuntimeCapabilityProfile';

/**
 * ContractNegotiator: the one place that decides how KKD talks to a runtime.
 *
 * It generalises the M46 adaptive-schema mechanism; it does not replace it. M46's rule (start prompt-only, enforce
 * the provider schema after a protocol failure, revert if enforcement does not help) is still the reactive path in
 * the RecoveryController. What the negotiator adds is the *starting point* and the *memory*: it reads what is known
 * about the runtime (probe plus live outcomes) so a runtime that already showed it needs enforcement starts there,
 * and a capable one is left alone.
 *
 * Modes are limited to what the dispatch layer can execute reliably today. Further protocols (XML tool blocks,
 * Hermes-style calls) are deliberately not modelled: adding one means adding a member to `InteractionMode` and a
 * branch to `negotiateContract`, nothing else.
 */

export type InteractionMode =
  /** Provider defaults: nothing forced, native reasoning left to the model. */
  | 'native_default'
  /** Contract asked for in the prompt only (M46 starting mode). */
  | 'prompt_contract'
  /** Response schema enforced by the provider's decoder. */
  | 'provider_schema';

export type ReasoningSetting = 'default' | 'disabled';

/** What has been seen live for this runtime in the current task; all zero at the start. */
export interface ContractObservations {
  protocolFailures?: number;
  emptyCompletions?: number;
  /** Schema enforcement was tried and the reply was still unusable. */
  enforcementHarmful?: boolean;
}

export interface ContractDecision {
  interaction: InteractionMode;
  /** The M46 contract mode this maps onto, so the existing journal and recovery vocabulary is unchanged. */
  contractMode: ContractMode;
  reasoning: ReasoningSetting;
  /** What the decision rests on. `default` means nothing was known and nothing is forced. */
  basis: 'default' | 'profile' | 'live_observation';
  reason: string;
}

const DEFAULT_DECISION: ContractDecision = {
  interaction: 'native_default',
  contractMode: 'prompt_only',
  reasoning: 'default',
  basis: 'default',
  reason: 'no capability evidence against native behaviour: provider defaults, contract in the prompt',
};

export function negotiateContract(
  profile: RuntimeCapabilityProfile | undefined,
  observed: ContractObservations = {},
  env: NodeJS.ProcessEnv = process.env,
): ContractDecision {
  if (!profile || !adaptiveSchemaEnabled(env)) return DEFAULT_DECISION;

  const canEnforce = profile.structuredSchema === 'yes' || profile.schemaEnforcementHelps === 'yes';
  const emptyBefore = profile.emptyCompletion === 'observed' || profile.providerHealth.emptyCompletions > 0 || (observed.emptyCompletions ?? 0) > 0;
  const reasoningOff: ReasoningSetting = emptyBefore && profile.reasoning.canDisable !== 'no' ? 'disabled' : 'default';

  // Enforcement failed to help, here or in an earlier task on this runtime: never start there again.
  if (observed.enforcementHarmful || profile.schemaEnforcementHelps === 'no') {
    return {
      interaction: 'prompt_contract',
      contractMode: 'prompt_only',
      reasoning: reasoningOff,
      basis: observed.enforcementHarmful ? 'live_observation' : 'profile',
      reason: 'provider schema enforcement did not produce a usable reply on this runtime; the contract stays in the prompt',
    };
  }

  if (canEnforce && profile.schemaEnforcementHelps === 'yes') {
    return {
      interaction: 'provider_schema',
      contractMode: 'provider_schema',
      reasoning: reasoningOff === 'disabled' || profile.reasoning.canDisable === 'yes' ? 'disabled' : 'default',
      basis: 'profile',
      reason: 'earlier work on this runtime showed schema enforcement clears its protocol failures: starting enforced',
    };
  }

  if (canEnforce && (observed.protocolFailures ?? 0) > 0) {
    return {
      interaction: 'provider_schema',
      contractMode: 'provider_schema',
      reasoning: reasoningOff === 'disabled' || profile.reasoning.canDisable === 'yes' ? 'disabled' : 'default',
      basis: 'live_observation',
      reason: 'a protocol failure was observed and the runtime honours the response schema: enforcing it (objective and proposal unchanged)',
    };
  }

  // Even a trivial JSON contract was not followed by the prompt alone, but the runtime can be forced.
  if (profile.structuredSchema === 'yes' && profile.promptOnlyContract === 'no') {
    return {
      interaction: 'provider_schema',
      contractMode: 'provider_schema',
      reasoning: profile.reasoning.canDisable === 'yes' && emptyBefore ? 'disabled' : 'default',
      basis: 'profile',
      reason: 'the probe showed the JSON contract is not followed from the prompt alone while the runtime honours the schema: starting enforced',
    };
  }

  if (reasoningOff === 'disabled') {
    return {
      interaction: 'prompt_contract',
      contractMode: 'prompt_only',
      reasoning: 'disabled',
      basis: emptyBefore && (observed.emptyCompletions ?? 0) > 0 ? 'live_observation' : 'profile',
      reason: 'native reasoning consumed the output budget on this runtime and can be switched off: reasoning off, contract in the prompt',
    };
  }

  return profile.promptOnlyContract !== 'yes'
    ? DEFAULT_DECISION
    : { ...DEFAULT_DECISION, basis: 'profile', reason: 'the runtime follows the prompt contract and answers with reasoning on: nothing is constrained' };
}
