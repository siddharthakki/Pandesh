import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openCoreDatabase } from '../db/openCore';
import type { CoreDatabase } from '../db/connection';
import { createPairingCode, getBridgeTask, redeemPairingCode, submitBridgeTask, type BridgePairing } from '../domain/pandaBridge';
import { cancelBridgeTask, dispatchBridgeTask, type BridgeRuntime } from '../runtime/kandev/pandaBridge';
import { ServiceRegistry } from '../runtime/kandev/bridgeServices';
import { activityItem, deriveExecutionState, MODEL_WAIT_STALL_MS, STALL_MS, type ActivitySignals } from '../runtime/kandev/bridgeActivity';
import { ModelCallTracker } from '../runtime/modelCallTracker';
import type { ModelBackend } from '../runtime/modelBackend';
import type { KandevClient } from '../runtime/kandev/kandevClient';

const NOW = Date.parse('2026-11-20T10:00:00Z');
const iso = (agoMs: number) => new Date(NOW - agoMs).toISOString();
const task = (status: string, extra: Record<string, unknown> = {}): ActivitySignals['task'] =>
  ({ status, executor: 'native', control: 'none', updatedAt: iso(1000), statusDetail: null, result: null, ...extra }) as ActivitySignals['task'];
const derive = (t: ActivitySignals['task'], rest: Partial<ActivitySignals> = {}) => deriveExecutionState({ now: NOW, task: t, ...rest });
const attempt = (status: string, o: Record<string, unknown> = {}) => ({ status, updatedAt: iso(1000), claimExpiresAt: new Date(NOW + 60_000).toISOString(), ...o });

describe('execution state comes from backend facts', () => {
  it('maps the recorded task status', () => {
    expect(derive(task('received')).state).toBe('queued');
    expect(derive(task('awaiting_executor')).state).toBe('waiting_for_executor');
    expect(derive(task('dispatching')).state).toBe('queued');
    expect(derive(task('awaiting_approval')).state).toBe('waiting_for_approval');
    expect(derive(task('completed')).state).toBe('completed');
    expect(derive(task('failed')).state).toBe('failed');
    expect(derive(task('cancelled')).state).toBe('cancelled');
  });

  it('native: queued attempt, running attempt, approval wait', () => {
    expect(derive(task('running'), { attempt: attempt('queued') }).state).toBe('queued');
    expect(derive(task('running'), { attempt: attempt('running') }).state).toBe('running');
    expect(derive(task('running'), { attempt: attempt('waiting_for_approval') }).state).toBe('waiting_for_approval');
  });

  it('waiting for the model/GPU only while a call is in flight with no token, and says what it is behind', () => {
    const wait = { inFlight: true, awaitingFirstToken: true, inFlightMs: 90_000, othersInFlight: 2, lastActivityAt: NOW - 90_000 };
    const d = derive(task('running', { updatedAt: iso(90_000) }), { attempt: attempt('running', { updatedAt: iso(90_000) }), model: wait });
    expect(d.state).toBe('waiting_for_model');
    expect(d.reason).toMatch(/2 other model calls in flight/);
    const streaming = derive(task('running'), { attempt: attempt('running'), model: { ...wait, awaitingFirstToken: false, lastActivityAt: NOW - 500 } });
    expect(streaming.state).toBe('running');
    expect(derive(task('running', { updatedAt: iso(30 * 60_000) }), { attempt: attempt('running'), model: { ...wait, inFlightMs: MODEL_WAIT_STALL_MS + 1 } }).state).toBe('stalled');
  });

  it('stalled = an expired worker lease, or total silence with no legitimate wait; never just elapsed time', () => {
    const expired = derive(task('running'), { attempt: attempt('running', { claimExpiresAt: iso(10 * 60_000) }) });
    expect(expired.state).toBe('stalled');
    expect(expired.reason).toMatch(/lease expired/);
    const quiet = { inFlight: false, awaitingFirstToken: false, inFlightMs: 0, othersInFlight: 0, lastActivityAt: NOW - STALL_MS - 1000 };
    const silent = derive(task('running', { updatedAt: iso(STALL_MS + 1000) }), { attempt: attempt('running', { updatedAt: iso(STALL_MS + 1000) }), model: quiet });
    expect(silent.state).toBe('stalled');
    expect(silent.heartbeatAgeMs).toBeGreaterThan(STALL_MS);
    // A long task that keeps producing activity is running, however long it has been going.
    expect(derive(task('running', { updatedAt: iso(2000) }), { attempt: attempt('running') }).state).toBe('running');
    // A streaming model call is not stalled even if the task row is old.
    const streaming = { inFlight: true, awaitingFirstToken: false, inFlightMs: 600_000, othersInFlight: 0, lastActivityAt: NOW - 1000 };
    expect(derive(task('running', { updatedAt: iso(STALL_MS * 3) }), { attempt: attempt('running', { updatedAt: iso(STALL_MS * 3) }), model: streaming }).state).toBe('running');
  });

  it('ACP executor waiting for a worker slot is waiting for model capacity', () => {
    expect(derive(task('running', { executor: 'opencode' }), { storyWaitingForSlot: true }).state).toBe('waiting_for_model');
  });
});

