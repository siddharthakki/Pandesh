import {
  ForgeInvocationAuditMetadata,
  ForgeInvocationModelCall,
  ForgeInvocationModelCallRequest,
  ForgeInvocationModelResultLookup,
  ForgeInvocationModelResultLookupRequest,
  ForgeInvocationPreparation,
  ForgeInvocationPreparationRequest,
  ForgeInvocationStart,
  ForgeExecutionBoundary,
  ForgeInvocationLifecycleControl,
  ForgeInvocationLifecycleControlRequest,
  ForgeInvocationStartEligibility,
  ForgeInvocationStartEligibilityRequest,
  ForgeInvocationStartRequest,
  ForgeInvocationStartReservation,
  ForgeInvocationStartReservationExpiration,
  ForgeInvocationStartReservationExpirationRequest,
  ForgeInvocationStartReservationList,
  ForgeInvocationStartReservationListRequest,
  ForgeInvocationStartReservationLookup,
  ForgeInvocationStartReservationLookupRequest,
  ForgeInvocationStartReservationRequest,
  ForgeInvocationReservationAcquire,
  ForgeInvocationReservationAcquireRequest,
  ForgeInvocationReservationLease,
  ForgeInvocationReservationLeaseRenewal,
  ForgeInvocationReservationLeaseRenewalRequest,
  ForgeInvocationReservationMetrics,
  ForgeInvocationReservationMetricsRequest,
  ForgeInvocationReservationRelease,
  ForgeInvocationReservationReleaseRequest,
  ForgeInvocationQueueEntry,
  ForgeInvocationQueueInspection,
  ForgeInvocationQueueInspectionRequest,
  ForgeInvocationStatus,
  ForgeSchedulerSnapshot,
  ForgeSchedulerSnapshotRequest,
  ForgeSchedulerValidation,
  ForgeSchedulerValidationIssue,
  ForgeSchedulerValidationRequest,
  StartTaskRequest,
} from './AgentEngineTypes';
import { LocalAgentEngine } from './LocalAgentEngine';
import { PersistedEvent } from './TaskTypes';
import { GovernedModelExecutionDispatcher } from './GovernedModelExecutionDispatcher';
import { GOVERNED_MODEL_CONTRACT_VERSION, GovernedModelRequest, GovernedModelResult } from './GovernedModelExecutionTypes';

export interface ForgeInvocationReference {
  invocationId: string;
  taskId: string;
  audit?: ForgeInvocationAuditMetadata;
}

export interface ForgeInvocationStatusLookup {
  invocationId: string;
  audit?: ForgeInvocationAuditMetadata;
}

export interface ForgeInvocationEventsLookup {
  invocationId: string;
  afterSeq?: number;
}

export interface ForgeInvocationEvents {
  invocationId: string;
  taskId: string;
  events: PersistedEvent[];
  warnings: string[];
  integrityFailed: boolean;
}

export interface ForgeInvocationProgressLookup {
  invocationId: string;
}

export interface ForgeInvocationProgress {
  invocationId: string;
  taskId: string;
  phase: string;
  updatedAt: string;
  currentIteration?: number;
  validationPassed?: boolean;
  pendingApproval: boolean;
  usage: {
    elapsedActiveMs: number;
    waitingApprovalMs: number;
    modelCalls: number;
    toolCalls: number;
    repairAttempts: number;
    iterations: number;
    outputBytes: number;
    noProgressSteps: number;
    repeatedValidationFailures: number;
    lastProgressAt?: string;
  };
  budgets: {
    maxWallClockMs: number;
    maxModelCalls: number;
    maxToolCalls: number;
    maxRepairAttempts: number;
    maxIterations: number;
    maxOutputBytes: number;
    maxNoProgressSteps: number;
  };
}

export interface ForgeInvocationPreparationInput {
  invocationId: string;
  taskId: string;
  goal: string;
  audit?: ForgeInvocationAuditMetadata;
}

export interface ForgeInvocationStartEligibilityInput {
  invocationId: string;
  taskId: string;
  goal: string;
  prepared: boolean;
  audit?: ForgeInvocationAuditMetadata;
}

export interface ForgeInvocationStartReservationInput {
  invocationId: string;
  taskId: string;
  goal: string;
  prepared: boolean;
  audit?: ForgeInvocationAuditMetadata;
}

export interface ForgeInvocationStartReservationLookupInput {
  reservationId: string;
  audit?: ForgeInvocationAuditMetadata;
}

export interface ForgeInvocationReservationAcquireInput {
  reservationId: string;
  ownerId: string;
  audit?: ForgeInvocationAuditMetadata;
}

export interface ForgeInvocationReservationReleaseInput {
  reservationId: string;
  ownerId: string;
  audit?: ForgeInvocationAuditMetadata;
}

export interface ForgeInvocationReservationLeaseRenewalInput {
  reservationId: string;
  ownerId: string;
  audit?: ForgeInvocationAuditMetadata;
}

export interface ForgeInvocationReservationMetricsInput {
  audit?: ForgeInvocationAuditMetadata;
}

export interface ForgeInvocationQueueInspectionInput {
  includeExpired?: boolean;
  audit?: ForgeInvocationAuditMetadata;
}

export interface ForgeSchedulerSnapshotInput {
  includeExpired?: boolean;
  audit?: ForgeInvocationAuditMetadata;
}

export interface ForgeSchedulerValidationInput {
  audit?: ForgeInvocationAuditMetadata;
}

export interface ForgeInvocationStartReservationExpirationInput {
  reservationId: string;
  audit?: ForgeInvocationAuditMetadata;
}

export interface ForgeInvocationStartReservationListInput {
  includeExpired?: boolean;
  audit?: ForgeInvocationAuditMetadata;
}
export interface ForgeInvocationStartInput {
  invocationId: string;
  taskId: string;
  goal: string;
  reservationId: string;
  mode?: StartTaskRequest['mode'];
  model?: string;
  audit?: ForgeInvocationAuditMetadata;
}

/**
 * Input for the M4.3 governed model call. Deliberately the smallest valid
 * shape: the accepted reservation already owns the governed goal and the
 * invocation/task identity, so none of those are accepted from the caller
 * here (they are derived from the validated reservation once resolved).
 * There is no cancellation field — cancellation is resolved internally via
 * `ReadOnlyForgeInvocationAdapter.cancelModelCall`, not a caller-supplied
 * `AbortSignal` (which is not transport-safe/JSON-serializable). `model` is
 * required (unlike start) because exactly one model invocation must name a
 * concrete model; there is no AgentLoop-side default to fall back on.
 */
export interface ForgeInvocationModelCallInput {
  reservationId: string;
  model: string;
  audit?: ForgeInvocationAuditMetadata;
}

interface ForgeInvocationModelCallIdentity {
  invocationId: string;
  taskId: string;
  reservationId: string;
  model: string;
}

/**
 * M4.5-M4.6: input for the read-only governed model execution result
 * lookup. `invocationId`/`taskId` are required (not derived, since this is
 * itself the ownership check) so a caller can only retrieve a result for the
 * invocation/task identity it actually owns.
 */
export interface ForgeInvocationModelResultLookupInput {
  reservationId: string;
  invocationId: string;
  taskId: string;
  audit?: ForgeInvocationAuditMetadata;
}

