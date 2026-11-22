import { describe, expect, it } from 'vitest';
import { changeCounts, changeFlag, changeStatusLabel, changeSummary, eventAge, eventLabel, groupWorkers, QUIET_MS, workerControls, type ChangeDiffView, type ChangeFile, type WorkerItem } from '../renderer-v2/src/workerModel';

const item = (o: Partial<WorkerItem> = {}): WorkerItem => ({
  id: 't', executor: 'claude', state: 'running', createdAt: '2026-11-21T10:00:00Z', latest: null, lastEventAt: null, heartbeatAgeMs: null, ...o,
});
const now = Date.parse('2026-11-21T10:05:00Z');

describe('worker panels', () => {
  it('groups Kandev workers by agent, Claude first, live before finished; other executors are left out', () => {
    const groups = groupWorkers([
      item({ id: 'o1', executor: 'opencode' }),
      item({ id: 'c-done', state: 'completed', createdAt: '2026-11-21T10:03:00Z' }),
      item({ id: 'c-live', createdAt: '2026-11-21T10:01:00Z' }),
      item({ id: 'n1', executor: 'native' }),
      item({ id: 's1', executor: 'service:files' }),
    ]);
    expect(groups.map(g => g.label)).toEqual(['Claude Code', 'OpenCode']);
    expect(groups[0]!.items.map(i => i.id)).toEqual(['c-live', 'c-done']);
  });

  it('measures "last event" from the worker\'s own newest event, not from Core\'s heartbeat', () => {
    const fresh = eventAge(item({ lastEventAt: '2026-11-21T10:04:57Z', heartbeatAgeMs: 0 }), now);
    expect(fresh).toEqual({ text: 'Last event: 3 s ago', quiet: false });
  });

  it('never shows a silent live worker as plainly running: after a minute it says how long it has been quiet', () => {
    const quiet = eventAge(item({ lastEventAt: new Date(now - QUIET_MS - 15_000).toISOString(), heartbeatAgeMs: 0 }), now);
    expect(quiet.quiet).toBe(true);
    expect(quiet.text).toMatch(/^No event for 1 min 15 s/);
    expect(eventAge(item(), now)).toEqual({ text: 'No worker event yet.', quiet: true });
  });

  it('a finished worker states when its last event was, without a running clock', () => {
    const done = eventAge(item({ state: 'completed', lastEventAt: '2026-11-21T09:00:00Z' }), now);
    expect(done.quiet).toBe(false);
    expect(done.text).toMatch(/^Last event at /);
  });

  it('offers only the controls Core supports for the worker\'s state', () => {
    expect(workerControls({ state: 'running' }).map(c => c.label)).toEqual(['Pause', 'Stop']);
    expect(workerControls({ state: 'paused' }).map(c => c.label)).toEqual(['Resume', 'Stop']);
    expect(workerControls({ state: 'queued' }).map(c => c.label)).toEqual(['Stop']);
    expect(workerControls({ state: 'completed' })).toEqual([]);
  });

  it('labels Kandev event kinds in plain words', () => {
    expect(eventLabel('tool_execute')).toBe('Ran');
    expect(eventLabel('permission_request')).toBe('Asked permission');
    expect(eventLabel('tool_web_fetch')).toBe('web fetch');
  });
});

describe('A5 View diff helpers', () => {
  const file = (o: Partial<ChangeFile>): ChangeFile => ({ path: 'a.js', oldPath: null, status: 'modified', additions: 1, deletions: 1, binary: false, patch: '+x', truncated: false, note: null, ...o });
  it('labels status, counts and flags plainly', () => {
    expect(changeStatusLabel('untracked')).toBe('New (uncommitted)');
    expect(changeCounts(file({ additions: 3, deletions: 0 }))).toBe('+3 −0');
    expect(changeCounts(file({ binary: true, additions: null, deletions: null }))).toBe('binary');
    expect(changeFlag(file({}))).toBeNull();
    expect(changeFlag(file({ binary: true, patch: null }))).toMatchObject({ kind: 'binary' });
    expect(changeFlag(file({ truncated: true }))).toMatchObject({ kind: 'large' });
    expect(changeFlag(file({ patch: null, note: 'Not shown: the new file is too large (300000 bytes).' }))).toMatchObject({ kind: 'large' });
    expect(changeFlag(file({ patch: null, note: 'Not shown: Git could not produce this file\'s diff.' }))).toMatchObject({ kind: 'unavailable', text: 'Diff unavailable' });
  });
  it('summarises the change, or says why there is no diff', () => {
    const d: ChangeDiffView = { available: true, reason: null, source: 'worker worktree', base: 'a25faaf', head: '3c1d2e0 + uncommitted', files: [], ignored: [], summary: { files: 2, additions: 5, deletions: 1, binary: 1, large: 0, unavailable: 0 } };
    expect(changeSummary(d)).toBe('2 files changed · +5 −1 · 1 binary · read from the worker worktree (a25faaf → 3c1d2e0 + uncommitted)');
    expect(changeSummary({ ...d, available: false, reason: 'The worker has not started, so there is no change yet.' })).toBe('Diff unavailable: The worker has not started, so there is no change yet.');
  });
});
