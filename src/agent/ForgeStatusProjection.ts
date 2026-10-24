import {
  AgentPhase,
  AgentTaskSnapshot,
  ForgeInvocationAuditMetadata,
  ForgeInvocationStatus,
  ForgeInvocationStatusPhase,
} from './AgentEngineTypes';

export interface ForgeStatusProjectionOptions {
  invocationId: string;
  audit?: ForgeInvocationAuditMetadata;
}

function phaseToForgePhase(snapshot: AgentTaskSnapshot): ForgeInvocationStatusPhase {
  switch (snapshot.phase) {
    case 'created':
    case 'understanding':
    case 'planning':
    case 'ready':
      return 'accepted';
    case 'waiting_for_approval':
      return 'approval_required';
    case 'blocked':
    case 'paused':
      return 'blocked';
    case 'failed':
      return 'failed';
    case 'completed':
      return 'delivered';
    case 'cancelled':
      return 'cancelled';
    case 'validating':
      return snapshot.validationPassed ? 'verified' : 'running';
    case 'executing':
    case 'repairing':
    case 'recovering':
      return 'running';
    default: {
      const exhaustive: never = snapshot.phase;
      return exhaustive;
    }
  }
}

function errorSummaryForSnapshot(snapshot: AgentTaskSnapshot): string | undefined {
  if (snapshot.task.failure?.message) {
    return snapshot.task.failure.message;
  }
  if (snapshot.phase === 'blocked') {
    return snapshot.blockedReason ?? snapshot.task.blockedReason;
  }
  if (snapshot.phase === 'paused') {
    return snapshot.blockedReason ?? snapshot.task.blockedReason ?? 'Task is paused.';
  }
  return undefined;
}

function cancellationReasonForSnapshot(snapshot: AgentTaskSnapshot): string | undefined {
  if (snapshot.phase !== 'cancelled') {
    return undefined;
  }
  return snapshot.blockedReason ?? snapshot.task.blockedReason;
}

export function projectAgentSnapshotToForgeStatus(
  snapshot: AgentTaskSnapshot,
  options: ForgeStatusProjectionOptions,
): ForgeInvocationStatus {
  return {
    invocationId: options.invocationId,
    taskId: snapshot.task.taskId,
    phase: phaseToForgePhase(snapshot),
    createdAt: snapshot.task.createdAt,
    updatedAt: snapshot.task.updatedAt,
    cancellationReason: cancellationReasonForSnapshot(snapshot),
    errorSummary: errorSummaryForSnapshot(snapshot),
    audit: options.audit,
  };
}
