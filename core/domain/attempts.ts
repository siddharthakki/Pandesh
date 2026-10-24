import type { CoreDatabase } from '../db/connection';
import type {
  AttemptRecord,
  AttemptStatus,
  AttemptKind,
  AttemptRetryStrategy,
  ModelSelectionEvidence,
} from '../shared/wireTypes';
import { CoreError } from './errors';
import { newId, nowIso } from './ids';
import { recordRuntimeEvent } from './runtimeEvents';
import { validateAttemptTransition, isTerminalAttemptStatus } from './attemptTransitions';
import { assertFence } from './fence';
import { cancelNonterminalModelInvocationsForAttempt } from './modelInvocations';
import { contextWindowEventMetadata, createAttemptContext, getAttemptContext, type AttemptContextInput } from './attemptContext';
import { getRequest } from './requests';
import { attemptRetryEligibility } from './retryPolicy';
import { recordExecutionQuality } from './executionQuality';
import { synchronizeConversationTurnAttempt } from './conversationLedger';
import { expirePendingApprovalsForAttempt } from './approvals';

/**
 * Aborts an in-flight capability adapter bound to an anchor attempt.
 * `capabilityDispatch.ts` registers the real abort so this module never
 * imports that file (the cycle would be attempts → dispatch → attempts).
 * Unregistered, this is a no-op: tests that never dispatch still settle.
 */
let abortCapabilityExecution: (attemptId: string) => void = () => undefined;

export function setCapabilityExecutionAbort(fn: (attemptId: string) => void): void {
  abortCapabilityExecution = fn;
}

export type CapabilityAttemptOutcome = 'completed' | 'failed' | 'cancelled';

function rowToAttempt(row: Record<string, unknown>): AttemptRecord {
  return {
    id: String(row.id),
    requestId: String(row.requestId),
    predecessorAttemptId: (row.predecessorAttemptId as string) ?? null,
    parentAttemptId: (row.parentAttemptId as string) ?? null,
    kind: row.kind as AttemptKind,
    status: row.status as AttemptStatus,
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
    startedAt: (row.startedAt as string) ?? null,
    completedAt: (row.completedAt as string) ?? null,
    cancelledAt: (row.cancelledAt as string) ?? null,
    cancelRequestedAt: (row.cancelRequestedAt as string) ?? null,
    failureReason: (row.failureReason as string) ?? null,
    claimOwner: (row.claimOwner as string) ?? null,
    claimExpiresAt: (row.claimExpiresAt as string) ?? null,
    fenceToken: (row.fenceToken as string) ?? null,
    fenceGeneration: Number(row.fenceGeneration ?? 0),
    revision: Number(row.revision),
  };
}

export function getAttempt(db: CoreDatabase, id: string): AttemptRecord {
  const row = db.get<Record<string, unknown>>('SELECT * FROM attempts WHERE id = ?', [id]);
  if (!row) throw new CoreError('not_found', `attempt '${id}' not found`);
  return rowToAttempt(row);
}

export interface CreateAttemptInput {
  requestId: string;
  kind: AttemptKind;
  actor: string;
  clientId?: string | null;
  context?: AttemptContextInput;
  /**
   * The owning attempt, for an attempt created to carry work on another
   * attempt's behalf. Written once here; there is no path that reassigns it,
   * so ownership cannot be moved after the fact.
   */
  parentAttemptId?: string | null;
}

