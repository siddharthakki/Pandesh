import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import { taskDir } from '../M15AutonomousWork';
import type { FailureFingerprint, PatchDelta } from '../../autonomy/FailureFingerprint';
import type { SubgoalPlan } from '../../autonomy/SubgoalPlan';
import type { ContractModeRecord } from '../../reliability/ContractEnforcement';

/** Journal-sized view of ContextPackTelemetry: identities, forms, sizes and reasons; never content. */
export interface ContextPackRecord {
  packHash: string;
  taskType: string;
  tier?: string;
  subgoalId?: string;
  budgetChars: number;
  packChars: number;
  estimatedTokens: number;
  candidates: number;
  selected: Array<{ id: string; section: string; form: string; chars: number }>;
  rejected: Array<{ id: string; section: string; reason: string }>;
  intelSource?: string;
}
import type { HostBoundCodingProposal } from '../../coding/WorkspaceMutation';
import {
  RECOVERY_SCHEMA_VERSION,
  type FailureCause,
  type ModelIdentity,
  type RecoveryDecision,
  type RecoveryTerminalState,
  type StageOutcome,
  type ValidationFailureFact,
} from './RecoveryTypes';

/**
 * Durable, append-only task-level history for the M42 recovery control plane.
 *
 * One JSONL file per task (`<task dir>/recovery/journal.jsonl`). It records
 * facts and decisions; it never grants approval and never holds secrets. The
 * in-memory {@link JournalState} is a pure fold of the file, so a restart
 * reconstructs exactly what was known before it — including which mutation
 * was applied and whether its validation finished.
 */

export interface EvidenceEntry {
  path: string;
  /** `sha256:<hex>` of the exact bytes the model was shown (whole file). */
  contentHash: string;
  /** Worktree base commit at read time. Movement of the base invalidates the entry. */
  baseRevision?: string;
  /** Number of mutations applied to the worktree when this was read. */
  epoch: number;
  /** Inclusive 1-based line ranges actually delivered. */
  ranges: Array<[number, number]>;
  totalLines?: number;
  source: 'model_read' | 'runtime_seed' | 'initial_context';
  attemptId: string;
  at: string;
}

export type JournalRecord =
  | { t: 'attempt_started'; attemptId: string; pass: number; model?: ModelIdentity; baseRevision?: string; resumeAtValidation?: boolean; instructionRevision?: number }
  /** The task contract changed (scope-changing steering): mutation/delivery/terminal history no longer describes the worktree. */
  | { t: 'superseded'; reason: string; instructionRevision: number }
  /** A human resumed a stopped task: the stop is cleared and the recovery window is fresh. */
  | { t: 'resumed'; priorTerminal: RecoveryTerminalState }
  | { t: 'evidence'; entry: EvidenceEntry }
  | { t: 'search'; attemptId: string; query: string; scope?: string; matchCount: number }
  | { t: 'proposal'; attemptId: string; pass: number; fingerprint?: string; paths: string[]; valid: boolean; errors?: string[] }
  | { t: 'patch'; attemptId: string; fingerprint: string; paths: string[] }
  | { t: 'validation'; attemptId: string; pass: number; cycle: number; passed: boolean; failureFingerprint?: string; failures: ValidationFailureFact[]; passedCommands: string[] }
  /** A validation-repair cycle was consumed (recorded before the repair turn is dispatched). Survives controller re-entry. */
  | { t: 'repair_cycle'; attemptId: string; pass: number; cycle: number }
  | { t: 'reviewer'; attemptId: string; verdict: string; findings: string[] }
  | { t: 'routing'; attemptId: string; attemptedModel?: string; executedModel?: string; fallbackUsed: boolean; decision?: string; reason?: string }
  | { t: 'outcome'; outcome: StageOutcome }
  | { t: 'decision'; decision: RecoveryDecision }
  | { t: 'dispatch'; decisionSeq: number; pass: number; dispatchFingerprint?: string; action: string }
  | {
    t: 'mutation';
    phase: 'started' | 'applied';
    attemptId: string;
    proposalFingerprint: string;
    /** Only on `started`: the exact host-bound proposal, so restart can reconcile it. */
    proposal?: HostBoundCodingProposal;
    /** Only on `started` (M46): what this mutation changed per file relative to the file just before it. */
    deltas?: PatchDelta[];
    /** Only on `applied`: post-mutation `sha256:` per path (null = file absent). */
    postHashes?: Record<string, string | null>;
  }
  | { t: 'validation_phase'; phase: 'started' | 'completed'; attemptId: string; passed?: boolean }
  | { t: 'contract'; gate: string; digest: string; instructionRevision: number; proposalFingerprint?: string }
  | { t: 'delivery'; phase: 'started' | 'completed' | 'aborted'; attemptId: string; detail?: string }
  | { t: 'terminal'; terminalState: RecoveryTerminalState; reason: string; cause?: FailureCause }
  /** M46: the deterministic subgoal plan and its progress; the latest record wins. Cleared when the objective is superseded. */
  | { t: 'subgoal_plan'; plan: SubgoalPlan }
  /** M46: what one Context Pack contained and why (sizes and identities only, never file contents). */
  | { t: 'context_pack'; attemptId: string; pass: number; pack: ContextPackRecord }
  /** Adaptive contract enforcement: the response contract changed mode (or the change was judged), and why. */
  | ({ t: 'contract_mode' } & ContractModeRecord)
  /** M46: between two validation-repair cycles of one pass, the same failure recurred and the runtime widened the evidence. */
  | { t: 'evidence_widened'; attemptId: string; pass: number; cycle: number; paths: string[]; reason: string };

