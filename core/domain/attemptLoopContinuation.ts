/**
 * M38 — Core Saath Kar agent-loop execution checkpoint.
 *
 * `RuntimeExecutor.runAgentLoop` (core/runtime/executor.ts) keeps its in-flight
 * tool-calling turn — the assistant's tool-call message, ordered tool-call
 * results already fed back to the model, and the pending/remaining calls —
 * only in local JS memory. When a consequential governed-capability call
 * suspends the loop on `approval_required`, that in-flight state must survive
 * an Extension Host or Core restart so the same attempt can resume the exact
 * same model conversation once a human resolves the approval, rather than
 * resubmitting or silently losing the turn.
 *
 * This is an execution cursor/checkpoint only — approvals, tool_invocations,
 * attempts, idempotency records, and runtime_events remain the sole authority
 * for decisions and evidence. `continuationJson` never duplicates the durable
 * conversation transcript (rebuilt from `conversation_messages` as always);
 * it holds only the bounded in-flight delta layered on top of it.
 */
import * as crypto from 'node:crypto';
import type { CoreDatabase } from '../db/connection';
import type { ModelChatMessage, ModelToolCall } from '../runtime/modelBackend';
import type { LoopProgressState, PriorOperation } from '../runtime/loopProgress';
import { CoreError } from './errors';
import { nowIso } from './ids';

export const LOOP_CONTINUATION_SCHEMA_VERSION = 1;

/** Bounds the persisted delta — this is a resumable execution cursor, not a
 * second transcript/audit store. Per-turn tool output is already bounded
 * (8000 chars) by every ToolRunner/adapter, so a legitimate in-flight delta
 * across the `MAX_TOOL_TURNS` bound stays well under this. */
const MAX_CONTINUATION_BYTES = 256 * 1024;
/** Product classification for a proposal too large to checkpoint (the failure reason starts with this token). */
export const MUTATION_PAYLOAD_TOO_LARGE = 'MUTATION_PAYLOAD_TOO_LARGE';

export type LoopContinuationState = 'running' | 'awaiting_capability_approval' | 'resumable';

export interface LoopContinuationPayload {
  /** Messages appended after the durable conversation-history baseline that
   * `buildMessages` reconstructs — the assistant tool-call turn(s) and the
   * exact model-visible tool-result messages already supplied this attempt. */
  deltaMessages: ModelChatMessage[];
  /** Loop-detection state (`core/runtime/executor.ts`'s `priorOperations` map),
   * carried across a resume so a repeated-call signature is still caught. */
  priorOperations: Array<[string, PriorOperation]>;
  /** M45 workspace revision and consecutive non-progress turns. Optional so a
   * checkpoint written before M45 still loads; absence means the initial state. */
  loopProgress?: LoopProgressState;
  /** M45 delta-relative message index → operation key of each clearable (read-only)
   * tool result, so loop-delta compaction survives a resume. Optional and
   * additive: a checkpoint without it simply has nothing clearable. */
  toolMessageKeys?: Array<[number, string]>;
  /** M45 measured prompt-token ÷ estimate, only ever raised. Absent reads as 1. */
  promptCalibration?: number;
  /** The tool call awaiting a decision (governed approval) or about to be
   * dispatched — null once the whole turn has been checkpointed as clean. */
  pendingCall: ModelToolCall | null;
  /** Calls from the same model turn not yet dispatched, in order, to run
   * after `pendingCall` resolves. */
  remainingCalls: ModelToolCall[];
  /** Optional autonomous-mission evidence cursor. Absent on Saath Kar checkpoints. */
  missionEvidence?: {
    approvedMutation: boolean;
    approvedPath?: string;
    approvedPaths?: string[];
    validationPassed: boolean;
    validationCommand?: string;
    validationExitCode?: number | null;
    lastValidationSummary?: string;
    repairCount?: number;
    diffReview: 'pass' | 'reject' | 'pending';
    reviewDigest?: string;
    commitSha?: string;
    deliveryStatus?: 'local_commit' | 'blocked' | 'needs_clarification';
  };
  missionLedger?: Array<{
    action: string;
    path?: string;
    range?: string;
    query?: string;
    resultCount: number;
    truncated: boolean;
    fingerprint?: string;
    output: string;
    ok: boolean;
  }>;
  missionBudget?: {
    phase: 'investigation' | 'implementation' | 'repair';
    repairPhases: number;
    phaseUsed: number;
    phaseAllowance: number;
    productiveTotal: number;
    protocolRetries: number;
    cacheHits: number;
    remaining: number;
    startedAt: string;
    phaseStartedAt?: string;
    phaseHostMs?: number;
    hostMs?: number;
    elapsedMs?: number;
    phaseActiveMs?: number;
    remainingAbsoluteMs?: number;
    terminationReason?: string | null;
    lastTransition: string;
  };
}