export interface ForgeInvocationLifecycleControlInput {
  invocationId: string;
  action: ForgeInvocationLifecycleControlRequest['action'];
  reason?: string;
  audit?: ForgeInvocationAuditMetadata;
}

type ForgeInvocationReader = Pick<LocalAgentEngine, 'getForgeInvocationStatus' | 'getTask' | 'startTask' | 'pauseTask' | 'resumeTask' | 'cancelTask'> & {
  taskStore: Pick<LocalAgentEngine['taskStore'], 'getEvents'>;
};

export class ReadOnlyForgeInvocationAdapter {
  private readonly invocations: Map<string, ForgeInvocationReference>;

  private readonly startReservations =
    new Map<string, ForgeInvocationStartReservation>();

  private readonly reservationLeases =
    new Map<string, ForgeInvocationReservationLease>();

  private readonly startLocks = new Set<string>();

  private readonly completedStarts = new Map<string, ForgeInvocationStart>();

  /** Governed goal captured at `reserveStart` time, keyed by reservationId; the sole authoritative prompt source for `invokeModel`. */
  private readonly reservationGoals = new Map<string, string>();

  /**
   * Cross-execution-path exclusivity claim: a reservation may be claimed by
   * `start` or by `invokeModel`, never both, and never by both concurrently.
   * Claimed synchronously (no `await` in between) so a race between the two
   * paths cannot both cross their respective execution boundary.
   */
  private readonly reservationClaims = new Map<string, 'start' | 'model'>();

  /** In-flight promises keyed by reservationId: concurrent identical calls await the same result instead of dispatching twice. */
  private readonly inFlightModelCalls = new Map<string, Promise<ForgeInvocationModelCall>>();

  /** Internal, non-Forge-callable cancellation registry — never exposed as a second externally visible cancellation protocol. */
  private readonly modelCallControllers = new Map<string, AbortController>();

  private readonly cancelledModelCallReservations = new Set<string>();

  /**
   * Completed model calls, keyed by reservationId, retained only as
   * redacted metadata (no completion text) so a later duplicate call
   * returns deterministic idempotency evidence without replaying raw
   * completion text from an indefinite cache.
   */
  private readonly completedModelCalls = new Map<string, ForgeInvocationModelCall>();

  constructor(
    private readonly engine: ForgeInvocationReader,
    invocations: readonly ForgeInvocationReference[],
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly modelDispatcher?: GovernedModelExecutionDispatcher,
  ) {
    this.invocations = new Map(invocations.map(reference => [reference.invocationId, { ...reference }]));
  }

  async getStatus(lookup: ForgeInvocationStatusLookup): Promise<ForgeInvocationStatus> {
    const reference = this.requireReference(lookup.invocationId);

    return this.engine.getForgeInvocationStatus(
      reference.taskId,
      reference.invocationId,
      lookup.audit ?? reference.audit,
    );
  }

  async getEvents(lookup: ForgeInvocationEventsLookup): Promise<ForgeInvocationEvents> {
    const reference = this.requireReference(lookup.invocationId);
    await this.engine.getTask(reference.taskId);
    const result = await this.engine.taskStore.getEvents(reference.taskId, { afterSeq: lookup.afterSeq });

    return {
      invocationId: reference.invocationId,
      taskId: reference.taskId,
      events: result.events,
      warnings: result.warnings,
      integrityFailed: result.integrityFailed,
    };
  }

  async getProgress(lookup: ForgeInvocationProgressLookup): Promise<ForgeInvocationProgress> {
    const reference = this.requireReference(lookup.invocationId);
    const snapshot = await this.engine.getTask(reference.taskId);

    return {
      invocationId: reference.invocationId,
      taskId: reference.taskId,
      phase: snapshot.phase,
      updatedAt: snapshot.task.updatedAt,
      currentIteration: snapshot.task.currentIteration,
      validationPassed: snapshot.validationPassed,
      pendingApproval: Boolean(snapshot.pendingApproval),
      usage: {
        elapsedActiveMs: snapshot.usage.elapsedActiveMs,
        waitingApprovalMs: snapshot.usage.waitingApprovalMs,
        modelCalls: snapshot.usage.modelCalls,
        toolCalls: snapshot.usage.toolCalls,
        repairAttempts: snapshot.usage.repairAttempts,
        iterations: snapshot.usage.iterations,
        outputBytes: snapshot.usage.outputBytes,
        noProgressSteps: snapshot.usage.noProgressSteps,
        repeatedValidationFailures: snapshot.usage.repeatedValidationFailures,
        lastProgressAt: snapshot.usage.lastProgressAt,
      },
      budgets: {
        maxWallClockMs: snapshot.budgets.maxWallClockMs,
        maxModelCalls: snapshot.budgets.maxModelCalls,
        maxToolCalls: snapshot.budgets.maxToolCalls,
        maxRepairAttempts: snapshot.budgets.maxRepairAttempts,
        maxIterations: snapshot.budgets.maxIterations,
        maxOutputBytes: snapshot.budgets.maxOutputBytes,
        maxNoProgressSteps: snapshot.budgets.maxNoProgressSteps,
      },
    };
  }

  prepare(request: ForgeInvocationPreparationInput): ForgeInvocationPreparation {
    const validation = validateForgeInvocationPreparationRequest(request);

    return {
      invocationId: request.invocationId,
      taskId: request.taskId,
      ready: validation.accepted,
      phase: 'prepared',
      contractVersion: 1,
      nonExecuting: true,
      sideEffects: 'none',
      validation,
      audit: request.audit,
    };
  }

  canStart(request: ForgeInvocationStartEligibilityInput): ForgeInvocationStartEligibility {
    const validation = validateForgeInvocationStartEligibilityRequest(request);
    const reasons: ForgeInvocationStartEligibility['reasons'] = [];
    const missingPrerequisites = [...validation.errors];

    if (validation.accepted && !request.prepared) {
      missingPrerequisites.push('prepared invocation');
      reasons.push({
        code: 'missing_preparation',
        message: 'Invocation must be prepared before start eligibility can pass.',
      });
    }

    if (!validation.accepted) {
      reasons.push({
        code: 'invalid_request',
        message: 'Start eligibility request shape is invalid.',
      });
    } else if (request.prepared) {
      reasons.push({
        code: 'eligible',
        message: 'Invocation has the required dry-run prerequisites to start.',
      });
    }

    return {
      invocationId: request.invocationId,
      taskId: request.taskId,
      eligible: validation.accepted && request.prepared,
      contractVersion: 1,
      sideEffects: 'none',
      nonExecuting: true,
      reasons,
      missingPrerequisites,
      audit: request.audit,
    };
  }

  reserveStart(request: ForgeInvocationStartReservationInput): ForgeInvocationStartReservation {
    const eligibilityBasis = this.canStart(request);
    const createdAt = this.now();
    const expiresAt = new Date(Date.parse(createdAt) + 5 * 60 * 1000).toISOString();
    const reservationId = createStartReservationId(request.invocationId, request.taskId);
    const accepted = eligibilityBasis.eligible;
    const reasons = accepted
      ? [{
        code: 'reserved',
        message: 'Start intent reservation recorded in memory.',
      }]
      : eligibilityBasis.reasons.map(reason => ({ ...reason }));

    const reservation: ForgeInvocationStartReservation = {
      accepted,
      reservationId: accepted ? reservationId : undefined,
      invocationId: request.invocationId,
      taskId: request.taskId,
      eligibilityBasis,
      contractVersion: 1,
      sideEffects: 'metadata-only',
      nonExecuting: true,
      createdAt,
      expiresAt,
      reasons,
      audit: request.audit,
    };

    if (accepted) {
      this.startReservations.set(reservationId, reservation);
      this.reservationGoals.set(reservationId, request.goal);
    }

    return reservation;
  }

