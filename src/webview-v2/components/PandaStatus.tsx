import React from 'react';
import type { TaskProjection } from '../state/types';

const PANDA_STATE_TO_FILE: Record<string, string> = {
  idle: 'mascot-idle.webp',
  thinking: 'action-thinking.webp',
  reading: 'action-repository.webp',
  searching: 'action-searching.webp',
  planning: 'action-thinking.webp',
  delegating: 'action-delegating.webp',
  coding: 'action-coding.webp',
  building: 'action-building.webp',
  testing: 'action-testing.webp',
  reviewing: 'action-reviewing.webp',
  waiting_for_delivery_approval: 'action-approval.webp',
  blocked: 'action-blocked.webp',
  failed: 'action-failed.webp',
  completed: 'mascot-success.webp',
  cancelled: 'mascot-done.webp',
};

const LIFECYCLE_FALLBACK: Record<string, string> = {
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

const LIFECYCLE_OVERRIDE_STATES = new Set([
  'waiting_for_approval',
  'waiting_for_proposal_approval',
  'waiting_for_mutation_approval',
  'waiting_for_delivery_approval',
  'cancelling',
  'blocked',
  'failed',
  'completed',
  'cancelled',
]);

export interface PandaPresentation {
  state: string;
  label: string;
  filename: string;
}

function visibleLabel(state: string): string {
  switch (state) {
    case 'thinking':
    case 'planning':
      return 'thinking';
    case 'reading':
    case 'searching':
      return 'reading';
    case 'delegating':
    case 'coding':
    case 'building':
    case 'testing':
    case 'reviewing':
      return 'working';
    case 'waiting_for_delivery_approval':
      return 'waiting';
    case 'completed':
      return 'success';
    case 'blocked':
      return 'blocked';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'stopped';
    default:
      return 'ready';
  }
}

export function resolvePandaPresentation(task: TaskProjection): PandaPresentation {
  const lifecyclePanda = task.pandaState || LIFECYCLE_FALLBACK[task.state] || 'idle';
  const latestEventPanda = [...task.activity]
    .reverse()
    .find(event => typeof event.pandaState === 'string' && event.pandaState)?.pandaState;
  const state = LIFECYCLE_OVERRIDE_STATES.has(task.state)
    ? lifecyclePanda
    : (latestEventPanda || lifecyclePanda);
  return {
    state,
    label: visibleLabel(state),
    filename: PANDA_STATE_TO_FILE[state] || PANDA_STATE_TO_FILE.idle,
  };
}

export function PandaStatus({ task }: { task: TaskProjection }) {
  const presentation = resolvePandaPresentation(task);
  const baseUri = document.body.dataset.pandaBaseUri?.replace(/\/+$/, '') ?? '';
  const src = baseUri ? `${baseUri}/${presentation.filename}` : presentation.filename;

  return (
    <div
      className="kd2-panda-status"
      data-testid="panda-state"
      data-panda-state={presentation.state}
      data-display-state={presentation.label}
      aria-label={`KarkeDikha ${presentation.label}`}
    >
      <img
        className="kd2-panda-status__image"
        data-testid="panda-state-image"
        src={src}
        alt=""
        aria-hidden="true"
      />
      <span className="kd2-panda-status__label" data-testid="panda-state-label">
        {presentation.label}
      </span>
    </div>
  );
}
