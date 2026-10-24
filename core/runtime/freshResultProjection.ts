/**
 * M45 Tier 1b — admission of a *fresh* tool batch into the active Saath context.
 *
 * Invariant: canonical tool result != active model-context projection. The full
 * result is already durable (tool_invocations evidence) and was never touched;
 * this module only builds a bounded projection for the in-flight loop delta.
 *
 * `compactLoopDelta` (loopDeltaCompaction.ts) deliberately protects everything
 * after the last assistant message, so when one turn's *new* results alone
 * exceed the budget it has nothing left to clear. Instead of failing closed
 * straight away, the executor asks this module for a fair projection of just
 * the reconstructable read-only results in that newest batch:
 *
 *  - every compactable result stays represented (status line, tool, arguments,
 *    original size, digest, retained head/tail, explicit omission, recovery hint);
 *  - the budget is shared by max-min fairness (water-filling), so one huge file
 *    cannot consume the allowance and erase the other calls, and a result that
 *    fits its fair share is kept verbatim;
 *  - errors, mutation results, validation, policy/strategy notes and anything
 *    without a recorded read-only operation key are never touched.
 *
 * Pure: no I/O, no clock, no model. Message count and order never change, so
 * delta-relative indices (and the compaction cursor) stay valid.
 */
import { createHash } from 'node:crypto';
import type { ModelChatMessage } from './modelBackend';
import { CLEARED_BODY_MARKER, deltaChars, isProtectedNote } from './loopDeltaCompaction';

export const COMPACTED_RESULT_MARKER = '[COMPACTED';
/** Text kept per result at the "sensible minimum" level, before falling back to header-only. */
export const FRESH_MIN_TEXT_KEEP_CHARS = 240;
/** Share of a result's retained text taken from its start; the rest is its end. */
export const FRESH_HEAD_SHARE = 0.7;
/** Aim just under the budget so estimate rounding never flips an admitted batch. */
export const FRESH_BUDGET_SLACK = 0.01;

const SUCCESS_HEADER = /^\[([^\]]+)\] exit=0\n/;
const RANGE_HEADER = /^LINES (\d+)-(\d+) of (\d+)\n/;
const MAX_ARGS_ECHO_CHARS = 120;

export interface FreshProjectionItem {
  index: number;
  operationKey: string;
  toolName: string;
  /** Canonical arguments, bounded for reporting. */
  arguments: string;
  originalChars: number;
  projectedChars: number;
  omittedChars: number;
}

export interface FreshProjection {
  delta: ModelChatMessage[];
  /** Only the results that were actually compacted. */
  items: FreshProjectionItem[];
  /** Characters of every tool result in the newest batch, before projection. */
  freshChars: number;
  beforeChars: number;
  afterChars: number;
  /** The delta is within budget. When false the caller must fail closed and nothing was rewritten. */
  fits: boolean;
  reason?: 'nothing_compactable' | 'minimum_representation_does_not_fit';
}

interface Entry {
  index: number;
  key: string;
  content: string;
  tool: string;
  statusLine: string;
  correctionLine: string | null;
  rangeHeader: string | null;
  body: string;
  lines: string[];
  lineOffset: number;
  totalLines: number;
  argsJson: string;
  path: string | null;
  digest: string;
  truncatedByTool: boolean;
}