  getReservation(request: ForgeInvocationStartReservationLookupInput): ForgeInvocationStartReservationLookup {
    const validation = validateForgeInvocationStartReservationLookupRequest(request);
    const checkedAt = this.now();

    if (!validation.accepted) {
      return {
        found: false,
        reservationId: request.reservationId,
        active: false,
        expired: false,
        contractVersion: 1,
        sideEffects: 'none',
        nonExecuting: true,
        checkedAt,
        reasons: [{
          code: 'invalid_request',
          message: 'Reservation lookup request shape is invalid.',
        }],
        audit: request.audit,
      };
    }

    const reservation = this.startReservations.get(request.reservationId);
    if (!reservation) {
      return {
        found: false,
        reservationId: request.reservationId,
        active: false,
        expired: false,
        contractVersion: 1,
        sideEffects: 'none',
        nonExecuting: true,
        checkedAt,
        reasons: [{
          code: 'unknown_reservation',
          message: 'No start reservation exists for the requested reservationId.',
        }],
        audit: request.audit,
      };
    }

    const expired = Date.parse(reservation.expiresAt) <= Date.parse(checkedAt);

    return {
      found: true,
      reservationId: request.reservationId,
      reservation,
      active: !expired,
      expired,
      contractVersion: 1,
      sideEffects: 'none',
      nonExecuting: true,
      checkedAt,
      reasons: [{
        code: expired ? 'reservation_expired' : 'reservation_active',
        message: expired
          ? 'Start reservation exists but has expired.'
          : 'Start reservation exists and is active.',
      }],
      audit: request.audit ?? reservation.audit,
    };
  }

