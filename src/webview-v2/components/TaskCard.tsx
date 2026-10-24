import React from 'react';
import type { TaskProjection } from '../state/types';
import { PandaStatus } from './PandaStatus';

const TERMINAL_LABELS: Record<string, string> = {
  completed: 'Completed',
  failed: 'Failed',
  blocked: 'Blocked',
  cancelled: 'Cancelled',
};

/** Maps a real backend `state` string to a human label. Presentation only —
 * never used to decide behavior, only to render it. */
function stateLabel(state: string): string {
  return TERMINAL_LABELS[state] ?? state.replace(/_/g, ' ');
}

export function TaskCard({ task }: { task: TaskProjection }) {
  const terminal = task.state in TERMINAL_LABELS;
  return (
    <div className={`kd2-task-card kd2-task-card--${task.state}`} data-testid="task-card" data-task-id={task.taskId} data-task-state={task.state}>
      <div className="kd2-task-card__header">
        <PandaStatus task={task} />
        <div className="kd2-task-card__meta">
          <span className={`kd2-task-card__badge kd2-task-card__badge--${terminal ? task.state : 'active'}`} data-testid="task-card-state">
            {stateLabel(task.state)}
          </span>
          {task.autonomyMode ? <span className="kd2-task-card__autonomy">{task.autonomyMode}</span> : null}
        </div>
      </div>
      <div className="kd2-task-card__goal" data-testid="task-card-goal">{task.goal}</div>
      {task.provider || task.model ? (
        <div className="kd2-task-card__model">
          {task.provider ?? ''}{task.provider && task.model ? ' / ' : ''}{task.model ?? ''}
        </div>
      ) : null}
      {task.restartRestored ? (
        <div className="kd2-task-card__restart-note" role="note">Resumed after a restart</div>
      ) : null}
      {task.terminalSummary ? <div className="kd2-task-card__summary">{task.terminalSummary}</div> : null}
    </div>
  );
}
