import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import { atomicWrite, taskDir } from './M15AutonomousWork';
import type { GovernedModelRequest, GovernedModelResult } from '../agent/GovernedModelExecutionTypes';
import type { GovernedModelDispatchSeam } from '../agent/LocalFirstModelDispatchRouter';

/**
 * M42 slice 1 — durable TaskControlState and task-level BudgetLedger, OBSERVE ONLY.
 *
 * This is the single task-level accounting authority for autonomous execution.
 * It lives beside the existing M15 durable task record (same task directory,
 * keyed by the same `taskId`) and deliberately duplicates none of the task's
 * own fields: goal, state, attempt counter and routing snapshot remain owned
 * by `AutonomousTask`.
 *
 *   <task dir>/control.json          TaskControlState (limits, deadline, sequences, consumption projection)
 *   <task dir>/budget-ledger.jsonl   append-only reserve -> commit/release audit trail
 *
 * Observe-only contract: nothing here can block, delay or fail execution.
 * `reserve()` reports what WOULD have been refused (`WOULD_BLOCK`) and the
 * caller proceeds regardless. Stage-local limits elsewhere keep functioning and
 * are not the future global authority.
 *
 * The ledger file is authoritative. `TaskControlState.consumption` is a
 * projection rebuilt from it on every open, so a crash between the append and
 * the state write can never lose or reset committed consumption.
 */

export const TASK_CONTROL_SCHEMA_VERSION = 1 as const;
export const TASK_BUDGET_LEDGER_SCHEMA_VERSION = 1 as const;
/** Task contract/version reference recorded in control state; bump when admission semantics change. */
export const TASK_CONTROL_CONTRACT_VERSION = 'm42.observe.v1' as const;

export const BUDGET_RESOURCES = [
  'model_call',
  'tool_call',
  'recovery_attempt',
  'validation_repair',
  'model_escalation',
  'no_progress',
  /** Real elapsed time of an attempt, INCLUDING human approval waits. Measurement only; never a budget input. */
  'wall_clock_ms',
  /** Attempt elapsed time minus human approval waits: what KarkeDikha actually spent executing. The future time budget's input. */
  'active_execution_ms',
  /** Human wait time inside an attempt (proposal review, execution approval, elevated confirmation). */
  'waiting_for_approval_ms',
  /** Optional in v1: only recorded where a provider exposes reliable usage. Not wired yet. */
  'model_tokens',
] as const;
export type BudgetResource = typeof BUDGET_RESOURCES[number];

export interface TaskBudgetLimits {
  /**
   * Budget for ACTIVE autonomous execution (`active_execution_ms`). Human approval
   * waits and idle queue time never count against it.
   */
  wallClockMs: number;
  modelCalls: number;
  toolCalls: number;
  /** Per failure class, not a task-wide total. */
  recoveryAttemptsPerFailureClass: number;
  validationRepairs: number;
  modelEscalations: number;
  noProgress: number;
  modelTokens?: number;
}

/**
 * PROVISIONAL observation thresholds. They exist so `WOULD_BLOCK` can be
 * reported while real consumption is being measured; they must be calibrated
 * from ledger data before any enforcement slice relies on them.
 */
export const DEFAULT_TASK_BUDGET_LIMITS: Readonly<TaskBudgetLimits> = Object.freeze({
  wallClockMs: 4 * 60 * 60 * 1000,
  modelCalls: 200,
  toolCalls: 500,
  recoveryAttemptsPerFailureClass: 3,
  validationRepairs: 6,
  modelEscalations: 3,
  noProgress: 4,
});

export interface TaskContractReference {
  version: string;
  /** `AutonomousTask.schemaVersion` this control state was created against. */
  taskSchemaVersion: number;
  /** `AutonomousTask.inputIntegrity.inputDigest` when known; never task text. */
  inputDigest?: string;
  instructionRevision: number;
}

export interface TaskConsumptionSnapshot {
  /** Highest ledger sequence folded into this projection. */
  throughLedgerSeq: number;
  totals: Partial<Record<BudgetResource, number>>;
  recoveryByFailureClass: Record<string, number>;
}

