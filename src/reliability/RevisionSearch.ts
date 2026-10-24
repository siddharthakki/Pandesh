export type RevisionOutcome = 'good' | 'bad' | 'unknown';

export interface RevisionProbe {
  evaluate(revision: string, signal: AbortSignal): Promise<RevisionOutcome>;
}

export interface RevisionSearchResult {
  firstBadRevision?: string;
  checked: Array<{ revision: string; outcome: RevisionOutcome }>;
  complete: boolean;
  unknownRevisions: string[];
}

export class RevisionSearch {
  async locateFirstBad(
    revisionsOldestToNewest: readonly string[],
    probe: RevisionProbe,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<RevisionSearchResult> {
    if (revisionsOldestToNewest.length === 0) {
      return { checked: [], complete: false, unknownRevisions: [] };
    }
    const revisions = [...revisionsOldestToNewest];
    const checked = new Map<string, RevisionOutcome>();

    const first = await this.check(revisions[0], probe, signal, checked);
    const last = await this.check(revisions[revisions.length - 1], probe, signal, checked);
    if (first === 'bad') {
      return result(revisions[0], checked, true);
    }
    if (last !== 'bad') {
      return result(undefined, checked, false);
    }

    let low = 0;
    let high = revisions.length - 1;
    let firstBadIndex = high;
    while (low <= high) {
      if (signal.aborted) throw cancellationError();
      const middle = Math.floor((low + high) / 2);
      const outcome = await this.check(revisions[middle], probe, signal, checked);
      if (outcome === 'bad') {
        firstBadIndex = middle;
        high = middle - 1;
      } else if (outcome === 'good') {
        low = middle + 1;
      } else {
        const resolved = await this.resolveUnknown(revisions, middle, low, high, probe, signal, checked);
        if (!resolved) break;
        if (resolved.outcome === 'bad') {
          firstBadIndex = resolved.index;
          high = resolved.index - 1;
        } else {
          low = resolved.index + 1;
        }
      }
    }

    const candidate = revisions[firstBadIndex];
    const predecessor = firstBadIndex > 0
      ? await this.check(revisions[firstBadIndex - 1], probe, signal, checked)
      : 'good';
    const candidateOutcome = await this.check(candidate, probe, signal, checked);
    return result(
      candidateOutcome === 'bad' && predecessor === 'good' ? candidate : undefined,
      checked,
      candidateOutcome === 'bad' && predecessor === 'good',
    );
  }

  private async check(
    revision: string,
    probe: RevisionProbe,
    signal: AbortSignal,
    checked: Map<string, RevisionOutcome>,
  ): Promise<RevisionOutcome> {
    if (signal.aborted) throw cancellationError();
    const existing = checked.get(revision);
    if (existing) return existing;
    const outcome = await probe.evaluate(revision, signal);
    checked.set(revision, outcome);
    return outcome;
  }

  private async resolveUnknown(
    revisions: string[],
    middle: number,
    low: number,
    high: number,
    probe: RevisionProbe,
    signal: AbortSignal,
    checked: Map<string, RevisionOutcome>,
  ): Promise<{ index: number; outcome: Exclude<RevisionOutcome, 'unknown'> } | undefined> {
    for (let distance = 1; middle - distance >= low || middle + distance <= high; distance += 1) {
      for (const index of [middle - distance, middle + distance]) {
        if (index < low || index > high) continue;
        const outcome = await this.check(revisions[index], probe, signal, checked);
        if (outcome !== 'unknown') return { index, outcome };
      }
    }
    return undefined;
  }
}

function result(
  firstBadRevision: string | undefined,
  checked: Map<string, RevisionOutcome>,
  complete: boolean,
): RevisionSearchResult {
  const entries = [...checked.entries()].map(([revision, outcome]) => ({ revision, outcome }));
  return {
    firstBadRevision,
    checked: entries,
    complete,
    unknownRevisions: entries.filter(entry => entry.outcome === 'unknown').map(entry => entry.revision),
  };
}

function cancellationError(): Error {
  const error = new Error('Revision search cancelled.');
  error.name = 'AbortError';
  return error;
}
