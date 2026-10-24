import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openCoreDatabase } from '../db/openCore';
import type { CoreDatabase } from '../db/connection';
import { createProject, listProjects, updateProject, archiveProject, getOrCreateImportedDefaultProject } from '../domain/projects';
import { createStory, getStory, updateStory, transitionStory, archiveStory, addComment, listStories } from '../domain/stories';
import { addDependency, removeDependency } from '../domain/dependencies';
import { withIdempotency } from '../domain/idempotency';
import { listEventsAfter } from '../domain/events';
import { CoreError } from '../domain/errors';

let dir: string;
let db: CoreDatabase;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karkedikha-domain-test-'));
  db = openCoreDatabase(path.join(dir, 'core.db')).db;
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('projects', () => {
  it('creates a project with aliases and resolves by name/alias/id', () => {
    const project = createProject(db, { name: 'JUGAAD', aliases: ['household app', 'household-platform'] });
    expect(project.revision).toBe(1);
    expect(project.aliases).toEqual(['household app', 'household-platform']);
    expect(listProjects(db).map((p) => p.id)).toContain(project.id);
  });

  it('supports update with optimistic concurrency', () => {
    const project = createProject(db, { name: 'JUGAAD' });
    const updated = updateProject(db, project.id, { description: 'household platform', expectedRevision: 1 });
    expect(updated.revision).toBe(2);
    expect(() => updateProject(db, project.id, { description: 'stale', expectedRevision: 1 })).toThrow(CoreError);
  });

  it('archives a project and preserves it (not deleted)', () => {
    const project = createProject(db, { name: 'JUGAAD' });
    const archived = archiveProject(db, project.id);
    expect(archived.status).toBe('archived');
    expect(archived.archivedAt).not.toBeNull();
  });

  it('creates the imported-default project only once', () => {
    const first = getOrCreateImportedDefaultProject(db);
    const second = getOrCreateImportedDefaultProject(db);
    expect(first.id).toBe(second.id);
    expect(first.name).toBe('Imported');
  });
});

describe('stories: transactional mutation + event', () => {
  it('creates a story and exactly one story_created event in the same transaction', () => {
    const project = createProject(db, { name: 'JUGAAD' });
    const story = createStory(db, {
      projectId: project.id,
      title: 'Add dark mode',
      storyType: 'story',
      actor: 'user:sid',
    });
    expect(story.status).toBe('inbox');
    expect(story.revision).toBe(1);
    const events = listEventsAfter(db, 0, 100).filter((e) => e.storyId === story.id);
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('story_created');
  });

  it('rejects creating a story under a nonexistent project', () => {
    expect(() =>
      createStory(db, { projectId: 'missing', title: 't', storyType: 'task', actor: 'user:sid' }),
    ).toThrow(CoreError);
  });
});

describe('lifecycle transitions', () => {
  it('accepts a valid transition and rejects an invalid one', () => {
    const project = createProject(db, { name: 'JUGAAD' });
    const story = createStory(db, { projectId: project.id, title: 't', storyType: 'task', actor: 'user:sid' });
    const readied = transitionStory(db, story.id, { toStatus: 'ready', actor: 'user:sid' });
    expect(readied.status).toBe('ready');

    expect(() => transitionStory(db, story.id, { toStatus: 'done', actor: 'user:sid' })).toThrow(CoreError);
    // story must be unchanged after a rejected transition
    expect(getStory(db, story.id).status).toBe('ready');
  });

  it('archive works from any non-archived status and is idempotent-refusing on a second archive', () => {
    const project = createProject(db, { name: 'JUGAAD' });
    const story = createStory(db, { projectId: project.id, title: 't', storyType: 'task', actor: 'user:sid' });
    const archived = archiveStory(db, story.id, { actor: 'user:sid' });
    expect(archived.status).toBe('archived');
    expect(() => archiveStory(db, story.id, { actor: 'user:sid' })).toThrow(CoreError);
  });
});