/** Creates the first attempt for a request. Use `retryAttempt` to create a successor. */
export function createAttempt(db: CoreDatabase, input: CreateAttemptInput): AttemptRecord {
  return db.transaction(() => {
    const request = db.get('SELECT id FROM requests WHERE id = ?', [input.requestId]);
    if (!request) throw new CoreError('invalid_request', `request '${input.requestId}' does not exist`);
    const existingForRequest = db.get('SELECT id FROM attempts WHERE requestId = ?', [input.requestId]);
    if (existingForRequest) {
      throw new CoreError('conflict', `request '${input.requestId}' already has an attempt; use retryAttempt for a new one`);
    }
    const id = newId('att');
    const now = nowIso();
    if (input.parentAttemptId) {
      const parent = db.get('SELECT id FROM attempts WHERE id = ?', [input.parentAttemptId]);
      if (!parent) throw new CoreError('not_found', `parent attempt '${input.parentAttemptId}' not found`);
    }
    db.run(
      `INSERT INTO attempts (id, requestId, predecessorAttemptId, parentAttemptId, kind, status, createdAt, updatedAt, revision)
       VALUES (?, ?, NULL, ?, ?, 'created', ?, ?, 1)`,
      [id, input.requestId, input.parentAttemptId ?? null, input.kind, now, now],
    );
    const context = createAttemptContext(db, id, getRequest(db, input.requestId), input.context);
    recordRuntimeEvent(db, {
      domain: 'attempt',
      entityId: id,
      eventType: 'attempt_created',
      actor: input.actor,
      clientId: input.clientId,
      metadata: {
        requestId: input.requestId,
        kind: input.kind,
        contextIdentity: context.contextIdentity,
        contextHash: context.contextHash,
        parentAttemptId: input.parentAttemptId ?? null,
      },
      resultingRevision: 1,
    });
    return getAttempt(db, id);
  });
}

export interface TransitionAttemptInput {
  toStatus: AttemptStatus;
  expectedRevision?: number;
  /** Required when the attempt is fenced — a stale token is rejected with `fence_stale`. */
  fenceToken?: string | null;
  actor: string;
  clientId?: string | null;
  reason?: string;
}

export function transitionAttempt(db: CoreDatabase, id: string, input: TransitionAttemptInput): AttemptRecord {
  const result = db.transaction(() => {
    const existing = db.get<Record<string, unknown>>('SELECT * FROM attempts WHERE id = ?', [id]);
    if (!existing) throw new CoreError('not_found', `attempt '${id}' not found`);
    assertFence(db, id, input.fenceToken);
    if (input.expectedRevision !== undefined && Number(existing.revision) !== input.expectedRevision) {
      throw new CoreError('revision_mismatch', `attempt '${id}' revision mismatch`);
    }
    const fromStatus = existing.status as AttemptStatus;
    const allowed = validateAttemptTransition(fromStatus, input.toStatus);
    if (!allowed.ok) {
      throw new CoreError('invalid_transition', allowed.reason, { from: fromStatus, to: input.toStatus });
    }
    const now = nowIso();
    const newRevision = Number(existing.revision) + 1;
    const startedAt = input.toStatus === 'running' && !existing.startedAt ? now : (existing.startedAt as string) ?? null;
    const completedAt = isTerminalAttemptStatus(input.toStatus) ? now : (existing.completedAt as string) ?? null;
    db.run(
      `UPDATE attempts SET status = ?, updatedAt = ?, startedAt = ?, completedAt = ?, revision = ? WHERE id = ?`,
      [input.toStatus, now, startedAt, completedAt, newRevision, id],
    );
    if (isTerminalAttemptStatus(input.toStatus)) {
      expirePendingApprovalsForAttempt(db, id, {
        actor: input.actor,
        clientId: input.clientId,
        reason: input.reason ?? `attempt transitioned to ${input.toStatus}`,
      });
    }
    synchronizeConversationTurnAttempt(db, id, input.toStatus, now);
    recordRuntimeEvent(db, {
      domain: 'attempt',
      entityId: id,
      eventType: 'attempt_transitioned',
      actor: input.actor,
      clientId: input.clientId,
      metadata: { from: fromStatus, to: input.toStatus, reason: input.reason ?? null },
      resultingRevision: newRevision,
    });
    return getAttempt(db, id);
  });
  if (isTerminalAttemptStatus(result.status)) {
    settleOwnedAfterTerminal(db, {
      ownerAttemptId: result.id,
      outcome: result.status as CapabilityAttemptOutcome,
      reason: input.reason,
      actor: input.actor,
      clientId: input.clientId,
    });
  }
  return result;
}

export interface FailAttemptInput {
  failureReason: string;
  expectedRevision?: number;
  fenceToken?: string | null;
  actor: string;
  clientId?: string | null;
}