export interface TaskControlState {
  schemaVersion: typeof TASK_CONTROL_SCHEMA_VERSION;
  taskId: string;
  createdAt: string;
  /** Only `observe` exists in this slice. */
  enforcement: 'observe';
  contract: TaskContractReference;
  /** Set once, on the first attempt ever begun. A restart never resets it. */
  startedAt?: string;
  /**
   * INFORMATIONAL ONLY: startedAt + wallClockMs on the task-age clock. It includes
   * human wait time, so it must NEVER be enforced; the budget is `active_execution_ms`.
   */
  deadlineAt?: string;
  limits: TaskBudgetLimits;
  attempts: { sequence: number; ids: string[] };
  /** Home for the future decision log; nothing allocates decisions in this slice. */
  decisions: { sequence: number };
  consumption: TaskConsumptionSnapshot;
}

export type LedgerPhase = 'reserve' | 'commit' | 'release';
export type AdmissionVerdict = 'ADMIT' | 'WOULD_BLOCK';

export interface WouldBlockDetail {
  limit: string;
  limitValue: number;
  projected: number;
}

export interface LedgerEntry {
  schemaVersion: typeof TASK_BUDGET_LEDGER_SCHEMA_VERSION;
  seq: number;
  phase: LedgerPhase;
  reservationId: string;
  taskId: string;
  attemptId?: string;
  stage: string;
  resource: BudgetResource;
  amount: number;
  timestamp: string;
  /** Ledger instance (process incarnation) that wrote the entry. */
  instanceId: string;
  model?: string;
  provider?: string;
  reason?: string;
  failureClass?: string;
  admission?: AdmissionVerdict;
  wouldBlock?: WouldBlockDetail;
  outcome?: string;
}

export interface ReserveRequest {
  /** Unique per real consumption; a repeat of the same key is a no-op. */
  idempotencyKey: string;
  attemptId?: string;
  stage: string;
  resource: BudgetResource;
  amount?: number;
  model?: string;
  provider?: string;
  reason?: string;
  failureClass?: string;
}

export interface Reservation {
  reservationId: string;
  admission: AdmissionVerdict;
  /** True when this key was already recorded; nothing new was written. */
  duplicate: boolean;
  wouldBlock?: WouldBlockDetail;
}

export interface CommitDetail {
  /** Actual amount if it differs from the reserved estimate. */
  amount?: number;
  model?: string;
  provider?: string;
  outcome?: string;
  reason?: string;
}

export interface WouldBlockObservation extends WouldBlockDetail {
  reservationId: string;
  resource: BudgetResource;
  stage: string;
  attemptId?: string;
  failureClass?: string;
  observedAt: string;
}

export type ResourceTotals = Record<BudgetResource, number>;

/** Answers: for task T, what has autonomous execution consumed, and in which stages? */
export interface TaskBudgetSummary {
  taskId: string;
  mode: 'observe';
  startedAt?: string;
  deadlineAt?: string;
  /** Real elapsed time since the first attempt began (includes waits); 0 before any attempt. */
  taskAgeMs: number;
  attempts: number;
  limits: TaskBudgetLimits;
  /** Committed consumption, including calls interrupted by a restart (charged, never refunded). */
  totals: ResourceTotals;
  byStage: Record<string, Partial<Record<BudgetResource, number>>>;
  recoveryByFailureClass: Record<string, number>;
  /** Reserved by a live instance and not yet committed. */
  inFlight: Partial<Record<BudgetResource, number>>;
  /** Reservations a prior process never settled; counted as consumed. */
  unresolvedCharged: number;
  wouldBlockCount: number;
  wouldBlock: WouldBlockObservation[];
  ledgerEntries: number;
  corruptLedgerLines: number;
}

const MAX_REPORTED_WOULD_BLOCK = 50;
const TIME_RESOURCES: ReadonlySet<BudgetResource> = new Set<BudgetResource>(['wall_clock_ms', 'active_execution_ms', 'waiting_for_approval_ms']);

interface Slot {
  reserve: LedgerEntry;
  settled?: LedgerEntry;
}

interface Tally {
  totals: ResourceTotals;
  byStage: Record<string, Partial<Record<BudgetResource, number>>>;
  byClass: Record<string, number>;
}

function emptyTotals(): ResourceTotals {
  return Object.fromEntries(BUDGET_RESOURCES.map(resource => [resource, 0])) as ResourceTotals;
}

function emptyTally(): Tally {
  return { totals: emptyTotals(), byStage: {}, byClass: {} };
}

