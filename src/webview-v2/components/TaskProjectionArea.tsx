import React from 'react';
import type { ApprovalProjection, TaskProjection } from '../state/types';
import { TaskCard } from './TaskCard';
import { ApprovalCard, type ApprovalCardHandlers } from './ApprovalCard';
import { ActivityTimeline } from './ActivityTimeline';
import { ValidationSummary } from './ValidationSummary';
import { DeliverySummary } from './DeliverySummary';

export interface TaskProjectionAreaProps {
  task: TaskProjection | undefined;
  approvals: ApprovalProjection[];
  handlers: ApprovalCardHandlers;
}

/** Phase 3: real task/approval/activity/validation/delivery projection,
 * driven exclusively by autonomousTaskStarted/autonomousTaskStatus and the
 * proposal/mutation/delivery approval events. Renders nothing when there is
 * no active/most-recent task. */
export function TaskProjectionArea({ task, approvals, handlers }: TaskProjectionAreaProps) {
  if (!task) return null;
  const taskApprovals = approvals.filter((a) => a.taskId === task.taskId);

  return (
    <div className="kd2-task-projection" data-testid="task-projection-area">
      <TaskCard task={task} />
      {taskApprovals.map((approval) => (
        <ApprovalCard
          key={`${approval.kind}_${approval.proposalId ?? approval.requestId ?? approval.taskId}`}
          approval={approval}
          handlers={handlers}
        />
      ))}
      <ValidationSummary task={task} />
      <DeliverySummary task={task} />
      <ActivityTimeline events={task.activity} />
    </div>
  );
}