export type StoredJournalRecord = JournalRecord & { seq: number; at: string; taskId: string; v: typeof RECOVERY_SCHEMA_VERSION };

export interface MutationEntry {
  phase: 'started' | 'applied';
  attemptId: string;
  proposalFingerprint: string;
  /** The exact host-bound proposal (recorded on `started`) so a restart can reconcile it. */
  proposal?: HostBoundCodingProposal;
  /** M46: per-file change footprint of this mutation (recorded on `started`). */
  deltas?: PatchDelta[];
  postHashes?: Record<string, string | null>;
}

/**
 * Every mutation this task began, in order: the approved proposal first, then
 * any validation-repair mutations. `validationCompleted` refers to the latest.
 */
export interface MutationHistory {
  entries: MutationEntry[];
  /** True once validation for the latest mutation ran to completion (pass or fail). */
  validationCompleted: boolean;
}

export interface JournalState {
  records: number;
  corruptLines: number;
  nextSeq: number;
  passes: number;
  /** Instruction revision the latest dispatch ran against (undefined before the first dispatch). */
  instructionRevision?: number;
  /** Latest evidence entries per path, oldest first, bounded. */
  evidence: Map<string, EvidenceEntry[]>;
  /** Searches that returned nothing: negative evidence. */
  negativeSearches: Array<{ query: string; scope?: string }>;
  outcomes: StageOutcome[];
  /** M46: outcomes ever folded, and the value at the last reset (success, human resume, supersede): failures after it form one progress window. */
  outcomesSeen: number;
  progressFloor: number;
  decisions: RecoveryDecision[];
  /** Every dispatched attempt fingerprint with the number of times it was dispatched. */
  dispatchCounts: Map<string, number>;
  /** How often each effective outcome fingerprint was observed. */
  outcomeCounts: Map<string, number>;
  /** Validation commands that have passed at least once on this task (regression detection). */
  passedCommands: Set<string>;
  modelsAttempted: string[];
  /** Non-terminal recoveries dispatched, by failure cause. */
  recoveryByCause: Map<string, number>;
  mutationEpoch: number;
  /** Highest validation-repair cycle consumed on this task attempt (never reset by a new pass, resume or supersede). */
  validationRepairCycles: number;
  mutation?: MutationHistory;
  delivery?: { phase: 'started' | 'completed'; attemptId: string };
  terminal?: { terminalState: RecoveryTerminalState; reason: string };
  contracts: Array<{ gate: string; digest: string; instructionRevision: number; proposalFingerprint?: string }>;
  lastDecisionSeq: number;
  /** M46: the current subgoal plan. */
  subgoalPlan?: SubgoalPlan;
  /** Contract mode changes and their justification, oldest first, bounded. */
  contractModes: ContractModeRecord[];
  /** M46: evidence widenings performed inside a pass (between repair cycles), bounded. */
  evidenceWidenings: Array<{ pass: number; cycle: number; paths: string[]; reason: string }>;
}

const MAX_EVIDENCE_PER_PATH = 8;
const MAX_KEPT_OUTCOMES = 64;
const MAX_KEPT_DECISIONS = 128;

