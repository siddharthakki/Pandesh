import type { MissionObservation } from './missionObservations';
import type { MissionLedgerEntry } from './missionCompaction';

export const MAX_IDENTICAL_SEARCH_RETURNS = 2;
export const MAX_DECISION_TURNS = 2;

function searchKey(query: string, path?: string): string {
  return `${query.trim()}|${(path ?? '').replace(/\\/g, '/')}`;
}

function readKey(path: string, range?: string): string {
  return `${path.replace(/\\/g, '/')}|${range ?? ''}`;
}

function isRealSearch(observation: MissionObservation): boolean {
  return observation.action === 'search' && observation.ok === true && !observation.cached;
}

function isSuccessfulMutation(observation: MissionObservation): boolean {
  return (observation.action === 'propose_file_change' || observation.action === 'propose_text_edit') && observation.ok === true;
}

function isProgressObservation(observation: MissionObservation): boolean {
  if (observation.action === 'decision_required') return false;
  if (observation.action === 'protocol_correction') return false;
  if (observation.cached) return false;
  if (observation.action === 'verify_acceptance' || observation.action === 'host_verification') {
    return true;
  }
  if (isSuccessfulMutation(observation)) return true;
  if (observation.action === 'search' && observation.ok) return true;
  if (observation.action === 'read_file' && observation.ok) return true;
  if (observation.action === 'run_check' && observation.ok) return true;
  if (observation.action === 'workspace_validation') return true;
  if (observation.action === 'inspect_page' && observation.ok) return true;
  return false;
}

function lastSuccessfulMutationIndex(ledger: readonly MissionLedgerEntry[]): number {
  for (let index = ledger.length - 1; index >= 0; index -= 1) {
    if (isSuccessfulMutation(ledger[index].observation)) return index;
  }
  return -1;
}

/**
 * Consecutive decision turns in the current workspace revision. Lifetime
 * stalls from an earlier revision or before later progress do not count.
 */
export function countDecisionTurns(ledger: readonly MissionLedgerEntry[]): number {
  const revisionStart = lastSuccessfulMutationIndex(ledger);
  let count = 0;
  for (let index = ledger.length - 1; index > revisionStart; index -= 1) {
    const observation = ledger[index].observation;
    if (observation.action === 'decision_required') {
      count += 1;
      continue;
    }
    if (isProgressObservation(observation)) break;
  }
  return count;
}

/**
 * If this search already has a current result, do not rerun it. After repeated
 * cached returns, force a bounded decision turn instead of looping.
 * Mutation invalidates the cache. Later progress resets the cached-repeat
 * counter so genuine work is not treated as a stall.
 */
export function resolveRepeatedSearch(
  action: { query: string; path?: string },
  ledger: readonly MissionLedgerEntry[],
): MissionObservation | null {
  const key = searchKey(action.query, action.path);
  const revisionStart = lastSuccessfulMutationIndex(ledger);
  let priorIndex = -1;
  for (let index = ledger.length - 1; index > revisionStart; index -= 1) {
    const observation = ledger[index].observation;
    if (isRealSearch(observation) && searchKey(observation.query ?? '', observation.path) === key) {
      priorIndex = index;
      break;
    }
  }
  if (priorIndex < 0) return null;
  const prior = ledger[priorIndex].observation;

  let countStart = priorIndex;
  for (let index = ledger.length - 1; index > priorIndex; index -= 1) {
    if (isProgressObservation(ledger[index].observation)) {
      countStart = index;
      break;
    }
  }

  const cachedAfter = ledger.slice(countStart + 1).filter((entry) => (
    entry.observation.cached === true
    && entry.observation.action === 'search'
    && searchKey(entry.observation.query ?? '', entry.observation.path) === key
  )).length;
  const identity = prior.fingerprint ?? 'unknown';
  if (cachedAfter >= MAX_IDENTICAL_SEARCH_RETURNS) {
    return {
      action: 'decision_required',
      query: action.query,
      path: action.path,
      resultCount: 0,
      truncated: false,
      fingerprint: identity,
      ok: false,
      output: `repeated non-progress: search result ${identity} is still current. Do not search again. Read a new relevant file, propose a change, or explain what information is missing.`,
    };
  }
  return {
    action: 'search',
    query: action.query,
    path: action.path,
    resultCount: prior.resultCount,
    truncated: false,
    fingerprint: identity,
    cached: true,
    ok: true,
    output: `search result unchanged (${identity}). Use existing evidence, read a new relevant file, propose a change, or explain what information is missing.`,
  };
}

function isRealRead(observation: MissionObservation): boolean {
  return observation.action === 'read_file' && observation.ok === true && !observation.cached;
}

function requestedReadKey(action: { path: string; startLine?: number; endLine?: number }): string {
  const start = action.startLine && action.startLine > 0 ? action.startLine : 1;
  const end = action.endLine && action.endLine > 0 ? String(action.endLine) : '*';
  return readKey(action.path, `${start}-${end}`);
}

function observationReadKey(observation: MissionObservation): string {
  const range = observation.range ?? '1-*';
  if (/^1-\d+$/.test(range)) return readKey(observation.path ?? '', '1-*');
  return readKey(observation.path ?? '', range);
}

/**
 * Exact duplicate reads in the current workspace revision return cached
 * evidence. They do not consume a productive action.
 */
export function resolveRepeatedRead(
  action: { path: string; startLine?: number; endLine?: number },
  ledger: readonly MissionLedgerEntry[],
): MissionObservation | null {
  const key = requestedReadKey(action);
  const revisionStart = lastSuccessfulMutationIndex(ledger);
  let priorIndex = -1;
  for (let index = ledger.length - 1; index > revisionStart; index -= 1) {
    const observation = ledger[index].observation;
    if (isRealRead(observation) && observationReadKey(observation) === key) {
      priorIndex = index;
      break;
    }
  }
  if (priorIndex < 0) return null;
  const prior = ledger[priorIndex].observation;
  let countStart = priorIndex;
  for (let index = ledger.length - 1; index > priorIndex; index -= 1) {
    if (isProgressObservation(ledger[index].observation)) {
      countStart = index;
      break;
    }
  }
  const cachedAfter = ledger.slice(countStart + 1).filter((entry) => (
    entry.observation.cached === true
    && entry.observation.action === 'read_file'
    && observationReadKey(entry.observation) === observationReadKey(prior)
  )).length;
  const identity = prior.fingerprint ?? 'unknown';
  if (cachedAfter >= MAX_IDENTICAL_SEARCH_RETURNS) {
    return {
      action: 'decision_required',
      path: action.path,
      range: prior.range,
      resultCount: 0,
      truncated: false,
      fingerprint: identity,
      ok: false,
      output: `repeated non-progress: file ${identity} is still current. Do not read it again. Read a new relevant file, propose a change, or explain what information is missing.`,
    };
  }
  return {
    action: 'read_file',
    path: prior.path,
    range: prior.range,
    resultCount: prior.resultCount,
    truncated: false,
    fingerprint: identity,
    cached: true,
    ok: true,
    output: `read result unchanged (${identity}). Use existing evidence, read a new relevant file, propose a change, or explain what information is missing.`,
  };
}
