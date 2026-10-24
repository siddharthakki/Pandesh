/**
 * Maps typed autonomous lifecycle/progress event kinds to the bounded set of
 * KarkeDikha panda mascot states and Kaam ka Dhaaga connector states. Pure and
 * derived only from existing typed data (AutonomousProgressEvent.kind,
 * AutonomousLifecycleState) — never from model prose.
 */

export type PandaState =
  | 'idle'
  | 'thinking'
  | 'reading'
  | 'searching'
  | 'planning'
  | 'delegating'
  | 'coding'
  | 'building'
  | 'testing'
  | 'reviewing'
  | 'waiting_for_delivery_approval'
  | 'blocked'
  | 'failed'
  | 'completed'
  | 'cancelled';

export type ConnectorState = 'queued' | 'active' | 'subagent' | 'waiting' | 'done' | 'blocked' | 'failed' | 'cancelled';

const KIND_TO_PANDA_STATE: Record<string, PandaState> = {
  preparing: 'thinking',
  approval_auto_approved: 'thinking',
  running: 'thinking',
  readiness_check: 'reading',
  graph_execution: 'planning',
  graph_stage_started: 'delegating',
  graph_stage_completed: 'delegating',
  graph_stage_failed: 'blocked',
  graph_stage_cancelled: 'blocked',
  graph_stage_timed_out: 'blocked',
  proposal_generated: 'coding',
  proposal_operation_count: 'coding',
  proposal_validation_failed: 'reviewing',
  proposal_regeneration_started: 'coding',
  proposal_regenerated: 'coding',
  proposal_validation_passed: 'reviewing',
  proposal_regeneration_failed: 'blocked',
  proposal_ready: 'reviewing',
  approval_requested: 'waiting_for_delivery_approval',
  approval_waiting: 'waiting_for_delivery_approval',
  approval_approved: 'coding',
  approval_rejected: 'blocked',
  approval_expired: 'blocked',
  mutating: 'coding',
  mutation_completed: 'building',
  validating: 'testing',
  validation_completed: 'testing',
  waiting_for_delivery_approval: 'waiting_for_delivery_approval',
  m16_gate_result: 'reviewing',
  blocked: 'blocked',
  cancelled: 'cancelled',
  runtime_error: 'failed',
  investigation_read_file: 'reading',
  investigation_search: 'searching',
  investigation_submit_proposal: 'coding',
  investigation_insufficient_context: 'thinking',
  investigation_no_change_claim: 'reviewing',
  investigation_invalid_action: 'thinking',
  investigation_recovery: 'thinking',
  investigation_cloud_recovery: 'thinking',
  investigation_cloud_skipped: 'thinking',
  investigation_transcript_compacted: 'thinking',
  investigation_stop: 'thinking',
  unknown: 'thinking',
};

/** Maps a parsed AutonomousProgressEvent.kind to a panda mascot state. */
export function pandaStateForEventKind(kind: string): PandaState {
  return KIND_TO_PANDA_STATE[kind] ?? 'thinking';
}

const LIFECYCLE_TO_PANDA_STATE: Record<string, PandaState> = {
  queued: 'idle',
  scheduled: 'idle',
  waiting_for_resources: 'idle',
  preparing: 'thinking',
  waiting_for_approval: 'waiting_for_delivery_approval',
  running: 'coding',
  waiting_for_proposal_approval: 'waiting_for_delivery_approval',
  waiting_for_mutation_approval: 'waiting_for_delivery_approval',
  paused: 'idle',
  cancelling: 'cancelled',
  validating: 'testing',
  waiting_for_delivery_approval: 'waiting_for_delivery_approval',
  committing: 'building',
  creating_pull_request: 'building',
  monitoring_ci: 'testing',
  waiting_for_review: 'reviewing',
  updating_pull_request: 'coding',
  blocked: 'blocked',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
};

/** Maps an AutonomousLifecycleState to a panda mascot state. */
export function pandaStateForLifecycleState(state: string): PandaState {
  return LIFECYCLE_TO_PANDA_STATE[state] ?? 'idle';
}

const LIFECYCLE_TO_CONNECTOR_STATE: Record<string, ConnectorState> = {
  queued: 'queued',
  scheduled: 'queued',
  waiting_for_resources: 'queued',
  preparing: 'active',
  waiting_for_approval: 'waiting',
  running: 'active',
  waiting_for_proposal_approval: 'waiting',
  waiting_for_mutation_approval: 'waiting',
  paused: 'queued',
  cancelling: 'blocked',
  validating: 'active',
  waiting_for_delivery_approval: 'waiting',
  committing: 'active',
  creating_pull_request: 'active',
  monitoring_ci: 'active',
  waiting_for_review: 'waiting',
  updating_pull_request: 'active',
  blocked: 'blocked',
  completed: 'done',
  failed: 'failed',
  cancelled: 'cancelled',
};

/** Maps an AutonomousLifecycleState to a Kaam ka Dhaaga connector visual state. */
export function connectorStateForLifecycleState(state: string): ConnectorState {
  return LIFECYCLE_TO_CONNECTOR_STATE[state] ?? 'queued';
}

const GRAPH_STAGE_KINDS = new Set(['graph_stage_started', 'graph_stage_completed', 'graph_stage_failed', 'graph_stage_cancelled', 'graph_stage_timed_out']);

/** True when a progress-event kind represents a bounded subagent-branch node. */
export function isSubagentEventKind(kind: string): boolean {
  return GRAPH_STAGE_KINDS.has(kind);
}
