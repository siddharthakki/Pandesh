/**
 * The Simulation Lab's first model: customers arriving at a stall with one shared queue and one or more serving
 * counters (first come, first served, any free counter). A small discrete-event simulation with a seeded random
 * generator, so the same parameters and seed always give the same customers, waits and averages — in Core (tool
 * results quote these numbers) and in the window (which animates the very same run).
 *
 * Simulated outcomes, not predictions: the assumptions are part of every result and are always shown.
 * Other models (physics, traffic, warehouse) would be further entries of SIMULATION_MODELS; only `queue` exists.
 * Pure TypeScript (no Node, no DOM).
 */

export const SIMULATION_FORMAT = 'pandesh.simulation';
export const SIMULATION_MODELS = ['queue'] as const;
export type SimulationModel = typeof SIMULATION_MODELS[number];

export interface QueueParams {
  /** Mean minutes between two arrivals. */
  arrivalEveryMinutes: number;
  /** Mean minutes to serve one customer. */
  serviceMinutes: number;
  counters: number;
  /** How long customers keep arriving (the stall then serves whoever is already waiting). */
  durationMinutes: number;
  /** random = Poisson arrivals (exponential gaps); fixed = exactly every N minutes. */
  arrivalPattern: 'random' | 'fixed';
  /** random = exponential service times; fixed = exactly N minutes each. */
  servicePattern: 'random' | 'fixed';
  seed: number;
  /** A customer who finds this many already waiting leaves; null = nobody leaves. */
  maxQueue: number | null;
}

export interface SimulationSpec {
  format: typeof SIMULATION_FORMAT;
  version: 1;
  model: SimulationModel;
  title: string;
  params: QueueParams;
  notes: string[];
}

export const QUEUE_BOUNDS: Record<'arrivalEveryMinutes' | 'serviceMinutes' | 'counters' | 'durationMinutes' | 'seed', { min: number; max: number; integer?: boolean }> = {
  arrivalEveryMinutes: { min: 0.05, max: 240 },
  serviceMinutes: { min: 0.05, max: 240 },
  counters: { min: 1, max: 20, integer: true },
  durationMinutes: { min: 1, max: 1_440 },
  seed: { min: 0, max: 2 ** 32 - 1, integer: true },
};

export const DEFAULT_QUEUE: QueueParams = { arrivalEveryMinutes: 2, serviceMinutes: 3, counters: 1, durationMinutes: 120, arrivalPattern: 'random', servicePattern: 'random', seed: 42, maxQueue: null };
const MAX_CUSTOMERS = 10_000;

type Result<T> = { ok: true; value: T; warnings: string[] } | { ok: false; errors: string[] };
const isRecord = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown) => { const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v; return typeof n === 'number' && Number.isFinite(n) ? n : null; };

function cleanParams(raw: Record<string, unknown>, base: QueueParams, errors: string[]): QueueParams {
  const out: QueueParams = { ...base };
  for (const [key, bound] of Object.entries(QUEUE_BOUNDS) as Array<[keyof typeof QUEUE_BOUNDS, { min: number; max: number; integer?: boolean }]>) {
    if (raw[key] === undefined) continue;
    let n = num(raw[key]);
    if (n === null) { errors.push(`${key} must be a number`); continue; }
    if (bound.integer) n = Math.round(n);
    if (n < bound.min || n > bound.max) { errors.push(`${key} must be between ${bound.min} and ${bound.max} (got ${n})`); continue; }
    out[key] = n;
  }
  for (const key of ['arrivalPattern', 'servicePattern'] as const) {
    if (raw[key] === undefined) continue;
    const v = String(raw[key]).toLowerCase();
    if (v !== 'random' && v !== 'fixed') { errors.push(`${key} must be "random" or "fixed"`); continue; }
    out[key] = v;
  }
  if (raw.maxQueue !== undefined) {
    const n = raw.maxQueue === null ? null : num(raw.maxQueue);
    if (raw.maxQueue !== null && (n === null || n < 1 || n > 1_000)) errors.push('maxQueue must be 1–1000, or null for no limit');
    else out.maxQueue = n === null ? null : Math.round(n);
  }
  const expected = out.durationMinutes / out.arrivalEveryMinutes;
  if (expected > MAX_CUSTOMERS) errors.push(`about ${Math.round(expected)} customers would arrive; shorten the duration or space the arrivals (limit ${MAX_CUSTOMERS})`);
  return out;
}

