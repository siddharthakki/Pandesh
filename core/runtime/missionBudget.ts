/**
 * Progress-sensitive mission phase budgets plus a hard absolute deadline.
 * The 20-minute wall clock is measured from mission start and includes
 * model inference, tools, validation, and browser verification. Mutation,
 * phase transition, and repair feedback never reset it. A separate phase
 * inactivity budget may exclude bounded host work and refresh on genuine
 * progress, but it cannot replace or extend the absolute deadline.
 * Cached duplicates, protocol retries, and host validation or verification
 * do not consume productive allowance. Repeated non-progress never opens
 * a new phase.
 */
export const INVESTIGATION_ALLOWANCE = 12;
export const IMPLEMENTATION_ALLOWANCE = 8;
export const MAX_REPAIR_PHASES = 2;
export const ABSOLUTE_PRODUCTIVE_CEILING = 40;
export const MISSION_WALL_CLOCK_MS = 20 * 60 * 1000;
export const MISSION_PHASE_INACTIVITY_MS = 20 * 60 * 1000;

export type MissionPhase = 'investigation' | 'implementation' | 'repair';

export interface MissionBudget {
  phase: MissionPhase;
  repairPhases: number;
  phaseUsed: number;
  phaseAllowance: number;
  productiveTotal: number;
  protocolRetries: number;
  cacheHits: number;
  remaining: number;
  startedAt: string;
  phaseStartedAt: string;
  phaseHostMs: number;
  hostMs: number;
  elapsedMs: number;
  phaseActiveMs: number;
  remainingAbsoluteMs: number;
  terminationReason: string | null;
  lastTransition: string;
}

export interface MissionBudgetSnapshot {
  elapsedMs: number;
  phaseActiveMs: number;
  hostMs: number;
  productiveTotal: number;
  remainingAbsoluteMs: number;
  terminationReason: string | null;
}

export function createMissionBudget(startedAt = new Date().toISOString()): MissionBudget {
  return persistMissionClock({
    phase: 'investigation',
    repairPhases: 0,
    phaseUsed: 0,
    phaseAllowance: INVESTIGATION_ALLOWANCE,
    productiveTotal: 0,
    protocolRetries: 0,
    cacheHits: 0,
    remaining: INVESTIGATION_ALLOWANCE,
    startedAt,
    phaseStartedAt: startedAt,
    phaseHostMs: 0,
    hostMs: 0,
    elapsedMs: 0,
    phaseActiveMs: 0,
    remainingAbsoluteMs: MISSION_WALL_CLOCK_MS,
    terminationReason: null,
    lastTransition: 'mission started in investigation',
  }, Date.parse(startedAt));
}

export function hydrateMissionBudget(raw?: Partial<MissionBudget> | null): MissionBudget {
  if (!raw) return createMissionBudget();
  const startedAt = raw.startedAt ?? new Date().toISOString();
  return persistMissionClock({
    ...createMissionBudget(startedAt),
    ...raw,
    startedAt,
    phaseStartedAt: raw.phaseStartedAt ?? raw.startedAt ?? startedAt,
    phaseHostMs: raw.phaseHostMs ?? 0,
    hostMs: raw.hostMs ?? 0,
  });
}

function withRemaining(budget: MissionBudget): MissionBudget {
  const phaseLeft = Math.max(0, budget.phaseAllowance - budget.phaseUsed);
  const ceilingLeft = Math.max(0, ABSOLUTE_PRODUCTIVE_CEILING - budget.productiveTotal);
  return { ...budget, remaining: Math.min(phaseLeft, ceilingLeft) };
}

export function missionElapsedMs(budget: MissionBudget, nowMs = Date.now()): number {
  return Math.max(0, nowMs - Date.parse(budget.startedAt));
}

