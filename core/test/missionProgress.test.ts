import { describe, expect, it } from 'vitest';
import type { MissionLedgerEntry } from '../runtime/missionCompaction';
import type { MissionObservation } from '../runtime/missionObservations';
import {
  MAX_DECISION_TURNS,
  MAX_IDENTICAL_SEARCH_RETURNS,
  countDecisionTurns,
  resolveRepeatedSearch,
} from '../runtime/missionProgress';

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

describe('revision-scoped mission progress', () => {
  it('does not reuse a pre-mutation search as the current result', () => {
    const ledger = [
      entry({
        action: 'search',
        query: 'reading list',
        fingerprint: 'sha256:old',
        resultCount: 16,
        cached: false,
      }),
      entry({ action: 'propose_file_change', path: 'index.html', ok: true }),
    ];
    expect(resolveRepeatedSearch({ query: 'reading list' }, ledger)).toBeNull();
  });

  it('resets cached-repeat counts after a new search, read, or verification result', () => {
    const prior = entry({
      action: 'search',
      query: 'reading list',
      fingerprint: 'sha256:old',
      resultCount: 16,
      cached: false,
    });
    const cached = entry({
      action: 'search',
      query: 'reading list',
      fingerprint: 'sha256:old',
      cached: true,
    });
    const afterNewSearch = [
      prior,
      cached,
      cached,
      entry({ action: 'search', query: 'reading list filter book', fingerprint: 'sha256:new', cached: false }),
    ];
    const replay = resolveRepeatedSearch({ query: 'reading list' }, afterNewSearch);
    expect(replay?.action).toBe('search');
    expect(replay?.cached).toBe(true);
    expect(replay?.action).not.toBe('decision_required');

    const afterRead = [
      prior,
      cached,
      cached,
      entry({ action: 'read_file', path: 'src/app.js', ok: true }),
    ];
    expect(resolveRepeatedSearch({ query: 'reading list' }, afterRead)?.action).toBe('search');

    const afterVerification = [
      prior,
      cached,
      cached,
      entry({ action: 'verify_acceptance', path: '.karkedikha/verification-plan.json', ok: false }),
    ];
    expect(resolveRepeatedSearch({ query: 'reading list' }, afterVerification)?.action).toBe('search');
  });

  it('still bounds unchanged searches when no later progress exists', () => {
    const ledger = [
      entry({
        action: 'search',
        query: 'tip calculator',
        fingerprint: 'sha256:same',
        resultCount: 8,
        cached: false,
      }),
    ];
    for (let i = 0; i < MAX_IDENTICAL_SEARCH_RETURNS; i += 1) {
      const again = resolveRepeatedSearch({ query: 'tip calculator' }, ledger);
      expect(again?.cached).toBe(true);
      ledger.push(entry(again!));
    }
    expect(resolveRepeatedSearch({ query: 'tip calculator' }, ledger)?.action).toBe('decision_required');
  });

  it('counts consecutive decision turns only in the current revision', () => {
    expect(MAX_DECISION_TURNS).toBe(2);
    const lifetime = [
      entry({ action: 'decision_required', query: 'reading list', ok: false }),
      entry({ action: 'decision_required', query: 'reading list', ok: false }),
    ];
    expect(countDecisionTurns(lifetime)).toBe(2);

    const afterMutation = [
      ...lifetime,
      entry({ action: 'propose_file_change', path: 'index.html', ok: true }),
      entry({ action: 'search', query: 'reading list filter book', cached: false }),
      entry({ action: 'decision_required', query: 'reading list', ok: false }),
    ];
    expect(countDecisionTurns(afterMutation)).toBe(1);

    const afterVerification = [
      ...lifetime,
      entry({ action: 'verify_acceptance', ok: false }),
      entry({ action: 'decision_required', query: 'reading list', ok: false }),
    ];
    expect(countDecisionTurns(afterVerification)).toBe(1);

    const consecutive = [
      entry({ action: 'read_file', path: 'index.html', ok: true }),
      entry({ action: 'decision_required', query: 'reading list', ok: false }),
      entry({ action: 'search', query: 'reading list', cached: true }),
      entry({ action: 'decision_required', query: 'reading list', ok: false }),
    ];
    expect(countDecisionTurns(consecutive)).toBe(2);
  });
});
