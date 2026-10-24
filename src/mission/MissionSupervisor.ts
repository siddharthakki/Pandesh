import { JournalState } from '../autonomous/recovery/AttemptJournal';
import { MissionCheckpoint } from './MissionCheckpoint';
import { ProviderCircuitBreaker, ProviderReachability } from './ProviderCircuitBreaker';
import { PressureState } from '../telemetry/SustainedPressurePolicy';

export interface MissionSupervisorConfig {
  /** No progress signal for at least this long (per MissionCheckpoint.lastMeaningfulProgressAt) is a stall. */
  stallWindowMs: number;
  /** Same effective-outcome fingerprint observed at least this many times is a repeated failure. */
  repeatedFailureThreshold: number;
  /** Checkpoint at least this often even with no step-count trigger. */
  checkpointIntervalMs: number;
  /** Checkpoint after this many mission steps regardless of elapsed time. */
  checkpointEveryNSteps: number;
  /** Attach mission-aware compaction once the transcript reaches this many messages. */
  compactionMessageThreshold: number;
  providerCooldownMs: number;
}

export const DEFAULT_MISSION_SUPERVISOR_CONFIG: MissionSupervisorConfig = {
  stallWindowMs: 10 * 60_000,
  repeatedFailureThreshold: 3,
  checkpointIntervalMs: 5 * 60_000,
  checkpointEveryNSteps: 10,
  compactionMessageThreshold: 40,
  providerCooldownMs: 5 * 60_000,
};

export type MissionProgressVerdict =
  | { kind: 'progressing' }
  | { kind: 'stalled'; elapsedMs: number }
  | { kind: 'repeated_failure'; fingerprint: string; count: number };

export interface MissionSchedulingState {
  lastCheckpointAt?: string;
  stepsSinceLastCheckpoint: number;
}

export type MissionCompletionVerdict = 'complete' | 'incomplete' | 'needs_validation';

/**
 * Mission-level orchestration above `AutonomousTaskRuntime.runTask`, built to
 * the seams `docs/M43_ENDURANCE_FOUNDATION.md` names rather than inventing a
 * second recovery mechanism: it composes `RecoveryController`'s existing
 * fingerprint/repetition vocabulary (via `AttemptJournal`'s folded
 * `outcomeCounts`) and `MissionCheckpoint`'s progress tracking, and it
 * delegates the actual retry/reroute *decision* to `RecoveryController` /
 * `RecoveryModelRouter` — this class only decides *when* those should run
 * again, when to checkpoint/compact, and whether a mission (not a single
 * task) is done. It owns no I/O of its own: every method takes
 * already-observed state and returns a verdict for the caller to act on.
 *
 * Wiring this into `AutonomousTaskRuntime.runTask`'s live loop is left to a
 * follow-up: the stall/repeated-failure seam next to `runTask` is exactly
 * what the M43 doc calls out, and this class is built to be called from
 * there once that integration lands, without needing to change its own
 * shape.
 */
export class MissionSupervisor {
  private readonly circuitBreaker: ProviderCircuitBreaker;

  constructor(private readonly config: MissionSupervisorConfig = DEFAULT_MISSION_SUPERVISOR_CONFIG) {
    this.circuitBreaker = new ProviderCircuitBreaker({ cooldownMs: config.providerCooldownMs });
  }

  /**
   * No-progress and repeated-failure detection. Repeated failure takes
   * priority (it is a stronger, more specific signal than mere elapsed
   * time) and reuses the same `outcomeCounts` map `RecoveryController`
   * already folds from the journal — no separate fingerprinting is
   * introduced here.
   */
  evaluateProgress(
    checkpoint: Pick<MissionCheckpoint, 'lastMeaningfulProgressAt'>,
    journal: Pick<JournalState, 'outcomeCounts'>,
    now: number = Date.now(),
  ): MissionProgressVerdict {
    for (const [fingerprint, count] of journal.outcomeCounts) {
      if (count >= this.config.repeatedFailureThreshold) {
        return { kind: 'repeated_failure', fingerprint, count };
      }
    }
    if (checkpoint.lastMeaningfulProgressAt) {
      const elapsedMs = now - Date.parse(checkpoint.lastMeaningfulProgressAt);
      if (elapsedMs >= this.config.stallWindowMs) {
        return { kind: 'stalled', elapsedMs };
      }
    }
    return { kind: 'progressing' };
  }

  shouldCheckpoint(scheduling: MissionSchedulingState, now: number = Date.now()): boolean {
    if (scheduling.stepsSinceLastCheckpoint >= this.config.checkpointEveryNSteps) return true;
    if (!scheduling.lastCheckpointAt) return true;
    return now - Date.parse(scheduling.lastCheckpointAt) >= this.config.checkpointIntervalMs;
  }

  shouldCompact(messageCount: number): boolean {
    return messageCount >= this.config.compactionMessageThreshold;
  }

  /**
   * Provider recovery: skips the probe entirely while the breaker is open
   * (a provider down for the whole session is not retried on every turn),
   * otherwise runs it and records the outcome.
   */
  checkProvider<T extends { reachability: ProviderReachability }>(
    probe: () => Promise<T>,
  ): Promise<{ result?: T; skipped: boolean }> {
    return this.circuitBreaker.check(probe);
  }

  /**
   * Resource pressure as one more input to a retry/pause decision (M44.5):
   * purely a read of already-computed `SustainedPressurePolicy` gate states
   * — this method makes no I/O call and enforces nothing itself; it is the
   * caller's job to decide what "pause" means for a given dispatch.
   */
  isUnderResourcePressure(gateStates: Readonly<Record<string, PressureState>>): boolean {
    return Object.values(gateStates).some(state => state === 'pressure');
  }

  /**
   * Completion validation: delegates the actual check to the caller
   * (`ValidationRunner`/`runWorkspaceValidation`'s result, passed in as
   * `validationPassed`); this only decides what a mission-level "done" means
   * once that result is known.
   */
  evaluateCompletion(input: { allPlannedWorkDone: boolean; validationPassed?: boolean }): MissionCompletionVerdict {
    if (!input.allPlannedWorkDone) return 'incomplete';
    if (input.validationPassed === undefined) return 'needs_validation';
    return input.validationPassed ? 'complete' : 'incomplete';
  }
}
