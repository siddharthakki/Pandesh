import { describe, expect, it } from 'vitest';
import { eventAge, eventLabel, groupWorkers, QUIET_MS, workerControls, type WorkerItem } from '../renderer-v2/src/workerModel';

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