export function emptyJournalState(): JournalState {
  return {
    records: 0,
    corruptLines: 0,
    nextSeq: 1,
    passes: 0,
    evidence: new Map(),
    negativeSearches: [],
    outcomes: [],
    outcomesSeen: 0,
    progressFloor: 0,
    decisions: [],
    dispatchCounts: new Map(),
    outcomeCounts: new Map(),
    passedCommands: new Set(),
    modelsAttempted: [],
    recoveryByCause: new Map(),
    mutationEpoch: 0,
    validationRepairCycles: 0,
    contracts: [],
    lastDecisionSeq: 0,
    contractModes: [],
    evidenceWidenings: [],
  };
}

/** Merges inclusive line ranges into a sorted, non-overlapping list. */
export function mergeRanges(ranges: ReadonlyArray<readonly [number, number]>): Array<[number, number]> {
  const sorted = ranges.map(range => [...range] as [number, number]).sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range[0] <= last[1] + 1) last[1] = Math.max(last[1], range[1]);
    else merged.push(range);
  }
  return merged;
}

export function fold(state: JournalState, record: StoredJournalRecord): void {
  state.records += 1;
  state.nextSeq = Math.max(state.nextSeq, record.seq + 1);
  switch (record.t) {
    case 'attempt_started': {
      state.passes = Math.max(state.passes, record.pass);
      if (record.instructionRevision !== undefined) state.instructionRevision = record.instructionRevision;
      const key = `${record.model?.provider ?? 'unknown'}/${record.model?.model ?? 'unknown'}`;
      if (record.model?.model && !state.modelsAttempted.includes(key)) state.modelsAttempted.push(key);
      break;
    }
    case 'evidence': {
      const list = state.evidence.get(record.entry.path) ?? [];
      // Merge with the previous entry when it is the same content at the same base:
      // successive ranged reads of one file accumulate coverage.
      const previous = list[list.length - 1];
      if (
        previous
        && previous.contentHash === record.entry.contentHash
        && previous.baseRevision === record.entry.baseRevision
      ) {
        previous.ranges = mergeRanges([...previous.ranges, ...record.entry.ranges]);
        previous.totalLines = record.entry.totalLines ?? previous.totalLines;
      } else {
        list.push({ ...record.entry, ranges: mergeRanges(record.entry.ranges) });
        if (list.length > MAX_EVIDENCE_PER_PATH) list.shift();
      }
      state.evidence.set(record.entry.path, list);
      break;
    }
    case 'search':
      if (record.matchCount === 0) state.negativeSearches.push({ query: record.query, scope: record.scope });
      if (state.negativeSearches.length > 64) state.negativeSearches.shift();
      break;
    case 'outcome': {
      state.outcomes.push(record.outcome);
      if (state.outcomes.length > MAX_KEPT_OUTCOMES) state.outcomes.shift();
      state.outcomesSeen += 1;
      if (record.outcome.ok) state.progressFloor = state.outcomesSeen;
      const fp = effectiveOutcomeFingerprint(record.outcome);
      if (!record.outcome.ok) state.outcomeCounts.set(fp, (state.outcomeCounts.get(fp) ?? 0) + 1);
      break;
    }
    case 'decision': {
      state.decisions.push(record.decision);
      if (state.decisions.length > MAX_KEPT_DECISIONS) state.decisions.shift();
      state.lastDecisionSeq = Math.max(state.lastDecisionSeq, record.decision.decisionSeq);
      break;
    }
    case 'dispatch': {
      if (record.dispatchFingerprint) {
        state.dispatchCounts.set(record.dispatchFingerprint, (state.dispatchCounts.get(record.dispatchFingerprint) ?? 0) + 1);
      }
      const decision = state.decisions.find(item => item.decisionSeq === record.decisionSeq);
      if (decision?.cause) {
        state.recoveryByCause.set(decision.cause, (state.recoveryByCause.get(decision.cause) ?? 0) + 1);
      }
      break;
    }
    case 'mutation': {
      const history = state.mutation ?? { entries: [], validationCompleted: false };
      if (record.phase === 'started') {
        history.entries.push({
          phase: 'started',
          attemptId: record.attemptId,
          proposalFingerprint: record.proposalFingerprint,
          proposal: record.proposal,
          ...(record.deltas ? { deltas: record.deltas } : {}),
        });
      } else {
        const pending = [...history.entries].reverse().find(entry => entry.phase === 'started' && entry.proposalFingerprint === record.proposalFingerprint);
        if (pending) {
          pending.phase = 'applied';
          pending.postHashes = record.postHashes;
        } else {
          history.entries.push({ phase: 'applied', attemptId: record.attemptId, proposalFingerprint: record.proposalFingerprint, postHashes: record.postHashes });
        }
        state.mutationEpoch += 1;
      }
      history.validationCompleted = false;
      state.mutation = history;
      break;
    }
    case 'validation_phase':
      if (state.mutation) state.mutation.validationCompleted = record.phase === 'completed';
      break;
    case 'repair_cycle':
      state.validationRepairCycles = Math.max(state.validationRepairCycles, record.cycle);
      break;
    case 'validation':
      for (const command of record.passedCommands ?? []) state.passedCommands.add(command);
      break;
    case 'contract':
      state.contracts.push({ gate: record.gate, digest: record.digest, instructionRevision: record.instructionRevision, proposalFingerprint: record.proposalFingerprint });
      if (state.contracts.length > 32) state.contracts.shift();
      break;
    case 'delivery':
      // `aborted` is a KNOWN failure before completion, so nothing is in doubt any more.
      state.delivery = record.phase === 'aborted' ? undefined : { phase: record.phase, attemptId: record.attemptId };
      break;
    case 'terminal':
      state.terminal = { terminalState: record.terminalState, reason: record.reason };
      break;
    case 'subgoal_plan':
      state.subgoalPlan = record.plan;
      break;
    case 'evidence_widened':
      state.evidenceWidenings.push({ pass: record.pass, cycle: record.cycle, paths: record.paths, reason: record.reason });
      if (state.evidenceWidenings.length > 32) state.evidenceWidenings.shift();
      break;
    case 'contract_mode': {
      const { t: _t, ...change } = record;
      state.contractModes.push(change);
      if (state.contractModes.length > 32) state.contractModes.shift();
      break;
    }
    case 'superseded':
      state.subgoalPlan = undefined;
      state.mutation = undefined;
      state.delivery = undefined;
      state.terminal = undefined;
      state.instructionRevision = record.instructionRevision;
      state.outcomeCounts.clear();
      state.dispatchCounts.clear();
      state.recoveryByCause.clear();
      state.passedCommands.clear();
      state.progressFloor = state.outcomesSeen;
      break;
    case 'resumed':
      state.terminal = undefined;
      state.outcomeCounts.clear();
      state.dispatchCounts.clear();
      state.recoveryByCause.clear();
      state.progressFloor = state.outcomesSeen;
      break;
    default:
      break;
  }
}