function addToTally(tally: Tally, entry: LedgerEntry, amount: number): void {
  tally.totals[entry.resource] += amount;
  const stage = (tally.byStage[entry.stage] ??= {});
  stage[entry.resource] = (stage[entry.resource] ?? 0) + amount;
  if (entry.resource === 'recovery_attempt') {
    const cls = entry.failureClass ?? 'unclassified';
    tally.byClass[cls] = (tally.byClass[cls] ?? 0) + amount;
  }
}

function boundedText(value: string | undefined, limit = 200): string | undefined {
  if (value === undefined) return undefined;
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function reservationIdFor(resource: BudgetResource, idempotencyKey: string): string {
  return `${resource}:${boundedText(idempotencyKey, 300)}`;
}

export interface OpenTaskBudgetLedgerOptions {
  repositoryRoot: string;
  taskId: string;
  contract: Omit<TaskContractReference, 'version'> & { version?: string };
  limits?: Partial<TaskBudgetLimits>;
  now?: () => Date;
  /** Invoked (best effort) the first time each resource would have been refused. */
  onWouldBlock?: (observation: WouldBlockObservation) => void;
}

export class TaskBudgetLedger {
  private static readonly locks = new Map<string, Promise<void>>();

  private readonly slots = new Map<string, Slot>();
  private entryCount = 0;
  private corruptLines = 0;
  private nextSeq = 1;
  private readonly instanceId = crypto.randomBytes(6).toString('hex');
  private readonly reportedWouldBlock = new Set<string>();

  private constructor(
    private readonly dir: string,
    private stateValue: TaskControlState,
    private readonly now: () => Date,
    private readonly onWouldBlock?: (observation: WouldBlockObservation) => void,
  ) {}

  /** Opens (creating on first use) the ledger for one task. State and consumption survive restarts. */
  static async open(options: OpenTaskBudgetLedgerOptions): Promise<TaskBudgetLedger> {
    const dir = taskDir(options.repositoryRoot, options.taskId);
    const now = options.now ?? (() => new Date());
    const existing = await readControlState(dir);
    const state: TaskControlState = existing ?? {
      schemaVersion: TASK_CONTROL_SCHEMA_VERSION,
      taskId: options.taskId,
      createdAt: now().toISOString(),
      enforcement: 'observe',
      contract: { ...options.contract, version: options.contract.version ?? TASK_CONTROL_CONTRACT_VERSION },
      // Limits are frozen at creation: a reload never grants a fresh or changed budget.
      limits: { ...DEFAULT_TASK_BUDGET_LIMITS, ...definedOnly(options.limits) },
      attempts: { sequence: 0, ids: [] },
      decisions: { sequence: 0 },
      consumption: { throughLedgerSeq: 0, totals: {}, recoveryByFailureClass: {} },
    };
    const ledger = new TaskBudgetLedger(dir, state, now, options.onWouldBlock);
    await ledger.withLock(async () => {
      await ledger.loadEntries();
      await ledger.persistState();
    });
    return ledger;
  }

  /** Read-only summary for a task; undefined when the task has no control state. */
  static async readSummary(repositoryRoot: string, taskId: string): Promise<TaskBudgetSummary | undefined> {
    const dir = taskDir(repositoryRoot, taskId);
    const state = await readControlState(dir);
    if (!state) return undefined;
    const ledger = new TaskBudgetLedger(dir, state, () => new Date());
    await ledger.loadEntries();
    return ledger.summary();
  }

  get state(): Readonly<TaskControlState> {
    return this.stateValue;
  }

  /** Registers an attempt. Idempotent; the first call ever fixes start and deadline. */
  async beginAttempt(attemptId: string, contract?: Partial<TaskContractReference>): Promise<void> {
    await this.withLock(async () => {
      const state = this.stateValue;
      const startedAt = state.startedAt ?? this.now().toISOString();
      const isNew = !state.attempts.ids.includes(attemptId);
      this.stateValue = {
        ...state,
        startedAt,
        deadlineAt: state.deadlineAt ?? new Date(Date.parse(startedAt) + state.limits.wallClockMs).toISOString(),
        contract: { ...state.contract, ...definedOnly(contract) },
        attempts: isNew
          ? { sequence: state.attempts.sequence + 1, ids: [...state.attempts.ids, attemptId] }
          : state.attempts,
      };
      await this.persistState();
    });
  }

  /** Allocates the next decision sequence number. Reserved for the future controller. */
  async allocateDecisionSequence(): Promise<number> {
    return this.withLock(async () => {
      const sequence = this.stateValue.decisions.sequence + 1;
      this.stateValue = { ...this.stateValue, decisions: { sequence } };
      await this.persistState();
      return sequence;
    });
  }

  /**
   * Reserve. In observe-only mode this NEVER refuses: it records whether the
   * request would have been admitted and always lets the caller proceed.
   */
  async reserve(request: ReserveRequest): Promise<Reservation> {
    return this.withLock(async () => {
      const resource = request.resource;
      const reservationId = reservationIdFor(resource, request.idempotencyKey);
      const existing = this.slots.get(reservationId);
      if (existing) {
        return { reservationId, admission: existing.reserve.admission ?? 'ADMIT', duplicate: true, wouldBlock: existing.reserve.wouldBlock };
      }
      const amount = request.amount ?? 1;
      const timestamp = this.now();
      const wouldBlock = this.evaluate(resource, amount, request.failureClass, timestamp.getTime());
      const entry: LedgerEntry = {
        schemaVersion: TASK_BUDGET_LEDGER_SCHEMA_VERSION,
        seq: this.nextSeq,
        phase: 'reserve',
        reservationId,
        taskId: this.stateValue.taskId,
        attemptId: request.attemptId,
        stage: boundedText(request.stage, 80) ?? 'unknown',
        resource,
        amount,
        timestamp: timestamp.toISOString(),
        instanceId: this.instanceId,
        model: boundedText(request.model),
        provider: boundedText(request.provider, 80),
        reason: boundedText(request.reason),
        failureClass: boundedText(request.failureClass, 120),
        admission: wouldBlock ? 'WOULD_BLOCK' : 'ADMIT',
        wouldBlock,
      };
      await this.append(entry);
      if (wouldBlock) this.notifyWouldBlock(entry);
      return { reservationId, admission: entry.admission!, duplicate: false, wouldBlock };
    });
  }

  /** Commit: the consumption is real. Idempotent; a settled reservation is never re-settled. */
  async commit(reservationId: string, detail: CommitDetail = {}): Promise<void> {
    await this.settle('commit', reservationId, detail);
  }

  /** Release: nothing was consumed (the operation provably never started). */
  async release(reservationId: string, reason?: string): Promise<void> {
    await this.settle('release', reservationId, { reason, outcome: 'released' });
  }

  /** Reserve + commit for a consumption that is observed rather than pre-announced (e.g. a tool call). */
  async record(request: ReserveRequest, detail: CommitDetail = {}): Promise<Reservation> {
    const reservation = await this.reserve(request);
    if (!reservation.duplicate) await this.commit(reservation.reservationId, detail);
    return reservation;
  }

  summary(): TaskBudgetSummary {
    const committed = this.tally('committed');
    const pending = this.tally('inflight');
    const wouldBlock: WouldBlockObservation[] = [];
    let wouldBlockCount = 0;
    let unresolvedCharged = 0;
    for (const slot of this.slots.values()) {
      const { reserve } = slot;
      if (reserve.wouldBlock) {
        wouldBlockCount += 1;
        if (wouldBlock.length < MAX_REPORTED_WOULD_BLOCK) wouldBlock.push(toObservation(reserve));
      }
      if (!slot.settled && reserve.instanceId !== this.instanceId) unresolvedCharged += 1;
    }
    const inFlight: Partial<Record<BudgetResource, number>> = {};
    for (const resource of BUDGET_RESOURCES) {
      if (pending.totals[resource] > 0) inFlight[resource] = pending.totals[resource];
    }
    return {
      taskId: this.stateValue.taskId,
      mode: 'observe',
      startedAt: this.stateValue.startedAt,
      deadlineAt: this.stateValue.deadlineAt,
      taskAgeMs: this.stateValue.startedAt ? Math.max(0, this.now().getTime() - Date.parse(this.stateValue.startedAt)) : 0,
      attempts: this.stateValue.attempts.sequence,
      limits: this.stateValue.limits,
      totals: committed.totals,
      byStage: committed.byStage,
      recoveryByFailureClass: committed.byClass,
      inFlight,
      unresolvedCharged,
      wouldBlockCount,
      wouldBlock,
      ledgerEntries: this.entryCount,
      corruptLedgerLines: this.corruptLines,
    };
  }

  // ── internals ────────────────────────────────────────────────────────────

  private async settle(phase: 'commit' | 'release', reservationId: string, detail: CommitDetail): Promise<void> {
    await this.withLock(async () => {
      const slot = this.slots.get(reservationId);
      if (!slot || slot.settled) return;
      const { reserve } = slot;
      await this.append({
        schemaVersion: TASK_BUDGET_LEDGER_SCHEMA_VERSION,
        seq: this.nextSeq,
        phase,
        reservationId,
        taskId: reserve.taskId,
        attemptId: reserve.attemptId,
        stage: reserve.stage,
        resource: reserve.resource,
        amount: phase === 'commit' ? detail.amount ?? reserve.amount : 0,
        timestamp: this.now().toISOString(),
        instanceId: this.instanceId,
        model: boundedText(detail.model) ?? reserve.model,
        provider: boundedText(detail.provider, 80) ?? reserve.provider,
        reason: boundedText(detail.reason) ?? reserve.reason,
        failureClass: reserve.failureClass,
        outcome: boundedText(detail.outcome, 120),
      });
    });
  }

  private evaluate(resource: BudgetResource, amount: number, failureClass: string | undefined, nowMs: number): WouldBlockDetail | undefined {
    const { limits } = this.stateValue;
    const committed = this.tally('committed');
    const pending = this.tally('inflight');
    // Time is measured on ACTIVE execution only. It is committed when an attempt
    // finishes, so this reflects prior attempts, not the one currently running.
    const activeMs = committed.totals.active_execution_ms;
    if (!TIME_RESOURCES.has(resource) && activeMs > limits.wallClockMs) {
      return { limit: 'active_execution_budget', limitValue: limits.wallClockMs, projected: activeMs };
    }
    const used = committed.totals[resource] + pending.totals[resource];
    let limitName: string = resource;
    let limitValue: number | undefined;
    let current = used;
    switch (resource) {
      case 'model_call': limitValue = limits.modelCalls; break;
      case 'tool_call': limitValue = limits.toolCalls; break;
      case 'validation_repair': limitValue = limits.validationRepairs; break;
      case 'model_escalation': limitValue = limits.modelEscalations; break;
      case 'no_progress': limitValue = limits.noProgress; break;
      case 'active_execution_ms': limitValue = limits.wallClockMs; break;
      // wall_clock_ms and waiting_for_approval_ms are measurements, never limits.
      case 'model_tokens': limitValue = limits.modelTokens; break;
      case 'recovery_attempt': {
        const cls = failureClass ?? 'unclassified';
        limitName = `recovery_attempt:${cls}`;
        limitValue = limits.recoveryAttemptsPerFailureClass;
        current = (committed.byClass[cls] ?? 0) + (pending.byClass[cls] ?? 0);
        break;
      }
    }
    if (limitValue === undefined) return undefined;
    const projected = current + amount;
    return projected > limitValue ? { limit: limitName, limitValue, projected } : undefined;
  }

  /** `committed` = settled commits plus reservations a prior instance abandoned; `inflight` = this instance's open reservations. */
  private tally(kind: 'committed' | 'inflight'): Tally {
    const tally = emptyTally();
    for (const slot of this.slots.values()) {
      const { reserve, settled } = slot;
      if (settled) {
        if (kind === 'committed' && settled.phase === 'commit') addToTally(tally, reserve, settled.amount);
        continue;
      }
      const ownedByThisInstance = reserve.instanceId === this.instanceId;
      // A reservation whose owner is gone may have reached the provider: charge it.
      if (kind === 'committed' && !ownedByThisInstance) addToTally(tally, reserve, reserve.amount);
      if (kind === 'inflight' && ownedByThisInstance) addToTally(tally, reserve, reserve.amount);
    }
    return tally;
  }

  private notifyWouldBlock(entry: LedgerEntry): void {
    const key = entry.wouldBlock?.limit ?? entry.resource;
    if (this.reportedWouldBlock.has(key)) return;
    this.reportedWouldBlock.add(key);
    try {
      this.onWouldBlock?.(toObservation(entry));
    } catch {
      // Observe-only: a listener failure must never affect execution.
    }
  }

  private async append(entry: LedgerEntry): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    await fs.appendFile(path.join(this.dir, 'budget-ledger.jsonl'), `${JSON.stringify(entry)}\n`, 'utf8');
    this.nextSeq = entry.seq + 1;
    this.entryCount += 1;
    this.fold(entry);
    if (entry.phase !== 'reserve') await this.persistState();
  }

  private fold(entry: LedgerEntry): void {
    if (entry.phase === 'reserve') {
      if (!this.slots.has(entry.reservationId)) this.slots.set(entry.reservationId, { reserve: entry });
      return;
    }
    const slot = this.slots.get(entry.reservationId);
    // First settlement wins; a later duplicate or an orphan settle is ignored.
    if (slot && !slot.settled) slot.settled = entry;
  }

  private async loadEntries(): Promise<void> {
    let raw = '';
    try {
      raw = await fs.readFile(path.join(this.dir, 'budget-ledger.jsonl'), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    this.slots.clear();
    this.entryCount = 0;
    this.corruptLines = 0;
    let highest = 0;
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as LedgerEntry;
        if (entry.schemaVersion !== TASK_BUDGET_LEDGER_SCHEMA_VERSION || typeof entry.seq !== 'number') throw new Error('bad_entry');
        this.entryCount += 1;
        highest = Math.max(highest, entry.seq);
        this.fold(entry);
      } catch {
        // A torn final line from a crash mid-append must not discard the rest.
        this.corruptLines += 1;
      }
    }
    this.nextSeq = highest + 1;
  }

  private async persistState(): Promise<void> {
    const committed = this.tally('committed');
    const totals: Partial<Record<BudgetResource, number>> = {};
    for (const resource of BUDGET_RESOURCES) {
      if (committed.totals[resource] > 0) totals[resource] = committed.totals[resource];
    }
    this.stateValue = {
      ...this.stateValue,
      consumption: { throughLedgerSeq: this.nextSeq - 1, totals, recoveryByFailureClass: committed.byClass },
    };
    await atomicWrite(path.join(this.dir, 'control.json'), `${JSON.stringify(this.stateValue, null, 2)}\n`);
  }

  private async withLock<T>(action: () => Promise<T>): Promise<T> {
    const key = this.dir;
    const previous = TaskBudgetLedger.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>(resolve => { release = resolve; });
    const queued = previous.then(() => current);
    TaskBudgetLedger.locks.set(key, queued);
    await previous;
    try {
      return await action();
    } finally {
      release();
      if (TaskBudgetLedger.locks.get(key) === queued) TaskBudgetLedger.locks.delete(key);
    }
  }
}