export function failAttempt(db: CoreDatabase, id: string, input: FailAttemptInput): AttemptRecord {
  const result = db.transaction(() => {
    const existing = db.get<Record<string, unknown>>('SELECT * FROM attempts WHERE id = ?', [id]);
    if (!existing) throw new CoreError('not_found', `attempt '${id}' not found`);
    assertFence(db, id, input.fenceToken);
    if (input.expectedRevision !== undefined && Number(existing.revision) !== input.expectedRevision) {
      throw new CoreError('revision_mismatch', `attempt '${id}' revision mismatch`);
    }
    const fromStatus = existing.status as AttemptStatus;
    const allowed = validateAttemptTransition(fromStatus, 'failed');
    if (!allowed.ok) throw new CoreError('invalid_transition', allowed.reason, { from: fromStatus, to: 'failed' });
    const now = nowIso();
    const newRevision = Number(existing.revision) + 1;
    db.run('UPDATE attempts SET status = ?, updatedAt = ?, completedAt = ?, failureReason = ?, revision = ? WHERE id = ?', [
      'failed',
      now,
      now,
      input.failureReason,
      newRevision,
      id,
    ]);
    expirePendingApprovalsForAttempt(db, id, {
      actor: input.actor,
      clientId: input.clientId,
      reason: input.failureReason,
    });
    synchronizeConversationTurnAttempt(db, id, 'failed', now);
    recordRuntimeEvent(db, {
      domain: 'attempt',
      entityId: id,
      eventType: 'attempt_failed',
      actor: input.actor,
      clientId: input.clientId,
      metadata: { failureReason: input.failureReason },
      resultingRevision: newRevision,
    });
    return getAttempt(db, id);
  });
  settleOwnedAfterTerminal(db, {
    ownerAttemptId: result.id,
    outcome: 'failed',
    reason: result.failureReason ?? input.failureReason,
    actor: input.actor,
    clientId: input.clientId,
  });
  return result;
}

/**
 * Idempotent cancellation request: marks intent immediately (cancelRequestedAt) so
 * repeated UI clicks are no-ops, and moves the attempt toward 'cancelling' unless it's
 * already terminal. The actual runtime is responsible for observing cancelRequestedAt
 * and terminating real model/tool processes — see docs/m32-recovery.md.
 */
export function requestCancelAttempt(db: CoreDatabase, id: string, input: { actor: string; clientId?: string | null }): AttemptRecord {
  const result = db.transaction(() => {
    const existing = db.get<Record<string, unknown>>('SELECT * FROM attempts WHERE id = ?', [id]);
    if (!existing) throw new CoreError('not_found', `attempt '${id}' not found`);
    const fromStatus = existing.status as AttemptStatus;
    if (isTerminalAttemptStatus(fromStatus) || existing.cancelRequestedAt) {
      // Idempotent: already terminal or already cancelling — return current state unchanged.
      return getAttempt(db, id);
    }
    const now = nowIso();
    const canTransitionNow = validateAttemptTransition(fromStatus, 'cancelling').ok;
    const newRevision = Number(existing.revision) + 1;
    db.run('UPDATE attempts SET cancelRequestedAt = ?, status = ?, updatedAt = ?, revision = ? WHERE id = ?', [
      now,
      canTransitionNow ? 'cancelling' : fromStatus,
      now,
      newRevision,
      id,
    ]);
    recordRuntimeEvent(db, {
      domain: 'attempt',
      entityId: id,
      eventType: 'attempt_cancel_requested',
      actor: input.actor,
      clientId: input.clientId,
      resultingRevision: newRevision,
    });
    return getAttempt(db, id);
  });
  // A cancel on the owner must reach the attempts it created. Shared anchors
  // have no parent and are not selected. Recursive and idempotent.
  for (const child of listOwnedCapabilityAttempts(db, result.id)) {
    abortCapabilityExecution(child.id);
    requestCancelAttempt(db, child.id, input);
  }
  return result;
}

