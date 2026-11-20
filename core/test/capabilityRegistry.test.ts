import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openCoreDatabase } from '../db/openCore';
import type { CoreDatabase } from '../db/connection';
import { createPairingCode, getBridgeTask, redeemPairingCode, submitBridgeTask, type BridgePairing } from '../domain/pandaBridge';
import { discoverExecutors, dispatchBridgeTask, type BridgeRuntime, type ExecutorListing } from '../runtime/kandev/pandaBridge';
import { defaultServiceRegistry, ServiceRegistry } from '../runtime/kandev/bridgeServices';
import {
  allDeclarations, routeTask, trackRecords, VERIFY_FILE_WORKFLOW, type ExecutorDeclaration, type TrackRecord,
} from '../runtime/kandev/capabilityRegistry';
import { planWorkflow, runWorkflow } from '../runtime/kandev/workflowRouter';
import { EXTRACT_DOCUMENT_WORKFLOW } from '../runtime/kandev/capabilityRegistry';
import { tailscaleStatusService } from '../runtime/kandev/bridgeToolServices';
import type { KandevClient } from '../runtime/kandev/kandevClient';

let dir: string; let db: CoreDatabase; let rt: BridgeRuntime; let pairing: BridgePairing;
const kandev = { healthy: async () => false, tool: async () => ({ agents: [] }) } as unknown as KandevClient;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'panda-reg-'));
  fs.mkdirSync(path.join(dir, 'data')); fs.mkdirSync(path.join(dir, 'allowed'));
  fs.writeFileSync(path.join(dir, 'allowed', 'a.txt'), 'hello');
  db = openCoreDatabase(path.join(dir, 'core.db')).db;
  rt = { db, kandev, dataDir: path.join(dir, 'data'), services: defaultServiceRegistry([path.join(dir, 'allowed')]) };
  const { code } = createPairingCode(db);
  pairing = redeemPairingCode(db, { code, label: 'JUGAAD' }).pairing;
});
afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const ex = (id: string, o: Partial<ListingExecutor> = {}): ListingExecutor => ({ id, label: id, kind: 'acp', dispatchable: true, available: true, reason: null, external: false, usesLocalGpu: false, models: [], ...o });
type ListingExecutor = ExecutorListing['executors'][number];
const listing = (executors: ListingExecutor[], gpuLanes = 1): ExecutorListing => ({ kandev: { running: true }, hardware: { gpu: null, gpuLanes }, executors });
const decl: ExecutorDeclaration[] = [
  { executor: 'a', classes: { 'code.edit': 90 }, deterministic: false, readOnly: false },
  { executor: 'b', classes: { 'code.edit': 70 }, deterministic: false, readOnly: false },
  { executor: 'cloud', classes: { 'code.edit': 99 }, deterministic: false, readOnly: false },
  { executor: 'svc', classes: { 'filesystem.inspect': 100 }, deterministic: true, readOnly: true },
];
const none = new Map<string, TrackRecord>();

describe('routeTask', () => {
  it('prefers the better declared fit, but demonstrated failures demote it', () => {
    const l = listing([ex('a'), ex('b')]);
    expect(routeTask({ taskClass: 'code.edit' }, l, decl, none).selected).toBe('a');
    const bad = new Map([['a|code.edit', { completed: 0, failed: 4, independent: 0 }], ['b|code.edit', { completed: 4, failed: 0, independent: 4 }]]);
    const d = routeTask({ taskClass: 'code.edit' }, l, decl, bad);
    expect(d.selected).toBe('b');
    expect(d.candidates[0]!.reasons.join(' ')).toContain('4 completed');
  });

  it('never selects an installed-but-unavailable or external executor by default', () => {
    const l = listing([ex('a', { available: false, reason: 'not installed' }), ex('b'), ex('cloud', { external: true })]);
    const d = routeTask({ taskClass: 'code.edit' }, l, decl, none);
    expect(d.selected).toBe('b');
    expect(d.candidates.find(c => c.executor === 'cloud')!.excluded).toMatch(/external/);
    expect(d.candidates.find(c => c.executor === 'a')!.excluded).toBe('not installed');
    expect(routeTask({ taskClass: 'code.edit', allowExternal: true }, l, decl, none).selected).toBe('cloud');
  });

  it('refuses instead of falling back when nothing fits', () => {
    const d = routeTask({ taskClass: 'code.edit' }, listing([ex('a', { available: false })]), decl, none);
    expect(d.selected).toBeNull();
    expect(d.refusal).toMatch(/choose one explicitly/);
    expect(routeTask({ taskClass: 'unknown.class' }, listing([]), decl, none).refusal).toMatch(/no executor declares/);
  });

  it('honours read-only and deterministic constraints', () => {
    const l = listing([ex('a'), ex('svc', { kind: 'service' })]);
    expect(routeTask({ taskClass: 'code.edit', readOnly: true }, l, decl, none).selected).toBeNull();
    expect(routeTask({ taskClass: 'filesystem.inspect', deterministicOnly: true }, l, decl, none).selected).toBe('svc');
  });
});