function toObservation(entry: LedgerEntry): WouldBlockObservation {
  return {
    ...entry.wouldBlock!,
    reservationId: entry.reservationId,
    resource: entry.resource,
    stage: entry.stage,
    attemptId: entry.attemptId,
    failureClass: entry.failureClass,
    observedAt: entry.timestamp,
  };
}

function definedOnly<T extends object>(value: T | undefined): Partial<T> {
  if (!value) return {};
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Partial<T>;
}

async function readControlState(dir: string): Promise<TaskControlState | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(dir, 'control.json'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const parsed = JSON.parse(raw) as TaskControlState;
  if (parsed.schemaVersion !== TASK_CONTROL_SCHEMA_VERSION) {
    throw new Error(`unsupported_task_control_schema:${String(parsed.schemaVersion)}`);
  }
  return parsed;
}

/** Compact one-line rendering for logs. */
export function formatBudgetSummary(summary: TaskBudgetSummary): string {
  const t = summary.totals;
  return `budget_observed mode=observe model_calls=${t.model_call} tool_calls=${t.tool_call} `
    + `validation_repairs=${t.validation_repair} recovery_attempts=${t.recovery_attempt} `
    + `escalations=${t.model_escalation} no_progress=${t.no_progress} would_block=${summary.wouldBlockCount} `
    + `task_age_ms=${summary.taskAgeMs} active_execution_ms=${t.active_execution_ms} waiting_for_approval_ms=${t.waiting_for_approval_ms}`;
}

