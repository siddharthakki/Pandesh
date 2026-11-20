import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openCoreDatabase } from '../db/openCore';
import type { CoreDatabase } from '../db/connection';
import { claimBridgeDispatch, createPairingCode, getBridgeTask, recordBridgeStatus, redeemPairingCode, submitBridgeTask, type BridgePairing } from '../domain/pandaBridge';
import { dispatchBridgeTask, startPandaBridgeLoop, type BridgeRuntime } from '../runtime/kandev/pandaBridge';
import { ServiceRegistry } from '../runtime/kandev/bridgeServices';
import { VERIFY_FILE_WORKFLOW } from '../runtime/kandev/capabilityRegistry';
import { defaultServiceRegistry } from '../runtime/kandev/bridgeServices';
import { runWorkflow } from '../runtime/kandev/workflowRouter';
import type { KandevClient } from '../runtime/kandev/kandevClient';

let dir: string; let db: CoreDatabase; let rt: BridgeRuntime; let pairing: BridgePairing;
const kandev = { healthy: async () => false, tool: async () => ({ agents: [] }) } as unknown as KandevClient;
const until = async (pred: () => boolean, ms = 3000) => { for (let t = 0; t < ms; t += 20) { if (pred()) return; await new Promise(r => setTimeout(r, 20)); } throw new Error('timeout'); };
let n = 0;
const submit = (instruction = 'x') => submitBridgeTask(db, pairing, { clientRequestId: `req-life-${String(++n).padStart(4, '0')}`, instruction }).task;
const req = (executor: string) => ({ executor, decidedBy: 'test', authority: 'host' as const });
const hang = new ServiceRegistry().register({
  id: 'hang', label: 'Hangs until cancelled', readOnly: true, roots: [],
  run: ({ signal }) => new Promise((_, rej) => signal.addEventListener('abort', () => rej(new Error('cancelled')))),
});
const crash = new ServiceRegistry().register({ id: 'crash', label: 'Crashes', readOnly: true, roots: [], run: async () => { throw 'boom (non-Error throw)'; } });

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'panda-life-'));
  fs.mkdirSync(path.join(dir, 'data'));
  db = openCoreDatabase(path.join(dir, 'core.db')).db;
  rt = { db, kandev, dataDir: path.join(dir, 'data'), services: hang };
  const { code } = createPairingCode(db);
  pairing = redeemPairingCode(db, { code, label: 'JUGAAD' }).pairing;
});
afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

describe('bridge lifecycle recovery', () => {
  it('an executor that crashes (even by throwing a non-Error) ends as failed with a reason, never stuck running', async () => {
    const t = submit();
    await dispatchBridgeTask({ ...rt, services: crash }, t.id, req('service:crash'));
    await until(() => getBridgeTask(db, t.id).status === 'failed');
    expect(getBridgeTask(db, t.id).statusDetail).toContain('failed');
  });

  it('Core restart: a service task left running with no live run is failed with a restart message', async () => {
    const t = submit();
    claimBridgeDispatch(db, t.id, { executor: 'service:hang', model: null, routing: 'explicit', consent: null, grantedBy: 'test' });
    recordBridgeStatus(db, t.id, 'running', 'Running service:hang');
    const stop = startPandaBridgeLoop(rt, 10);
    try {
      await until(() => getBridgeTask(db, t.id).status === 'failed');
      expect(getBridgeTask(db, t.id).statusDetail).toContain('Core restarted');
    } finally { stop(); }
  });

  it('Core restart: a dispatch claimed but never started does not sit in dispatching forever', async () => {
    const t = submit();
    claimBridgeDispatch(db, t.id, { executor: 'service:hang', model: null, routing: 'explicit', consent: null, grantedBy: 'test' });
    db.run('UPDATE bridge_tasks SET updatedAt = ? WHERE id = ?', [new Date(Date.now() - 3_600_000).toISOString(), t.id]);
    const stop = startPandaBridgeLoop(rt, 10);
    try { await until(() => getBridgeTask(db, t.id).status === 'failed'); } finally { stop(); }
    expect(getBridgeTask(db, t.id).statusDetail).toContain('interrupted');
  });

  it('timeout: a task past the deadline is cancelled through the normal cancel path and its run is aborted', async () => {
    const t = submit();
    await dispatchBridgeTask(rt, t.id, req('service:hang'));
    expect(getBridgeTask(db, t.id).status).toBe('running');
    db.run('UPDATE bridge_tasks SET createdAt = ? WHERE id = ?', [new Date(Date.now() - 24 * 3_600_000).toISOString(), t.id]);
    const stop = startPandaBridgeLoop(rt, 10);
    try { await until(() => getBridgeTask(db, t.id).status === 'cancelled'); } finally { stop(); }
  });

  it('a cancelled task stays cancelled even if the executor reports late', async () => {
    const t = submit();
    await dispatchBridgeTask(rt, t.id, req('service:hang'));
    const { cancelBridgeTask } = await import('../runtime/kandev/pandaBridge');
    await cancelBridgeTask(rt, t.id, 'test');
    await until(() => getBridgeTask(db, t.id).status === 'cancelled');
    expect(recordBridgeStatus(db, t.id, 'completed', 'late success')).toBe(false);
    expect(getBridgeTask(db, t.id).status).toBe('cancelled');
  });

  it('duplicate submission and duplicate dispatch under concurrency start exactly one run', async () => {
    const a = submitBridgeTask(db, pairing, { clientRequestId: 'req-dup-0001', instruction: 'x' });
    const b = submitBridgeTask(db, pairing, { clientRequestId: 'req-dup-0001', instruction: 'x' });
    expect(b.duplicate).toBe(true); expect(b.task.id).toBe(a.task.id);
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => dispatchBridgeTask(rt, a.task.id, req('service:hang'))));
    expect(results.filter(r => r.status === 'fulfilled' && r.value.started)).toHaveLength(1);
    const { cancelBridgeTask } = await import('../runtime/kandev/pandaBridge');
    await cancelBridgeTask(rt, a.task.id, 'cleanup');
  });

  it('partial completion: when step 2 of a workflow fails, step 1 keeps its completed receipt and the run reports failed', async () => {
    const root = path.join(dir, 'allowed'); fs.mkdirSync(root); fs.writeFileSync(path.join(root, 'f.txt'), 'abc');
    const real = { ...rt, services: defaultServiceRegistry([root]) };
    const run = await runWorkflow(real, pairing, VERIFY_FILE_WORKFLOW, { path: path.join(root, 'f.txt'), sha256: 'd'.repeat(64) }, { runId: 'run-partial-1', decidedBy: 'test', pollMs: 10 });
    expect(run.status).toBe('failed');
    const first = getBridgeTask(db, run.steps[0]!.taskId!);
    expect(first.status).toBe('completed');
    expect(first.result?.verification).toBe('independent');
    expect(getBridgeTask(db, run.steps[1]!.taskId!).status).toBe('failed');
  });

  it('missing executor: dispatching to an executor that is not registered is refused and the task stays startable', async () => {
    const t = submit();
    await expect(dispatchBridgeTask(rt, t.id, req('service:not-registered'))).rejects.toThrow(/unknown executor/);
    expect(getBridgeTask(db, t.id).status).toBe('awaiting_executor');
  });
});