/** True suffix after the rebuilt base prompt. Never persist the base itself. */
export function continuationSuffix(messages: ModelChatMessage[], baseLength: number): ModelChatMessage[] {
  if (baseLength <= 0) return [...messages];
  if (baseLength >= messages.length) return [];
  return messages.slice(baseLength);
}

/**
 * Rebuilds the live message array from a reconstructed base plus a stored
 * suffix. Legacy checkpoints that accidentally stored the whole array (base
 * duplicated inside delta) are detected and de-duplicated so resumed
 * approvals do not repeat system instructions or prior observations.
 */
export function appendContinuationDelta(base: ModelChatMessage[], delta: ModelChatMessage[]): ModelChatMessage[] {
  if (delta.length === 0) return [...base];
  if (
    base.length > 0
    && delta.length >= base.length
    && base.every((message, index) => message.role === delta[index]?.role && message.content === delta[index]?.content)
  ) {
    return [...base, ...delta.slice(base.length)];
  }
  return [...base, ...delta];
}

export interface LoopContinuationRecord {
  attemptId: string;
  schemaVersion: number;
  state: LoopContinuationState;
  provider: string;
  model: string;
  turnIndex: number;
  baseMessageSeq: number;
  payload: LoopContinuationPayload;
  pendingApprovalId: string | null;
  requestedActionDigest: string | null;
  frozenContextHash: string;
  updatedAt: string;
}