  expireReservation(request: ForgeInvocationStartReservationExpirationInput): ForgeInvocationStartReservationExpiration {
    const validation = validateForgeInvocationStartReservationExpirationRequest(request);
    const expiredAt = this.now();

    if (!validation.accepted) {
      return {
        expired: false,
        found: false,
        reservationId: request.reservationId,
        contractVersion: 1,
        sideEffects: 'metadata-only',
        nonExecuting: true,
        expiredAt,
        reasons: [{
          code: 'invalid_request',
          message: 'Reservation expiration request shape is invalid.',
        }],
        audit: request.audit,
      };
    }

    const reservation = this.startReservations.get(request.reservationId);
    if (!reservation) {
      return {
        expired: false,
        found: false,
        reservationId: request.reservationId,
        contractVersion: 1,
        sideEffects: 'metadata-only',
        nonExecuting: true,
        expiredAt,
        reasons: [{
          code: 'unknown_reservation',
          message: 'No start reservation exists for the requested reservationId.',
        }],
        audit: request.audit,
      };
    }

    this.startReservations.delete(request.reservationId);
    this.reservationGoals.delete(request.reservationId);

    return {
      expired: true,
      found: true,
      reservationId: request.reservationId,
      reservation,
      contractVersion: 1,
      sideEffects: 'metadata-only',
      nonExecuting: true,
      expiredAt,
      reasons: [{
        code: 'reservation_expired',
        message: 'Start reservation metadata was expired and removed.',
      }],
      audit: request.audit ?? reservation.audit,
    };
  }
  listReservations(request: ForgeInvocationStartReservationListInput = {}): ForgeInvocationStartReservationList {
    const checkedAt = this.now();
    const reservations = [...this.startReservations.values()];
    const activeReservations = reservations.filter(
      reservation => Date.parse(reservation.expiresAt) > Date.parse(checkedAt),
    );
    const expiredReservations = reservations.filter(
      reservation => Date.parse(reservation.expiresAt) <= Date.parse(checkedAt),
    );
    const visibleReservations = request.includeExpired
      ? reservations
      : activeReservations;

    return {
      reservations: visibleReservations.map(reservation => ({ ...reservation })),
      total: visibleReservations.length,
      active: activeReservations.length,
      expired: expiredReservations.length,
      contractVersion: 1,
      sideEffects: 'none',
      nonExecuting: true,
      checkedAt,
      audit: request.audit,
    };
  }
  reservationMetrics(
    request: ForgeInvocationReservationMetricsInput = {},
  ): ForgeInvocationReservationMetrics {
    const checkedAt = this.now();
    const entries = this.queueEntriesAt(checkedAt, true);
    const activeEntries = entries.filter(entry => !entry.expired);
    const expiredEntries = entries.filter(entry => entry.expired);
    const leased = activeEntries.filter(entry => entry.leased).length;

    return {
      total: entries.length,
      active: activeEntries.length,
      expired: expiredEntries.length,
      leased,
      available: activeEntries.length - leased,
      contractVersion: 1,
      sideEffects: 'none',
      nonExecuting: true,
      checkedAt,
      audit: request.audit,
    };
  }
  inspectQueue(
    request: ForgeInvocationQueueInspectionInput = {},
  ): ForgeInvocationQueueInspection {
    const checkedAt = this.now();
    const entries = this.queueEntriesAt(checkedAt, Boolean(request.includeExpired));

    return {
      entries,
      total: entries.length,
      contractVersion: 1,
      sideEffects: 'none',
      nonExecuting: true,
      checkedAt,
      audit: request.audit,
    };
  }
  schedulerSnapshot(
    request: ForgeSchedulerSnapshotInput = {},
  ): ForgeSchedulerSnapshot {
    const checkedAt = this.now();
    const allEntries = this.queueEntriesAt(checkedAt, true);
    const activeEntries = allEntries.filter(entry => !entry.expired);
    const leased = activeEntries.filter(entry => entry.leased).length;
    const queue = request.includeExpired ? allEntries : activeEntries;

    return {
      metrics: {
        total: allEntries.length,
        active: activeEntries.length,
        expired: allEntries.length - activeEntries.length,
        leased,
        available: activeEntries.length - leased,
        contractVersion: 1,
        sideEffects: 'none',
        nonExecuting: true,
        checkedAt,
        audit: request.audit,
      },
      queue,
      contractVersion: 1,
      sideEffects: 'none',
      nonExecuting: true,
      checkedAt,
      audit: request.audit,
    };
  }
  schedulerValidate(
    request: ForgeSchedulerValidationInput = {},
  ): ForgeSchedulerValidation {
    const checkedAt = this.now();
    const issues: ForgeSchedulerValidationIssue[] = [];
    const reservations = [...this.startReservations.entries()];
    const leases = [...this.reservationLeases.entries()];

    for (const [reservationId, reservation] of reservations) {
      if (reservation.reservationId !== reservationId) {
        issues.push({
          code: 'reservation_id_mismatch',
          message: 'Reservation key does not match its recorded reservationId.',
          reservationId,
        });
      }
      if (Date.parse(reservation.expiresAt) <= Date.parse(reservation.createdAt)) {
        issues.push({
          code: 'invalid_reservation_window',
          message: 'Reservation expiresAt is not after createdAt.',
          reservationId,
        });
      }
    }

    for (const [reservationId, lease] of leases) {
      if (lease.reservationId !== reservationId) {
        issues.push({
          code: 'lease_id_mismatch',
          message: 'Lease key does not match its recorded reservationId.',
          reservationId,
        });
      }
      if (!this.startReservations.has(reservationId)) {
        issues.push({
          code: 'orphaned_lease',
          message: 'Lease references a reservation that no longer exists.',
          reservationId,
        });
      }
    }

    return {
      valid: issues.length === 0,
      issues,
      checkedReservations: reservations.length,
      checkedLeases: leases.length,
      contractVersion: 1,
      sideEffects: 'none',
      nonExecuting: true,
      checkedAt,
      audit: request.audit,
    };
  }
  private queueEntriesAt(checkedAt: string, includeExpired: boolean): ForgeInvocationQueueEntry[] {
    const reservations = [...this.startReservations.values()]
      .filter(reservation => includeExpired || Date.parse(reservation.expiresAt) > Date.parse(checkedAt))
      .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));

    return reservations.map((reservation, index) => {
      const lease = reservation.reservationId
        ? this.reservationLeases.get(reservation.reservationId)
        : undefined;

      return {
        reservationId: reservation.reservationId ?? '',
        position: index + 1,
        invocationId: reservation.invocationId,
        taskId: reservation.taskId,
        createdAt: reservation.createdAt,
        expiresAt: reservation.expiresAt,
        expired: Date.parse(reservation.expiresAt) <= Date.parse(checkedAt),
        leased: Boolean(lease),
        ownerId: lease?.ownerId,
      };
    });
  }
  acquireReservation(
    request: ForgeInvocationReservationAcquireInput,
  ): ForgeInvocationReservationAcquire {

    const checkedAt = this.now();

    if (
      !isNonEmptyString(request.reservationId) ||
      !isNonEmptyString(request.ownerId)
    ) {
      return {
        acquired: false,
        alreadyOwned: false,
        reservationId: request.reservationId,
        contractVersion: 1,
        sideEffects: 'metadata-only',
        nonExecuting: true,
        checkedAt,
        reasons: [{
          code: 'invalid_request',
          message: 'Reservation acquisition request shape is invalid.',
        }],
        audit: request.audit,
      };
    }

    const reservation =
      this.startReservations.get(request.reservationId);

    if (!reservation) {
      return {
        acquired: false,
        alreadyOwned: false,
        reservationId: request.reservationId,
        contractVersion: 1,
        sideEffects: 'metadata-only',
        nonExecuting: true,
        checkedAt,
        reasons: [{
          code: 'unknown_reservation',
          message: 'No reservation exists.',
        }],
        audit: request.audit,
      };
    }

    const existing =
      this.reservationLeases.get(request.reservationId);

    if (existing) {

      if (existing.ownerId === request.ownerId) {

        return {
          acquired: true,
          alreadyOwned: true,
          reservationId: request.reservationId,
          lease: existing,
          contractVersion: 1,
          sideEffects: 'metadata-only',
          nonExecuting: true,
          checkedAt,
          reasons: [{
            code: 'already_owned',
            message: 'Reservation already owned by caller.',
          }],
          audit: request.audit,
        };

      }

      return {
        acquired: false,
        alreadyOwned: false,
        reservationId: request.reservationId,
        lease: existing,
        contractVersion: 1,
        sideEffects: 'metadata-only',
        nonExecuting: true,
        checkedAt,
        reasons: [{
          code: 'already_acquired',
          message: 'Reservation already owned by another caller.',
        }],
        audit: request.audit,
      };
    }

    const lease: ForgeInvocationReservationLease = {
      reservationId: request.reservationId,
      ownerId: request.ownerId,
      leaseId: `forge-lease:${request.reservationId}`,
      acquiredAt: checkedAt,
      expiresAt: reservation.expiresAt,
    };

    this.reservationLeases.set(request.reservationId, lease);

    return {
      acquired: true,
      alreadyOwned: false,
      reservationId: request.reservationId,
      lease,
      contractVersion: 1,
      sideEffects: 'metadata-only',
      nonExecuting: true,
      checkedAt,
      reasons: [{
        code: 'acquired',
        message: 'Reservation lease acquired.',
      }],
      audit: request.audit,
    };
  }
  releaseReservation(
    request: ForgeInvocationReservationReleaseInput,
  ): ForgeInvocationReservationRelease {

    const checkedAt = this.now();

    if (
      !isNonEmptyString(request.reservationId) ||
      !isNonEmptyString(request.ownerId)
    ) {
      return {
        released: false,
        alreadyReleased: false,
        reservationId: request.reservationId,
        contractVersion: 1,
        sideEffects: 'metadata-only',
        nonExecuting: true,
        checkedAt,
        reasons: [{
          code: 'invalid_request',
          message: 'Reservation release request shape is invalid.',
        }],
        audit: request.audit,
      };
    }

    const existing =
      this.reservationLeases.get(request.reservationId);

    if (!existing) {
      return {
        released: true,
        alreadyReleased: true,
        reservationId: request.reservationId,
        contractVersion: 1,
        sideEffects: 'metadata-only',
        nonExecuting: true,
        checkedAt,
        reasons: [{
          code: 'not_acquired',
          message: 'No active reservation lease exists; release is a no-op.',
        }],
        audit: request.audit,
      };
    }

    if (existing.ownerId !== request.ownerId) {
      return {
        released: false,
        alreadyReleased: false,
        reservationId: request.reservationId,
        contractVersion: 1,
        sideEffects: 'metadata-only',
        nonExecuting: true,
        checkedAt,
        reasons: [{
          code: 'owner_mismatch',
          message: 'Reservation lease is owned by another caller.',
        }],
        audit: request.audit,
      };
    }

    this.reservationLeases.delete(request.reservationId);

    return {
      released: true,
      alreadyReleased: false,
      reservationId: request.reservationId,
      contractVersion: 1,
      sideEffects: 'metadata-only',
      nonExecuting: true,
      checkedAt,
      reasons: [{
        code: 'released',
        message: 'Reservation lease released.',
      }],
      audit: request.audit,
    };
  }
  renewReservationLease(
    request: ForgeInvocationReservationLeaseRenewalInput,
  ): ForgeInvocationReservationLeaseRenewal {

    const checkedAt = this.now();

    if (
      !isNonEmptyString(request.reservationId) ||
      !isNonEmptyString(request.ownerId)
    ) {
      return {
        renewed: false,
        reservationId: request.reservationId,
        contractVersion: 1,
        sideEffects: 'metadata-only',
        nonExecuting: true,
        checkedAt,
        reasons: [{
          code: 'invalid_request',
          message: 'Reservation lease renewal request shape is invalid.',
        }],
        audit: request.audit,
      };
    }

    const existing =
      this.reservationLeases.get(request.reservationId);

    if (!existing) {
      return {
        renewed: false,
        reservationId: request.reservationId,
        contractVersion: 1,
        sideEffects: 'metadata-only',
        nonExecuting: true,
        checkedAt,
        reasons: [{
          code: 'not_acquired',
          message: 'No active reservation lease exists to renew.',
        }],
        audit: request.audit,
      };
    }

    if (existing.ownerId !== request.ownerId) {
      return {
        renewed: false,
        reservationId: request.reservationId,
        lease: existing,
        contractVersion: 1,
        sideEffects: 'metadata-only',
        nonExecuting: true,
        checkedAt,
        reasons: [{
          code: 'owner_mismatch',
          message: 'Reservation lease is owned by another caller.',
        }],
        audit: request.audit,
      };
    }

    if (Date.parse(existing.expiresAt) <= Date.parse(checkedAt)) {
      return {
        renewed: false,
        reservationId: request.reservationId,
        lease: existing,
        contractVersion: 1,
        sideEffects: 'metadata-only',
        nonExecuting: true,
        checkedAt,
        reasons: [{
          code: 'lease_expired',
          message: 'Reservation lease has already expired and cannot be renewed.',
        }],
        audit: request.audit,
      };
    }

    const renewedLease: ForgeInvocationReservationLease = {
      ...existing,
      expiresAt: new Date(Date.parse(checkedAt) + 5 * 60 * 1000).toISOString(),
    };

    this.reservationLeases.set(request.reservationId, renewedLease);

    return {
      renewed: true,
      reservationId: request.reservationId,
      lease: renewedLease,
      contractVersion: 1,
      sideEffects: 'metadata-only',
      nonExecuting: true,
      checkedAt,
      reasons: [{
        code: 'renewed',
        message: 'Reservation lease renewal recorded in memory.',
      }],
      audit: request.audit,
    };
  }
  async start(request: ForgeInvocationStartInput): Promise<ForgeInvocationStart> {
    const validation = validateForgeInvocationStartRequest(request);
    const reasons: ForgeInvocationStart['reasons'] = [];

    if (!validation.accepted) {
      reasons.push({
        code: 'invalid_request',
        message: 'Start request shape is invalid.',
      });
      return this.startRejected(request, reasons, request.audit);
    }

    const completed = this.completedStarts.get(request.reservationId);
    if (completed) {
      return this.duplicateStart(completed, request.audit);
    }

    if (this.startLocks.has(request.reservationId)) {
      reasons.push({
        code: 'duplicate_start_in_progress',
        message: 'A start request for this reservation is already in progress; engine.startTask was not called again.',
      });
      return this.startRejected(request, reasons, request.audit);
    }

    const reservation = this.startReservations.get(request.reservationId);
    if (!reservation) {
      reasons.push({
        code: 'unknown_reservation',
        message: 'Start requires a reservation returned by forge.invocation.reserveStart.',
      });
      return this.startRejected(request, reasons, request.audit);
    }

    if (!reservation.accepted) {
      reasons.push({
        code: 'reservation_rejected',
        message: 'Start reservation was not accepted.',
      });
    }
    if (reservation.invocationId !== request.invocationId || reservation.taskId !== request.taskId) {
      reasons.push({
        code: 'reservation_mismatch',
        message: 'Start reservation does not match the requested invocation and task.',
      });
    }
    if (Date.parse(reservation.expiresAt) <= Date.parse(this.now())) {
      reasons.push({
        code: 'reservation_expired',
        message: 'Start reservation has expired.',
      });
    }

    if (reasons.length > 0) {
      return this.startRejected(request, reasons, request.audit);
    }

    const existingClaim = this.reservationClaims.get(request.reservationId);
    if (existingClaim && existingClaim !== 'start') {
      reasons.push({
        code: 'reservation_claimed_by_other_execution_path',
        message: 'Reservation is already claimed by a concurrent invokeModel execution and cannot also start the task lifecycle.',
      });
      return this.startRejected(request, reasons, request.audit);
    }

    const audit = request.audit ?? reservation.audit;

    // Execution boundary: the seam where governed lifecycle execution attaches.
    // All pre-execution callables (prepare, canStart, reserveStart) complete before this boundary.
    const executionBoundary: ForgeExecutionBoundary = {
      taskId: request.taskId,
      goal: request.goal,
      mode: request.mode ?? 'agent',
      model: request.model,
      audit,
    };

    // Claim + lock synchronously (no `await` between the checks above and
    // here) so a concurrent invokeModel call cannot race past its own claim
    // check before this reservation is marked as start-owned.
    this.reservationClaims.set(request.reservationId, 'start');
    this.startLocks.add(request.reservationId);

    try {
      await this.engine.startTask({
        taskId: request.taskId,
        goal: request.goal,
        mode: request.mode ?? 'agent',
        model: request.model,
      });
    } catch (error) {
      this.startLocks.delete(request.reservationId);
      this.reservationClaims.delete(request.reservationId);
      return this.startFailed(request, error, audit);
    }

    this.invocations.set(request.invocationId, {
      invocationId: request.invocationId,
      taskId: request.taskId,
      audit,
    });
    this.startReservations.delete(request.reservationId);
    this.reservationGoals.delete(request.reservationId);
    this.startLocks.delete(request.reservationId);
    this.reservationClaims.delete(request.reservationId);

    const status = await this.engine.getForgeInvocationStatus(request.taskId, request.invocationId, audit);

    const startedReasons: ForgeInvocationStart['reasons'] = [{
      code: 'started',
      message: 'Start request accepted and task lifecycle execution began at the execution boundary.',
    }];

    const result: ForgeInvocationStart = {
      invocationId: request.invocationId,
      taskId: request.taskId,
      reservationId: request.reservationId,
      started: true,
      status,
      executionBoundary,
      contractVersion: 1,
      sideEffects: 'task-lifecycle',
      nonExecuting: false,
      reasons: startedReasons,
      audit,
      evidence: {
        invocationId: request.invocationId,
        taskId: request.taskId,
        reservationId: request.reservationId,
        decision: 'started',
        lifecycleAction: 'startTask',
        sideEffects: 'task-lifecycle',
        nonExecuting: false,
        status,
        reasons: startedReasons,
        audit,
      },
    };

    this.completedStarts.set(request.reservationId, result);
    return result;
  }

  private duplicateStart(
    original: ForgeInvocationStart,
    audit?: ForgeInvocationAuditMetadata,
  ): ForgeInvocationStart {
    const reasons: ForgeInvocationStart['reasons'] = [
      ...original.reasons,
      {
        code: 'duplicate_start',
        message: 'Start already completed for this reservation; engine.startTask was not called again.',
      },
    ];

    return {
      ...original,
      reasons,
      audit: audit ?? original.audit,
      evidence: {
        ...original.evidence,
        reasons,
        audit: audit ?? original.evidence.audit,
      },
    };
  }

  /**
   * M4.3: exactly one governed model invocation, gated by the same
   * reservation acceptance/expiry checks as `start`. Deliberately does not
   * call `engine.startTask` — see `ForgeInvocationModelCallRequest` for why
   * that would break the "one model call, zero tools, zero planning"
   * invariant. `invocationId`/`taskId`/the governed prompt are all derived
   * from the validated reservation, never accepted from the caller.
   *
   * Concurrency: concurrent calls for the same reservationId share one
   * in-flight promise (`inFlightModelCalls`) so the dispatcher/provider is
   * invoked at most once; the reservation itself is atomically claimed
   * (`reservationClaims`) so it cannot also be crossed by `start` while a
   * model call is in flight, and vice versa. Once a model call actually
   * completes, the reservation is consumed (deleted) the same way `start`
   * consumes it on success, so a completed model call cannot later
   * authorize `start`.
   */
  async invokeModel(request: ForgeInvocationModelCallInput): Promise<ForgeInvocationModelCall> {
    const startedAt = this.now();
    const validation = validateForgeInvocationModelCallRequest(request);

    if (!validation.accepted) {
      return this.modelCallRejected(
        { invocationId: '', taskId: '', reservationId: request.reservationId ?? '', model: request.model ?? '' },
        [{ code: 'invalid_request', message: 'Model call request shape is invalid.' }],
        startedAt,
        request.audit,
      );
    }

    const completed = this.completedModelCalls.get(request.reservationId);
    if (completed) {
      return this.duplicateModelCall(completed, request.audit);
    }

    const inFlight = this.inFlightModelCalls.get(request.reservationId);
    if (inFlight) {
      return inFlight;
    }

    const execution = this.executeModelCall(request, startedAt);
    this.inFlightModelCalls.set(request.reservationId, execution);
    try {
      return await execution;
    } finally {
      this.inFlightModelCalls.delete(request.reservationId);
    }
  }

  /**
   * Internal cancellation, resolved without a second externally visible
   * cancellation protocol: not a Forge callable, not part of
   * `ForgeCallableRequest`, and not reachable over the JSON transport.
   * Marks the reservation cancelled (covers pre-execution cancellation
   * before `invokeModel` is even called) and aborts the adapter-owned
   * `AbortController` for any in-flight dispatch (covers in-flight
   * cancellation reaching `InferenceProvider.chat` through the dispatcher).
   */
  cancelModelCall(reservationId: string): boolean {
    this.cancelledModelCallReservations.add(reservationId);
    const controller = this.modelCallControllers.get(reservationId);
    if (controller) {
      controller.abort();
      return true;
    }
    return false;
  }

  /**
   * M4.5-M4.6: read-only retrieval of a governed model execution's terminal
   * result/evidence by the reservation it was invoked under, scoped to the
   * invocation/task identity that owns that reservation. Never calls
   * `engine.startTask`, the dispatcher, or any provider — it only reads the
   * existing in-memory state already maintained by `invokeModel`
   * (`completedModelCalls`, `inFlightModelCalls`, `startReservations`), and
   * mutates none of it. A non-terminal call is reported as `pending`, never
   * fabricated as `completed`/`failed`. An unknown reservationId is
   * `not_found`; a reservation that exists but belongs to a different
   * invocation/task is `ownership_mismatch` — in both cases no evidence is
   * returned.
   */
  getModelExecutionResult(request: ForgeInvocationModelResultLookupInput): ForgeInvocationModelResultLookup {
    const checkedAt = this.now();
    const validation = validateForgeInvocationModelResultLookupRequest(request);

    if (!validation.accepted) {
      return {
        found: false,
        ready: false,
        outcome: 'invalid_request',
        reservationId: request.reservationId ?? '',
        invocationId: request.invocationId ?? '',
        taskId: request.taskId ?? '',
        contractVersion: 1,
        nonExecuting: true,
        sideEffects: 'none',
        checkedAt,
        reasons: [{
          code: 'invalid_request',
          message: 'Model execution result lookup request shape is invalid.',
        }],
        audit: request.audit,
      };
    }

    const completed = this.completedModelCalls.get(request.reservationId);
    if (completed) {
      if (completed.invocationId !== request.invocationId || completed.taskId !== request.taskId) {
        return this.modelResultOwnershipMismatch(request, checkedAt);
      }

      return {
        found: true,
        ready: true,
        outcome: completed.evidence.status,
        reservationId: request.reservationId,
        invocationId: completed.invocationId,
        taskId: completed.taskId,
        model: completed.evidence.model,
        invoked: completed.invoked,
        failureCode: completed.failureCode,
        evidence: completed.evidence,
        contractVersion: 1,
        nonExecuting: true,
        sideEffects: 'none',
        checkedAt,
        reasons: [{
          code: 'result_ready',
          message: 'Terminal governed model execution result is available.',
        }],
        audit: request.audit ?? completed.audit,
      };
    }

    if (this.inFlightModelCalls.has(request.reservationId)) {
      return this.modelResultPending(request, checkedAt, 'Model execution is still in progress.');
    }

    const reservation = this.startReservations.get(request.reservationId);
    if (reservation) {
      if (reservation.invocationId !== request.invocationId || reservation.taskId !== request.taskId) {
        return this.modelResultOwnershipMismatch(request, checkedAt);
      }

      return this.modelResultPending(request, checkedAt, 'Reservation exists but the model has not been invoked yet.');
    }

    return {
      found: false,
      ready: false,
      outcome: 'not_found',
      reservationId: request.reservationId,
      invocationId: request.invocationId,
      taskId: request.taskId,
      contractVersion: 1,
      nonExecuting: true,
      sideEffects: 'none',
      checkedAt,
      reasons: [{
        code: 'unknown_reservation',
        message: 'No governed model execution is known for the requested reservationId.',
      }],
      audit: request.audit,
    };
  }

  private modelResultOwnershipMismatch(
    request: ForgeInvocationModelResultLookupInput,
    checkedAt: string,
  ): ForgeInvocationModelResultLookup {
    return {
      found: false,
      ready: false,
      outcome: 'ownership_mismatch',
      reservationId: request.reservationId,
      invocationId: request.invocationId,
      taskId: request.taskId,
      contractVersion: 1,
      nonExecuting: true,
      sideEffects: 'none',
      checkedAt,
      reasons: [{
        code: 'ownership_mismatch',
        message: 'The requested invocation/task identity does not own this reservation.',
      }],
      audit: request.audit,
    };
  }

  private modelResultPending(
    request: ForgeInvocationModelResultLookupInput,
    checkedAt: string,
    message: string,
  ): ForgeInvocationModelResultLookup {
    return {
      found: true,
      ready: false,
      outcome: 'pending',
      reservationId: request.reservationId,
      invocationId: request.invocationId,
      taskId: request.taskId,
      contractVersion: 1,
      nonExecuting: true,
      sideEffects: 'none',
      checkedAt,
      reasons: [{ code: 'not_ready', message }],
      audit: request.audit,
    };
  }

  private async executeModelCall(
    request: ForgeInvocationModelCallInput,
    startedAt: string,
  ): Promise<ForgeInvocationModelCall> {
    const reasons: ForgeInvocationModelCall['reasons'] = [];

    if (this.cancelledModelCallReservations.has(request.reservationId)) {
      this.cancelledModelCallReservations.delete(request.reservationId);
      return this.modelCallCancelled(
        { invocationId: '', taskId: '', reservationId: request.reservationId, model: request.model },
        startedAt,
        request.audit,
      );
    }

    const reservation = this.startReservations.get(request.reservationId);
    const identity = (): ForgeInvocationModelCallIdentity => ({
      invocationId: reservation?.invocationId ?? '',
      taskId: reservation?.taskId ?? '',
      reservationId: request.reservationId,
      model: request.model,
    });

    if (!reservation) {
      reasons.push({
        code: 'unknown_reservation',
        message: 'Model call requires a reservation returned by forge.invocation.reserveStart.',
      });
      return this.modelCallRejected(identity(), reasons, startedAt, request.audit);
    }

    if (!reservation.accepted) {
      reasons.push({ code: 'reservation_rejected', message: 'Start reservation was not accepted.' });
    }
    if (Date.parse(reservation.expiresAt) <= Date.parse(this.now())) {
      reasons.push({ code: 'reservation_expired', message: 'Start reservation has expired.' });
    }
    if (reasons.length > 0) {
      return this.modelCallRejected(identity(), reasons, startedAt, request.audit);
    }

    if (!this.modelDispatcher) {
      reasons.push({
        code: 'model_dispatcher_unavailable',
        message: 'No governed model execution dispatcher is configured for this adapter.',
      });
      return this.modelCallRejected(identity(), reasons, startedAt, request.audit);
    }

    const existingClaim = this.reservationClaims.get(request.reservationId);
    if (existingClaim && existingClaim !== 'model') {
      reasons.push({
        code: 'reservation_claimed_by_other_execution_path',
        message: 'Reservation is already claimed by a concurrent start execution and cannot also invoke the model.',
      });
      return this.modelCallRejected(identity(), reasons, startedAt, request.audit);
    }

    const goal = this.reservationGoals.get(request.reservationId);
    if (!isNonEmptyString(goal)) {
      reasons.push({
        code: 'reservation_goal_missing',
        message: 'Reservation does not have an associated governed goal.',
      });
      return this.modelCallRejected(identity(), reasons, startedAt, request.audit);
    }

    // Claim synchronously (no `await` between the checks above and here) so
    // a concurrent `start` call cannot race past its own claim check before
    // this reservation is marked as model-owned.
    this.reservationClaims.set(request.reservationId, 'model');

    if (this.cancelledModelCallReservations.has(request.reservationId)) {
      this.cancelledModelCallReservations.delete(request.reservationId);
      this.reservationClaims.delete(request.reservationId);
      return this.modelCallCancelled(identity(), startedAt, request.audit, goal.length);
    }

    const audit = request.audit ?? reservation.audit;
    const controller = new AbortController();
    this.modelCallControllers.set(request.reservationId, controller);

    const governedRequest: GovernedModelRequest = {
      contractVersion: GOVERNED_MODEL_CONTRACT_VERSION,
      requestId: `forge-model-call:${request.reservationId}`,
      invocationId: reservation.invocationId,
      taskId: reservation.taskId,
      model: request.model,
      prompt: goal,
      signal: controller.signal,
      audit,
    };

    let result: GovernedModelResult;
    try {
      result = await this.modelDispatcher.dispatch(governedRequest);
    } finally {
      this.modelCallControllers.delete(request.reservationId);
      this.reservationClaims.delete(request.reservationId);
    }

    const invoked = result.status === 'completed';
    const outcomeReasons: ForgeInvocationModelCall['reasons'] = invoked
      ? [{ code: 'model_invoked', message: 'Model call accepted and exactly one governed model invocation was performed.' }]
      : [{
        code: result.failureCode ?? 'model_call_failed',
        message: result.failureReason ?? 'Governed model invocation did not complete.',
      }];

    const modelCall: ForgeInvocationModelCall = {
      invocationId: reservation.invocationId,
      taskId: reservation.taskId,
      reservationId: request.reservationId,
      invoked,
      completion: result.completion,
      contractVersion: 1,
      sideEffects: 'model-call',
      nonExecuting: false,
      failureCode: result.failureCode,
      reasons: outcomeReasons,
      audit,
      evidence: result.evidence,
    };

    if (invoked) {
      // The reservation is now consumed by the model-execution path; it can
      // no longer later authorize `start`.
      this.startReservations.delete(request.reservationId);
      this.reservationGoals.delete(request.reservationId);
    }

    // Retain only redacted, non-sensitive metadata for future duplicate
    // calls — never the raw completion text — so idempotent replay cannot
    // leak the completion from an indefinite in-memory cache.
    this.completedModelCalls.set(request.reservationId, { ...modelCall, completion: undefined });

    return modelCall;
  }

  private modelCallRejected(
    identity: ForgeInvocationModelCallIdentity,
    reasons: ForgeInvocationModelCall['reasons'],
    startedAt: string,
    audit?: ForgeInvocationAuditMetadata,
  ): ForgeInvocationModelCall {
    const completedAt = this.now();

    return {
      invocationId: identity.invocationId,
      taskId: identity.taskId,
      reservationId: identity.reservationId,
      invoked: false,
      contractVersion: 1,
      sideEffects: 'metadata-only',
      nonExecuting: true,
      failureCode: 'execution_rejected',
      reasons,
      audit,
      evidence: {
        contractVersion: GOVERNED_MODEL_CONTRACT_VERSION,
        requestId: `forge-model-call:${identity.reservationId}`,
        invocationId: identity.invocationId,
        taskId: identity.taskId,
        model: identity.model,
        startedAt,
        completedAt,
        durationMs: Date.parse(completedAt) - Date.parse(startedAt),
        status: 'failed',
        failureCode: 'execution_rejected',
        failureReason: reasons.map(reason => reason.message).join('; '),
        audit,
      },
    };
  }

  private modelCallCancelled(
    identity: ForgeInvocationModelCallIdentity,
    startedAt: string,
    audit?: ForgeInvocationAuditMetadata,
    promptCharacterCount?: number,
  ): ForgeInvocationModelCall {
    const completedAt = this.now();
    const reasons: ForgeInvocationModelCall['reasons'] = [{
      code: 'cancelled',
      message: 'Model call was cancelled before the provider was invoked.',
    }];

    return {
      invocationId: identity.invocationId,
      taskId: identity.taskId,
      reservationId: identity.reservationId,
      invoked: false,
      contractVersion: 1,
      sideEffects: 'metadata-only',
      nonExecuting: true,
      failureCode: 'cancelled',
      reasons,
      audit,
      evidence: {
        contractVersion: GOVERNED_MODEL_CONTRACT_VERSION,
        requestId: `forge-model-call:${identity.reservationId}`,
        invocationId: identity.invocationId,
        taskId: identity.taskId,
        model: identity.model,
        startedAt,
        completedAt,
        durationMs: Date.parse(completedAt) - Date.parse(startedAt),
        promptCharacterCount,
        status: 'cancelled',
        failureCode: 'cancelled',
        failureReason: 'Cancelled via the internal model-call cancellation registry.',
        audit,
      },
    };
  }

  private duplicateModelCall(
    original: ForgeInvocationModelCall,
    audit?: ForgeInvocationAuditMetadata,
  ): ForgeInvocationModelCall {
    const reasons: ForgeInvocationModelCall['reasons'] = [
      ...original.reasons,
      {
        code: 'duplicate_model_call',
        message: 'Model already invoked for this reservation; the model was not invoked again.',
      },
    ];

    return {
      ...original,
      reasons,
      audit: audit ?? original.audit,
      evidence: { ...original.evidence, audit: audit ?? original.evidence.audit },
    };
  }

  async controlLifecycle(request: ForgeInvocationLifecycleControlInput): Promise<ForgeInvocationLifecycleControl> {
    const validation = validateForgeInvocationLifecycleControlRequest(request);
    const reasons: ForgeInvocationLifecycleControl['reasons'] = [];

    if (!validation.accepted) {
      reasons.push({
        code: 'invalid_request',
        message: 'Lifecycle control request shape is invalid.',
      });
      return {
        invocationId: request.invocationId,
        taskId: '',
        action: request.action,
        applied: false,
        contractVersion: 1,
        sideEffects: 'task-lifecycle',
        reasons,
        audit: request.audit,
      };
    }

    const reference = this.requireReference(request.invocationId);
    let snapshot;
    if (request.action === 'pause') {
      snapshot = await this.engine.pauseTask(reference.taskId);
    } else if (request.action === 'resume') {
      snapshot = await this.engine.resumeTask(reference.taskId);
    } else {
      snapshot = await this.engine.cancelTask(reference.taskId);
    }

    const status = await this.getStatus({
      invocationId: request.invocationId,
      audit: request.audit ?? reference.audit,
    });

    return {
      invocationId: request.invocationId,
      taskId: reference.taskId,
      action: request.action,
      applied: true,
      status,
      contractVersion: 1,
      sideEffects: 'task-lifecycle',
      reasons: [{
        code: `${request.action}_applied`,
        message: `Invocation lifecycle ${request.action} applied through Forge.`,
      }],
      audit: request.audit ?? reference.audit,
    };
  }
  private requireReference(invocationId: string): ForgeInvocationReference {
    const reference = this.invocations.get(invocationId);
    if (!reference) {
      throw new Error(`Forge invocation not found: ${invocationId}`);
    }
    return reference;
  }

  private startRejected(
    request: Pick<ForgeInvocationStartInput, 'invocationId' | 'taskId' | 'reservationId'>,
    reasons: ForgeInvocationStart['reasons'],
    audit?: ForgeInvocationAuditMetadata,
  ): ForgeInvocationStart {
    return {
      invocationId: request.invocationId,
      taskId: request.taskId,
      reservationId: request.reservationId,
      started: false,
      contractVersion: 1,
      sideEffects: 'metadata-only',
      nonExecuting: true,
      reasons,
      audit,
      evidence: {
        invocationId: request.invocationId,
        taskId: request.taskId,
        reservationId: request.reservationId,
        decision: 'rejected',
        lifecycleAction: 'none',
        sideEffects: 'metadata-only',
        nonExecuting: true,
        reasons,
        audit,
      },
    };
  }

  private startFailed(
    request: Pick<ForgeInvocationStartInput, 'invocationId' | 'taskId' | 'reservationId'>,
    error: unknown,
    audit?: ForgeInvocationAuditMetadata,
  ): ForgeInvocationStart {
    const reasons: ForgeInvocationStart['reasons'] = [{
      code: 'engine_start_failed',
      message: `engine.startTask failed: ${error instanceof Error ? error.message : String(error)}`,
    }];

    return {
      invocationId: request.invocationId,
      taskId: request.taskId,
      reservationId: request.reservationId,
      started: false,
      contractVersion: 1,
      sideEffects: 'task-lifecycle',
      nonExecuting: false,
      reasons,
      audit,
      evidence: {
        invocationId: request.invocationId,
        taskId: request.taskId,
        reservationId: request.reservationId,
        decision: 'rejected',
        lifecycleAction: 'startTask',
        sideEffects: 'task-lifecycle',
        nonExecuting: false,
        reasons,
        audit,
      },
    };
  }
}

