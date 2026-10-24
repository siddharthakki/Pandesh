import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  JsonBoardEventStore,
  JsonIssueLeaseStore,
  checkDefinitionOfDone,
  checkDefinitionOfReady,
  convertBoardIssueToKarkeDikhaTask,
} from '../../scrum/M18ScrumControlPlane';
import type { ScrumIssueRecord } from '../../scrum/M18ScrumControlPlane';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

function readyIssue(type: ScrumIssueRecord['type'] = 'story'): ScrumIssueRecord {
  return {
    repository: 'siddharthakki/ollama-agent',
    number: 101,
    title: 'Implement bounded feature',
    body: 'A complete issue body.',
    type,
    labels: [
      `type:${type}`,
      'priority:high',
      'ai-ready',
      ...(type === 'bug' ? ['needs-regression-test'] : []),
    ],
    milestone: 'Current Sprint',
    acceptanceCriteria: ['The behavior is observable.', 'Focused validation passes.'],
    dependencies: [],
    estimate: 3,
    status: 'ready',
    updatedAt: '2026-07-13T00:00:00.000Z',
  };
}

describe('M18 Scrum control plane', () => {
  it('enforces Definition of Ready and produces a governed KarkeDikha conversion', () => {
    const issue = readyIssue();
    expect(checkDefinitionOfReady(issue)).toEqual({ passed: true, errors: [] });

    const converted = convertBoardIssueToKarkeDikhaTask(
      issue,
      '/workspace/ollama-agent',
      'dogfood/m17',
      ['npm run compile'],
    );

    expect(converted).toMatchObject({
      origin: 'github-project',
      repositoryId: issue.repository,
      baseBranch: 'dogfood/m17',
      priority: 'high',
      requireHumanMergeApproval: true,
      issue: { number: 101 },
    });
    expect(converted.instructions).toContain('Acceptance criteria:');
    expect(converted.validationCommands).toEqual(['npm run compile']);
  });

  it('rejects incomplete stories and requires regression evidence plus human merge for bugs', () => {
    const incomplete = { ...readyIssue(), milestone: undefined, acceptanceCriteria: [], estimate: 0 };
    expect(checkDefinitionOfReady(incomplete)).toEqual({
      passed: false,
      errors: expect.arrayContaining([
        'milestone_required',
        'acceptance_criteria_required',
        'story_points_must_be_1_to_13',
      ]),
    });

    const bug = readyIssue('bug');
    expect(checkDefinitionOfDone(bug, {
      pullRequestUrl: 'https://github.com/siddharthakki/ollama-agent/pull/500',
      validationPassed: true,
      ciPassed: true,
      reviewPassed: true,
      regressionTests: [],
      humanMergeApproved: false,
    })).toEqual({
      passed: false,
      errors: ['regression_test_required', 'human_merge_approval_required'],
    });
  });

  it('deduplicates board events and stores only a content digest', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'm18-events-'));
    roots.push(root);
    const store = new JsonBoardEventStore(path.join(root, 'events.json'));
    const event = {
      id: 'delivery-1',
      repository: 'siddharthakki/ollama-agent',
      issueNumber: 101,
      action: 'moved' as const,
      occurredAt: '2026-07-13T00:00:00.000Z',
    };

    expect((await store.ingest(event, { privateText: 'DO_NOT_PERSIST_RAW' })).accepted).toBe(true);
    expect((await store.ingest(event, { privateText: 'DO_NOT_PERSIST_RAW' })).accepted).toBe(false);
    const persisted = await fs.readFile(path.join(root, 'events.json'), 'utf8');
    expect(persisted).not.toContain('DO_NOT_PERSIST_RAW');
    expect(await store.list()).toHaveLength(1);
  });

  it('claims, heartbeats, expires, reclaims, and token-protects durable issue leases', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'm18-leases-'));
    roots.push(root);
    let clock = Date.parse('2026-07-13T00:00:00.000Z');
    const store = new JsonIssueLeaseStore(path.join(root, 'leases.json'), () => new Date(clock));

    const first = await store.claim('repo#101', 'worker-a', 1_000);
    expect(first).toBeDefined();
    expect(await store.claim('repo#101', 'worker-b', 1_000)).toBeUndefined();
    expect(await store.heartbeat('repo#101', 'wrong-token', 1_000)).toBeUndefined();

    clock += 500;
    const renewed = await store.heartbeat('repo#101', first!.token, 1_000);
    expect(renewed?.expiresAt).toBe('2026-07-13T00:00:01.500Z');

    clock += 1_001;
    const reclaimed = await store.claim('repo#101', 'worker-b', 1_000);
    expect(reclaimed?.ownerId).toBe('worker-b');
    expect(await store.release('repo#101', first!.token)).toBe(false);
    expect(await store.release('repo#101', reclaimed!.token)).toBe(true);
  });
});
