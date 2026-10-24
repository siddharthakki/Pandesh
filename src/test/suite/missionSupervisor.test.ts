import { describe, it, expect } from 'vitest';
import { MissionSupervisor, DEFAULT_MISSION_SUPERVISOR_CONFIG } from '../../mission/MissionSupervisor';
import { ProviderCircuitBreaker } from '../../mission/ProviderCircuitBreaker';
import { emptyJournalState } from '../../autonomous/recovery/AttemptJournal';

describe('M44.4 MissionSupervisor.evaluateProgress', () => {
  it('reports progressing when there is no repeated failure and progress is recent', () => {
    const supervisor = new MissionSupervisor();
    const journal = emptyJournalState();
    const now = Date.parse('2026-01-01T00:10:00.000Z');
    const verdict = supervisor.evaluateProgress({ lastMeaningfulProgressAt: '2026-01-01T00:09:00.000Z' }, journal, now);
    expect(verdict).toEqual({ kind: 'progressing' });
  });

  it('reports stalled once no progress has been observed for the configured window', () => {
    const supervisor = new MissionSupervisor({ ...DEFAULT_MISSION_SUPERVISOR_CONFIG, stallWindowMs: 60_000 });
    const journal = emptyJournalState();
    const now = Date.parse('2026-01-01T00:10:00.000Z');
    const verdict = supervisor.evaluateProgress({ lastMeaningfulProgressAt: '2026-01-01T00:08:00.000Z' }, journal, now);
    expect(verdict).toEqual({ kind: 'stalled', elapsedMs: 120_000 });
  });

  it('reports repeated_failure once a fingerprint hits the threshold, ahead of stall', () => {
    const supervisor = new MissionSupervisor({ ...DEFAULT_MISSION_SUPERVISOR_CONFIG, repeatedFailureThreshold: 2, stallWindowMs: 60_000 });
    const journal = emptyJournalState();
    journal.outcomeCounts.set('fp-a', 2);
    const now = Date.parse('2026-01-01T00:10:00.000Z');
    const verdict = supervisor.evaluateProgress({ lastMeaningfulProgressAt: '2026-01-01T00:00:00.000Z' }, journal, now);
    expect(verdict).toEqual({ kind: 'repeated_failure', fingerprint: 'fp-a', count: 2 });
  });
});

describe('M44.4 MissionSupervisor checkpoint/compaction scheduling', () => {
  const supervisor = new MissionSupervisor({ ...DEFAULT_MISSION_SUPERVISOR_CONFIG, checkpointIntervalMs: 60_000, checkpointEveryNSteps: 5 });

  it('checkpoints when no checkpoint has ever been taken', () => {
    expect(supervisor.shouldCheckpoint({ stepsSinceLastCheckpoint: 0 })).toBe(true);
  });

  it('checkpoints once the step count trigger is reached', () => {
    expect(supervisor.shouldCheckpoint({ lastCheckpointAt: new Date().toISOString(), stepsSinceLastCheckpoint: 5 })).toBe(true);
  });

  it('checkpoints once the time interval has elapsed', () => {
    const now = Date.parse('2026-01-01T00:02:00.000Z');
    expect(supervisor.shouldCheckpoint({ lastCheckpointAt: '2026-01-01T00:00:00.000Z', stepsSinceLastCheckpoint: 1 }, now)).toBe(true);
  });

  it('does not checkpoint when neither trigger has fired', () => {
    const now = Date.parse('2026-01-01T00:00:30.000Z');
    expect(supervisor.shouldCheckpoint({ lastCheckpointAt: '2026-01-01T00:00:00.000Z', stepsSinceLastCheckpoint: 1 }, now)).toBe(false);
  });

  it('compacts once the message threshold is reached', () => {
    const compactor = new MissionSupervisor({ ...DEFAULT_MISSION_SUPERVISOR_CONFIG, compactionMessageThreshold: 40 });
    expect(compactor.shouldCompact(39)).toBe(false);
    expect(compactor.shouldCompact(40)).toBe(true);
  });
});

describe('M44.4 MissionSupervisor.evaluateCompletion', () => {
  const supervisor = new MissionSupervisor();

  it('is incomplete while planned work remains', () => {
    expect(supervisor.evaluateCompletion({ allPlannedWorkDone: false })).toBe('incomplete');
  });

  it('needs validation once work is done but validation has not run', () => {
    expect(supervisor.evaluateCompletion({ allPlannedWorkDone: true })).toBe('needs_validation');
  });

  it('is complete once work is done and validation passed', () => {
    expect(supervisor.evaluateCompletion({ allPlannedWorkDone: true, validationPassed: true })).toBe('complete');
  });

  it('is incomplete when work is done but validation failed', () => {
    expect(supervisor.evaluateCompletion({ allPlannedWorkDone: true, validationPassed: false })).toBe('incomplete');
  });
});

describe('M44.4 ProviderCircuitBreaker', () => {
  it('runs the probe when closed and records an unavailable outcome', async () => {
    const breaker = new ProviderCircuitBreaker({ cooldownMs: 60_000 });
    const probe = async () => ({ reachability: 'unavailable' as const });
    const first = await breaker.check(probe, 0);
    expect(first).toEqual({ result: { reachability: 'unavailable' }, skipped: false });
    expect(breaker.isOpen(1_000)).toBe(true);
  });

  it('skips the probe entirely while open, and reports skipped: true', async () => {
    const breaker = new ProviderCircuitBreaker({ cooldownMs: 60_000 });
    await breaker.check(async () => ({ reachability: 'unavailable' as const }), 0);
    let called = false;
    const result = await breaker.check(async () => { called = true; return { reachability: 'ready' as const }; }, 1_000);
    expect(called).toBe(false);
    expect(result).toEqual({ skipped: true });
  });

  it('closes again once the cooldown elapses and a ready probe runs', async () => {
    const breaker = new ProviderCircuitBreaker({ cooldownMs: 60_000 });
    await breaker.check(async () => ({ reachability: 'unavailable' as const }), 0);
    const after = await breaker.check(async () => ({ reachability: 'ready' as const }), 60_001);
    expect(after).toEqual({ result: { reachability: 'ready' }, skipped: false });
    expect(breaker.isOpen(60_002)).toBe(false);
  });

  it('a cancelled outcome does not open or close the breaker', async () => {
    const breaker = new ProviderCircuitBreaker({ cooldownMs: 60_000 });
    await breaker.check(async () => ({ reachability: 'cancelled' as const }), 0);
    expect(breaker.isOpen(1)).toBe(false);
  });
});