describe('model call tracker', () => {
  it('reports in-flight, first token and contention per attempt', async () => {
    const tracker = new ModelCallTracker();
    let release!: () => void; let emit!: (t: string) => void;
    const slow: ModelBackend = { streamChat: (_r, onToken) => new Promise((res) => { emit = onToken; release = () => res({} as never); }) };
    const a = tracker.wrap('att_a', slow);
    const pending = a.streamChat({} as never, () => undefined);
    expect(tracker.snapshot('att_a')).toMatchObject({ inFlight: true, awaitingFirstToken: true, othersInFlight: 0 });
    expect(tracker.snapshot('att_b').othersInFlight).toBe(1);
    emit('hi');
    expect(tracker.snapshot('att_a').awaitingFirstToken).toBe(false);
    release(); await pending;
    expect(tracker.snapshot('att_a')).toMatchObject({ inFlight: false });
    expect(tracker.snapshot('att_a').lastActivityAt).not.toBeNull();
  });
});

describe('activity item for a real bridge task', () => {
  let dir: string; let db: CoreDatabase; let rt: BridgeRuntime; let pairing: BridgePairing;
  const hang = new ServiceRegistry().register({ id: 'hang', label: 'Hang', readOnly: true, roots: [], run: ({ signal }) => new Promise((_, rej) => signal.addEventListener('abort', () => rej(new Error('cancelled')))) });
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'panda-act-')); fs.mkdirSync(path.join(dir, 'data'));
    db = openCoreDatabase(path.join(dir, 'core.db')).db;
    rt = { db, kandev: { healthy: async () => false, tool: async () => ({ agents: [] }) } as unknown as KandevClient, dataDir: path.join(dir, 'data'), services: hang };
    pairing = redeemPairingCode(db, { code: createPairingCode(db).code, label: 'Chrome (ChatGPT)' }).pairing;
  });
  afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  it('shows origin, instruction, executor, state, active time and heartbeat, and follows the lifecycle', async () => {
    const { task: t } = submitBridgeTask(db, pairing, { clientRequestId: 'req-act-0001', instruction: 'Hi what is my daily brief', sourceRef: { url: 'https://chatgpt.com/', title: 'ChatGPT', via: 'panda_mode' } });
    let item = activityItem(db, getBridgeTask(db, t.id), 'Chrome (ChatGPT)');
    expect(item).toMatchObject({ state: 'waiting_for_executor', stateLabel: 'Waiting for executor', instruction: 'Hi what is my daily brief', elapsedMs: null, origin: { kind: 'chatgpt', client: 'Chrome (ChatGPT)', via: 'panda_mode' } });
    await dispatchBridgeTask(rt, t.id, { executor: 'service:hang', decidedBy: 'test', authority: 'host' });
    item = activityItem(db, getBridgeTask(db, t.id), 'Chrome (ChatGPT)');
    expect(item).toMatchObject({ state: 'running', executor: 'service:hang', routing: 'explicit' });
    expect(item.elapsedMs).not.toBeNull();
    expect(item.lastHeartbeatAt).not.toBeNull();
    await cancelBridgeTask(rt, t.id, 'test');
    await new Promise(r => setTimeout(r, 50));
    expect(activityItem(db, getBridgeTask(db, t.id), 'x').state).toBe('cancelled');
  });
});

describe('workflow steps in the activity feed', () => {
  it('shows a workflow-created task as a step with its service, not as raw JSON arguments', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'panda-wfact-'));
    const db = openCoreDatabase(path.join(dir, 'core.db')).db;
    try {
      const pairing = redeemPairingCode(db, { code: createPairingCode(db).code, label: 'Chrome' }).pairing;
      const { task } = submitBridgeTask(db, pairing, { clientRequestId: 'wf-ptask_parent-1-collect', instruction: '{}' });
      const item = activityItem(db, getBridgeTask(db, task.id), 'Chrome');
      expect(item.origin.kind).toBe('workflow');
      expect(item.instruction).toMatch(/^Workflow step/);
    } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