export function confirmAttemptCancelled(
  db: CoreDatabase,
  id: string,
  input: { actor: string; clientId?: string | null; fenceToken?: string | null },
): AttemptRecord {
  const result = db.transaction(() => {
    const existing = db.get<Record<string, unknown>>('SELECT * FROM attempts WHERE id = ?', [id]);
    if (!existing) throw new CoreError('not_found', `attempt '${id}' not found`);
    assertFence(db, id, input.fenceToken);
    const now = nowIso();
    cancelNonterminalModelInvocationsForAttempt(db, id, {
      actor: input.actor,
      clientId: input.clientId,
      reason: 'attempt_cancelled',
      cancelledAt: now,
    });
    const fromStatus = existing.status as AttemptStatus;
    if (fromStatus === 'cancelled') return getAttempt(db, id);
    const allowed = validateAttemptTransition(fromStatus, 'cancelled');
    if (!allowed.ok) throw new CoreError('invalid_transition', allowed.reason, { from: fromStatus, to: 'cancelled' });
    const newRevision = Number(existing.revision) + 1;
    db.run('UPDATE attempts SET status = ?, updatedAt = ?, completedAt = ?, cancelledAt = ?, revision = ? WHERE id = ?', [
      'cancelled',
      now,
      now,
      now,
      newRevision,
      id,
    ]);
    expirePendingApprovalsForAttempt(db, id, {
      actor: input.actor,
      clientId: input.clientId,
      reason: 'attempt cancelled',
    });
    synchronizeConversationTurnAttempt(db, id, 'cancelled', now);
    recordRuntimeEvent(db, {
      domain: 'attempt',
      entityId: id,
      eventType: 'attempt_cancelled',
      actor: input.actor,
      clientId: input.clientId,
      resultingRevision: newRevision,
    });
    return getAttempt(db, id);
  });
  settleOwnedAfterTerminal(db, {
    ownerAttemptId: result.id,
    outcome: 'cancelled',
    actor: input.actor,
    clientId: input.clientId,
  });
  return result;
}

/**
 * The single authority that turns "the user asked to stop" into the
 * authoritative terminal state.
 *
 * A cancel request records intent (`cancelRequestedAt`) and moves the attempt
 * to `cancelling`; the terminal edge itself is owned by the attempt's
 * executor. This helper is what every finalizer calls so that the outcome
 * cannot depend on *which* code path noticed the cancel first:
 *
 * - Already terminal: returned unchanged (idempotent).
 * - `cancelling`, `created`, `queued`, `paused`, `blocked`: settled straight
 *   to `cancelled`.
 * - `running` / `validating`: these have no legal edge to `cancelled`, so the
 *   attempt first moves to `cancelling` — the state the cancel request already
 *   implies — and is then settled. Without this step the terminal transition
 *   is rejected (`invalid_transition`) and the attempt stays non-terminal
 *   forever, which is exactly how a cancel could be requested and the turn
 *   still "finish" without the attempt ever reaching an authoritative state.
 *
 * Fencing is never bypassed: a stale token is rejected by `assertFence` and the
 * caller must step aside. A cancellation is never fabricated.
 */
export function settleCancelledAttempt(
  db: CoreDatabase,
  id: string,
  input: { actor: string; clientId?: string | null; fenceToken?: string | null },
): AttemptRecord {
  const existing = getAttempt(db, id);
  if (isTerminalAttemptStatus(existing.status)) return existing;
  if (existing.status !== 'cancelling' && validateAttemptTransition(existing.status, 'cancelling').ok) {
    transitionAttempt(db, id, {
      toStatus: 'cancelling',
      fenceToken: input.fenceToken,
      actor: input.actor,
      clientId: input.clientId,
      reason: 'cancellation_requested',
    });
  }
  return confirmAttemptCancelled(db, id, input);
}

function listOwnedCapabilityAttempts(db: CoreDatabase, ownerAttemptId: string): AttemptRecord[] {
  return db.all<Record<string, unknown>>(
    'SELECT * FROM attempts WHERE parentAttemptId = ? ORDER BY createdAt',
    [ownerAttemptId],
  ).map(rowToAttempt);
}

/**
 * Settles the capability anchor attempts an owning attempt created, so a
 * finished owner never leaves its mutation attempt running.
 *
 * Touches only anchors whose `parentAttemptId` is this owner, which is why it
 * is safe to call unconditionally at owner termination: a shared anchor has no
 * parent and is left alone. Idempotent — an already-terminal anchor is
 * returned unchanged, so a retried settle, a restart-resumed owner, and a
 * replay all converge on the same state.
 */
export function settleOwnedCapabilityAttempts(
  db: CoreDatabase,
  input: {
    ownerAttemptId: string;
    outcome: CapabilityAttemptOutcome;
    reason?: string;
    actor: string;
    clientId?: string | null;
  },
): AttemptRecord[] {
  return listOwnedCapabilityAttempts(db, input.ownerAttemptId).map((anchor) => settleOwnedOne(db, anchor.id, input));
}

