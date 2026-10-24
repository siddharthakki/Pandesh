import type { JournalState } from '../autonomous/recovery/AttemptJournal';
import { emptyFacts, type StageOutcome } from '../autonomous/recovery/RecoveryTypes';
import { deriveFailedApproaches, deriveModelRoutingHistory } from './MissionCheckpointDerivation';
import { emptyMissionCheckpoint, mergeMissionCheckpoint, type MissionCheckpoint } from './MissionCheckpoint';
import { MissionCheckpointStore } from './MissionCheckpointStore';
import { renderMissionCheckpointSummary } from './MissionCompactor';
import {
  DEFAULT_MISSION_SUPERVISOR_CONFIG,
  MissionSchedulingState,
  MissionSupervisor,
  MissionSupervisorConfig,
} from './MissionSupervisor';
import { ProviderCircuitBreaker, ProviderReachability } from './ProviderCircuitBreaker';
import { CpuUsageSampler, takeResourceSnapshot, type ResourceSnapshot } from '../telemetry/ResourceTelemetry';
import { SustainedPressurePolicy, type PressureState } from '../telemetry/SustainedPressurePolicy';
import type { GovernedCodingExecutionResult } from '../coding/GovernedCodingExecutor';

/**
 * Default resource gates for the mission-level sustained-pressure sampler.
 * `SustainedPressurePolicy` deliberately ships with no built-in thresholds
 * (see its own doc comment); these are the runtime's own choice, not a
 * library default, and exist so a real sampling loop has something to feed
 * `evaluate()` with. They favor never falsely tripping over a short spike:
 * hysteresis requires the gauge to stay past the enter threshold for a full
 * minute, and the exit threshold has real headroom under the enter one.
 */
const RESOURCE_PRESSURE_GATES: Record<'cpu' | 'ram' | 'disk', { enterThreshold: number; exitThreshold: number; minSustainedMs: number }> = {
  cpu: { enterThreshold: 92, exitThreshold: 75, minSustainedMs: 60_000 },
  ram: { enterThreshold: 92, exitThreshold: 80, minSustainedMs: 60_000 },
  disk: { enterThreshold: 95, exitThreshold: 88, minSustainedMs: 60_000 },
};

const RESOURCE_SAMPLE_INTERVAL_MS = 30_000;

export interface MissionRuntimeSupervisorOptions {
  /** Where mission checkpoints are durably stored (e.g. `ExtensionContext.globalStorageUri.fsPath`). */
  managedStorageRoot: string;
  taskId: string;
  objective: string;
  config?: MissionSupervisorConfig;
  /** Test seam: overrides the real OS resource probe with a scripted one. Production never sets this. */
  sampleResources?: () => Promise<ResourceSnapshot>;
  /** Test seam: overrides the real 30s sampling cadence. Production never sets this. */
  resourceSampleIntervalMs?: number;
  /** Test seam: overrides the real (minutes-scale hysteresis) resource-pressure gates. Production never sets this. */
  pressureGates?: Record<string, { enterThreshold: number; exitThreshold: number; minSustainedMs: number }>;
  log?: (message: string) => void;
}

/**
 * Glue between `AutonomousTaskRuntime.runTask`'s live mission loop and the
 * standalone M44 modules (`MissionSupervisor`, `MissionCheckpoint*`,
 * `ProviderCircuitBreaker`, `ResourceTelemetry`/`SustainedPressurePolicy`).
 * Mirrors `RecoverySupervisor`'s shape on purpose: it owns no decision
 * policy of its own beyond scheduling *when* those modules run, and every
 * consequential decision (retry/reroute/replan) is still made by the
 * existing `RecoveryController` — this class only feeds it a synthetic
 * stall/repeated-failure signal when one fires, exactly as
 * `docs/M43_ENDURANCE_FOUNDATION.md` and `MissionSupervisor`'s own doc
 * comment describe.
 */
export class MissionRuntimeSupervisor {
  private readonly store: MissionCheckpointStore;
  private readonly supervisor: MissionSupervisor;
  private readonly providerBreakers = new Map<string, ProviderCircuitBreaker>();
  private readonly cpuSampler = new CpuUsageSampler();
  private readonly pressurePolicy: SustainedPressurePolicy;
  private resourceTimer?: NodeJS.Timeout;
  private latestGateStates: Readonly<Record<string, PressureState>> = {};
  private latestSnapshot?: ResourceSnapshot;
  private scheduling: MissionSchedulingState = { stepsSinceLastCheckpoint: 0 };
  private checkpointValue: MissionCheckpoint;

