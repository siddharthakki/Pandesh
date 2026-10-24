import type { GovernedModelResult } from '../agent/GovernedModelExecutionTypes';

/**
 * Host-owned investigation evidence. The loop stores structured observations
 * and this module serializes a bounded transcript — it never asks a model to
 * summarize, and it never drops path/range/fingerprint identity for a read.
 */

export const INVESTIGATION_TRANSCRIPT_BUDGET_CHARS = 12_000;
export const INVESTIGATION_TRANSCRIPT_TIGHT_BUDGET_CHARS = 10_000;
/** Newest successful reads whose bodies must survive compaction. */
export const INVESTIGATION_PROTECTED_READ_BODIES = 2;

export type InvestigationRecord =
  | {
    kind: 'read';
    ok: true;
    path: string;
    range: string;
    fingerprint: string;
    content: string;
    totalLines?: number;
    characterCount?: number;
    eof?: boolean;
    requestedRange?: string;
    returnedRange?: string;
    noUnreadContent?: boolean;
  }
  | {
    kind: 'read';
    ok: false;
    path: string;
    error: string;
  }
  | {
    kind: 'search';
    key: string;
    query: string;
    scope: string;
    formatted: string;
  }
  | {
    kind: 'note';
    text: string;
  };

export interface CompactedInvestigationTranscript {
  transcript: string;
  compacted: boolean;
  keptReads: number;
  omittedReadBodies: number;
  /** `${path}\n${range}` of every read whose BODY is present in `transcript` (omitted/dropped ones are absent). */
  includedBodyKeys: ReadonlySet<string>;
}

export interface CompactionOptions {
  /** Read keys (`${path}\n${range}`) that must keep their bodies ahead of any other read: a re-read already granted once. */
  pinnedReadKeys?: ReadonlySet<string>;
}

export function isContextBudgetRejection(result: GovernedModelResult): boolean {
  return result.failureCode === 'execution_rejected'
    && result.evidence?.context?.status === 'blocked';
}

/**
 * Deterministic compaction: keep the latest unique search per query+scope,
 * keep every distinct successful read path+range (latest body wins), keep
 * the latest notes, then drop oldest read *bodies* (not identity) if the
 * serialized transcript still exceeds the budget.
 */
export function compactInvestigationTranscript(
  records: readonly InvestigationRecord[],
  budgetChars: number,
  options: CompactionOptions = {},
): CompactedInvestigationTranscript {
  const compactable = dedupeRecords(records);
  const serialized = compactable.map(record => serializeRecord(record, false, false));
  let omittedReadBodies = 0;

  if (serialized.join('').length <= budgetChars) {
    return {
      transcript: serialized.join(''),
      compacted: compactable.length !== records.length,
      keptReads: compactable.filter(record => record.kind === 'read' && record.ok).length,
      omittedReadBodies: 0,
      includedBodyKeys: bodyKeys(compactable, new Set(), 0),
    };
  }

  const omitSearchMatches = new Set<number>();
  for (let index = 0; index < compactable.length && joinedLength(compactable, new Set(), omitSearchMatches) > budgetChars; index += 1) {
    if (compactable[index].kind === 'search') {
      omitSearchMatches.add(index);
    }
  }

  const protectedReads = protectedReadIndexes(compactable, options.pinnedReadKeys);
  const omitBody = new Set<number>();
  for (let index = 0; index < compactable.length && joinedLength(compactable, omitBody, omitSearchMatches) > budgetChars; index += 1) {
    const record = compactable[index];
    if (record.kind === 'read' && record.ok && !protectedReads.has(index)) {
      omitBody.add(index);
      omittedReadBodies += 1;
    }
  }

  if (joinedLength(compactable, omitBody, omitSearchMatches) > budgetChars) {
    for (const index of protectedReads) {
      if (joinedLength(compactable, omitBody, omitSearchMatches) <= budgetChars) break;
      if (!omitBody.has(index)) {
        omitBody.add(index);
        omittedReadBodies += 1;
      }
    }
  }

  let startIndex = 0;
  while (
    startIndex < compactable.length - 1 &&
    compactable
      .slice(startIndex)
      .reduce((sum, r, idx) => sum + serializeRecord(r, omitBody.has(startIndex + idx), omitSearchMatches.has(startIndex + idx)).length, 0) > budgetChars
  ) {
    startIndex += 1;
  }

  const finalRecords = compactable.slice(startIndex);
  const transcript = finalRecords
    .map((record, idx) => serializeRecord(record, omitBody.has(startIndex + idx), omitSearchMatches.has(startIndex + idx)))
    .join('');
  return {
    transcript,
    compacted: true,
    keptReads: finalRecords.filter(record => record.kind === 'read' && record.ok).length,
    omittedReadBodies,
    includedBodyKeys: bodyKeys(finalRecords, omitBody, startIndex),
  };
}

function bodyKeys(records: readonly InvestigationRecord[], omitBody: ReadonlySet<number>, offset: number): Set<string> {
  const keys = new Set<string>();
  records.forEach((record, index) => {
    if (record.kind === 'read' && record.ok && !record.noUnreadContent && !omitBody.has(offset + index)) keys.add(`${record.path}\n${record.range}`);
  });
  return keys;
}