export function validateSimulation(raw: unknown): Result<SimulationSpec> {
  if (!isRecord(raw)) return { ok: false, errors: ['a simulation must be an object'] };
  const errors: string[] = [];
  const model = String(raw.model ?? 'queue');
  if (!(SIMULATION_MODELS as readonly string[]).includes(model)) return { ok: false, errors: [`model must be one of ${SIMULATION_MODELS.join(', ')}`] };
  const source = isRecord(raw.params) ? raw.params : raw;
  const params = cleanParams(source, DEFAULT_QUEUE, errors);
  if (errors.length) return { ok: false, errors };
  const title = typeof raw.title === 'string' && raw.title.trim() ? raw.title.replace(/\s+/g, ' ').trim().slice(0, 120) : 'Queue simulation';
  const notes = (Array.isArray(raw.notes) ? raw.notes : []).filter((n): n is string => typeof n === 'string').map((n) => n.slice(0, 200)).slice(0, 5);
  return { ok: true, value: { format: SIMULATION_FORMAT, version: 1, model: 'queue', title, params, notes }, warnings: [] };
}

export function parseSimulationFile(text: string): Result<SimulationSpec> {
  try {
    const raw = JSON.parse(text) as Record<string, unknown>;
    if (raw.format !== SIMULATION_FORMAT) return { ok: false, errors: ['not a Pandesh simulation file'] };
    return validateSimulation(raw);
  } catch { return { ok: false, errors: ['the simulation file is not valid JSON'] }; }
}

export interface SimulationChange { field: string; from: string; to: string }

/**
 * A change in plain terms: `set` gives new values; `adjust` scales or adds ("double the arrival rate" =
 * arrivalRateTimes 2, which halves the minutes between arrivals; "add another counter" = addCounters 1).
 */
export function applySimulationChanges(spec: SimulationSpec, change: unknown): { ok: true; spec: SimulationSpec; changes: SimulationChange[] } | { ok: false; errors: string[] } {
  if (!isRecord(change)) return { ok: false, errors: ['give set: {…} and/or adjust: {…}'] };
  const errors: string[] = [];
  const next: SimulationSpec = { ...spec, params: { ...spec.params } };
  if (isRecord(change.set)) next.params = cleanParams(change.set, next.params, errors);
  if (isRecord(change.adjust)) {
    const a = change.adjust;
    const draft: Record<string, unknown> = {};
    const rate = num(a.arrivalRateTimes);
    if (a.arrivalRateTimes !== undefined) { if (rate === null || rate <= 0) errors.push('arrivalRateTimes must be a positive number'); else draft.arrivalEveryMinutes = Math.round((next.params.arrivalEveryMinutes / rate) * 1000) / 1000; }
    const service = num(a.serviceTimeTimes);
    if (a.serviceTimeTimes !== undefined) { if (service === null || service <= 0) errors.push('serviceTimeTimes must be a positive number'); else draft.serviceMinutes = Math.round(next.params.serviceMinutes * service * 1000) / 1000; }
    const add = num(a.addCounters);
    if (a.addCounters !== undefined) { if (add === null) errors.push('addCounters must be a number'); else draft.counters = next.params.counters + Math.round(add); }
    const longer = num(a.durationTimes);
    if (a.durationTimes !== undefined) { if (longer === null || longer <= 0) errors.push('durationTimes must be positive'); else draft.durationMinutes = Math.round(next.params.durationMinutes * longer); }
    next.params = cleanParams(draft, next.params, errors);
  }
  if (typeof change.title === 'string' && change.title.trim()) next.title = change.title.trim().slice(0, 120);
  if (errors.length) return { ok: false, errors };
  const changes: SimulationChange[] = [];
  for (const key of Object.keys(next.params) as Array<keyof QueueParams>) {
    if (next.params[key] !== spec.params[key]) changes.push({ field: key, from: String(spec.params[key]), to: String(next.params[key]) });
  }
  if (next.title !== spec.title) changes.push({ field: 'title', from: spec.title, to: next.title });
  if (!changes.length) return { ok: false, errors: ['that changes nothing'] };
  return { ok: true, spec: next, changes };
}

