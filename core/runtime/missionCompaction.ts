import { isHostOwnedSearchPath } from './missionHostPaths';
import { formatObservation, missionValidationStatus, missionVerificationStatus, type MissionEvidence, type MissionObservation } from './missionObservations';

export const MISSION_CONTEXT_BUDGET_CHARS = 12_000;

export interface MissionLedgerEntry {
  observation: MissionObservation;
}

export interface CompactedMissionContext {
  prompt: string;
  compacted: boolean;
  omittedBodies: number;
}

export interface MissionPinnedContext {
  goal: string;
  acceptanceCriteria: string[];
  permissions: string[];
  currentDiff?: string;
  latestTestResult?: string;
  missionBudget?: string;
}

function normalizePath(value: string | undefined): string {
  return (value ?? '').replace(/\\/g, '/').replace(/^\.\//, '');
}

function searchKey(observation: MissionObservation): string {
  return `${observation.query ?? ''}|${normalizePath(observation.path)}`;
}

function omitBody(observation: MissionObservation, reason: string): MissionObservation {
  return { ...observation, output: `(${reason})` };
}

function latestSuccessfulReadIndexes(ledger: readonly MissionLedgerEntry[]): Map<string, number> {
  const latest = new Map<string, number>();
  ledger.forEach((entry, index) => {
    const observation = entry.observation;
    // A cached repeat carries only a placeholder ("read result unchanged"),
    // never the file body. Tracking it as the "latest" read for its path
    // would supersede the real read that actually holds the content, so the
    // next model turn loses the evidence the placeholder tells it to use.
    if (observation.action !== 'read_file' || !observation.ok || observation.cached || !observation.path) return;
    if (isHostOwnedSearchPath(observation.path)) return;
    latest.set(normalizePath(observation.path), index);
  });
  return latest;
}

function firstSuccessfulSearchIndexes(ledger: readonly MissionLedgerEntry[]): Map<string, number> {
  const first = new Map<string, number>();
  ledger.forEach((entry, index) => {
    const observation = entry.observation;
    if (observation.action !== 'search' || !observation.ok || observation.cached) return;
    const key = searchKey(observation);
    if (!first.has(key)) first.set(key, index);
  });
  return first;
}

function renderLedger(
  ledger: readonly MissionLedgerEntry[],
  latestReads: Map<string, number>,
  firstSearches: Map<string, number>,
  omitSearchBodies: boolean,
  omittedUniqueReads: Set<number>,
): { bodies: string[]; omittedBodies: number } {
  let omittedBodies = 0;
  const bodies = ledger.map((item, index) => {
    const observation = item.observation;
    if (observation.action === 'read_file' && observation.ok) {
      const path = normalizePath(observation.path);
      if (isHostOwnedSearchPath(path) || latestReads.get(path) !== index || omittedUniqueReads.has(index)) {
        omittedBodies += 1;
        const reason = isHostOwnedSearchPath(path)
          ? 'host-owned body omitted; fingerprint retained'
          : latestReads.get(path) !== index
            ? 'superseded read; fingerprint retained'
            : 'body omitted; fingerprint retained';
        return formatObservation(omitBody(observation, reason));
      }
      return formatObservation(observation);
    }
    if (observation.action === 'search' && observation.ok && !observation.cached) {
      if (omitSearchBodies || firstSearches.get(searchKey(observation)) !== index) {
        omittedBodies += 1;
        return formatObservation(omitBody(
          observation,
          firstSearches.get(searchKey(observation)) !== index
            ? 'duplicate search; result identity retained'
            : 'search output omitted; result identity retained',
        ));
      }
    }
    return formatObservation(observation);
  });
  return { bodies, omittedBodies };
}

function assemble(header: string, bodies: string[]): string {
  return `${header}\nObservations:\n${bodies.join('\n') || '(none)'}`;
}

/**
 * Deterministic host compaction. Pins goal, acceptance, permissions, current
 * diff, latest test result, and file fingerprints. Unique current read bodies
 * stay while the budget allows. Duplicate searches and superseded reads collapse
 * first; host-owned bodies never displace application files.
 */
export function compactMissionContext(
  pinned: MissionPinnedContext,
  evidence: MissionEvidence,
  ledger: readonly MissionLedgerEntry[],
  budgetChars = MISSION_CONTEXT_BUDGET_CHARS,
): CompactedMissionContext {
  const header = [
    `Goal: ${pinned.goal}`,
    `Acceptance: ${pinned.acceptanceCriteria.join(' | ') || '(none)'}`,
    `Permissions: ${pinned.permissions.join('; ')}`,
    `Evidence: mutation=${evidence.approvedMutation ? 'approved' : 'missing'} validation=${missionValidationStatus(evidence)} verification=${missionVerificationStatus(evidence)} repair=${evidence.repairCount ?? 0} diffReview=${evidence.diffReview} commit=${evidence.commitSha ?? 'missing'} delivery=${evidence.deliveryStatus ?? 'pending'}`,
    ...(pinned.missionBudget ? [`Budget: ${pinned.missionBudget}`] : []),
    pinned.currentDiff ? `Current diff:\n${pinned.currentDiff}` : 'Current diff: (none)',
    pinned.latestTestResult ? `Latest test:\n${pinned.latestTestResult}` : 'Latest test: (none)',
  ].join('\n');

  const latestReads = latestSuccessfulReadIndexes(ledger);
  const firstSearches = firstSuccessfulSearchIndexes(ledger);
  const omittedUniqueReads = new Set<number>();

  let rendered = renderLedger(ledger, latestReads, firstSearches, false, omittedUniqueReads);
  let prompt = assemble(header, rendered.bodies);
  if (prompt.length <= budgetChars) {
    return { prompt, compacted: rendered.omittedBodies > 0, omittedBodies: rendered.omittedBodies };
  }

  rendered = renderLedger(ledger, latestReads, firstSearches, true, omittedUniqueReads);
  prompt = assemble(header, rendered.bodies);
  if (prompt.length <= budgetChars) {
    return { prompt, compacted: true, omittedBodies: rendered.omittedBodies };
  }

  const uniqueReadOrder = [...latestReads.values()].sort((left, right) => left - right);
  for (const index of uniqueReadOrder) {
    if (prompt.length <= budgetChars) break;
    omittedUniqueReads.add(index);
    rendered = renderLedger(ledger, latestReads, firstSearches, true, omittedUniqueReads);
    prompt = assemble(header, rendered.bodies);
  }
  if (prompt.length > budgetChars) {
    prompt = `${prompt.slice(0, budgetChars)}\n…[truncated]`;
  }
  return { prompt, compacted: true, omittedBodies: rendered.omittedBodies };
}