// ── Per-attempt accounting session (what the governed executor sees) ───────

/**
 * Narrow surface the governed executor uses. Every method is best-effort:
 * implementations must never throw into, or delay, the execution path.
 */
export interface GovernedRunAccounting {
  withStage<T>(stage: string, fn: () => Promise<T>): Promise<T>;
  /** Wraps one REAL provider dispatcher so each provider call is counted exactly once. */
  observeDispatcher(inner: GovernedModelDispatchSeam, route: 'primary' | 'cloud'): GovernedModelDispatchSeam;
  recordToolCall(kind: string, key: string, detail?: { reason?: string }): void;
  recordValidationRepair(cycle: number): void;
  recordNoProgress(stage: string, key: string): void;
  recordRecoveryAttempt(failureClass: string, key: string): void;
  /** Wraps a call that blocks on a human so its duration is not charged as active execution. */
  withApprovalWait<T>(fn: () => Promise<T>): Promise<T>;
}

export interface TaskAccountingSessionOptions {
  attemptId: string;
  runLabel?: string;
  log?: (message: string) => void;
}

export class TaskAccountingSession implements GovernedRunAccounting {
  /** Unique per session (process incarnation): a re-run after restart makes NEW calls and must never dedupe against old ones. */
  private readonly sessionId = crypto.randomBytes(4).toString('hex');
  private readonly startedAtMs: number;
  private phase = 'unattributed';
  private readonly pending = new Set<Promise<unknown>>();
  private readonly callSeq = new Map<string, number>();
  private readonly accountedRequests = new WeakSet<object>();
  private escalationRecorded = false;
  private approvalWaitDepth = 0;
  private approvalWaitStartedMs = 0;
  private approvalWaitedMs = 0;