/** mulberry32: a small, well-known seeded generator (same seed, same sequence, everywhere). */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SimCustomer { id: number; arrive: number; start: number | null; end: number | null; counter: number | null; balked: boolean }

export interface QueueMetrics {
  arrived: number;
  served: number;
  leftWithoutService: number;
  averageWaitMinutes: number;
  p90WaitMinutes: number;
  maxWaitMinutes: number;
  averageQueueLength: number;
  maxQueueLength: number;
  /** Share of counter time spent serving, 0–1. */
  utilization: number;
  servedPerHour: number;
  /** Minutes the stall had to keep serving after arrivals stopped. */
  overrunMinutes: number;
  endMinutes: number;
}

export interface QueueRun { customers: SimCustomer[]; metrics: QueueMetrics; queueSeries: Array<[number, number]> }

/** Runs the whole simulation. Deterministic for the given parameters (including the seed). */
export function runQueue(params: QueueParams): QueueRun {
  const rnd = seededRandom(params.seed);
  const draw = (mean: number, pattern: 'random' | 'fixed') => (pattern === 'fixed' ? mean : -mean * Math.log(1 - rnd()));
  const customers: SimCustomer[] = [];
  let t = draw(params.arrivalEveryMinutes, params.arrivalPattern);
  while (t <= params.durationMinutes && customers.length < MAX_CUSTOMERS) {
    customers.push({ id: customers.length + 1, arrive: t, start: null, end: null, counter: null, balked: false });
    t += draw(params.arrivalEveryMinutes, params.arrivalPattern);
  }
  const free = Array.from({ length: params.counters }, () => 0);
  const services = customers.map(() => draw(params.serviceMinutes, params.servicePattern));
  // FIFO with any free counter: the next customer starts when they have arrived and the earliest counter is free.
  const startsSoFar: number[] = [];
  for (const [i, c] of customers.entries()) {
    if (params.maxQueue !== null) {
      // People still waiting when this customer arrives (arrived before, not yet started).
      let waiting = 0;
      for (let j = i - 1; j >= 0 && waiting <= params.maxQueue; j -= 1) { const s = startsSoFar[j]; if (!customers[j].balked && s !== undefined && s > c.arrive) waiting += 1; }
      if (waiting >= params.maxQueue) { c.balked = true; startsSoFar[i] = -1; continue; }
    }
    let k = 0;
    for (let j = 1; j < free.length; j += 1) if (free[j] < free[k]) k = j;
    const start = Math.max(c.arrive, free[k]);
    c.start = start; c.end = start + services[i]; c.counter = k;
    free[k] = c.end;
    startsSoFar[i] = start;
  }
  const served = customers.filter((c) => !c.balked);
  const endMinutes = Math.max(params.durationMinutes, ...served.map((c) => c.end ?? 0));
  const waits = served.map((c) => (c.start ?? 0) - c.arrive).sort((a, b) => a - b);
  // Queue length over time from arrival and start events (time-weighted average).
  const events: Array<[number, number]> = [];
  for (const c of served) { events.push([c.arrive, 1]); events.push([c.start ?? c.arrive, -1]); }
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let q = 0; let last = 0; let area = 0; let maxQ = 0;
  const series: Array<[number, number]> = [[0, 0]];
  for (const [time, delta] of events) { area += q * (time - last); last = time; q += delta; maxQ = Math.max(maxQ, q); series.push([time, q]); }
  area += q * (endMinutes - last);
  const busy = served.reduce((s, c) => s + ((c.end ?? 0) - (c.start ?? 0)), 0);
  const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
  const metrics: QueueMetrics = {
    arrived: customers.length,
    served: served.length,
    leftWithoutService: customers.length - served.length,
    averageWaitMinutes: round(waits.length ? waits.reduce((s, w) => s + w, 0) / waits.length : 0),
    p90WaitMinutes: round(waits.length ? waits[Math.min(waits.length - 1, Math.floor(waits.length * 0.9))] : 0),
    maxWaitMinutes: round(waits.length ? waits[waits.length - 1] : 0),
    averageQueueLength: round(endMinutes > 0 ? area / endMinutes : 0),
    maxQueueLength: maxQ,
    utilization: round(endMinutes > 0 ? busy / (params.counters * endMinutes) : 0, 3),
    servedPerHour: round(endMinutes > 0 ? (served.length / endMinutes) * 60 : 0, 1),
    overrunMinutes: round(Math.max(0, endMinutes - params.durationMinutes), 1),
    endMinutes: round(endMinutes, 1),
  };
  return { customers, metrics, queueSeries: series };
}

