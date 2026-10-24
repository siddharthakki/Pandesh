import type { StoryStatus } from '../shared/wireTypes';

/**
 * Lifecycle transition graph. `archived` is deliberately excluded: archiving
 * is its own operation (`POST /v1/stories/:id/archive`), not a transition,
 * so it can apply from any non-terminal-cancelled status and emits
 * `story_archived` rather than `story_transitioned`.
 */
const ALLOWED_TRANSITIONS: Record<StoryStatus, StoryStatus[]> = {
  inbox: ['discovery', 'ready', 'cancelled'],
  discovery: ['ready', 'blocked', 'cancelled'],
  ready: ['assigned', 'planning', 'blocked', 'cancelled', 'deferred'],
  assigned: ['planning', 'blocked', 'cancelled', 'deferred', 'ready'],
  planning: ['proposal_approval', 'blocked', 'cancelled', 'ready'],
  proposal_approval: ['implementing', 'blocked', 'cancelled', 'deferred', 'planning'],
  implementing: ['review', 'blocked', 'failed', 'cancelled'],
  review: ['validation', 'implementing', 'blocked', 'cancelled'],
  validation: ['delivery_approval', 'implementing', 'blocked', 'failed'],
  delivery_approval: ['merge_queue', 'blocked', 'cancelled', 'implementing'],
  merge_queue: ['done', 'blocked', 'failed'],
  done: [],
  blocked: ['ready', 'assigned', 'planning', 'implementing', 'review', 'validation', 'delivery_approval', 'cancelled'],
  failed: ['ready', 'planning', 'cancelled'],
  cancelled: [],
  deferred: ['ready', 'assigned', 'planning', 'cancelled'],
  archived: [],
};

export function validateTransition(from: StoryStatus, to: StoryStatus): { ok: true } | { ok: false; reason: string } {
  if (from === to) {
    return { ok: false, reason: `story is already in status '${from}'` };
  }
  if (to === 'archived') {
    return { ok: false, reason: `use the archive action, not transition, to reach 'archived'` };
  }
  const allowed = ALLOWED_TRANSITIONS[from] ?? [];
  if (!allowed.includes(to)) {
    return { ok: false, reason: `transition from '${from}' to '${to}' is not permitted` };
  }
  return { ok: true };
}

export function isArchivable(status: StoryStatus): boolean {
  return status !== 'archived';
}