  constructor(
    private readonly ledger: TaskBudgetLedger,
    private readonly options: TaskAccountingSessionOptions,
    now: () => number = Date.now,
  ) {
    this.startedAtMs = now();
    this.now = now;
  }

  private readonly now: () => number;

  async withStage<T>(stage: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.phase;
    this.phase = stage;
    try {
      return await fn();
    } finally {
      this.phase = prior;
    }
  }

  /** Marks `fn` as waiting on a human: its duration counts as waiting_for_approval_ms, not active execution. */
  async withApprovalWait<T>(fn: () => Promise<T>): Promise<T> {
    if (this.approvalWaitDepth++ === 0) this.approvalWaitStartedMs = this.now();
    try {
      return await fn();
    } finally {
      if (--this.approvalWaitDepth === 0) this.approvalWaitedMs += Math.max(0, this.now() - this.approvalWaitStartedMs);
    }
  }

  observeDispatcher(inner: GovernedModelDispatchSeam, route: 'primary' | 'cloud'): GovernedModelDispatchSeam {
    return {
      dispatch: async (request: GovernedModelRequest): Promise<GovernedModelResult> => {
        // The same request object passing two observed layers is one call, not two.
        if (this.accountedRequests.has(request)) return inner.dispatch(request);
        this.accountedRequests.add(request);
        const stage = this.stageFor(request);
        const reservation = await this.safe(() => this.ledger.reserve({
          idempotencyKey: this.uniqueKey(request.requestId),
          attemptId: this.options.attemptId,
          stage,
          resource: 'model_call',
          model: request.model,
          provider: request.providerType,
          reason: route === 'cloud' ? 'cloud_route' : undefined,
        }));
        let result: GovernedModelResult;
        try {
          result = await inner.dispatch(request);
        } catch (error) {
          // The provider may have been reached: charge it rather than refund.
          await this.settle(reservation, { outcome: 'dispatch_threw', reason: error instanceof Error ? error.name : 'error' });
          throw error;
        }
        await this.settle(reservation, {
          model: result.model,
          provider: result.providerType,
          outcome: result.status,
          reason: result.failureCode,
        });
        if (route === 'cloud' && !this.escalationRecorded) {
          this.escalationRecorded = true;
          this.track(this.ledger.record({
            idempotencyKey: `${this.sessionId}:escalation`,
            attemptId: this.options.attemptId,
            stage,
            resource: 'model_escalation',
            model: result.model,
            provider: result.providerType,
            reason: 'cloud_dispatch',
          }, { model: result.model, provider: result.providerType, outcome: 'escalated' }));
        }
        return result;
      },
    };
  }