/** What has happened by simulated minute t (for the animation and its live numbers). */
export function stateAt(run: QueueRun, t: number) {
  let waiting = 0; let serving = 0; let done = 0; let waitSum = 0; let started = 0;
  const atCounter: Array<number | null> = [];
  for (const c of run.customers) {
    if (c.balked || c.arrive > t) continue;
    if (c.start !== null && c.start <= t) {
      started += 1; waitSum += c.start - c.arrive;
      if (c.end !== null && c.end <= t) done += 1; else { serving += 1; if (c.counter !== null) atCounter[c.counter] = c.id; }
    } else waiting += 1;
  }
  return { t, waiting, serving, done, averageWaitSoFar: started ? Math.round((waitSum / started) * 100) / 100 : 0, atCounter };
}

/** The assumptions behind a result, in plain words; always shown with it. */
export function queueAssumptions(p: QueueParams): string[] {
  return [
    p.arrivalPattern === 'random' ? `Customers arrive at random, on average every ${p.arrivalEveryMinutes} min (a Poisson process).` : `A customer arrives exactly every ${p.arrivalEveryMinutes} min.`,
    p.servicePattern === 'random' ? `Serving takes ${p.serviceMinutes} min on average, varying at random (exponential).` : `Serving takes exactly ${p.serviceMinutes} min.`,
    `${p.counters} counter${p.counters === 1 ? '' : 's'}, one shared queue, first come first served, any free counter.`,
    p.maxQueue === null ? 'Nobody leaves the queue.' : `A customer who finds ${p.maxQueue} or more waiting leaves.`,
    `Arrivals for ${p.durationMinutes} min; whoever is waiting then is still served. Random seed ${p.seed} (same seed, same result).`,
    'A simulation of these assumptions, not a prediction of a real day: real arrivals change with the hour, the weather and the queue itself.',
  ];
}

export function describeMetrics(m: QueueMetrics): string {
  return `${m.arrived} arrived, ${m.served} served${m.leftWithoutService ? `, ${m.leftWithoutService} left without service` : ''}; average wait ${m.averageWaitMinutes} min (90% waited at most ${m.p90WaitMinutes} min, longest ${m.maxWaitMinutes} min); average queue ${m.averageQueueLength}, longest ${m.maxQueueLength}; counters busy ${Math.round(m.utilization * 100)}% of the time; ${m.servedPerHour} served per hour; ${m.overrunMinutes} min of serving after arrivals stopped.`;
}
