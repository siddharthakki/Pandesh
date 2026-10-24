import { PersistedApproval, PersistedSteeringMessage } from '../agent/TaskTypes';

export const MISSION_CHECKPOINT_SCHEMA_VERSION = 1 as const;

export interface MissionModelRoutingEntry {
  at: string;
  model: { provider: string; model: string; local: boolean };
  reason: string;
}

export interface MissionValidationState {
  passed?: boolean;
  lastAttempt?: number;
  lastCommands?: string[];
}

/**
 * Durable mission-level memory: everything a long-running mission needs to
 * remain coherent once its raw transcript is pruned or the process restarts,
 * and that a single task's `PersistedTask` does not already capture on its
 * own. Sourced from data the recovery/task layers already record —
 * `modelRoutingHistory` and `failedApproaches` are folded from
 * `AttemptJournal`'s decisions, `steeringHistory`/`approvals` reuse the
 * existing `PersistedSteeringMessage`/`PersistedApproval` shapes — this is
 * aggregation, not a new source of truth.
 */
export interface MissionCheckpoint {
  schemaVersion: typeof MISSION_CHECKPOINT_SCHEMA_VERSION;
  taskId: string;
  objective: string;
  constraints: string[];
  plan: string[];
  completedWork: string[];
  pendingWork: string[];
  touchedFiles: string[];
  validationState: MissionValidationState;
  failedApproaches: string[];
  steeringHistory: PersistedSteeringMessage[];
  approvals: PersistedApproval[];
  modelRoutingHistory: MissionModelRoutingEntry[];
  blockers: string[];
  lastMeaningfulProgressAt?: string;
  lastProgressFingerprint?: string;
  updatedAt: string;
}

export function emptyMissionCheckpoint(taskId: string, objective: string): MissionCheckpoint {
  return {
    schemaVersion: MISSION_CHECKPOINT_SCHEMA_VERSION,
    taskId,
    objective,
    constraints: [],
    plan: [],
    completedWork: [],
    pendingWork: [],
    touchedFiles: [],
    validationState: {},
    failedApproaches: [],
    steeringHistory: [],
    approvals: [],
    modelRoutingHistory: [],
    blockers: [],
    updatedAt: new Date().toISOString(),
  };
}

const MAX_LIST_ENTRIES = 200;

function boundedUnion(existing: readonly string[], additions: readonly string[]): string[] {
  const merged = [...new Set([...existing, ...additions])];
  return merged.length > MAX_LIST_ENTRIES ? merged.slice(merged.length - MAX_LIST_ENTRIES) : merged;
}

/**
 * Merges a partial update onto an existing checkpoint. List-valued fields
 * union (deduplicated, bounded) rather than replace, so a caller can append
 * one new blocker/constraint without having to resend the whole list.
 * `touchedFiles`, `steeringHistory`, `approvals`, and `modelRoutingHistory`
 * follow the same union rule.
 */
export function mergeMissionCheckpoint(
  base: MissionCheckpoint,
  update: Partial<Omit<MissionCheckpoint, 'schemaVersion' | 'taskId'>>,
): MissionCheckpoint {
  return {
    ...base,
    objective: update.objective ?? base.objective,
    constraints: update.constraints ? boundedUnion(base.constraints, update.constraints) : base.constraints,
    plan: update.plan ?? base.plan,
    completedWork: update.completedWork ? boundedUnion(base.completedWork, update.completedWork) : base.completedWork,
    pendingWork: update.pendingWork ?? base.pendingWork,
    touchedFiles: update.touchedFiles ? boundedUnion(base.touchedFiles, update.touchedFiles) : base.touchedFiles,
    validationState: update.validationState ?? base.validationState,
    failedApproaches: update.failedApproaches ? boundedUnion(base.failedApproaches, update.failedApproaches) : base.failedApproaches,
    steeringHistory: update.steeringHistory
      ? [...base.steeringHistory, ...update.steeringHistory].slice(-MAX_LIST_ENTRIES)
      : base.steeringHistory,
    approvals: update.approvals ? [...base.approvals, ...update.approvals].slice(-MAX_LIST_ENTRIES) : base.approvals,
    modelRoutingHistory: update.modelRoutingHistory
      ? [...base.modelRoutingHistory, ...update.modelRoutingHistory].slice(-MAX_LIST_ENTRIES)
      : base.modelRoutingHistory,
    blockers: update.blockers ?? base.blockers,
    lastMeaningfulProgressAt: update.lastMeaningfulProgressAt ?? base.lastMeaningfulProgressAt,
    lastProgressFingerprint: update.lastProgressFingerprint ?? base.lastProgressFingerprint,
    updatedAt: new Date().toISOString(),
  };
}
