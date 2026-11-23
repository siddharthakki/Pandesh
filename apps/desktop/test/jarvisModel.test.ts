import { describe, expect, it } from 'vitest';
import { buildHome, LIVE_MS, UNCLAIMED_MS } from '../renderer-v2/src/jarvisModel';
import type { BridgeActivityItem } from '../renderer-v2/src/Missions';

const NOW = Date.parse('2026-11-23T09:00:00Z');
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const item = (p: Partial<BridgeActivityItem>): BridgeActivityItem => ({
  id: 'b1', origin: { kind: 'chatgpt', client: 'ChatGPT', title: null, via: null }, instruction: 'Fix the bug', executor: 'claude',
  state: 'running', stateLabel: 'Running', reason: '', progress: null, elapsedMs: null, heartbeatAgeMs: null, verification: null,
  conversationId: null, createdAt: iso(10 * 60_000), latest: null, lastEventAt: null, eventCount: 0, branch: null,
  pendingWorkerActions: [], storyId: 's1', ...p,
});
const home = (bridge: BridgeActivityItem[]) => buildHome({ missions: [], bridge, approvals: [], tasks: [], snapshot: null, now: NOW });

describe('Jarvis Home model', () => {
  it('an idle Pandesh shows no activity and a still presence', () => {
    const h = home([]);
    expect(h.presence).toBe('idle');
    expect(h.inFlight).toEqual([]);
    expect(h.line).toBe('Nothing is running and nothing needs you.');
  });

  it('a worker is "live" only while its own last event is recent', () => {
    expect(home([item({ lastEventAt: iso(4000), latest: { at: iso(4000), kind: 'tool_edit', text: 'x' } })]).inFlight[0]).toMatchObject({ live: true, engine: 'Claude Code' });
    const quiet = home([item({ lastEventAt: iso(LIVE_MS + 5000) })]);
    expect(quiet.inFlight[0].live).toBe(false);
    expect(quiet.inFlight[0].eventText).toMatch(/stale/);
    expect(quiet.presence).toBe('idle');
  });

  it('a task no executor picked up for a long time is an exception with Stop, not work in flight', () => {
    const h = home([item({ state: 'waiting_for_executor', stateLabel: 'Waiting for executor', executor: null, createdAt: iso(UNCLAIMED_MS + 60_000) })]);
    expect(h.inFlight).toEqual([]);
    expect(h.exceptions[0]).toMatchObject({ stopBridgeId: 'b1' });
    expect(h.exceptions[0].detail).toMatch(/no executor has picked it up/);
  });

  it('a worker permission request is a decision and turns the presence amber', () => {
    const h = home([item({ pendingWorkerActions: [{ pendingId: 'p1', what: 'run npm test' }], lastEventAt: iso(2000) })]);
    expect(h.decisions[0]).toMatchObject({ kind: 'worker_permission', pendingId: 'p1', storyId: 's1' });
    expect(h.presence).toBe('needs_you');
  });

  it('with nothing new in a day, Ready shows the most recent older results and says so', () => {
    const h = home([item({ state: 'completed', lastEventAt: iso(26 * 3600_000), verification: 'human-reviewed' }), item({ id: 'svc', state: 'completed', executor: 'service:fs.inspect', lastEventAt: null, createdAt: iso(3600_000) })]);
    expect(h.readyIsOlder).toBe(true);
    expect(h.ready.map((r) => r.id)).toEqual(['b1']);
    expect(h.line).not.toMatch(/ready/);
  });
});