describe('registry on the real bridge', () => {
  it('a registered service declares its own classes and is routed to', async () => {
    const l = await discoverExecutors(kandev, { services: rt.services! });
    const d = routeTask({ taskClass: 'filesystem.inspect', readOnly: true }, l, allDeclarations(rt.services), none);
    expect(d.selected).toBe('service:fs.inspect');
  });

  it('dispatch auto + taskClass routes, records the class, and builds a track record', async () => {
    const { task } = submitBridgeTask(db, pairing, { clientRequestId: 'req-auto-0001', instruction: JSON.stringify({ path: path.join(dir, 'allowed', 'a.txt') }) });
    const r = await dispatchBridgeTask(rt, task.id, { executor: 'auto', taskClass: 'filesystem.inspect', decidedBy: 'test', authority: 'extension' });
    expect(r.started).toBe(true);
    for (let i = 0; i < 100 && getBridgeTask(db, task.id).status !== 'completed'; i++) await new Promise(res => setTimeout(res, 20));
    const done = getBridgeTask(db, task.id);
    expect(done.executor).toBe('service:fs.inspect');
    expect(done.routing).toBe('auto');
    expect(trackRecords(db).get('service:fs.inspect|filesystem.inspect')).toEqual({ completed: 1, failed: 0, independent: 1 });
  });

  it('auto + taskClass with no suitable executor is an error, not a silent fallback', async () => {
    const { task } = submitBridgeTask(db, pairing, { clientRequestId: 'req-auto-0002', instruction: 'refactor' });
    await expect(dispatchBridgeTask(rt, task.id, { executor: 'auto', taskClass: 'no.such.class', decidedBy: 'test', authority: 'extension' })).rejects.toThrow(/automatic routing/);
    expect(getBridgeTask(db, task.id).status).toBe('awaiting_executor');
  });
});

describe('workflow router', () => {
  const sha = crypto.createHash('sha256').update('hello').digest('hex');

  it('plans without starting anything', async () => {
    const plan = await planWorkflow(rt, VERIFY_FILE_WORKFLOW);
    expect(plan.map(s => s.route.selected)).toEqual(['service:fs.inspect', 'service:workflow.verify-hash']);
  });

  it('runs inspect then verify as two bridge tasks; step 2 consumes step 1 evidence', async () => {
    const run = await runWorkflow(rt, pairing, VERIFY_FILE_WORKFLOW, { path: path.join(dir, 'allowed', 'a.txt') }, { runId: 'run-0001', decidedBy: 'test', pollMs: 10 });
    expect(run.status).toBe('completed');
    expect(run.steps.map(s => s.executor)).toEqual(['service:fs.inspect', 'service:workflow.verify-hash']);
    expect(run.steps[0]!.evidence?.sha256).toBe(sha);
    expect(run.steps[1]!.evidence?.match).toBe(true);
    for (const s of run.steps) { expect(s.taskId).toMatch(/^ptask/); expect(s.verification).toBe('independent'); }
  });

  it('stops at a failing step and reports it; a repeated run id does not duplicate tasks', async () => {
    const wrong = { path: path.join(dir, 'allowed', 'a.txt'), sha256: 'b'.repeat(64) };
    const run = await runWorkflow(rt, pairing, VERIFY_FILE_WORKFLOW, wrong, { runId: 'run-0002', decidedBy: 'test', pollMs: 10 });
    expect(run.status).toBe('failed');
    expect(run.steps[1]!.status).toBe('failed');
    expect(run.steps[1]!.detail).toContain('hash mismatch');
    const again = await runWorkflow(rt, pairing, VERIFY_FILE_WORKFLOW, wrong, { runId: 'run-0002', decidedBy: 'test', pollMs: 10 });
    expect(again.steps[0]!.taskId).toBe(run.steps[0]!.taskId);
  });

  it('refuses a path outside the service roots without reaching the second step', async () => {
    const run = await runWorkflow(rt, pairing, VERIFY_FILE_WORKFLOW, { path: path.join(dir, 'data') }, { runId: 'run-0003', decidedBy: 'test', pollMs: 10 });
    expect(run.status).toBe('failed');
    expect(run.steps).toHaveLength(1);
  });
});

