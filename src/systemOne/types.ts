/**
 * Provider-independent contracts for the System-One decision control plane.
 *
 * KKD talks to this normalized shape only. A concrete provider (Ollaya, a
 * future hosted Jev-compatible service, ...) adapts between this contract and
 * its own wire format. Nothing outside `src/systemOne` should know what
 * "Ollaya" or "Laya" is.
 */

export type SystemOneMode = 'off' | 'shadow';

export interface SystemOneSettings {
  enabled: boolean;
  mode: SystemOneMode;
  /** Provider implementation id, e.g. 'ollaya'. */
  provider: string;
  /** Loopback-only HTTP endpoint of the provider. */
  endpoint: string;
  /** Optional model id passed through to the provider, verbatim. */
  model: string | null;
  timeoutMs: number;
}

export interface SystemOneChoiceQuestion {
  type: 'choice';
  instructions: string;
  criteria: Record<string, string>;
}

export type SystemOneQuestion = SystemOneChoiceQuestion;

/** Named decision types KKD may ask about. Not all are wired to a live call yet. */
export type SystemOneDecisionType =
  | 'intent'
  | 'follow_up'
  | 'mutation_required'
  | 'scope_change'
  | 'new_objective';

export interface SystemOneDecisionRequest {
  /** Free-text state/context for the provider to reason over. */
  context: string;
  questions: Partial<Record<SystemOneDecisionType, SystemOneQuestion>>;
  /** Optional model id; falls back to the provider's own default when omitted. */
  model?: string | null;
  timeoutMs: number;
  correlation?: {
    conversationId?: string;
    requestId?: string;
  };
}

export interface SystemOneDecisionValue {
  value: string;
  confidence: number | null;
}

export interface SystemOneDecisionResponse {
  decisions: Partial<Record<SystemOneDecisionType, SystemOneDecisionValue>>;
  provider: string;
  model: string | null;
  latencyMs: number;
  /** Raw provider payload, kept only for diagnostics. */
  raw?: unknown;
  /** Set (and `decisions` left empty/partial) on any failure. Never throws. */
  error?: string;
}

export interface SystemOneHealth {
  ok: boolean;
  detail?: string;
}

/**
 * Control-plane abstraction the product depends on. KKD understands "a
 * System One decision provider", never a specific vendor's internals.
 */
export interface SystemOneProvider {
  readonly name: string;
  decide(request: SystemOneDecisionRequest): Promise<SystemOneDecisionResponse>;
  health?(): Promise<SystemOneHealth>;
}