export function validateForgeInvocationPreparationRequest(
  request: ForgeInvocationPreparationRequest,
): ForgeInvocationPreparation['validation'] {
  const errors: string[] = [];

  if (!isNonEmptyString(request.invocationId)) {
    errors.push('invocationId must be a non-empty string');
  }
  if (!isNonEmptyString(request.taskId)) {
    errors.push('taskId must be a non-empty string');
  }
  if (!isNonEmptyString(request.goal)) {
    errors.push('goal must be a non-empty string');
  }

  return {
    accepted: errors.length === 0,
    errors,
  };
}

export function validateForgeInvocationStartEligibilityRequest(
  request: ForgeInvocationStartEligibilityRequest,
): { accepted: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!isNonEmptyString(request.invocationId)) {
    errors.push('invocationId must be a non-empty string');
  }
  if (!isNonEmptyString(request.taskId)) {
    errors.push('taskId must be a non-empty string');
  }
  if (!isNonEmptyString(request.goal)) {
    errors.push('goal must be a non-empty string');
  }
  if (typeof request.prepared !== 'boolean') {
    errors.push('prepared must be a boolean');
  }

  return {
    accepted: errors.length === 0,
    errors,
  };
}

export function validateForgeInvocationStartReservationLookupRequest(
  request: ForgeInvocationStartReservationLookupRequest,
): { accepted: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!isNonEmptyString(request.reservationId)) {
    errors.push('reservationId must be a non-empty string');
  }

  return {
    accepted: errors.length === 0,
    errors,
  };
}