function splitLines(body: string): string[] {
  if (body === '') return [];
  const lines = body.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function argsOf(key: string, tool: string): string {
  return key.startsWith(`${tool}:`) ? key.slice(tool.length + 1) : key;
}

function pathOf(argsJson: string): string | null {
  try {
    const parsed = JSON.parse(argsJson) as { path?: unknown };
    return typeof parsed.path === 'string' && parsed.path ? parsed.path : null;
  } catch {
    return null;
  }
}

function parseEntry(index: number, key: string, content: string, digestFor?: (key: string) => string | undefined): Entry | null {
  const head = SUCCESS_HEADER.exec(content);
  if (!head) return null;
  let body = content.slice(head[0].length);
  let correctionLine: string | null = null;
  if (body.startsWith('PATH_CORRECTION ')) {
    const newline = body.indexOf('\n');
    if (newline >= 0) { correctionLine = body.slice(0, newline); body = body.slice(newline + 1); }
  }
  let rangeHeader: string | null = null;
  let lineOffset = 0;
  let declaredTotal: number | null = null;
  const range = RANGE_HEADER.exec(body);
  if (range) {
    rangeHeader = range[0].trimEnd();
    lineOffset = Number(range[1]) - 1;
    declaredTotal = Number(range[3]);
    body = body.slice(range[0].length);
  }
  const lines = splitLines(body);
  const tool = head[1];
  const argsJson = argsOf(key, tool);
  return {
    index, key, content, tool,
    statusLine: `[${tool}] exit=0`,
    correctionLine, rangeHeader, body, lines, lineOffset,
    totalLines: declaredTotal ?? lineOffset + lines.length,
    argsJson,
    path: pathOf(argsJson),
    digest: digestFor?.(key) ?? `sha256:${createHash('sha256').update(content).digest('hex').slice(0, 12)}`,
    truncatedByTool: body.trimEnd().endsWith('…[truncated]'),
  };
}

const fmt = (n: number) => n.toLocaleString('en-US');
const span = (from: number, to: number) => (from === to ? `${from}` : `${from}-${to}`);

/** The projection of one result that keeps about `keep` characters of its body. Returns the original when nothing would be omitted. */
function render(entry: Entry, keep: number): string {
  const headBudget = Math.ceil(keep * FRESH_HEAD_SHARE);
  const tailBudget = keep - headBudget;
  const headLines: string[] = [];
  let used = 0;
  for (const line of entry.lines) {
    if (used + line.length + 1 > headBudget) break;
    headLines.push(line);
    used += line.length + 1;
  }
  const tailLines: string[] = [];
  used = 0;
  for (let i = entry.lines.length - 1; i >= headLines.length; i -= 1) {
    if (used + entry.lines[i].length + 1 > tailBudget) break;
    tailLines.unshift(entry.lines[i]);
    used += entry.lines[i].length + 1;
  }

  let headText = headLines.join('\n');
  let tailText = tailLines.join('\n');
  // A single very long line cannot be kept by whole lines: fall back to character slices.
  const charMode = keep > 0 && headLines.length === 0 && tailLines.length === 0;
  if (charMode) {
    headText = entry.body.slice(0, headBudget);
    tailText = tailBudget > 0 ? entry.body.slice(Math.max(headText.length, entry.body.length - tailBudget)) : '';
  }
  const shownChars = headText.length + tailText.length;
  const omittedChars = entry.body.length - shownChars;
  if (omittedChars <= 0) return entry.content;

  const total = entry.totalLines;
  const first = entry.lineOffset + 1;
  const gapFrom = entry.lineOffset + headLines.length + 1;
  const gapTo = entry.lineOffset + entry.lines.length - tailLines.length;
  const hasGap = !charMode && gapTo >= gapFrom;

  let shown: string;
  if (charMode) {
    shown = shownChars > 0 ? `${fmt(shownChars)} of ${fmt(entry.body.length)} chars` : 'no text';
  } else {
    const ranges: string[] = [];
    if (headLines.length > 0) ranges.push(span(first, first + headLines.length - 1));
    if (tailLines.length > 0) ranges.push(span(gapTo + 1, entry.lineOffset + entry.lines.length));
    shown = ranges.length > 0 ? `lines ${ranges.join(' and ')} of ${fmt(total)}` : `no lines of ${fmt(total)}`;
  }

  const target = entry.path ? `path=${JSON.stringify(entry.path)}` : `args=${entry.argsJson.slice(0, MAX_ARGS_ECHO_CHARS)}`;
  let recover: string;
  if (entry.tool === 'read_file' && entry.path && hasGap) {
    recover = `Recover: read_file path=${JSON.stringify(entry.path)} startLine=${gapFrom} endLine=${gapTo} (narrower ranges cost less)`;
  } else if (entry.tool === 'read_file') {
    recover = 'Recover: a very long line cannot be split by line range; search for or read a different part';
  } else {
    recover = `Recover: repeat ${entry.tool} with narrower arguments`;
  }
  const toolCut = entry.truncatedByTool ? ' The tool output was itself cut at its read limit.' : '';

  const parts = [entry.statusLine];
  if (entry.correctionLine) parts.push(entry.correctionLine);
  if (entry.rangeHeader) parts.push(entry.rangeHeader);
  parts.push(`${COMPACTED_RESULT_MARKER} ${entry.tool} ${target}: ${fmt(entry.content.length)} chars, digest ${entry.digest}]`);
  if (headText) parts.push(headText);
  if (hasGap) parts.push(`… [lines ${span(gapFrom, gapTo)} omitted] …`);
  else if (headText && tailText) parts.push('… [text omitted] …');
  if (tailText) parts.push(tailText);
  parts.push(`${COMPACTED_RESULT_MARKER}: shown ${shown}; ${fmt(omittedChars)} chars omitted. NOT the complete result — Core retains the full output.${toolCut} ${recover}.]`);
  return parts.join('\n');
}

/** The largest kept-body size whose projection is at most `target` characters. */
function renderWithin(entry: Entry, target: number): string {
  let keep = Math.max(0, target - render(entry, 0).length);
  let text = render(entry, keep);
  while (text.length > target && keep > 0) {
    keep = Math.max(0, keep - (text.length - target));
    text = render(entry, keep);
  }
  return text;
}

/** allocation_i = clamp(L, floor_i, cap_i) for the largest L whose sum stays within `avail`. */
function waterFill(floors: readonly number[], caps: readonly number[], avail: number): number[] {
  const total = (level: number) => floors.reduce((sum, floor, i) => sum + Math.min(caps[i], Math.max(floor, level)), 0);
  let lo = 0;
  let hi = Math.max(0, ...caps);
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (total(mid) <= avail) lo = mid; else hi = mid - 1;
  }
  return floors.map((floor, i) => Math.min(caps[i], Math.max(floor, lo)));
}