describe('workflow fallback and tool services', () => {
  const mk = (id: string, classes: string[], run: () => Promise<{ summary: string; evidence: Record<string, unknown> }>) =>
    ({ id, label: id, readOnly: true, taskClasses: classes, roots: [], run });
  const wf = (extra: Record<string, unknown> = {}) => ({ ...EXTRACT_DOCUMENT_WORKFLOW, ...extra });

  it('runs the OCR fallback as its own task only when the first step failed for the declared reason', async () => {
    const services = new ServiceRegistry()
      .register(mk('text', ['document.extract'], async () => { throw new Error('no text layer found (a scan?)'); }))
      .register(mk('ocr', ['ocr.pdf'], async () => ({ summary: 'ok', evidence: { kind: 'pdf-ocr', chars: 5 } })));
    const run = await runWorkflow({ ...rt, services }, pairing, wf(), { path: 'x.pdf' }, { runId: 'run-fb-0001', decidedBy: 'test', pollMs: 10 });
    expect(run.status).toBe('completed');
    expect(run.steps.map(s => `${s.name}:${s.status}`)).toEqual(['extract:failed', 'extract:fallback:completed']);
    expect(run.steps[1]!.executor).toBe('service:ocr');
    expect(getBridgeTask(db, run.steps[0]!.taskId!).status).toBe('failed'); // the failure stays on record
  });

  it('does not fall back on an unrelated failure', async () => {
    const services = new ServiceRegistry()
      .register(mk('text', ['document.extract'], async () => { throw new Error('disk exploded'); }))
      .register(mk('ocr', ['ocr.pdf'], async () => ({ summary: 'ok', evidence: {} })));
    const run = await runWorkflow({ ...rt, services }, pairing, wf(), { path: 'x.pdf' }, { runId: 'run-fb-0002', decidedBy: 'test', pollMs: 10 });
    expect(run.status).toBe('failed');
    expect(run.steps).toHaveLength(1);
  });

  it('Tailscale status reports state and counts only, and fails when not running', async () => {
    const run = (json: string) => tailscaleStatusService(process.execPath, ['-e', `console.log(process.argv[1])`, json]).run({ args: {}, signal: new AbortController().signal });
    const ok = await run('{"BackendState":"Running","CurrentTailnet":{"Name":"t.example"},"Self":{"DNSName":"pc.t.example.","Online":true,"TailscaleIPs":["100.64.0.1"]},"Peer":{"a":{"Online":true,"TailscaleIPs":["100.64.0.2"]},"b":{"Online":false}}}');
    expect(ok.evidence).toMatchObject({ backendState: 'Running', self: 'pc.t.example', peers: { total: 2, online: 1 } });
    expect(JSON.stringify(ok.evidence)).not.toContain('100.64');
    await expect(run('{"BackendState":"Stopped"}')).rejects.toThrow(/not running/);
  });
});