export function validateForgeInvocationStartReservationExpirationRequest(
  request: ForgeInvocationStartReservationExpirationRequest,
): { accepted: boolean; errors: string[] } {
  return validateForgeInvocationStartReservationLookupRequest(request);
}
export function validateForgeInvocationStartReservationRequest(
  request: ForgeInvocationStartReservationRequest,
): { accepted: boolean; errors: string[] } {
  return validateForgeInvocationStartEligibilityRequest(request);
}

export function validateForgeInvocationStartRequest(
  request: ForgeInvocationStartRequest,
): { accepted: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!isNonEmptyString(request.invocationId)) {
    errors.push('invocationId must be a non-empty string');
  }
  if (!isNonEmptyString(request.taskId)) {
    errors.push('taskId must be a non-empty string');
  }
  if (!isNonEmptyString(request.goal)) {
    errors.push('goal must be a non-empty string');
  }
  if (!isNonEmptyString(request.reservationId)) {
    errors.push('reservationId must be a non-empty string');
  }

  return {
    accepted: errors.length === 0,
    errors,
  };
}


export function validateForgeInvocationModelCallRequest(
  request: ForgeInvocationModelCallRequest,
): { accepted: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!isNonEmptyString(request.reservationId)) {
    errors.push('reservationId must be a non-empty string');
  }
  if (!isNonEmptyString(request.model)) {
    errors.push('model must be a non-empty string');
  }
  if (request.audit !== undefined && (typeof request.audit !== 'object' || request.audit === null || Array.isArray(request.audit))) {
    errors.push('audit must be an object, not an array, when provided');
  }

  return {
    accepted: errors.length === 0,
    errors,
  };
}

