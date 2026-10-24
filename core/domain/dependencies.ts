import type { CoreDatabase } from '../db/connection';
import type { DependencyType, StoryDependencyRecord } from '../shared/wireTypes';
import { CoreError } from './errors';
import { newId, nowIso } from './ids';
import { recordStoryEvent } from './events';

/** Dependency types whose graph must stay acyclic (in the given direction). `related` is symmetric/non-hierarchical and exempt. */
const ACYCLIC_TYPES: DependencyType[] = ['blocks', 'blocked_by', 'parent_child'];

function wouldCreateCycle(db: CoreDatabase, dependencyType: DependencyType, storyId: string, dependsOnStoryId: string): boolean {
  // BFS from dependsOnStoryId following the same dependencyType edges; if we reach storyId, adding
  // storyId -> dependsOnStoryId would close a cycle.
  const visited = new Set<string>();
  const queue = [dependsOnStoryId];
  while (queue.length) {
    const current = queue.shift()!;
    if (current === storyId) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    const next = db.all<{ dependsOnStoryId: string }>(
      'SELECT dependsOnStoryId FROM story_dependencies WHERE storyId = ? AND dependencyType = ?',
      [current, dependencyType],
    );
    for (const row of next) queue.push(row.dependsOnStoryId);
  }
  return false;
}

export function addDependency(
  db: CoreDatabase,
  input: {
    storyId: string;
    dependsOnStoryId: string;
    dependencyType: DependencyType;
    actor: string;
    clientId?: string | null;
    idempotencyKey?: string | null;
  },
): StoryDependencyRecord {
  if (input.storyId === input.dependsOnStoryId) {
    throw new CoreError('dependency_violation', 'a story cannot depend on itself');
  }
  return db.transaction(() => {
    const story = db.get('SELECT id, archivedAt FROM stories WHERE id = ?', [input.storyId]) as
      | { id: string; archivedAt: string | null }
      | undefined;
    if (!story) throw new CoreError('invalid_request', `story '${input.storyId}' does not exist`);
    const target = db.get('SELECT id, archivedAt FROM stories WHERE id = ?', [input.dependsOnStoryId]) as
      | { id: string; archivedAt: string | null }
      | undefined;
    if (!target) throw new CoreError('invalid_request', `story '${input.dependsOnStoryId}' does not exist`);
    if (target.archivedAt) {
      throw new CoreError('dependency_violation', `story '${input.dependsOnStoryId}' is archived and cannot be depended on`);
    }

    const duplicate = db.get(
      'SELECT id FROM story_dependencies WHERE storyId = ? AND dependsOnStoryId = ? AND dependencyType = ?',
      [input.storyId, input.dependsOnStoryId, input.dependencyType],
    );
    if (duplicate) {
      throw new CoreError('conflict', 'this dependency already exists', {
        storyId: input.storyId,
        dependsOnStoryId: input.dependsOnStoryId,
        dependencyType: input.dependencyType,
      });
    }

    if (ACYCLIC_TYPES.includes(input.dependencyType) && wouldCreateCycle(db, input.dependencyType, input.storyId, input.dependsOnStoryId)) {
      throw new CoreError('dependency_violation', `adding this '${input.dependencyType}' dependency would create a cycle`);
    }

    const id = newId('dep');
    const createdAt = nowIso();
    db.run('INSERT INTO story_dependencies (id, storyId, dependsOnStoryId, dependencyType, createdAt) VALUES (?, ?, ?, ?, ?)', [
      id,
      input.storyId,
      input.dependsOnStoryId,
      input.dependencyType,
      createdAt,
    ]);
    recordStoryEvent(db, {
      storyId: input.storyId,
      eventType: 'dependency_added',
      actor: input.actor,
      clientId: input.clientId,
      idempotencyKey: input.idempotencyKey,
      metadata: { dependsOnStoryId: input.dependsOnStoryId, dependencyType: input.dependencyType },
    });
    return { id, storyId: input.storyId, dependsOnStoryId: input.dependsOnStoryId, dependencyType: input.dependencyType, createdAt };
  });
}

export function removeDependency(
  db: CoreDatabase,
  id: string,
  input: { actor: string; clientId?: string | null; idempotencyKey?: string | null },
): void {
  db.transaction(() => {
    const existing = db.get<Record<string, unknown>>('SELECT * FROM story_dependencies WHERE id = ?', [id]);
    if (!existing) throw new CoreError('not_found', `dependency '${id}' not found`);
    db.run('DELETE FROM story_dependencies WHERE id = ?', [id]);
    recordStoryEvent(db, {
      storyId: String(existing.storyId),
      eventType: 'dependency_removed',
      actor: input.actor,
      clientId: input.clientId,
      idempotencyKey: input.idempotencyKey,
      metadata: { dependsOnStoryId: existing.dependsOnStoryId, dependencyType: existing.dependencyType },
    });
  });
}

export function listDependencies(db: CoreDatabase, storyId: string): StoryDependencyRecord[] {
  return db.all<StoryDependencyRecord>(
    'SELECT id, storyId, dependsOnStoryId, dependencyType, createdAt FROM story_dependencies WHERE storyId = ? ORDER BY createdAt',
    [storyId],
  );
}
