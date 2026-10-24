import { describe, expect, it } from 'vitest';
import {
  ABSOLUTE_PRODUCTIVE_CEILING,
  IMPLEMENTATION_ALLOWANCE,
  INVESTIGATION_ALLOWANCE,
  MAX_REPAIR_PHASES,
  MISSION_WALL_CLOCK_MS,
  bindAbsoluteMissionDeadline,
  createMissionBudget,
  evaluateMissionBudget,
  formatMissionBudget,
  noteCacheHit,
  noteHostElapsed,
  noteHostFeedback,
  noteProductiveAction,
  noteProtocolRetry,
  noteSuccessfulMutation,
  snapshotMissionBudget,
} from '../runtime/missionBudget';
import { resolveRepeatedRead } from '../runtime/missionProgress';
import type { MissionLedgerEntry } from '../runtime/missionCompaction';
import type { MissionObservation } from '../runtime/missionObservations';

function entry(observation: Partial<MissionObservation> & Pick<MissionObservation, 'action'>): MissionLedgerEntry {
  return {
    observation: {
      resultCount: 1,
      truncated: false,
      ok: true,
      output: observation.action,
      ...observation,
    },
  };
}

describe('mission phase budgets', () => {
  it('starts in investigation and does not consume cache or protocol retries', () => {
    let budget = createMissionBudget('2026-09-13T10:00:00.000Z');
    expect(budget.phase).toBe('investigation');
    expect(budget.remaining).toBe(INVESTIGATION_ALLOWANCE);
    budget = noteCacheHit(budget);
    budget = noteProtocolRetry(budget);
    expect(budget.productiveTotal).toBe(0);
    expect(budget.cacheHits).toBe(1);
    expect(budget.protocolRetries).toBe(1);
    expect(budget.remaining).toBe(INVESTIGATION_ALLOWANCE);
    expect(evaluateMissionBudget(budget, Date.parse(budget.startedAt) + 1000)).toBeNull();
    const formatted = formatMissionBudget(budget, Date.parse(budget.startedAt) + 1000);
    expect(formatted).toContain('elapsedMs=1000');
    expect(formatted).toContain('phaseActiveMs=1000');
    expect(formatted).toContain('hostMs=0');
    expect(formatted).toContain(`remainingAbsoluteMs=${MISSION_WALL_CLOCK_MS - 1000}`);
    expect(formatted).toContain('reason=ok');
  });

  it('opens a fresh implementation allowance after the first successful mutation', () => {
    let budget = createMissionBudget();
    for (let i = 0; i < 5; i += 1) budget = noteProductiveAction(budget);
    budget = noteSuccessfulMutation(budget);
    expect(budget.phase).toBe('implementation');
    expect(budget.phaseUsed).toBe(1);
    expect(budget.phaseAllowance).toBe(IMPLEMENTATION_ALLOWANCE);
    expect(budget.productiveTotal).toBe(6);
    expect(budget.remaining).toBe(IMPLEMENTATION_ALLOWANCE - 1);
    expect(budget.lastTransition).toMatch(/began implementation/);
  });

  it('opens a repair phase on failed verification and refuses a third reset', () => {
    let budget = noteSuccessfulMutation(createMissionBudget());
    budget = noteHostFeedback(budget, 'verification_failed');
    expect(budget.phase).toBe('repair');
    expect(budget.repairPhases).toBe(1);
    expect(budget.phaseUsed).toBe(0);
    budget = noteProductiveAction(budget);
    budget = noteHostFeedback(budget, 'verification_failed');
    expect(budget.repairPhases).toBe(2);
    expect(budget.phaseUsed).toBe(0);
    budget = noteProductiveAction(budget);
    const ignored = noteHostFeedback(budget, 'verification_failed');
    expect(ignored.repairPhases).toBe(MAX_REPAIR_PHASES);
    expect(ignored.phaseUsed).toBe(1);
    expect(ignored.lastTransition).toMatch(/no remaining repair phase/);
  });

  it('does not treat cached repeats as a phase reset', () => {
    let budget = noteSuccessfulMutation(createMissionBudget());
    budget = noteProductiveAction(budget);
    const before = budget.phaseUsed;
    budget = noteCacheHit(budget);
    budget = noteCacheHit(budget);
    expect(budget.phaseUsed).toBe(before);
    expect(budget.lastTransition).toMatch(/mutation/);
  });

  it('enforces the wall clock and absolute productive ceiling', () => {
    let budget = createMissionBudget('2026-09-13T10:00:00.000Z');
    expect(evaluateMissionBudget(budget, Date.parse(budget.startedAt) + MISSION_WALL_CLOCK_MS + 1)).toBe(
      'exceeded 20 minute mission wall clock',
    );
    budget = createMissionBudget();
    for (let i = 0; i < ABSOLUTE_PRODUCTIVE_CEILING; i += 1) {
      if (i === 3) budget = noteSuccessfulMutation(budget);
      else budget = noteProductiveAction(budget);
    }
    expect(evaluateMissionBudget(budget)).toMatch(/productive mission actions/);
  });

  it('counts host work toward the absolute deadline and never extends it', () => {
    let budget = createMissionBudget('2026-09-13T10:00:00.000Z');
    const start = Date.parse(budget.startedAt);
    budget = noteHostElapsed(budget, 5 * 60 * 1000);
    expect(evaluateMissionBudget(budget, start + MISSION_WALL_CLOCK_MS)).toBeNull();
    expect(evaluateMissionBudget(budget, start + MISSION_WALL_CLOCK_MS + 1)).toBe(
      'exceeded 20 minute mission wall clock',
    );
    const snapshot = snapshotMissionBudget(budget, start + MISSION_WALL_CLOCK_MS + 1);
    expect(snapshot.hostMs).toBe(5 * 60 * 1000);
    expect(snapshot.elapsedMs).toBe(MISSION_WALL_CLOCK_MS + 1);
    expect(snapshot.remainingAbsoluteMs).toBe(0);
    expect(snapshot.terminationReason).toBe('exceeded 20 minute mission wall clock');
  });

  it('does not extend the absolute deadline after repeated mutations', () => {
    let budget = createMissionBudget('2026-09-13T10:00:00.000Z');
    const start = Date.parse(budget.startedAt);
    budget = noteSuccessfulMutation(budget, new Date(start + 5 * 60_000).toISOString());
    budget = noteSuccessfulMutation(budget, new Date(start + 12 * 60_000).toISOString());
    budget = noteSuccessfulMutation(budget, new Date(start + 19 * 60_000).toISOString());
    expect(evaluateMissionBudget(budget, start + MISSION_WALL_CLOCK_MS)).toBeNull();
    expect(evaluateMissionBudget(budget, start + MISSION_WALL_CLOCK_MS + 1)).toBe(
      'exceeded 20 minute mission wall clock',
    );
    expect(snapshotMissionBudget(budget, start + MISSION_WALL_CLOCK_MS + 1).phaseActiveMs).toBeLessThan(2 * 60_000);
  });

  it('does not extend the absolute deadline after repair failures', () => {
    let budget = createMissionBudget('2026-09-13T10:00:00.000Z');
    const start = Date.parse(budget.startedAt);
    budget = noteSuccessfulMutation(budget, new Date(start + 2 * 60_000).toISOString());
    budget = noteHostFeedback(budget, 'verification_failed', new Date(start + 10 * 60_000).toISOString());
    budget = noteHostFeedback(budget, 'validation_failed', new Date(start + 19 * 60_000).toISOString());
    expect(evaluateMissionBudget(budget, start + MISSION_WALL_CLOCK_MS)).toBeNull();
    expect(evaluateMissionBudget(budget, start + MISSION_WALL_CLOCK_MS + 1)).toBe(
      'exceeded 20 minute mission wall clock',
    );
    expect(formatMissionBudget(budget, start + MISSION_WALL_CLOCK_MS + 1)).toContain(
      'reason=exceeded 20 minute mission wall clock',
    );
  });
});