function dedupeRecords(records: readonly InvestigationRecord[]): InvestigationRecord[] {
  const searches = new Map<string, InvestigationRecord>();
  const reads = new Map<string, InvestigationRecord>();
  const notes: InvestigationRecord[] = [];
  const order: Array<{ type: 'search' | 'read' | 'note'; key: string }> = [];

  for (const record of records) {
    if (record.kind === 'search') {
      if (!searches.has(record.key)) {
        order.push({ type: 'search', key: record.key });
      }
      searches.set(record.key, record);
      continue;
    }
    if (record.kind === 'read') {
      const key = record.ok ? `${record.path}\n${record.range}` : `fail:${record.path}:${record.error}`;
      const existing = order.findIndex(item => item.type === 'read' && item.key === key);
      if (existing >= 0) {
        order.splice(existing, 1);
      }
      order.push({ type: 'read', key });
      reads.set(key, record);
      continue;
    }
    notes.push(record);
    order.push({ type: 'note', key: String(notes.length - 1) });
  }

  const keptNotes = notes.slice(-3);
  const noteStart = Math.max(0, notes.length - keptNotes.length);
  const result: InvestigationRecord[] = [];
  for (const item of order) {
    if (item.type === 'search') {
      const record = searches.get(item.key);
      if (record) result.push(record);
    } else if (item.type === 'read') {
      const record = reads.get(item.key);
      if (record) result.push(record);
    } else {
      const index = Number(item.key);
      if (index >= noteStart) {
        result.push(notes[index]);
      }
    }
  }
  return result;
}

function protectedReadIndexes(records: readonly InvestigationRecord[], pinned?: ReadonlySet<string>): Set<number> {
  const successful: number[] = [];
  const pinnedIndexes: number[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record.kind !== 'read' || !record.ok) continue;
    successful.push(index);
    if (pinned?.has(`${record.path}\n${record.range}`)) pinnedIndexes.push(index);
  }
  return new Set([...successful.slice(-INVESTIGATION_PROTECTED_READ_BODIES), ...pinnedIndexes]);
}

function serializeRecord(record: InvestigationRecord, omitReadBody: boolean, omitSearchMatches: boolean): string {
  if (record.kind === 'note') {
    return record.text;
  }
  if (record.kind === 'search') {
    if (!omitSearchMatches) return record.formatted;
    const header = record.formatted.trimStart().split('\n')[0] ?? `### search: "${record.query}" scope=${record.scope}`;
    return `\n${header}\nMATCH_LINES_OMITTED to fit the local context budget. Re-search this query if you still need the hit list.\n`;
  }
  if (!record.ok) {
    return `\n### read_file: ${record.path}\nFAILED: ${record.error}\n`;
  }

  const formatRange = (r: string): string => (r.startsWith('lines ') ? r : `lines ${r}`);
  const requested = record.requestedRange ? formatRange(record.requestedRange) : formatRange(record.range);
  const returned = record.returnedRange ? formatRange(record.returnedRange) : formatRange(record.range);
  const metaLines = [
    `path: ${record.path}`,
    `requested: ${requested}`,
    `returned: ${returned}`,
  ];
  if (record.totalLines !== undefined) {
    metaLines.push(`totalLines: ${record.totalLines}`);
  }
  if (record.characterCount !== undefined) {
    metaLines.push(`characterCount: ${record.characterCount}`);
  }
  if (record.eof !== undefined) {
    metaLines.push(`eof: ${record.eof ? 'true' : 'false'}`);
  }
  const metaHeader = metaLines.join('\n');

  if (record.noUnreadContent) {
    return `\n### read_file: ${record.path} range=${record.range} fingerprint=${record.fingerprint}\n${metaHeader}\nEOF already reached. File contains ${record.totalLines ?? 0} lines; no unread content remains.\n`;
  }

  if (omitReadBody) {
    return `\n### read_file: ${record.path} range=${record.range} fingerprint=${record.fingerprint}\n${metaHeader}\nBODY_OMITTED to fit the local context budget (${record.characterCount ?? record.content.length} chars preserved as identity only). Re-reading it costs context: ask again only if you truly need these exact bytes (one re-read is allowed).\n`;
  }
  return `\n### read_file: ${record.path} range=${record.range} fingerprint=${record.fingerprint}\n${metaHeader}\nCOMPLETE\n\`\`\`\n${record.content}\n\`\`\`\n`;
}

function joinedLength(
  records: readonly InvestigationRecord[],
  omitBody: ReadonlySet<number>,
  omitSearchMatches: ReadonlySet<number>,
): number {
  return records.reduce(
    (sum, record, index) => sum + serializeRecord(record, omitBody.has(index), omitSearchMatches.has(index)).length,
    0,
  );
}

export function formatInvestigationTranscriptCompacted(
  budgetChars: number,
  keptReads: number,
  omittedReadBodies: number,
): string {
  return `investigation_transcript_compacted budget=${budgetChars} kept_reads=${keptReads} omitted_read_bodies=${omittedReadBodies}`;
}