export interface SaveLoopContinuationInput {
  state: LoopContinuationState;
  provider: string;
  model: string;
  turnIndex: number;
  baseMessageSeq: number;
  payload: LoopContinuationPayload;
  pendingApprovalId?: string | null;
  requestedActionDigest?: string | null;
  frozenContextHash: string;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function checksumOf(material: {
  schemaVersion: number;
  state: string;
  provider: string;
  model: string;
  turnIndex: number;
  baseMessageSeq: number;
  continuationJson: string;
  pendingApprovalId: string | null;
  requestedActionDigest: string | null;
  frozenContextHash: string;
}): string {
  return crypto.createHash('sha256').update(canonicalJson(material), 'utf8').digest('hex');
}

/** Persists (creates or replaces) this attempt's execution checkpoint. Bounds
 * the serialized delta so this table can never grow into an unbounded
 * transcript/audit store. */
export function saveLoopContinuation(db: CoreDatabase, attemptId: string, input: SaveLoopContinuationInput): void {
  const continuationJson = JSON.stringify(input.payload);
  const continuationBytes = Buffer.byteLength(continuationJson, 'utf8');
  if (continuationBytes > MAX_CONTINUATION_BYTES) {
    // Product-level classification of the one realistic way to hit this bound: a single proposal carrying a very large file.
    throw new CoreError(
      'invalid_request',
      `${MUTATION_PAYLOAD_TOO_LARGE}: this step's proposed content is about ${Math.ceil(continuationBytes / 1024)} KB, above the ${MAX_CONTINUATION_BYTES / 1024} KB limit for one proposal. `
      + 'Nothing was written. Ask for the file in smaller parts (for example several files, or one section per step).',
      { code: MUTATION_PAYLOAD_TOO_LARGE, bytes: continuationBytes, limitBytes: MAX_CONTINUATION_BYTES },
    );
  }
  const pendingApprovalId = input.pendingApprovalId ?? null;
  const requestedActionDigest = input.requestedActionDigest ?? null;
  const updatedAt = nowIso();
  const checksum = checksumOf({
    schemaVersion: LOOP_CONTINUATION_SCHEMA_VERSION,
    state: input.state,
    provider: input.provider,
    model: input.model,
    turnIndex: input.turnIndex,
    baseMessageSeq: input.baseMessageSeq,
    continuationJson,
    pendingApprovalId,
    requestedActionDigest,
    frozenContextHash: input.frozenContextHash,
  });
  db.run(
    `INSERT INTO attempt_loop_continuations (
       attemptId, schemaVersion, state, provider, model, turnIndex, baseMessageSeq,
       continuationJson, pendingApprovalId, requestedActionDigest, frozenContextHash,
       updatedAt, checksum
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(attemptId) DO UPDATE SET
       schemaVersion = excluded.schemaVersion,
       state = excluded.state,
       provider = excluded.provider,
       model = excluded.model,
       turnIndex = excluded.turnIndex,
       baseMessageSeq = excluded.baseMessageSeq,
       continuationJson = excluded.continuationJson,
       pendingApprovalId = excluded.pendingApprovalId,
       requestedActionDigest = excluded.requestedActionDigest,
       frozenContextHash = excluded.frozenContextHash,
       updatedAt = excluded.updatedAt,
       checksum = excluded.checksum`,
    [
      attemptId,
      LOOP_CONTINUATION_SCHEMA_VERSION,
      input.state,
      input.provider,
      input.model,
      input.turnIndex,
      input.baseMessageSeq,
      continuationJson,
      pendingApprovalId,
      requestedActionDigest,
      input.frozenContextHash,
      updatedAt,
      checksum,
    ],
  );
}

/**
 * Loads and integrity-checks this attempt's checkpoint. Returns `undefined`
 * when there is none (the common case — a fresh or already-clean attempt).
 * Throws `CoreError('context_mismatch', ...)` for a corrupt, oversized, or
 * schema-incompatible row so the caller fails the attempt closed rather than
 * silently resuming from wrong or partial state.
 */
export function loadLoopContinuation(db: CoreDatabase, attemptId: string): LoopContinuationRecord | undefined {
  const row = db.get<Record<string, unknown>>('SELECT * FROM attempt_loop_continuations WHERE attemptId = ?', [attemptId]);
  if (!row) return undefined;
  const schemaVersion = Number(row.schemaVersion);
  if (schemaVersion !== LOOP_CONTINUATION_SCHEMA_VERSION) {
    throw new CoreError('context_mismatch', `attempt '${attemptId}' loop continuation schema version ${schemaVersion} is not supported`);
  }
  const continuationJson = String(row.continuationJson);
  if (Buffer.byteLength(continuationJson, 'utf8') > MAX_CONTINUATION_BYTES) {
    throw new CoreError('context_mismatch', `attempt '${attemptId}' loop continuation exceeds the bounded size and cannot be trusted`);
  }
  const pendingApprovalId = (row.pendingApprovalId as string | null) ?? null;
  const requestedActionDigest = (row.requestedActionDigest as string | null) ?? null;
  const expectedChecksum = checksumOf({
    schemaVersion,
    state: String(row.state),
    provider: String(row.provider),
    model: String(row.model),
    turnIndex: Number(row.turnIndex),
    baseMessageSeq: Number(row.baseMessageSeq),
    continuationJson,
    pendingApprovalId,
    requestedActionDigest,
    frozenContextHash: String(row.frozenContextHash),
  });
  if (expectedChecksum !== String(row.checksum)) {
    throw new CoreError('context_mismatch', `attempt '${attemptId}' loop continuation failed its integrity check`);
  }
  let payload: LoopContinuationPayload;
  try {
    payload = JSON.parse(continuationJson) as LoopContinuationPayload;
  } catch {
    throw new CoreError('context_mismatch', `attempt '${attemptId}' loop continuation is not valid JSON`);
  }
  return {
    attemptId,
    schemaVersion,
    state: row.state as LoopContinuationState,
    provider: String(row.provider),
    model: String(row.model),
    turnIndex: Number(row.turnIndex),
    baseMessageSeq: Number(row.baseMessageSeq),
    payload,
    pendingApprovalId,
    requestedActionDigest,
    frozenContextHash: String(row.frozenContextHash),
    updatedAt: String(row.updatedAt),
  };
}

/** Finds the Saath Kar attempt (if any) whose loop is suspended waiting on
 * this exact approval — the link Core's approval-resolve route uses to know
 * which attempt to resume, since a governed-capability approval's own
 * `attemptId` is the capability-dispatch anchor attempt, not necessarily the
 * Saath Kar attempt whose model loop is actually waiting on it. */
export function findAttemptIdByPendingApproval(db: CoreDatabase, approvalId: string): string | undefined {
  const row = db.get<{ attemptId: string }>(
    `SELECT attemptId FROM attempt_loop_continuations WHERE pendingApprovalId = ? AND state = 'awaiting_capability_approval'`,
    [approvalId],
  );
  return row?.attemptId;
}

/** Terminally closes (deletes) this attempt's checkpoint. Only ever called
 * once the owning attempt itself is terminal (completed/failed/cancelled) —
 * a live checkpoint must never be dropped while the attempt could still
 * resume. Idempotent: closing an attempt with no checkpoint is a no-op. */
export function closeLoopContinuation(db: CoreDatabase, attemptId: string): void {
  db.run('DELETE FROM attempt_loop_continuations WHERE attemptId = ?', [attemptId]);
}
