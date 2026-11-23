import { describe, expect, it } from 'vitest';
import { buildAgents, type ExecutorListing } from '../renderer-v2/src/agentsModel';
import type { BridgeActivityItem } from '../renderer-v2/src/Missions';

const NOW = Date.parse('2026-11-23T10:00:00Z');
// The executor listing exactly as the scratch Core reported it on 2026-11-23 (trimmed).
const listing: ExecutorListing = {
  kandev: { running: true }, hardware: { gpu: { name: 'NVIDIA GeForce RTX 3090', totalVramMb: 24576, freeVramMb: 21296 }, gpuLanes: 1 },
  executors: [
    { id: 'claude', label: 'Claude Code', kind: 'acp', dispatchable: true, available: true, reason: null, external: true, usesLocalGpu: false, models: ['sonnet'] },
    { id: 'opencode', label: 'OpenCode', kind: 'acp', dispatchable: true, available: true, reason: null, external: false, usesLocalGpu: true, models: [] },
    { id: 'antigravity', label: 'Antigravity', kind: 'acp', dispatchable: true, available: false, reason: 'Antigravity is not installed on this PC', external: true, usesLocalGpu: false, models: [] },
    { id: 'hermes', label: 'Hermes', kind: 'acp', dispatchable: true, available: false, reason: 'not_installed agent not installed', external: true, usesLocalGpu: true, models: [] },
    { id: 'codex-acp', label: 'codex-acp', kind: 'acp', dispatchable: false, available: false, reason: 'installed in Kandev, but the Pandesh coordinator does not drive this agent yet', external: true, usesLocalGpu: false, models: [] },
    { id: 'native', label: 'Pandesh (native Windows capabilities)', kind: 'native', dispatchable: true, available: true, reason: null, external: false, usesLocalGpu: false, models: [] },
  ],
};
const task = (p: Partial<BridgeActivityItem>): BridgeActivityItem => ({
  id: 't', origin: { kind: 'chatgpt', client: 'ChatGPT', title: null, via: null }, instruction: 'Fix it', executor: 'claude', state: 'running', stateLabel: 'Running',
  reason: '', progress: null, elapsedMs: null, heartbeatAgeMs: null, verification: null, conversationId: null, createdAt: new Date(NOW - 60_000).toISOString(),
  latest: null, lastEventAt: new Date(NOW - 3000).toISOString(), eventCount: 3, branch: null, pendingWorkerActions: [], storyId: 's', ...p,
});

describe('Agents model', () => {
  it('shows each engine as Kandev reports it, primary engines first, never inventing availability', () => {
    const m = buildAgents([], listing, [], NOW);
    expect(m.engines.map((e) => [e.id, e.status])).toEqual([
      ['claude', 'available'], ['opencode', 'available'], ['hermes', 'not_installed'], ['antigravity', 'not_installed'], ['codex-acp', 'not_driven'],
    ]);
    expect(m.engines.find((e) => e.id === 'hermes')?.reason).toBeNull();
    expect(m.gpu).toMatchObject({ lanes: 1, busy: 0, queued: 0 });
  });

  it('an engine is busy only with a live task; GPU waits are named', () => {
    const m = buildAgents([], listing, [task({}), task({ id: 'q', executor: 'opencode', state: 'waiting_for_model', stateLabel: 'Waiting for model/GPU', lastEventAt: null })], NOW);
    expect(m.engines[0]).toMatchObject({ status: 'busy', live: true });
    expect(m.engines[1]).toMatchObject({ status: 'waiting_gpu' });
    expect(m.gpu.queued).toBe(1);
  });

  it('a change awaiting the owner is on the review gate', () => {
    const m = buildAgents([], listing, [task({ state: 'waiting_for_approval', codeChange: { project: 'CalcDemo', baseRef: 'main', awaitingReview: true, changedFiles: ['a.js'], deliverable: false, delivered: null } })], NOW);
    expect(m.gate.awaitingOwner).toHaveLength(1);
  });
});