function settleOwnedAfterTerminal(
  db: CoreDatabase,
  input: {
    ownerAttemptId: string;
    outcome: CapabilityAttemptOutcome;
    reason?: string;
    actor: string;
    clientId?: string | null;
  },
): void {
  try {
    settleOwnedCapabilityAttempts(db, input);
  } catch (err) {
    recordRuntimeEvent(db, {
      domain: 'attempt',
      entityId: input.ownerAttemptId,
      eventType: 'capability_attempt_settle_failed',
      actor: input.actor,
      clientId: input.clientId,
      metadata: { reason: err instanceof Error ? err.message : String(err) },
    });
  }
}

function settleOwnedOne(
  db: CoreDatabase,
  anchorId: string,
  input: { outcome: CapabilityAttemptOutcome; reason?: string; actor: string; clientId?: string | null },
): AttemptRecord {
  abortCapabilityExecution(anchorId);
  const anchor = getAttempt(db, anchorId);
  if (isTerminalAttemptStatus(anchor.status)) return anchor;
  const actor = { actor: input.actor, clientId: input.clientId ?? undefined };

  // An anchor already cancelling can only finish cancelling, whatever the
  // owner's outcome was; forcing any other terminal state here would be an
  // illegal transition and would lose the cancellation.
  if (anchor.status === 'cancelling') {
    return transitionAttempt(db, anchorId, { toStatus: 'cancelled', ...actor });
  }
  if (input.outcome === 'cancelled') {
    const cancelling = requestCancelAttempt(db, anchorId, actor);
    if (isTerminalAttemptStatus(cancelling.status)) return cancelling;
    return transitionAttempt(db, anchorId, { toStatus: 'cancelled', ...actor });
  }
  if (input.outcome === 'failed') {
    return failAttempt(db, anchorId, {
      failureReason: input.reason ?? 'owning attempt failed',
      ...actor,
    });
  }
  // `completed` is reachable only from running/validating. An anchor can still
  // be sitting in 'created' or parked in 'waiting_for_approval' when the owner
  // finishes, so walk it back to running first rather than forcing an illegal
  // transition.
  if (anchor.status !== 'running' && anchor.status !== 'validating') {
    transitionAttempt(db, anchorId, { toStatus: 'running', ...actor });
  }
  return transitionAttempt(db, anchorId, { toStatus: 'completed', ...actor });
}

export interface RetryAttemptInput {
  predecessorAttemptId: string;
  actor: string;
  clientId?: string | null;
  idempotencyKey?: string | null;
  strategy?: AttemptRetryStrategy;
  guidance?: string | null;
  selectedProvider?: string | null;
  selectedModel?: string | null;
  modelSelection?: ModelSelectionEvidence;
}

/**
 * Creates a brand-new attempt for the same request, linked to its predecessor.
 * Never copies transcript, scratch, tool results, or approval tokens from the
 * predecessor — "retry from scratch" per the M32 charter. Idempotent: a duplicate
 * retry call for a predecessor that already has a successor returns the existing
 * successor rather than creating a second one.
 */