/** Stable identity of "the same failure with the same inputs": used for repetition detection. */
export function effectiveOutcomeFingerprint(outcome: StageOutcome): string {
  return sha([
    outcome.cause ?? 'none',
    outcome.subcode ?? '',
    outcome.fingerprints.failure ?? '',
    outcome.fingerprints.proposal ?? '',
    outcome.fingerprints.patch ?? '',
  ].join('|'));
}

/**
 * M46: the failure fingerprints of the current progress window, oldest first. The window restarts at a
 * success, a human resume or a supersede, exactly where the outcome counters restart. Derived purely from
 * journaled outcomes, so a restart reconstructs the same history.
 */
export function progressHistory(state: Pick<JournalState, 'outcomes' | 'outcomesSeen' | 'progressFloor'>): FailureFingerprint[] {
  const inWindow = Math.max(0, Math.min(state.outcomes.length, state.outcomesSeen - state.progressFloor));
  return state.outcomes
    .slice(state.outcomes.length - inWindow)
    // Only reasoning-level failures are hypotheses. A protocol failure (unusable envelope), a provider stall, an
    // environment fault or a policy stop says nothing about whether the model's idea was right, so none of them
    // is part of the window.
    .filter(outcome => !outcome.ok && (outcome.cause === 'validation_failure' || outcome.cause === 'semantic_failure' || outcome.cause === 'grounding_failure') && outcome.failureFingerprint !== undefined)
    .map(outcome => outcome.failureFingerprint as FailureFingerprint);
}

export function sha(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 24);
}

export interface OpenAttemptJournalOptions {
  repositoryRoot: string;
  taskId: string;
  now?: () => Date;
}

export class AttemptJournal {
  private static readonly locks = new Map<string, Promise<void>>();

  private constructor(
    readonly filePath: string,
    readonly taskId: string,
    private readonly stateValue: JournalState,
    private readonly now: () => Date,
    /** True when the file ends mid-record (a crash during an append): the next append must start a new line. */
    private needsLeadingNewline = false,
  ) {}

