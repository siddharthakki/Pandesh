import { WorkspaceInspectionTools, DEFAULT_INSPECTION_LIMITS, throwIfAborted } from './WorkspaceInspection';
import { extractReferencedSymbols } from '../orchestration/ConversationContinuity';

/**
 * Bounded, task-targeted source excerpts for EXISTING files that are too large to show whole.
 *
 * An anchored `edit` needs exact current text. An outline, a symbol list or a byte-0 prefix of a 146 KB file gives
 * the proposer nothing to copy an anchor from, so it guesses and every anchor fails closed. This picks the few regions
 * of a large file that the task's own words (and the functions declared there) point at, and shows them verbatim with
 * file/line provenance. Purely read-only model context: it never decides or applies anything.
 */
export const TARGETED_EXCERPT_LARGE_FILE_CHARS = 20_000;
export const TARGETED_EXCERPT_DEFAULT_MAX_CHARS = 12_000;
export const TARGETED_EXCERPT_DEFAULT_MAX_EXCERPTS = 10;
export const TARGETED_EXCERPT_MAX_FILES = 3;
const TARGETED_EXCERPT_MAX_READ_BYTES = 2_000_000;
const LINES_BEFORE = 6;
const LINES_AFTER = 14;
const MAX_LINE_CHARS = 3_000;
const SOURCE_EXTENSIONS = /\.(html?|js|mjs|cjs|jsx|ts|tsx|vue|svelte|css|scss|py|rb|go|rs|java|kt|cs|php|swift|c|cc|cpp|h|hpp)$/i;

const STOPWORDS = new Set([
  'about', 'above', 'action', 'actions', 'add', 'after', 'again', 'all', 'also', 'and', 'any', 'application', 'are',
  'automatically', 'backend', 'based', 'been', 'before', 'being', 'both', 'but', 'can', 'change', 'code', 'contain',
  'could', 'create', 'demonstrate', 'does', 'each', 'every', 'existing', 'feature', 'file', 'files', 'for', 'framework',
  'from', 'has', 'have', 'implementation', 'into', 'introduce', 'its', 'just', 'make', 'mechanism', 'modifying', 'must',
  'new', 'not', 'only', 'original', 'other', 'refactor', 'redesign', 'reuse', 'same', 'should', 'start', 'still', 'sufficiently',
  'that', 'the', 'their', 'them', 'then', 'there', 'these', 'this', 'unrelated', 'use', 'used', 'using', 'validate',
  'very', 'want', 'way', 'what', 'when', 'where', 'which', 'while', 'will', 'with', 'within', 'without', 'works', 'would',
  'your', 'behavior', 'behaviour', 'architecture', 'model', 'style', 'visual', 'receives', 'different', 'still', 'works',
]);

export interface TargetedExcerpt {
  path: string;
  /** 1-based inclusive. */
  startLine: number;
  endLine: number;
  totalLines: number;
  text: string;
}

export interface TargetedSourceContext {
  excerpts: TargetedExcerpt[];
  /** Rendered prompt block, or '' when nothing relevant was found. */
  text: string;
  terms: string[];
}

export interface TargetedSourceOptions {
  /** Only files at least this large (characters) are excerpted; smaller files are shown whole elsewhere. */
  minFileChars?: number;
  maxChars?: number;
  maxExcerpts?: number;
  /** Restrict to these repository-relative paths; otherwise large source files in the workspace are considered. */
  paths?: readonly string[];
  signal?: AbortSignal;
}

/** Task words worth searching for: code identifiers named in the task plus distinctive plain words, with light stemming. */
export function targetedSearchTerms(task: string): string[] {
  const terms = new Set<string>();
  for (const symbol of extractReferencedSymbols(task)) terms.add(symbol.toLowerCase());
  const words = String(task ?? '').toLowerCase().match(/[a-z][a-z0-9_]{3,}/g) ?? [];
  for (const word of words) {
    if (STOPWORDS.has(word)) continue;
    terms.add(stem(word));
  }
  return [...terms].filter(term => term.length >= 4).slice(0, 40);
}

function stem(word: string): string {
  for (const suffix of ['ations', 'ation', 'ings', 'ing', 'ed', 'es', 's']) {
    if (word.length - suffix.length >= 4 && word.endsWith(suffix)) {
      // "duplicated" -> "duplicat", "tickets" -> "ticket", "responses" -> "respons"
      return word.slice(0, word.length - suffix.length);
    }
  }
  return word.endsWith('e') && word.length > 5 ? word.slice(0, -1) : word;
}

