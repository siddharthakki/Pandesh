import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openCoreDatabase } from '../db/openCore';
import type { CoreDatabase } from '../db/connection';
import { createConversation } from '../domain/conversations';
import { listWorkshops, readWorkshopVersion, recordWorkshopFocus } from '../domain/workshops';
import { createWorkshopCapabilityAdapter } from '../runtime/workshopCapability';
import {
  DEFAULT_QUEUE, applySimulationChanges, queueAssumptions, runQueue, stateAt, validateSimulation, type QueueParams,
} from '../shared/workshop/simulation';

const p = (over: Partial<QueueParams>): QueueParams => ({ ...DEFAULT_QUEUE, ...over });

describe('the queue model (seeded, deterministic)', () => {
  it('gives exactly the same customers for the same seed, and a different run for another seed', () => {
    const a = runQueue(p({ seed: 7 }));
    const b = runQueue(p({ seed: 7 }));
    const c = runQueue(p({ seed: 8 }));
    expect(b.metrics).toEqual(a.metrics);
    expect(b.customers).toEqual(a.customers);
    expect(c.metrics.averageWaitMinutes).not.toBe(a.metrics.averageWaitMinutes);
  });

  it('a fixed stall that cannot keep up: one counter, a customer every 2 min, 3 min each — the n-th waits n−1 minutes', () => {
    const run = runQueue(p({ arrivalEveryMinutes: 2, serviceMinutes: 3, counters: 1, durationMinutes: 60, arrivalPattern: 'fixed', servicePattern: 'fixed' }));
    expect(run.metrics.arrived).toBe(30);
    expect(run.customers.map((c) => (c.start ?? 0) - c.arrive)).toEqual(Array.from({ length: 30 }, (_, i) => i));
    expect(run.metrics.averageWaitMinutes).toBe(14.5);
    expect(run.metrics.maxWaitMinutes).toBe(29);
    expect(run.metrics.overrunMinutes).toBe(32);
    // A second counter: nobody waits at all.
    const two = runQueue(p({ arrivalEveryMinutes: 2, serviceMinutes: 3, counters: 2, durationMinutes: 60, arrivalPattern: 'fixed', servicePattern: 'fixed' }));
    expect(two.metrics.averageWaitMinutes).toBe(0);
    expect(two.metrics.maxQueueLength).toBe(0);
  });

  it('random arrivals: a second counter turns a growing queue into a short one', () => {
    const one = runQueue(p({ counters: 1 })).metrics;
    const two = runQueue(p({ counters: 2 })).metrics;
    expect(one.averageWaitMinutes).toBeGreaterThan(10);
    expect(two.averageWaitMinutes).toBeLessThan(one.averageWaitMinutes / 3);
    expect(two.utilization).toBeLessThan(one.utilization);
  });

  it('customers who find the queue full leave, and are counted', () => {
    const run = runQueue(p({ maxQueue: 3 })).metrics;
    expect(run.leftWithoutService).toBeGreaterThan(0);
    expect(run.served + run.leftWithoutService).toBe(run.arrived);
  });

  it('reports what has happened by a given minute (for the animation)', () => {
    const run = runQueue(p({ arrivalEveryMinutes: 2, serviceMinutes: 3, counters: 1, durationMinutes: 60, arrivalPattern: 'fixed', servicePattern: 'fixed' }));
    // Arrivals at 2, 4, 6, 8, 10; customer 3 is served 8–11; customers 4 (arrived 8) and 5 (arrived 10) wait.
    const at = stateAt(run, 10.5);
    expect(at).toMatchObject({ waiting: 2, serving: 1, done: 2 });
  });

  it('changes in plain terms: doubling the arrival rate halves the gap; another counter adds one', () => {
    const spec = validateSimulation({ title: 'Stall', params: { arrivalEveryMinutes: 2, serviceMinutes: 3, counters: 1 } });
    expect(spec.ok).toBe(true);
    if (!spec.ok) return;
    const doubled = applySimulationChanges(spec.value, { adjust: { arrivalRateTimes: 2 } });
    expect(doubled.ok && doubled.spec.params.arrivalEveryMinutes).toBe(1);
    const more = applySimulationChanges(spec.value, { adjust: { addCounters: 1 } });
    expect(more.ok && more.spec.params.counters).toBe(2);
    expect(applySimulationChanges(spec.value, { set: { counters: 99 } }).ok).toBe(false);
    expect(applySimulationChanges(spec.value, { set: { counters: 1 } }).ok).toBe(false);
  });

  it('refuses unbounded runs and says what it assumes', () => {
    expect(validateSimulation({ params: { arrivalEveryMinutes: 0.05, durationMinutes: 1440, serviceMinutes: 1, counters: 1 } }).ok).toBe(false);
    expect(validateSimulation({ params: { counters: 0 } }).ok).toBe(false);
    expect(queueAssumptions(DEFAULT_QUEUE).join(' ')).toMatch(/not a prediction of a real day/);
  });
});

describe('the Simulation Lab through the governed tools', () => {
  let dir: string; let db: CoreDatabase; let conversationId: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pandesh-sim-'));
    db = openCoreDatabase(path.join(dir, 'core.db')).db;
    conversationId = createConversation(db, { mode: 'baat_kar', actor: 'test' }).id;
  });
  afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  it('creates a simulation quoting its measured results, then "add a second counter" re-simulates as a new version', async () => {
    const adapter = createWorkshopCapabilityAdapter({ db, dataDir: dir, commandTimeoutMs: 200 });
    const ctx = { cwd: dir, correlationId: conversationId, attemptId: 'att_test' };
    const created = await adapter.run({ name: 'create_simulation', arguments: { title: 'Food stall', arrivalEveryMinutes: 2, serviceMinutes: 3, counters: 1 } }, ctx);
    expect(created.status).toBe('succeeded');
    expect(created.output).toMatch(/^CREATED[\s\S]*Simulated result: \d+ arrived, \d+ served; average wait [\d.]+ min/);
    expect(created.output).toMatch(/not a prediction of a real day/);
    const [w] = listWorkshops(db, { conversationId });
    expect(w.type).toBe('simulation');
    recordWorkshopFocus(db, { conversationId, workshopId: w.workshopId, artifactId: w.latestArtifactId, open: true, actor: 'window' });
    const edited = await adapter.run({ name: 'workshop_edit', arguments: { adjust: { addCounters: 1 } } }, ctx);
    expect(edited.status).toBe('succeeded');
    const m = /average wait ([\d.]+) → ([\d.]+) min/.exec(edited.output);
    expect(m).not.toBeNull();
    expect(Number(m![2])).toBeLessThan(Number(m![1]));
    const after = listWorkshops(db, { conversationId })[0];
    expect(after.versions).toHaveLength(2);
    const v2 = JSON.parse(readWorkshopVersion(db, after.latestArtifactId).bytes.toString('utf8'));
    expect(v2.params.counters).toBe(2);
    expect(v2.params.seed).toBe(42);
  });
});