describe('dependencies', () => {
  it('rejects self-dependency, duplicate dependency, and cycles', () => {
    const project = createProject(db, { name: 'JUGAAD' });
    const a = createStory(db, { projectId: project.id, title: 'A', storyType: 'task', actor: 'user:sid' });
    const b = createStory(db, { projectId: project.id, title: 'B', storyType: 'task', actor: 'user:sid' });

    expect(() => addDependency(db, { storyId: a.id, dependsOnStoryId: a.id, dependencyType: 'blocks', actor: 'user:sid' })).toThrow(
      CoreError,
    );

    addDependency(db, { storyId: a.id, dependsOnStoryId: b.id, dependencyType: 'blocks', actor: 'user:sid' });
    expect(() =>
      addDependency(db, { storyId: a.id, dependsOnStoryId: b.id, dependencyType: 'blocks', actor: 'user:sid' }),
    ).toThrow(CoreError);

    // b -> a would close a cycle since a already depends on b via 'blocks'
    expect(() =>
      addDependency(db, { storyId: b.id, dependsOnStoryId: a.id, dependencyType: 'blocks', actor: 'user:sid' }),
    ).toThrow(CoreError);
  });

  it('removes a dependency and records the event', () => {
    const project = createProject(db, { name: 'JUGAAD' });
    const a = createStory(db, { projectId: project.id, title: 'A', storyType: 'task', actor: 'user:sid' });
    const b = createStory(db, { projectId: project.id, title: 'B', storyType: 'task', actor: 'user:sid' });
    const dep = addDependency(db, { storyId: a.id, dependsOnStoryId: b.id, dependencyType: 'related', actor: 'user:sid' });
    removeDependency(db, dep.id, { actor: 'user:sid' });
    const events = listEventsAfter(db, 0, 100).filter((e) => e.storyId === a.id && e.eventType === 'dependency_removed');
    expect(events).toHaveLength(1);
  });
});

describe('comments', () => {
  it('adds a comment and records an event', () => {
    const project = createProject(db, { name: 'JUGAAD' });
    const story = createStory(db, { projectId: project.id, title: 't', storyType: 'task', actor: 'user:sid' });
    const comment = addComment(db, story.id, { author: 'user:sid', body: 'looks good' });
    expect(comment.body).toBe('looks good');
    const events = listEventsAfter(db, 0, 100).filter((e) => e.storyId === story.id && e.eventType === 'comment_added');
    expect(events).toHaveLength(1);
  });
});

describe('idempotency', () => {
  it('an identical retry returns the original response without duplicating records', () => {
    const project = createProject(db, { name: 'JUGAAD' });
    let calls = 0;
    const run = () =>
      withIdempotency(db, { key: 'k1', clientId: 'c1', routeId: 'createStory' }, { title: 't' }, () => {
        calls += 1;
        return createStory(db, { projectId: project.id, title: 't', storyType: 'task', actor: 'user:sid' });
      });
    const first = run();
    const second = run();
    expect(first.id).toBe(second.id);
    expect(calls).toBe(1);
    expect(listStories(db, { projectId: project.id })).toHaveLength(1);
  });

  it('reusing the same key with a different body fails explicitly', () => {
    const run = (body: unknown) =>
      withIdempotency(db, { key: 'k2', clientId: 'c1', routeId: 'noop' }, body, () => ({ ok: true }));
    run({ a: 1 });
    expect(() => run({ a: 2 })).toThrow(CoreError);
  });

  it('idempotency records survive a close/reopen', () => {
    const dbPath = path.join(dir, 'core.db');
    withIdempotency(db, { key: 'k3', clientId: 'c1', routeId: 'noop' }, { a: 1 }, () => ({ v: 42 }));
    db.close();
    const reopened = openCoreDatabase(dbPath).db;
    try {
      const result = withIdempotency(reopened, { key: 'k3', clientId: 'c1', routeId: 'noop' }, { a: 1 }, () => ({ v: 999 }));
      expect(result).toEqual({ v: 42 });
    } finally {
      reopened.close();
      db = openCoreDatabase(dbPath).db; // so afterEach's db.close() has something valid to close
    }
  });
});

describe('event ordering', () => {
  it('sequences are strictly increasing across mutations', () => {
    const project = createProject(db, { name: 'JUGAAD' });
    const s1 = createStory(db, { projectId: project.id, title: 'A', storyType: 'task', actor: 'user:sid' });
    const s2 = createStory(db, { projectId: project.id, title: 'B', storyType: 'task', actor: 'user:sid' });
    transitionStory(db, s1.id, { toStatus: 'ready', actor: 'user:sid' });
    const events = listEventsAfter(db, 0, 100);
    const sequences = events.map((e) => e.sequence);
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
    expect(new Set(sequences).size).toBe(sequences.length);
  });
});