export function phaseElapsedMs(budget: MissionBudget, nowMs = Date.now()): number {
  const raw = nowMs - Date.parse(budget.phaseStartedAt ?? budget.startedAt);
  return Math.max(0, raw - Math.max(0, budget.phaseHostMs ?? 0));
}

export function snapshotMissionBudget(budget: MissionBudget, nowMs = Date.now()): MissionBudgetSnapshot {
  const elapsedMs = missionElapsedMs(budget, nowMs);
  const phaseActiveMs = phaseElapsedMs(budget, nowMs);
  const hostMs = Math.max(0, budget.hostMs ?? 0);
  const remainingAbsoluteMs = Math.max(0, MISSION_WALL_CLOCK_MS - elapsedMs);
  let terminationReason: string | null = null;
  if (elapsedMs > MISSION_WALL_CLOCK_MS) {
    terminationReason = `exceeded ${MISSION_WALL_CLOCK_MS / 60_000} minute mission wall clock`;
  } else if (phaseActiveMs > MISSION_PHASE_INACTIVITY_MS) {
    terminationReason = `exceeded ${MISSION_PHASE_INACTIVITY_MS / 60_000} minute ${budget.phase} inactivity`;
  } else if (budget.productiveTotal >= ABSOLUTE_PRODUCTIVE_CEILING) {
    terminationReason = `exceeded ${ABSOLUTE_PRODUCTIVE_CEILING} productive mission actions`;
  } else if (budget.phaseUsed >= budget.phaseAllowance) {
    terminationReason = `exceeded ${budget.phase} allowance (${budget.phaseAllowance} productive actions)`;
  }
  return {
    elapsedMs,
    phaseActiveMs,
    hostMs,
    productiveTotal: budget.productiveTotal,
    remainingAbsoluteMs,
    terminationReason,
  };
}

export function persistMissionClock(budget: MissionBudget, nowMs = Date.now()): MissionBudget {
  const snapshot = snapshotMissionBudget(budget, nowMs);
  return withRemaining({
    ...budget,
    elapsedMs: snapshot.elapsedMs,
    phaseActiveMs: snapshot.phaseActiveMs,
    remainingAbsoluteMs: snapshot.remainingAbsoluteMs,
    terminationReason: snapshot.terminationReason,
  });
}

export function evaluateMissionBudget(budget: MissionBudget, nowMs = Date.now()): string | null {
  return snapshotMissionBudget(budget, nowMs).terminationReason;
}

/**
 * AbortSignal that fires on user cancel OR when the absolute mission wall
 * clock elapses. Autonomous missions and Local Core must pass this into
 * model streams: a budget check only between turns cannot stop an open
 * generation that has already overrun the deadline (att_3bb591b6).
 */
export function bindAbsoluteMissionDeadline(
  cancelSignal: AbortSignal,
  budgetAnchorIso: string,
  nowMs = Date.now(),
): {
  signal: AbortSignal;
  isDeadlineExpired: () => boolean;
  dispose: () => void;
} {
  const inference = new AbortController();
  let deadlineExpired = false;
  const onCancel = () => inference.abort();
  const deadlineMs = Date.parse(budgetAnchorIso) + MISSION_WALL_CLOCK_MS;
  const onDeadline = () => {
    deadlineExpired = true;
    inference.abort();
  };
  cancelSignal.addEventListener('abort', onCancel);
  if (cancelSignal.aborted) inference.abort();
  const delayMs = deadlineMs - nowMs;
  // Already-expired/invalid anchors must refuse synchronously, before fetch.
  const timer = Number.isFinite(delayMs) && delayMs > 0 ? setTimeout(onDeadline, delayMs) : undefined;
  if (!timer) onDeadline();
  else if (typeof timer.unref === 'function') timer.unref();
  return {
    signal: inference.signal,
    isDeadlineExpired: () => deadlineExpired || Date.now() >= deadlineMs,
    dispose: () => {
      clearTimeout(timer);
      cancelSignal.removeEventListener('abort', onCancel);
    },
  };
}