  recordToolCall(kind: string, key: string, detail: { reason?: string } = {}): void {
    this.track(this.ledger.record({
      idempotencyKey: `${this.sessionId}:tool:${key}`,
      attemptId: this.options.attemptId,
      stage: this.phase,
      resource: 'tool_call',
      reason: detail.reason ?? kind,
    }, { outcome: kind }));
  }

  recordValidationRepair(cycle: number): void {
    this.track(this.ledger.record({
      idempotencyKey: `${this.sessionId}:validation_repair:${cycle}`,
      attemptId: this.options.attemptId,
      stage: 'validation_repair',
      resource: 'validation_repair',
      reason: 'validation_failure',
      failureClass: 'validation_failure',
    }));
  }

  recordNoProgress(stage: string, key: string): void {
    this.track(this.ledger.record({
      idempotencyKey: `${this.sessionId}:no_progress:${key}`,
      attemptId: this.options.attemptId,
      stage,
      resource: 'no_progress',
    }));
  }

  recordRecoveryAttempt(failureClass: string, key: string): void {
    this.track(this.ledger.record({
      idempotencyKey: `${this.sessionId}:recovery:${key}`,
      attemptId: this.options.attemptId,
      stage: this.phase,
      resource: 'recovery_attempt',
      failureClass,
      reason: failureClass,
    }));
  }