export function projectFreshResults(input: {
  delta: readonly ModelChatMessage[];
  budgetChars: number;
  /** Delta-relative index → operation key of a clearable (read-only) result. */
  toolMessageKeys: ReadonlyMap<number, string>;
  /** An existing result digest for an operation, when Core already recorded one. */
  digestFor?: (operationKey: string) => string | undefined;
}): FreshProjection {
  const budget = Math.max(0, Math.floor(input.budgetChars));
  const messages = input.delta.map((message) => ({ ...message }));
  const beforeChars = deltaChars(messages);

  let lastAssistant = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === 'assistant') { lastAssistant = i; break; }
  }
  let freshChars = 0;
  const entries: Entry[] = [];
  for (let i = lastAssistant + 1; i < messages.length; i += 1) {
    const message = messages[i];
    if (message.role !== 'tool') continue;
    freshChars += message.content.length;
    const key = input.toolMessageKeys.get(i);
    if (key === undefined || isProtectedNote(message)) continue;
    if (message.content.includes(CLEARED_BODY_MARKER) || message.content.includes(COMPACTED_RESULT_MARKER)) continue;
    const entry = parseEntry(i, key, message.content, input.digestFor);
    // Nothing to gain (or a result already smaller than its own notice): keep it verbatim.
    if (entry && render(entry, 0).length < entry.content.length) entries.push(entry);
  }

  const result = (over: Partial<FreshProjection>): FreshProjection => ({
    delta: messages, items: [], freshChars, beforeChars, afterChars: beforeChars, fits: beforeChars <= budget, ...over,
  });
  if (beforeChars <= budget) return result({});
  if (entries.length === 0) return result({ fits: false, reason: 'nothing_compactable' });

  const caps = entries.map((entry) => entry.content.length);
  const fixedChars = beforeChars - caps.reduce((sum, cap) => sum + cap, 0);
  const headerOnly = entries.map((entry) => render(entry, 0).length);
  const withText = entries.map((entry) => Math.min(render(entry, FRESH_MIN_TEXT_KEEP_CHARS).length, entry.content.length));

  let allocation: number[] | undefined;
  for (const slack of [FRESH_BUDGET_SLACK, 0]) {
    const avail = Math.floor(budget * (1 - slack)) - fixedChars;
    for (const floors of [withText, headerOnly]) {
      if (floors.reduce((sum, floor) => sum + floor, 0) <= avail) { allocation = waterFill(floors, caps, avail); break; }
    }
    if (allocation) break;
  }
  if (!allocation) return result({ fits: false, reason: 'minimum_representation_does_not_fit' });

  const items: FreshProjectionItem[] = [];
  entries.forEach((entry, n) => {
    if (allocation![n] >= entry.content.length) return;
    const projected = renderWithin(entry, allocation![n]);
    if (projected.length >= entry.content.length) return;
    messages[entry.index] = { ...messages[entry.index], content: projected };
    items.push({
      index: entry.index,
      operationKey: entry.key,
      toolName: entry.tool,
      arguments: entry.argsJson.slice(0, MAX_ARGS_ECHO_CHARS),
      originalChars: entry.content.length,
      projectedChars: projected.length,
      omittedChars: entry.content.length - projected.length,
    });
  });
  const afterChars = deltaChars(messages);
  return result({ items, afterChars, fits: afterChars <= budget });
}