export function retryAttempt(db: CoreDatabase, input: RetryAttemptInput): AttemptRecord {
  return db.transaction(() => {
    const predecessor = db.get<Record<string, unknown>>('SELECT * FROM attempts WHERE id = ?', [input.predecessorAttemptId]);
    if (!predecessor) throw new CoreError('not_found', `attempt '${input.predecessorAttemptId}' not found`);

    const existingSuccessor = db.get<Record<string, unknown>>('SELECT * FROM attempts WHERE predecessorAttemptId = ?', [
      input.predecessorAttemptId,
    ]);
    if (existingSuccessor) {
      return rowToAttempt(existingSuccessor);
    }

    const eligibility = attemptRetryEligibility(db, input.predecessorAttemptId);
    if (!eligibility.eligible) {
      throw new CoreError('invalid_transition', eligibility.reason);
    }

    const id = newId('att');
    const now = nowIso();
    const predecessorContext = getAttemptContext(db, input.predecessorAttemptId);
    const strategy = input.strategy ?? 'same_model';
    const guidance = input.guidance?.trim();
    if (guidance && guidance.length > 2_000) {
      throw new CoreError('invalid_request', 'retry guidance may not exceed 2000 characters');
    }
    const selectedProvider = input.selectedProvider ?? input.modelSelection?.selectedProvider ?? predecessorContext.selectedProvider;
    const selectedModel = input.selectedModel ?? input.modelSelection?.selectedModel ?? predecessorContext.selectedModel;
    if (input.modelSelection && (
      input.modelSelection.selectedProvider !== selectedProvider || input.modelSelection.selectedModel !== selectedModel
    )) {
      throw new CoreError('invalid_request', 'retry model-selection evidence does not match the selected provider/model');
    }
    if (selectedProvider !== predecessorContext.selectedProvider) {
      throw new CoreError('invalid_request', 'retry may not switch providers');
    }
    if (strategy === 'stronger_model') {
      const allowed = predecessorContext.modelSelection?.escalationCandidates.some(
        candidate => candidate.provider === selectedProvider && candidate.model === selectedModel,
      );
      if (!allowed || selectedModel === predecessorContext.selectedModel) {
        throw new CoreError('invalid_request', 'stronger-model retry must select a configured same-provider escalation candidate');
      }
    }
    if (strategy === 'same_model' && selectedModel !== predecessorContext.selectedModel) {
      throw new CoreError('invalid_request', 'same-model retry may not change the selected model');
    }
    if (strategy === 'with_guidance' && !guidance) {
      throw new CoreError('invalid_request', 'guided retry requires non-empty guidance');
    }
    // M50: same-model retries keep the frozen routing decision verbatim. A model change makes the predecessor's
    // routing explanation untrue, so it is dropped rather than carried onto a model it did not choose.
    const { routing: _predecessorRouting, ...predecessorSelectionWithoutRouting } = predecessorContext.modelSelection
      ?? ({} as Partial<ModelSelectionEvidence>);
    const modelSelection = input.modelSelection ?? (predecessorContext.modelSelection
      ? {
          ...(selectedModel === predecessorContext.selectedModel
            ? predecessorContext.modelSelection
            : predecessorSelectionWithoutRouting as ModelSelectionEvidence),
          selectedProvider,
          selectedModel,
          selectionReason: strategy === 'stronger_model'
            ? 'Retry selected a stronger configured model after the previous blocker.'
            : predecessorContext.modelSelection.selectionReason,
          userOverrode: predecessorContext.modelSelection.userOverrode,
        }
      : undefined);
    db.run(
      `INSERT INTO attempts (id, requestId, predecessorAttemptId, kind, status, createdAt, updatedAt, revision)
       VALUES (?, ?, ?, ?, 'created', ?, ?, 1)`,
      [id, predecessor.requestId, input.predecessorAttemptId, predecessor.kind, now, now],
    );
    const context = createAttemptContext(db, id, getRequest(db, String(predecessor.requestId)), {
      contextIdentity: predecessorContext.contextIdentity,
      workspaceRoot: predecessorContext.workspaceRoot,
      selectedProvider,
      selectedModel,
      modelSelection,
      repositoryContext: predecessorContext.repositoryContext,
      retryGuidance: strategy === 'with_guidance' ? guidance ?? null : null,
      hasWorkspace: predecessorContext.permittedCapabilities.hasWorkspace,
      gitCapable: predecessorContext.permittedCapabilities.gitCapable,
      allowedTools: predecessorContext.permittedCapabilities.allowedTools,
      approvalPolicy: predecessorContext.approvalPolicy,
    });
    recordRuntimeEvent(db, {
      domain: 'attempt',
      entityId: id,
      eventType: 'attempt_retried',
      actor: input.actor,
      clientId: input.clientId,
      idempotencyKey: input.idempotencyKey,
      metadata: {
        predecessorAttemptId: input.predecessorAttemptId,
        contextIdentity: context.contextIdentity,
        contextHash: context.contextHash,
        strategy,
        selectedProvider,
        selectedModel,
        guidanceProvided: Boolean(guidance),
        predecessorBlockerReason: predecessor.failureReason ?? null,
      },
      resultingRevision: 1,
    });
    recordExecutionQuality(db, id, {
      eventType: 'retry_created',
      actor: input.actor,
      clientId: input.clientId,
      idempotencyKey: `retry-created:${input.predecessorAttemptId}`,
      metadata: {
        predecessorAttemptId: input.predecessorAttemptId,
        strategy,
        selectedProvider,
        selectedModel,
        preservedRequestId: predecessor.requestId,
        guidanceProvided: Boolean(guidance),
      },
    });
    if (modelSelection) {
      recordExecutionQuality(db, id, {
        eventType: 'model_selection_decided',
        actor: input.actor,
        clientId: input.clientId,
        idempotencyKey: `model-selection:${id}`,
        metadata: {
          requiredCapabilities: modelSelection.requiredCapabilities,
          selectedProvider,
          selectedModel,
          selectionReason: modelSelection.selectionReason,
          suitabilitySummary: modelSelection.suitabilitySummary,
          userOverrode: modelSelection.userOverrode,
          escalationCandidates: modelSelection.escalationCandidates,
          ...contextWindowEventMetadata(context.modelSelection ?? modelSelection),
        },
      });
    }
    return getAttempt(db, id);
  });
}

