import React from 'react';
import type { StatusState } from '../state/types';

export function ActivityPanel({ open, status }: { open: boolean; status: StatusState }) {
  if (!open) return null;
  const hasActivity = !!status.runningLabel || status.blocked || status.completed;
  return (
    <div id="kd2-activity-panel" className="kd2-drawer" role="region" aria-label="Activity">
      {!hasActivity ? (
        <div className="kd2-drawer__empty">No activity</div>
      ) : (
        <div className="kd2-drawer__item">
          {status.runningLabel ?? (status.blocked ? 'Blocked' : 'Completed')}
        </div>
      )}
    </div>
  );
}