const DECLARATION = /(?:\bfunction\s+([A-Za-z_$][\w$]*)|^\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{|\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function|\(|[A-Za-z_$][\w$]*\s*=>)|\bdef\s+([A-Za-z_]\w*)|\bclass\s+([A-Za-z_$][\w$]*))/;

function declaredName(line: string): string | undefined {
  const match = DECLARATION.exec(line);
  if (!match) return undefined;
  const name = match.slice(1).find(Boolean);
  return name && !['if', 'for', 'while', 'switch', 'catch', 'function', 'return'].includes(name) ? name : undefined;
}

/** Pure: choose and render bounded excerpts of one file. Exported for tests. */
export function selectTargetedExcerpts(
  relativePath: string,
  content: string,
  terms: readonly string[],
  maxChars: number,
  maxExcerpts: number,
): TargetedExcerpt[] {
  if (terms.length === 0 || maxChars <= 0 || maxExcerpts <= 0) return [];
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const lowerLines = lines.map(line => line.toLowerCase());

  // Rarity weighting: a word on every other line ("event" in an event app) must not outrank the rare ones.
  const weight = new Map<string, number>();
  for (const term of terms) {
    let count = 0;
    for (const line of lowerLines) if (line.includes(term)) count += 1;
    if (count > 0) weight.set(term, 1 / Math.log2(2 + count));
  }
  if (weight.size === 0) return [];

  const scoreLines = (extra: ReadonlyMap<string, number>): number[] => lowerLines.map((line, index) => {
    let score = 0;
    for (const [term, value] of weight) if (line.includes(term)) score += value;
    for (const [term, value] of extra) if (line.includes(term)) score += value;
    if (score > 0 && declaredName(lines[index])) score *= 1.5;
    return score;
  });

  const chosen: Array<{ start: number; end: number }> = [];
  let usedChars = 0;
  const windowChars = (start: number, end: number): number => {
    let total = 0;
    for (let index = start; index <= end; index += 1) total += Math.min(lines[index].length, MAX_LINE_CHARS) + 1;
    return total;
  };
  const tryAdd = (lineIndex: number): boolean => {
    let start = Math.max(0, lineIndex - LINES_BEFORE);
    let end = Math.min(lines.length - 1, lineIndex + LINES_AFTER);
    // Shrink around the hit until the window is affordable (long minified-ish lines are common in single-file apps).
    const perExcerptCap = Math.max(1_200, Math.floor(maxChars / Math.max(2, Math.min(maxExcerpts, 5))));
    while (end > start && windowChars(start, end) > perExcerptCap) {
      if (end - lineIndex >= lineIndex - start && end > lineIndex) end -= 1;
      else if (start < lineIndex) start += 1;
      else end -= 1;
    }
    for (const existing of chosen) {
      if (lineIndex >= existing.start && lineIndex <= existing.end) return false;
      if (start <= existing.end + 1 && end >= existing.start - 1) {
        // Overlapping/adjacent: merge, if the merged window still fits.
        const mergedStart = Math.min(start, existing.start);
        const mergedEnd = Math.max(end, existing.end);
        const delta = windowChars(mergedStart, mergedEnd) - windowChars(existing.start, existing.end);
        if (usedChars + delta > maxChars) return false;
        usedChars += delta;
        existing.start = mergedStart;
        existing.end = mergedEnd;
        return true;
      }
    }
    if (chosen.length >= maxExcerpts) return false;
    const cost = windowChars(start, end);
    if (usedChars + cost > maxChars) return false;
    usedChars += cost;
    chosen.push({ start, end });
    return true;
  };

  const ranked = (scores: number[]): number[] => scores
    .map((score, index) => ({ score, index }))
    .filter(entry => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(entry => entry.index);

  // Round 1: the strongest few hits.
  const firstRound = ranked(scoreLines(new Map()));
  const seedBudget = Math.max(1, Math.ceil(maxExcerpts / 2));
  for (const index of firstRound) {
    if (chosen.length >= seedBudget) break;
    tryAdd(index);
  }
  // Round 2: functions declared inside those hits are probably what must change; their call sites (buttons,
  // routes) are where a new action gets wired in. Boost them, then fill the remaining budget.
  const boosted = new Map<string, number>();
  for (const window of chosen) {
    for (let index = window.start; index <= window.end; index += 1) {
      const name = declaredName(lines[index]);
      if (name && name.length >= 4 && weight.size > 0 && terms.some(term => lowerLines[index].includes(term))) {
        boosted.set(name.toLowerCase(), 2);
      }
    }
  }
  for (const index of ranked(scoreLines(boosted))) {
    if (chosen.length >= maxExcerpts && usedChars >= maxChars) break;
    tryAdd(index);
  }

  return chosen
    .sort((a, b) => a.start - b.start)
    .map(window => ({
      path: relativePath,
      startLine: window.start + 1,
      endLine: window.end + 1,
      totalLines: lines.length,
      text: lines.slice(window.start, window.end + 1).map(line => line.length > MAX_LINE_CHARS ? line.slice(0, MAX_LINE_CHARS) : line).join('\n'),
    }));
}

export function renderTargetedExcerpts(excerpts: readonly TargetedExcerpt[]): string {
  if (excerpts.length === 0) return '';
  const parts = [
    'Targeted source excerpts (EXACT current text read from disk for the large file(s) this task most likely changes).',
    'Copy every edit oldText verbatim from these excerpts; the "lines a-b" headers are provenance only and are NOT part of the file.',
    'Lines longer than 3000 characters are cut. Anchors must come from text shown here, never from memory or guesses.',
  ];
  for (const excerpt of excerpts) {
    parts.push(`\n### ${excerpt.path} lines ${excerpt.startLine}-${excerpt.endLine} of ${excerpt.totalLines}\n\`\`\`\n${excerpt.text}\n\`\`\``);
  }
  return parts.join('\n');
}

export async function buildTargetedSourceContext(
  workspaceRoot: string,
  task: string,
  options: TargetedSourceOptions = {},
): Promise<TargetedSourceContext> {
  const terms = targetedSearchTerms(task);
  const empty: TargetedSourceContext = { excerpts: [], text: '', terms };
  if (terms.length === 0) return empty;
  const minFileChars = options.minFileChars ?? TARGETED_EXCERPT_LARGE_FILE_CHARS;
  const maxChars = options.maxChars ?? TARGETED_EXCERPT_DEFAULT_MAX_CHARS;
  const maxExcerpts = options.maxExcerpts ?? TARGETED_EXCERPT_DEFAULT_MAX_EXCERPTS;
  const inspection = new WorkspaceInspectionTools(workspaceRoot, { ...DEFAULT_INSPECTION_LIMITS, maxReadBytes: TARGETED_EXCERPT_MAX_READ_BYTES });
  let candidates: string[];
  try {
    candidates = options.paths
      ? [...options.paths]
      : (await inspection.listFiles(options.signal))
        .filter(file => SOURCE_EXTENSIONS.test(file.path) && file.bytes >= minFileChars && file.bytes <= TARGETED_EXCERPT_MAX_READ_BYTES)
        .map(file => file.path);
  } catch {
    return empty;
  }

  // Score each large file by how strongly the task's words occur in it; keep the best few.
  const scored: Array<{ path: string; content: string; score: number }> = [];
  for (const relativePath of candidates.slice(0, 40)) {
    throwIfAborted(options.signal);
    try {
      const file = await inspection.readTextFile(relativePath, options.signal);
      if (file.content.length < minFileChars || file.content.includes('\u0000')) continue;
      const lower = file.content.toLowerCase();
      const score = terms.reduce((sum, term) => sum + (lower.includes(term) ? 1 : 0), 0);
      if (score > 0) scored.push({ path: relativePath, content: file.content, score });
    } catch {
      // Unreadable candidates are simply not excerpted; nothing is invented in their place.
    }
  }
  scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  const files = scored.slice(0, TARGETED_EXCERPT_MAX_FILES);
  if (files.length === 0) return empty;

  const excerpts: TargetedExcerpt[] = [];
  let remainingChars = maxChars;
  let remainingExcerpts = maxExcerpts;
  for (const [index, file] of files.entries()) {
    // The best-matching file gets the larger share.
    const share = index === files.length - 1 ? remainingChars : Math.floor(remainingChars * (index === 0 ? 0.7 : 0.5));
    const picked = selectTargetedExcerpts(file.path, file.content, terms, share, remainingExcerpts);
    excerpts.push(...picked);
    remainingChars -= picked.reduce((sum, excerpt) => sum + excerpt.text.length + 1, 0);
    remainingExcerpts -= picked.length;
    if (remainingChars <= 0 || remainingExcerpts <= 0) break;
  }
  return { excerpts, text: renderTargetedExcerpts(excerpts), terms };
}