export function validateForgeInvocationModelResultLookupRequest(
  request: ForgeInvocationModelResultLookupRequest,
): { accepted: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!isNonEmptyString(request.reservationId)) {
    errors.push('reservationId must be a non-empty string');
  }
  if (!isNonEmptyString(request.invocationId)) {
    errors.push('invocationId must be a non-empty string');
  }
  if (!isNonEmptyString(request.taskId)) {
    errors.push('taskId must be a non-empty string');
  }
  if (request.audit !== undefined && (typeof request.audit !== 'object' || request.audit === null || Array.isArray(request.audit))) {
    errors.push('audit must be an object, not an array, when provided');
  }

  return {
    accepted: errors.length === 0,
    errors,
  };
}

export function validateForgeInvocationLifecycleControlRequest(
  request: ForgeInvocationLifecycleControlRequest,
): { accepted: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!isNonEmptyString(request.invocationId)) {
    errors.push('invocationId must be a non-empty string');
  }
  if (request.action !== 'pause' && request.action !== 'resume' && request.action !== 'cancel') {
    errors.push('action must be pause, resume or cancel');
  }
  if (request.reason !== undefined && typeof request.reason !== 'string') {
    errors.push('reason must be a string when provided');
  }

  return {
    accepted: errors.length === 0,
    errors,
  };
}

function createStartReservationId(invocationId: string, taskId: string): string {
  return `forge-start-reservation:${invocationId}:${taskId}`;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}





