import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { LocalStoryStore, normalizeLocalStoryDraft } from '../../stories/LocalStoryStore';

describe('LocalStoryStore', () => {
  let root: string;
  let store: LocalStoryStore;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'karkedikha-local-board-'));
    store = new LocalStoryStore(root);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('persists an approved chat story locally and deduplicates retries', async () => {
    const input = {
      draft: {
        title: 'Add a local Scrum board',
        goal: 'Show durable work in VS Code.',
        acceptanceCriteria: ['Six board columns are visible.', 'Cards survive reload.'],
        constraints: ['Do not auto-merge.'],
        validation: ['Focused tests pass.'],
        dependencies: [],
        estimatedPoints: 5,
      },
      source: 'chat' as const,
      sourceConversationId: 'conversation-1',
      sourceText: 'Create a local Scrum board.',
    };

    const first = await store.create(input);
    const second = await store.create(input);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.story.id).toBe(first.story.id);
    expect((await store.list()).map(story => story.title)).toEqual(['Add a local Scrum board']);
  });

  it('tracks local board status without changing story identity', async () => {
    const created = await store.create({
      draft: {
        title: 'Everyday assistant',
        goal: 'Answer normal prompts.',
        acceptanceCriteria: ['Baat Kar replies visibly.'],
        constraints: [],
        validation: ['Smoke test passes.'],
        dependencies: [],
        estimatedPoints: 3,
      },
    });
    const updated = await store.updateStatus(created.story.id, 'blocked', 'Waiting for a workspace');
    expect(updated.id).toBe(created.story.id);
    expect(updated.status).toBe('blocked');
    expect(updated.blockedReason).toBe('Waiting for a workspace');
  });

  it('rejects malformed webview story payloads', () => {
    expect(() => normalizeLocalStoryDraft({ title: 'Incomplete' })).toThrow(/goal/i);
    expect(() => normalizeLocalStoryDraft({
      title: 'No criteria',
      goal: 'A goal',
      acceptanceCriteria: [],
    })).toThrow(/acceptance criterion/i);
  });
});