export interface RerouteAttemptInput {
  predecessorAttemptId: string;
  actor: string;
  provider: string;
  model: string;
  /** Frozen cloud spend facts for a cloud-pool target; absent for a local target. */
  cloudSpend?: ModelSelectionEvidence['cloudSpend'];
  fingerprint: string;
  reason: string;
  /** 1-based index of this reroute in the objective's chain. */
  rerouteIndex: number;
}

/**
 * Auto-only recovery successor: same request and objective, a different model, linked to the failed predecessor.
 * Unlike `retryAttempt` it may change provider (local -> cloud) because Auto owns provider choice, but it never
 * copies transcript/tool results, never carries the predecessor's routing explanation, and records both the failed
 * and the taking-over model as durable provenance. Idempotent per predecessor.
 */
export function rerouteAttempt(db: CoreDatabase, input: RerouteAttemptInput): AttemptRecord {
  return db.transaction(() => {
    const predecessor = db.get<Record<string, unknown>>('SELECT * FROM attempts WHERE id = ?', [input.predecessorAttemptId]);
    if (!predecessor) throw new CoreError('not_found', `attempt '${input.predecessorAttemptId}' not found`);
    const existingSuccessor = db.get<Record<string, unknown>>('SELECT * FROM attempts WHERE predecessorAttemptId = ?', [
      input.predecessorAttemptId,
    ]);
    if (existingSuccessor) return rowToAttempt(existingSuccessor);
    if (predecessor.status !== 'failed') throw new CoreError('invalid_transition', 'only a failed attempt can be rerouted');

    const id = newId('att');
    const now = nowIso();
    const predecessorContext = getAttemptContext(db, input.predecessorAttemptId);
    const { routing: _routing, contextWindowTokens: _window, contextWindowSource: _windowSource, ...carried } = predecessorContext.modelSelection
      ?? ({} as Partial<ModelSelectionEvidence>);
    const { cloudSpend: _cloudSpend, spendCapUsd: _spendCap, routingPolicy: _routingPolicy, ...withoutSpend } = carried as Partial<ModelSelectionEvidence>;
    const modelSelection = predecessorContext.modelSelection
      ? {
          ...withoutSpend,
          requiredCapabilities: predecessorContext.modelSelection.requiredCapabilities,
          candidates: [],
          escalationCandidates: [],
          suitabilitySummary: 'Auto rerouted after a model failure',
          selectedProvider: input.provider,
          selectedModel: input.model,
          selectionReason: `Auto reroute ${input.rerouteIndex}: ${input.reason}`,
          userOverrode: false,
          ...(input.cloudSpend ? { cloudSpend: input.cloudSpend, routingPolicy: 'explicit-cloud' as const } : {}),
        } as ModelSelectionEvidence
      : undefined;
    db.run(
      `INSERT INTO attempts (id, requestId, predecessorAttemptId, kind, status, createdAt, updatedAt, revision)
       VALUES (?, ?, ?, ?, 'created', ?, ?, 1)`,
      [id, predecessor.requestId, input.predecessorAttemptId, predecessor.kind, now, now],
    );
    const context = createAttemptContext(db, id, getRequest(db, String(predecessor.requestId)), {
      contextIdentity: predecessorContext.contextIdentity,
      workspaceRoot: predecessorContext.workspaceRoot,
      selectedProvider: input.provider,
      selectedModel: input.model,
      modelSelection,
      repositoryContext: predecessorContext.repositoryContext,
      hasWorkspace: predecessorContext.permittedCapabilities.hasWorkspace,
      gitCapable: predecessorContext.permittedCapabilities.gitCapable,
      allowedTools: predecessorContext.permittedCapabilities.allowedTools,
      approvalPolicy: predecessorContext.approvalPolicy,
    });
    recordRuntimeEvent(db, {
      domain: 'attempt',
      entityId: id,
      eventType: 'attempt_rerouted',
      actor: input.actor,
      metadata: {
        predecessorAttemptId: input.predecessorAttemptId,
        contextIdentity: context.contextIdentity,
        contextHash: context.contextHash,
        failedProvider: predecessorContext.selectedProvider,
        failedModel: predecessorContext.selectedModel,
        selectedProvider: input.provider,
        selectedModel: input.model,
        fingerprint: input.fingerprint,
        rerouteIndex: input.rerouteIndex,
        reason: input.reason,
      },
      resultingRevision: 1,
    });
    return getAttempt(db, id);
  });
}