  static async open(options: OpenAttemptJournalOptions): Promise<AttemptJournal> {
    const dir = path.join(taskDir(options.repositoryRoot, options.taskId), 'recovery');
    await fs.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, 'journal.jsonl');
    const state = emptyJournalState();
    let raw = '';
    try {
      raw = await fs.readFile(filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as StoredJournalRecord;
        if (parsed.v !== RECOVERY_SCHEMA_VERSION || typeof parsed.seq !== 'number' || typeof parsed.t !== 'string') {
          state.corruptLines += 1;
          continue;
        }
        fold(state, parsed);
      } catch {
        // A torn final line from a crash mid-append is expected; skip it.
        state.corruptLines += 1;
      }
    }
    return new AttemptJournal(filePath, options.taskId, state, options.now ?? (() => new Date()), raw.length > 0 && !raw.endsWith('\n'));
  }

  get state(): Readonly<JournalState> {
    return this.stateValue;
  }

  /** Durably appends one record (fsync'd write) and folds it into the state. */
  async append(record: JournalRecord): Promise<StoredJournalRecord> {
    return this.withLock(async () => {
      const stored = {
        ...record,
        seq: this.stateValue.nextSeq,
        at: this.now().toISOString(),
        taskId: this.taskId,
        v: RECOVERY_SCHEMA_VERSION,
      } as StoredJournalRecord;
      const handle = await fs.open(this.filePath, 'a');
      try {
        await handle.appendFile(`${this.needsLeadingNewline ? '\n' : ''}${JSON.stringify(stored)}\n`, 'utf8');
        this.needsLeadingNewline = false;
        await handle.sync();
      } finally {
        await handle.close();
      }
      fold(this.stateValue, stored);
      return stored;
    });
  }

  /** Reads every stored record (for diagnostics/tests). */
  async readAll(): Promise<StoredJournalRecord[]> {
    let raw = '';
    try {
      raw = await fs.readFile(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const out: StoredJournalRecord[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line) as StoredJournalRecord); } catch { /* torn line */ }
    }
    return out;
  }

  private async withLock<T>(action: () => Promise<T>): Promise<T> {
    const key = this.filePath;
    const previous = AttemptJournal.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>(resolve => { release = resolve; });
    const queued = previous.then(() => current);
    AttemptJournal.locks.set(key, queued);
    await previous;
    try {
      return await action();
    } finally {
      release();
      if (AttemptJournal.locks.get(key) === queued) AttemptJournal.locks.delete(key);
    }
  }
}

// ── Evidence manifest ──────────────────────────────────────────────────────

export interface AdmissionResult {
  admitted: boolean;
  reason?: 'never_read' | 'stale_content' | 'stale_base' | 'partial_read';
}

/**
 * Freshness-aware view of the journal's evidence. An entry satisfies grounding
 * only when it describes the CURRENT bytes of the file at the CURRENT base
 * revision; a read made before a mutation or a base move is stale by
 * construction and never grounds a later proposal.
 */
export class EvidenceManifest {
  constructor(private readonly state: Readonly<JournalState>) {}

  entriesFor(filePath: string): readonly EvidenceEntry[] {
    return this.state.evidence.get(normalizeEvidencePath(filePath)) ?? [];
  }

  admit(
    filePath: string,
    current: { contentHash: string; baseRevision?: string },
    options: { requireFullRead?: boolean } = {},
  ): AdmissionResult {
    const entries = this.entriesFor(filePath);
    if (entries.length === 0) return { admitted: false, reason: 'never_read' };
    const sameContent = entries.filter(entry => entry.contentHash === current.contentHash);
    if (sameContent.length === 0) return { admitted: false, reason: 'stale_content' };
    const sameBase = sameContent.filter(entry =>
      entry.baseRevision === undefined || current.baseRevision === undefined || entry.baseRevision === current.baseRevision);
    if (sameBase.length === 0) return { admitted: false, reason: 'stale_base' };
    if (options.requireFullRead) {
      const covered = mergeRanges(sameBase.flatMap(entry => entry.ranges));
      const total = Math.max(0, ...sameBase.map(entry => entry.totalLines ?? 0));
      const full = total === 0
        ? covered.length > 0
        : covered.length === 1 && covered[0][0] <= 1 && covered[0][1] >= total;
      if (!full) return { admitted: false, reason: 'partial_read' };
    }
    return { admitted: true };
  }

  /** Identity of the evidence set (latest entry per path + negative-search count). */
  fingerprint(): string {
    const parts: string[] = [];
    for (const [filePath, list] of [...this.state.evidence.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const latest = list[list.length - 1];
      parts.push(`${filePath}@${latest.contentHash}@${latest.baseRevision ?? ''}`);
    }
    parts.push(`neg:${this.state.negativeSearches.length}`);
    return sha(parts.join('\n'));
  }
}

export function normalizeEvidencePath(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/^\.\//, '');
}
