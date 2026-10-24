import type { StageOutcome } from '../autonomous/recovery/RecoveryTypes';

/**
 * Adaptive contract enforcement.
 *
 * A model can fail a task in two different ways that must never be confused:
 *
 *   protocol failure   the reply could not be used as the contract requires (not JSON, wrong keys, wrong
 *                      types, a missing version). It says nothing about whether the model's idea was right.
 *   reasoning failure  the reply was a well-formed proposal, and it was wrong (validation, semantics).
 *
 * This module is the pure half of the mechanism: it names the protocol failure kind, decides nothing about
 * recovery (the RecoveryController does), and, after the fact, says which of the two a task actually was.
 * Switching the response contract from "asked for in the prompt" to "enforced by the provider" changes only the
 * envelope: the objective, the canonical proposal schema and its host validation are the same in both modes.
 */

export type ContractFailureKind = 'syntax' | 'schema' | 'type' | 'key';

/** How the response contract is held: only requested in the prompt, or enforced by the provider's decoder. */
export type ContractMode = 'prompt_only' | 'provider_schema';

const SYNTAX_CODES = new Set(['response_not_json', 'json_parse_failed', 'empty_content', 'response_too_large', 'invalid_action']);
const KEY_CODES = new Set([
  'version_unsupported',
  'task_summary_required',
  'operations_required',
  'operations_empty',
  'path_required',
  'operation_reason_required',
]);
const TYPE_CODES = new Set([
  'operation_malformed',
  'operation_unsupported',
  'validation_command_malformed',
]);
const SCHEMA_CODES = new Set([
  'operation_placeholder_content_rejected',
  'delete_intent_mismatch',
  'content_prohibited_for_delete',
]);

/** Kind of a protocol failure from the classifier's subcode and detail codes, in order of specificity. */
export function classifyContractFailure(subcode: string | undefined, details: readonly string[] = []): ContractFailureKind {
  const codes = [subcode ?? '', ...details.map(item => item.split(/[\s:(]/)[0] ?? '')];
  if (codes.some(code => SYNTAX_CODES.has(code))) return 'syntax';
  if (codes.some(code => KEY_CODES.has(code))) return 'key';
  if (codes.some(code => TYPE_CODES.has(code))) return 'type';
  if (codes.some(code => SCHEMA_CODES.has(code))) return 'schema';
  return 'schema';
}

/** A protocol failure is, by classification, a `format_failure`: nothing else is ever treated as one. */
export function isProtocolFailure(outcome: Pick<StageOutcome, 'ok' | 'cause'>): boolean {
  return !outcome.ok && outcome.cause === 'format_failure';
}

/**
 * OLLAMA_AGENT_ADAPTIVE_SCHEMA=0 (or the older OLLAMA_AGENT_M46_CONSTRAINED=0) keeps the contract prompt-only for
 * the whole task. Default on. It is an ablation and kill switch, not a per-model setting.
 */
export function adaptiveSchemaEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OLLAMA_AGENT_ADAPTIVE_SCHEMA !== '0' && env.OLLAMA_AGENT_M46_CONSTRAINED !== '0';
}

/** Durable record of one contract mode change and why (journal record `contract_mode`). */
export interface ContractModeRecord {
  attemptId: string;
  pass: number;
  /** enforced: provider schema switched on; kept: it cleared the protocol failure; released: it did not, so it is off again. */
  change: 'enforced' | 'kept' | 'released';
  from: ContractMode;
  to: ContractMode;
  model?: string;
  trigger: { kind: ContractFailureKind; subcode?: string; codes: string[] };
  reason: string;
}

export type ProtocolVerdict =
  /** No protocol failure occurred: nothing to distinguish. */
  | 'NO_PROTOCOL_FAILURE'
  /** A protocol failure, then the same model's well-formed proposal fixed the task: only the envelope was wrong. */
  | 'MODEL_KNEW_ANSWER_BUT_FAILED_PROTOCOL'
  /** A protocol failure, then a well-formed proposal that was wrong: the reasoning failed, not just the envelope. */
  | 'MODEL_PROPOSAL_INCORRECT'
  /** Protocol failures only: the model never produced a usable proposal, so its reasoning was never observed. */
  | 'PROTOCOL_ONLY_UNOBSERVED';

export interface ProtocolAssessment {
  verdict: ProtocolVerdict;
  protocolFailures: number;
  kinds: ContractFailureKind[];
  /** Well-formed proposals seen after the first protocol failure, and how many of them were wrong. */
  wellFormedAfter: number;
  incorrectAfter: number;
}

const REASONING_CAUSES: ReadonlySet<string> = new Set(['validation_failure', 'semantic_failure', 'grounding_failure']);

/**
 * Post-hoc verdict from the journaled outcomes, oldest first. Deterministic and derived only from what the
 * runtime observed, so a restart or a report reaches the same answer. Failures of another kind (provider
 * stalls, environment, policy) are neither: they say nothing about the model's answer and are ignored.
 */
export function assessProtocolOutcome(outcomes: readonly StageOutcome[]): ProtocolAssessment {
  const first = outcomes.findIndex(isProtocolFailure);
  const protocol = outcomes.filter(isProtocolFailure);
  const kinds = [...new Set(protocol.map(outcome => classifyContractFailure(outcome.subcode, outcome.details)))];
  if (first < 0) return { verdict: 'NO_PROTOCOL_FAILURE', protocolFailures: 0, kinds: [], wellFormedAfter: 0, incorrectAfter: 0 };
  const after = outcomes.slice(first + 1);
  const succeeded = after.some(outcome => outcome.ok);
  const incorrect = after.filter(outcome => !outcome.ok && outcome.cause !== undefined && REASONING_CAUSES.has(outcome.cause));
  const wellFormedAfter = after.filter(outcome => outcome.ok || (outcome.cause !== undefined && REASONING_CAUSES.has(outcome.cause))).length;
  const verdict: ProtocolVerdict = succeeded
    ? 'MODEL_KNEW_ANSWER_BUT_FAILED_PROTOCOL'
    : incorrect.length > 0 ? 'MODEL_PROPOSAL_INCORRECT' : 'PROTOCOL_ONLY_UNOBSERVED';
  return { verdict, protocolFailures: protocol.length, kinds, wellFormedAfter, incorrectAfter: incorrect.length };
}