export interface ListAttemptsFilter {
  requestId?: string;
  status?: AttemptStatus;
  activeOnly?: boolean;
  limit?: number;
  offset?: number;
}

const MAX_PAGE_SIZE = 200;
const ACTIVE_STATUSES: AttemptStatus[] = [
  'created',
  'queued',
  'running',
  'waiting_for_approval',
  'validating',
  'paused',
  'blocked',
  'cancelling',
  'recovery_required',
];

export function listAttempts(db: CoreDatabase, filter: ListAttemptsFilter = {}): AttemptRecord[] {
  const limit = Math.min(filter.limit ?? 50, MAX_PAGE_SIZE);
  const offset = filter.offset ?? 0;
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filter.requestId) {
    clauses.push('requestId = ?');
    params.push(filter.requestId);
  }
  if (filter.status) {
    clauses.push('status = ?');
    params.push(filter.status);
  } else if (filter.activeOnly) {
    clauses.push(`status IN (${ACTIVE_STATUSES.map(() => '?').join(',')})`);
    params.push(...ACTIVE_STATUSES);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db.all<Record<string, unknown>>(`SELECT * FROM attempts ${where} ORDER BY updatedAt DESC LIMIT ? OFFSET ?`, [
    ...params,
    limit,
    offset,
  ]);
  return rows.map(rowToAttempt);
}

/** Claims (or renews) ownership of an attempt for a bounded lease — the mechanism
 * restart-recovery uses to detect a stale claim left by a crashed runtime. */
export function claimAttempt(
  db: CoreDatabase,
  id: string,
  input: { claimOwner: string; leaseMs: number; actor: string; clientId?: string | null },
): AttemptRecord {
  return db.transaction(() => {
    const existing = db.get<Record<string, unknown>>('SELECT * FROM attempts WHERE id = ?', [id]);
    if (!existing) throw new CoreError('not_found', `attempt '${id}' not found`);
    const now = new Date();
    const nowIsoStr = now.toISOString();
    const currentOwner = existing.claimOwner as string | null;
    const currentExpiry = existing.claimExpiresAt ? new Date(existing.claimExpiresAt as string) : null;
    const staleOrUnowned = !currentOwner || !currentExpiry || currentExpiry.getTime() < now.getTime();
    if (!staleOrUnowned && currentOwner !== input.claimOwner) {
      throw new CoreError('conflict', `attempt '${id}' is already claimed by another owner`);
    }
    const expiresAt = new Date(now.getTime() + input.leaseMs).toISOString();
    const newRevision = Number(existing.revision) + 1;
    db.run('UPDATE attempts SET claimOwner = ?, claimExpiresAt = ?, updatedAt = ?, revision = ? WHERE id = ?', [
      input.claimOwner,
      expiresAt,
      nowIsoStr,
      newRevision,
      id,
    ]);
    recordRuntimeEvent(db, {
      domain: 'attempt',
      entityId: id,
      eventType: 'attempt_claimed',
      actor: input.actor,
      clientId: input.clientId,
      metadata: { claimOwner: input.claimOwner },
      resultingRevision: newRevision,
    });
    return getAttempt(db, id);
  });
}