describe('bindAbsoluteMissionDeadline', () => {
  it('aborts an open generation when the wall clock elapses without treating cancel as the cause', async () => {
    const cancel = new AbortController();
    const anchor = new Date(Date.now() - (MISSION_WALL_CLOCK_MS - 80)).toISOString();
    const bound = bindAbsoluteMissionDeadline(cancel.signal, anchor);
    expect(bound.isDeadlineExpired()).toBe(false);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('deadline did not abort inference')), 2_000);
      bound.signal.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    expect(bound.isDeadlineExpired()).toBe(true);
    expect(cancel.signal.aborted).toBe(false);
    bound.dispose();
  });

  it('aborts immediately when the anchor is already past the wall clock', async () => {
    const cancel = new AbortController();
    const anchor = new Date(Date.now() - MISSION_WALL_CLOCK_MS - 1_000).toISOString();
    const bound = bindAbsoluteMissionDeadline(cancel.signal, anchor);
    await new Promise<void>((resolve) => {
      if (bound.signal.aborted) {
        resolve();
        return;
      }
      bound.signal.addEventListener('abort', () => resolve(), { once: true });
    });
    expect(bound.isDeadlineExpired()).toBe(true);
    bound.dispose();
  });

  it('propagates user cancel without marking the deadline expired', async () => {
    const cancel = new AbortController();
    const anchor = new Date().toISOString();
    const bound = bindAbsoluteMissionDeadline(cancel.signal, anchor);
    cancel.abort();
    expect(bound.signal.aborted).toBe(true);
    expect(bound.isDeadlineExpired()).toBe(false);
    bound.dispose();
  });
});

describe('cached duplicate reads', () => {
  it('returns cached evidence for the same file in the current revision', () => {
    const ledger = [
      entry({
        action: 'read_file',
        path: 'src/app.js',
        range: '1-54',
        fingerprint: 'sha256:app',
        cached: false,
      }),
    ];
    const cached = resolveRepeatedRead({ path: 'src/app.js' }, ledger);
    expect(cached?.cached).toBe(true);
    expect(cached?.action).toBe('read_file');
    ledger.push(entry(cached!));
    ledger.push(entry({
      action: 'propose_file_change',
      path: 'src/app.js',
      ok: true,
    }));
    expect(resolveRepeatedRead({ path: 'src/app.js' }, ledger)).toBeNull();
  });
});