export function noteProtocolRetry(budget: MissionBudget): MissionBudget {
  return withRemaining({
    ...budget,
    protocolRetries: budget.protocolRetries + 1,
  });
}

export function noteCacheHit(budget: MissionBudget): MissionBudget {
  return withRemaining({
    ...budget,
    cacheHits: budget.cacheHits + 1,
  });
}

export function noteProductiveAction(budget: MissionBudget): MissionBudget {
  return withRemaining({
    ...budget,
    phaseUsed: budget.phaseUsed + 1,
    productiveTotal: budget.productiveTotal + 1,
  });
}

export function noteHostElapsed(budget: MissionBudget, elapsedMs: number): MissionBudget {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return budget;
  const charged = Math.floor(elapsedMs);
  return withRemaining({
    ...budget,
    phaseHostMs: Math.max(0, budget.phaseHostMs ?? 0) + charged,
    hostMs: Math.max(0, budget.hostMs ?? 0) + charged,
  });
}

function refreshPhaseClock(_budget: MissionBudget, nowIso = new Date().toISOString()): Pick<MissionBudget, 'phaseStartedAt' | 'phaseHostMs'> {
  return { phaseStartedAt: nowIso, phaseHostMs: 0 };
}

export function noteSuccessfulMutation(budget: MissionBudget, nowIso = new Date().toISOString()): MissionBudget {
  const nextPhase: MissionPhase = budget.phase === 'investigation' ? 'implementation' : budget.phase;
  return withRemaining({
    ...budget,
    phase: nextPhase,
    phaseAllowance: IMPLEMENTATION_ALLOWANCE,
    phaseUsed: 1,
    productiveTotal: budget.productiveTotal + 1,
    ...refreshPhaseClock(budget, nowIso),
    lastTransition: nextPhase === 'implementation' && budget.phase === 'investigation'
      ? 'successful mutation began implementation'
      : `successful mutation refreshed ${nextPhase}`,
  });
}

export function noteHostFeedback(budget: MissionBudget, kind: 'validation_failed' | 'verification_failed' | 'passed', nowIso = new Date().toISOString()): MissionBudget {
  if (kind === 'passed') {
    return withRemaining({
      ...budget,
      lastTransition: 'host verification or validation passed',
    });
  }
  if (budget.repairPhases >= MAX_REPAIR_PHASES) {
    return withRemaining({
      ...budget,
      lastTransition: 'repair feedback ignored; no remaining repair phase',
    });
  }
  return withRemaining({
    ...budget,
    phase: 'repair',
    repairPhases: budget.repairPhases + 1,
    phaseAllowance: IMPLEMENTATION_ALLOWANCE,
    phaseUsed: 0,
    ...refreshPhaseClock(budget, nowIso),
    lastTransition: `${kind} began repair ${budget.repairPhases + 1}`,
  });
}

export function formatMissionBudget(budget: MissionBudget, nowMs = Date.now()): string {
  const snapshot = snapshotMissionBudget(budget, nowMs);
  return [
    `phase=${budget.phase}`,
    `used=${budget.phaseUsed}/${budget.phaseAllowance}`,
    `productive=${snapshot.productiveTotal}/${ABSOLUTE_PRODUCTIVE_CEILING}`,
    `remaining=${budget.remaining}`,
    `elapsedMs=${snapshot.elapsedMs}`,
    `phaseActiveMs=${snapshot.phaseActiveMs}`,
    `hostMs=${snapshot.hostMs}`,
    `remainingAbsoluteMs=${snapshot.remainingAbsoluteMs}`,
    `repairs=${budget.repairPhases}/${MAX_REPAIR_PHASES}`,
    `protocol=${budget.protocolRetries}`,
    `cacheHits=${budget.cacheHits}`,
    `reason=${snapshot.terminationReason ?? 'ok'}`,
    `transition=${budget.lastTransition}`,
  ].join(' ');
}