  private constructor(
    private readonly options: MissionRuntimeSupervisorOptions,
    checkpoint: MissionCheckpoint,
  ) {
    this.store = new MissionCheckpointStore(options.managedStorageRoot);
    this.supervisor = new MissionSupervisor(options.config ?? DEFAULT_MISSION_SUPERVISOR_CONFIG);
    this.pressurePolicy = new SustainedPressurePolicy(options.pressureGates ?? RESOURCE_PRESSURE_GATES);
    this.checkpointValue = checkpoint;
  }

  /** Restores durable mission state from a prior run when present (a real restart-resume). */
  static async open(options: MissionRuntimeSupervisorOptions): Promise<MissionRuntimeSupervisor> {
    let restored: MissionCheckpoint | undefined;
    try {
      restored = await new MissionCheckpointStore(options.managedStorageRoot).read(options.taskId);
    } catch (error) {
      options.log?.(`mission_checkpoint_read_failed ${error instanceof Error ? error.message : String(error)}`);
    }
    const checkpoint = restored ?? emptyMissionCheckpoint(options.taskId, options.objective);
    const mission = new MissionRuntimeSupervisor(options, checkpoint);
    if (restored) options.log?.(`mission_checkpoint_restored steps=${checkpoint.completedWork.length}`);
    mission.startResourceSampling();
    return mission;
  }

  get checkpoint(): MissionCheckpoint {
    return this.checkpointValue;
  }

  /** Compact durable-facts block to fold into the next dispatch's goal once the mission has run long enough to need it. */
  contextInjection(stepCount: number): string | undefined {
    return this.supervisor.shouldCompact(stepCount) ? renderMissionCheckpointSummary(this.checkpointValue) : undefined;
  }

  /**
   * Folds one executor pass into durable mission memory (all pure reshapes
   * of state the M42 journal already recorded — no new tracking), then
   * checkpoints to disk when `MissionSupervisor.shouldCheckpoint` says the
   * step/time budget calls for it.
   */
  async recordPass(input: {
    result: GovernedCodingExecutionResult;
    journalState: Pick<JournalState, 'decisions' | 'outcomeCounts'>;
    goal: string;
    now?: number;
  }): Promise<void> {
    const now = input.now ?? Date.now();
    const { result } = input;
    const touchedFiles = result.executableProposal?.operations.map(operation => operation.path) ?? [];
    const meaningfulProgress = Boolean(result.mutation) || result.status === 'completed';
    this.checkpointValue = mergeMissionCheckpoint(this.checkpointValue, {
      touchedFiles,
      completedWork: result.status === 'completed' ? [`pass_completed:${result.runId}`] : undefined,
      failedApproaches: deriveFailedApproaches(input.journalState),
      modelRoutingHistory: deriveModelRoutingHistory(input.journalState),
      validationState: result.validationPhase.status === 'completed'
        ? { passed: result.validationPhase.failedCommandCount === 0, lastAttempt: now }
        : undefined,
      lastMeaningfulProgressAt: meaningfulProgress ? new Date(now).toISOString() : undefined,
    });
    this.scheduling.stepsSinceLastCheckpoint += 1;
    if (this.supervisor.shouldCheckpoint(this.scheduling, now)) {
      await this.checkpointNow();
    }
  }

