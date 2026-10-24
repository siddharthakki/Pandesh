import React from 'react';
import { MODE_LABELS, type StatusState } from '../state/types';

function readyLabel(status: StatusState): string {
  if (status.running) return status.runningLabel ?? 'Working…';
  if (status.blocked) return 'Blocked';
  return 'Ready';
}

export function StatusBar({ status }: { status: StatusState }) {
  const parts = [MODE_LABELS[status.mode]];
  if (status.provider || status.model) {
    parts.push([status.provider, status.model].filter(Boolean).join('/'));
  }
  if (status.permission) parts.push(status.permission);
  parts.push(readyLabel(status));

  return (
    <div className="kd2-status-bar" role="status">
      {parts.map((p, i) => (
        <span key={i} className="kd2-status-bar__part">
          {i > 0 ? <span className="kd2-status-bar__sep">·</span> : null}
          {p}
        </span>
      ))}
    </div>
  );
}