  /** Records this attempt's elapsed/active/waiting time, waits for all in-flight writes, and returns the summary. */
  async finish(): Promise<TaskBudgetSummary> {
    const nowMs = this.now();
    const elapsed = Math.max(0, nowMs - this.startedAtMs);
    // A wait still open at finish (e.g. cancelled while awaiting the user) counts up to now.
    const openWait = this.approvalWaitDepth > 0 ? Math.max(0, nowMs - this.approvalWaitStartedMs) : 0;
    const waiting = Math.min(elapsed, this.approvalWaitedMs + openWait);
    const times: Array<[string, BudgetResource, number]> = [
      ['wall', 'wall_clock_ms', elapsed],
      ['active', 'active_execution_ms', elapsed - waiting],
      ['waiting', 'waiting_for_approval_ms', waiting],
    ];
    for (const [suffix, resource, amount] of times) {
      this.track(this.ledger.record({
        idempotencyKey: `${this.sessionId}:${suffix}`,
        attemptId: this.options.attemptId,
        stage: 'attempt',
        resource,
        amount,
      }));
    }
    await Promise.allSettled([...this.pending]);
    return this.ledger.summary();
  }

  /**
   * M42: what the RecoveryController consults at each decision boundary. Committed
   * ledger totals plus THIS run's live active execution time (which is only
   * committed at `finish()`), so a long recovery cannot outrun the active-time
   * budget while it is still running. Human approval waits are excluded.
   */
  async budgetView(): Promise<{ totals: Partial<Record<BudgetResource, number>>; limits: TaskBudgetLimits }> {
    await Promise.allSettled([...this.pending]);
    const summary = this.ledger.summary();
    const nowMs = this.now();
    const elapsed = Math.max(0, nowMs - this.startedAtMs);
    const openWait = this.approvalWaitDepth > 0 ? Math.max(0, nowMs - this.approvalWaitStartedMs) : 0;
    const waiting = Math.min(elapsed, this.approvalWaitedMs + openWait);
    return {
      totals: { ...summary.totals, active_execution_ms: summary.totals.active_execution_ms + (elapsed - waiting) },
      limits: summary.limits,
    };
  }

  /** M42: allocates the next durable decision sequence number for the RecoveryController. */
  allocateDecisionSequence(): Promise<number> {
    return this.ledger.allocateDecisionSequence();
  }

  private stageFor(request: GovernedModelRequest): string {
    const id = request.requestId;
    if (id.startsWith('investigation:')) return id.endsWith(':repair') ? 'proposal_repair' : 'investigation';
    if (id.includes('proposal_repair_request')) return 'proposal_repair';
    if (id.startsWith('fixed-multi-agent:') && this.phase === 'graph') {
      return `graph:${id.slice(id.lastIndexOf(':') + 1)}`;
    }
    return this.phase;
  }

  private uniqueKey(requestId: string): string {
    const n = (this.callSeq.get(requestId) ?? 0) + 1;
    this.callSeq.set(requestId, n);
    return `${this.sessionId}:${requestId}#${n}`;
  }

  private async settle(reservation: Reservation | undefined, detail: CommitDetail): Promise<void> {
    if (!reservation || reservation.duplicate) return;
    await this.safe(() => this.ledger.commit(reservation.reservationId, detail));
  }

  private track(work: Promise<unknown>): void {
    const guarded = work.catch(error => this.options.log?.(`budget_ledger_write_failed ${describe(error)}`));
    this.pending.add(guarded);
    void guarded.finally(() => this.pending.delete(guarded));
  }

  private async safe<T>(fn: () => Promise<T>): Promise<T | undefined> {
    try {
      return await fn();
    } catch (error) {
      this.options.log?.(`budget_ledger_write_failed ${describe(error)}`);
      return undefined;
    }
  }
}

function describe(error: unknown): string {
  return boundedText(error instanceof Error ? error.message : String(error), 200) ?? 'unknown';
}
