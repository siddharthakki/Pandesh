import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { DurableTaskQueue } from '../../autonomous/M15AutonomousWork';
import {
  AutonomousScrumCoordinator,
  DEFAULT_M18_SCRUM_LABELS,
  ScrumBoardTransition,
  ScrumBoardTransport,
  ScrumStory,
  ScrumStoryRef,
} from '../../scrum/M18AutonomousScrum';

class FakeScrumBoard implements ScrumBoardTransport {
  readonly ensured: string[] = [];
  readonly transitions: Array<{ story: ScrumStoryRef; transition: ScrumBoardTransition }> = [];
  failNextTransition = false;

  constructor(readonly stories: ScrumStory[]) {}

  async resolveRepository(): Promise<string> {
    return 'siddharthakki/ollama-agent';
  }

  async resolveBaseBranch(): Promise<string> {
    return 'dogfood/m17';
  }

  async ensureLabels(repository: string): Promise<void> {
    this.ensured.push(repository);
  }

  async listReadyStories(): Promise<ScrumStory[]> {
    return this.stories.map(story => ({ ...story, labels: [...story.labels] }));
  }

  async transitionStory(story: ScrumStoryRef, transition: ScrumBoardTransition): Promise<void> {
    if (this.failNextTransition) {
      this.failNextTransition = false;
      throw new Error('board unavailable');
    }
    this.transitions.push({ story: { ...story }, transition: { ...transition, labels: { ...transition.labels } } });
  }
}

function story(number: number, labels: string[] = [DEFAULT_M18_SCRUM_LABELS.ready]): ScrumStory {
  return {
    repository: 'siddharthakki/ollama-agent',
    number,
    title: `Story ${number}`,
    body: `Acceptance criteria for ${number}`,
    url: `https://github.com/siddharthakki/ollama-agent/issues/${number}`,
    labels,
  };
}

describe('M18 autonomous Scrum coordinator', () => {
  let root: string;
  let queue: DurableTaskQueue;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-m18-scrum-'));
    queue = new DurableTaskQueue(root);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('selects the highest-priority Ready story and hands it to real governed delivery', async () => {
    const board = new FakeScrumBoard([
      story(10),
      story(11, [DEFAULT_M18_SCRUM_LABELS.ready, 'priority:urgent']),
      story(12, [DEFAULT_M18_SCRUM_LABELS.ready, 'priority:high']),
    ]);
    const runtime = { wake: vi.fn() };
    const coordinator = new AutonomousScrumCoordinator({
      repositoryRoot: root,
      queue,
      board,
      runtime,
      validationCommands: ['npm run compile'],
    });

    const result = await coordinator.runNextReadyStory();

    expect(result.status).toBe('queued');
    if (result.status !== 'queued') throw new Error('expected queued result');
    expect(result.story.number).toBe(11);
    expect(result.task).toMatchObject({
      origin: 'github-issue',
      priority: 'urgent',
      repositoryId: 'siddharthakki/ollama-agent',
      sourceIssue: { owner: 'siddharthakki', repo: 'ollama-agent', issueNumber: 11 },
      githubDelivery: { transport: 'gh-cli', remote: 'origin', baseBranch: 'dogfood/m17' },
      validationRequirements: [{ command: 'npm run compile', required: true }],
    });
    expect(result.task.evidence).toContain('scrum:m18');
    expect(result.task.evidence).toContain('scrum:board-status:in-progress');
    expect(board.transitions).toHaveLength(1);
    expect(board.transitions[0].transition.status).toBe('in-progress');
    expect(runtime.wake).toHaveBeenCalledTimes(1);
  });

  it('runs only one active Scrum story at a time', async () => {
    const board = new FakeScrumBoard([story(20), story(21)]);
    const runtime = { wake: vi.fn() };
    const coordinator = new AutonomousScrumCoordinator({ repositoryRoot: root, queue, board, runtime });

    const first = await coordinator.runNextReadyStory();
    const second = await coordinator.runNextReadyStory();

    expect(first.status).toBe('queued');
    expect(second.status).toBe('busy');
    expect((await queue.list()).filter(task => task.evidence.includes('scrum:m18'))).toHaveLength(1);
    expect(runtime.wake).toHaveBeenCalledTimes(1);
  });

  it('moves a completed story with a draft PR to Review exactly once', async () => {
    const board = new FakeScrumBoard([story(30)]);
    const runtime = { wake: vi.fn() };
    const coordinator = new AutonomousScrumCoordinator({ repositoryRoot: root, queue, board, runtime });
    const queued = await coordinator.runNextReadyStory();
    if (queued.status !== 'queued') throw new Error('expected queued result');
    const current = await queue.get(queued.task.taskId);
    if (!current) throw new Error('task missing');
    await queue.update({
      ...current,
      state: 'completed',
      githubDelivery: {
        ...current.githubDelivery,
        commitSha: 'abc123',
        pullRequestNumber: 42,
        pullRequestUrl: 'https://github.com/siddharthakki/ollama-agent/pull/42',
        draft: true,
      },
    }, 'test_completed');

    const firstSync = await coordinator.syncBoard();
    const secondSync = await coordinator.syncBoard();

    expect(firstSync.changes).toEqual([expect.objectContaining({ issueNumber: 30, from: 'in-progress', to: 'review' })]);
    expect(secondSync.changes).toEqual([]);
    expect(board.transitions.map(item => item.transition.status)).toEqual(['in-progress', 'review']);
    expect(board.transitions[1].transition.comment).toContain('/pull/42');
  });

  it('cancels the queued task safely when board ownership cannot be recorded', async () => {
    const board = new FakeScrumBoard([story(40)]);
    board.failNextTransition = true;
    const runtime = { wake: vi.fn() };
    const coordinator = new AutonomousScrumCoordinator({ repositoryRoot: root, queue, board, runtime });

    await expect(coordinator.runNextReadyStory()).rejects.toThrow('board unavailable');

    const tasks = await queue.list();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      state: 'cancelled',
      failure: { classification: 'scrum_board_claim_failed' },
    });
    expect(tasks[0].evidence).toContain('scrum:m18');
    expect(runtime.wake).not.toHaveBeenCalled();
  });

  it('returns a cancelled managed story to Ready during reconciliation', async () => {
    const board = new FakeScrumBoard([story(50)]);
    const runtime = { wake: vi.fn() };
    const coordinator = new AutonomousScrumCoordinator({ repositoryRoot: root, queue, board, runtime });
    const queued = await coordinator.runNextReadyStory();
    if (queued.status !== 'queued') throw new Error('expected queued result');
    await queue.transition(queued.task.taskId, 'cancelled', { reason: 'test' });

    const sync = await coordinator.syncBoard();

    expect(sync.changes).toEqual([expect.objectContaining({ issueNumber: 50, from: 'in-progress', to: 'ready' })]);
    expect(board.transitions.map(item => item.transition.status)).toEqual(['in-progress', 'ready']);
  });
});