  /** Forces an immediate durable write (e.g. right before a resource-pressure pause). Never throws. */
  async checkpointNow(): Promise<void> {
    try {
      await this.store.write(this.checkpointValue);
      this.scheduling = { stepsSinceLastCheckpoint: 0, lastCheckpointAt: new Date().toISOString() };
    } catch (error) {
      this.options.log?.(`mission_checkpoint_write_failed ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Deletes durable mission state once the mission is genuinely finished; a retryable/blocked task keeps it. */
  async retireOnCompletion(): Promise<void> {
    await this.store.delete(this.options.taskId).catch(() => undefined);
  }

  /** Stall / repeated-failure detection against the same journal bookkeeping `RecoveryController` already folds. */
  evaluateProgress(journalState: Pick<JournalState, 'outcomeCounts'>, now = Date.now()) {
    return this.supervisor.evaluateProgress(this.checkpointValue, journalState, now);
  }

  /**
   * Builds the synthetic `StageOutcome` a detected stall/repeated-failure
   * feeds into the existing `RecoveryController.decide()` — the same
   * observe -> classify -> decide -> persist loop every other outcome goes
   * through, so this never becomes a second, competing state machine.
   */
  synthesizeStallOutcome(input: { attemptId: string; pass: number; verdict: ReturnType<MissionSupervisor['evaluateProgress']> }): StageOutcome {
    const { verdict } = input;
    const detail = verdict.kind === 'stalled'
      ? `no progress for ${Math.round(verdict.elapsedMs / 1000)}s`
      : verdict.kind === 'repeated_failure'
        ? `outcome ${verdict.fingerprint} repeated ${verdict.count} times`
        : 'progressing';
    return {
      attemptId: input.attemptId,
      pass: input.pass,
      stage: 'investigation',
      ok: false,
      status: `mission_${verdict.kind}`,
      cause: 'no_progress',
      subcode: verdict.kind,
      details: [detail],
      facts: emptyFacts(),
      fingerprints: {},
      observedAt: new Date().toISOString(),
    };
  }

  /**
   * The synthetic `StageOutcome` fed into `RecoveryController.decide()` when
   * dispatch is about to redispatch to a provider whose breaker is open. Its
   * `cause: 'provider_failure'` is the SAME cause the controller already
   * classifies real provider errors as, so the controller's own existing
   * (already-tested) escalation ladder — one bounded retry, then
   * `CHANGE_MODEL` from its real candidate pool — decides the reroute; this
   * never invents a second routing table.
   */
  synthesizeProviderOutcome(input: { attemptId: string; pass: number; provider: string; model?: string }): StageOutcome {
    return {
      attemptId: input.attemptId,
      pass: input.pass,
      stage: 'investigation',
      ok: false,
      status: 'mission_provider_breaker_open',
      cause: 'provider_failure',
      subcode: 'circuit_breaker_open',
      details: [`provider ${input.provider}${input.model ? `/${input.model}` : ''} circuit breaker is open`],
      facts: emptyFacts(),
      fingerprints: {},
      model: { provider: input.provider, model: input.model },
      observedAt: new Date().toISOString(),
    };
  }

  /** True while the named provider's circuit breaker is open (recently failed, still cooling down). */
  isProviderOpen(provider: string | undefined, now = Date.now()): boolean {
    if (!provider) return false;
    return this.providerBreaker(provider).isOpen(now);
  }

  /** Bounded provider recovery: a provider that just failed is skipped, not retried on every pass. */
  recordProviderOutcome(provider: string | undefined, reachability: ProviderReachability, now = Date.now()): void {
    if (!provider) return;
    this.providerBreaker(provider).recordOutcome(reachability, now);
  }

  private providerBreaker(provider: string): ProviderCircuitBreaker {
    let breaker = this.providerBreakers.get(provider);
    if (!breaker) {
      breaker = new ProviderCircuitBreaker({ cooldownMs: (this.options.config ?? DEFAULT_MISSION_SUPERVISOR_CONFIG).providerCooldownMs });
      this.providerBreakers.set(provider, breaker);
    }
    return breaker;
  }

  /** True while at least one sampled resource gauge is sustaining pressure (never I/O — reads the last sample). */
  isUnderResourcePressure(): boolean {
    return this.supervisor.isUnderResourcePressure(this.latestGateStates);
  }

  private startResourceSampling(): void {
    const probe = this.options.sampleResources ?? (() => takeResourceSnapshot(this.cpuSampler));
    const sample = async (): Promise<void> => {
      try {
        this.latestSnapshot = await probe();
        const values: Record<string, number> = { ram: this.latestSnapshot.ram.usedPercent };
        if (this.latestSnapshot.cpu.utilizationPercent !== undefined) values.cpu = this.latestSnapshot.cpu.utilizationPercent;
        const disks = this.latestSnapshot.disks;
        if (disks && disks.length > 0) {
          const worstDiskUsedPercent = disks.reduce((max, disk) => {
            const usedPercent = disk.totalBytes > 0 ? 100 * (1 - disk.freeBytes / disk.totalBytes) : 0;
            return Math.max(max, usedPercent);
          }, 0);
          values.disk = worstDiskUsedPercent;
        }
        this.latestGateStates = this.pressurePolicy.evaluate(values, Date.now());
      } catch (error) {
        this.options.log?.(`mission_resource_sample_failed ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    void sample();
    this.resourceTimer = setInterval(() => void sample(), this.options.resourceSampleIntervalMs ?? RESOURCE_SAMPLE_INTERVAL_MS);
    this.resourceTimer.unref?.();
  }

  dispose(): void {
    if (this.resourceTimer) clearInterval(this.resourceTimer);
  }
}
