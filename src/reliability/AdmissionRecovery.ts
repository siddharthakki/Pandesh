import type { ContextPreflightResult } from './ContextBudget';

/**
 * Request admission recovery.
 *
 * A request that does not fit the runtime's real envelope is not a reason to give up, and not a reason to raise a
 * constant. It is a request to recompile: measure, drop the lowest-value material, measure again, and only
 * refuse when even the minimal request cannot fit. The measuring is the existing ContextBudgetPlanner preflight
 * (the caller passes it in), so there is exactly one token-accounting framework.
 *
 * What survives, highest value first, is enforced by *what this module is allowed to touch*, not by a scoring model:
 *
 *   never touched   contract head, governance text, the task/objective line, the failure being repaired
 *                   (everything outside the two regions below, including all text after the repository block)
 *   pass 1          the workspace file listing (reconstructable from the tools)
 *   pass 2          repository file bodies: trimmed toward the lines that mention the task's own identifiers,
 *                   largest first, never below a floor
 *   pass 3          whole low-relevance repository entries, from the end (entries arrive most-relevant first)
 *   terminal        only when the request with the floor-sized bodies still does not fit
 *
 * A file that was shown whole and is then trimmed is relabelled TRUNCATED. The prompt's own rule ("do not
 * reconstruct files marked TRUNCATED from partial information") then stops the model rewriting a file it only partly saw.
 */

export interface AdmissionStep {
  step: 'file_list_trimmed' | 'file_bodies_trimmed' | 'entries_omitted';
  tokensBefore: number;
  tokensAfter: number;
  detail: string;
}

export interface AdmissionRecoveryResult {
  /** True when `prompt` fits (either it already did, or a recompile made it fit). */
  ok: boolean;
  prompt: string;
  steps: AdmissionStep[];
  /** Set when not ok: why the minimal request still cannot be admitted. */
  reason?: string;
  finalPreflight: ContextPreflightResult;
}

const FILE_LIST_RE = /^(Available workspace files: )(.*)$/m;
/** `### path` + status line + fence. Captures header, status, fingerprint, body. */
const ENTRY_RE = /(### [^\n]+\n)(COMPLETE current file|TRUNCATED current file; remainder omitted)((?:; [^\n]*)?\n)```\n([\s\S]*?)\n```\n/g;

const BODY_FLOOR_CHARS = 700;
const KEPT_FILE_LIST = 12;
const MAX_PASSES = 12;

interface Entry {
  start: number;
  end: number;
  header: string;
  status: string;
  tail: string;
  body: string;
  path: string;
}

function findEntries(prompt: string): Entry[] {
  const entries: Entry[] = [];
  ENTRY_RE.lastIndex = 0;
  for (let match = ENTRY_RE.exec(prompt); match; match = ENTRY_RE.exec(prompt)) {
    entries.push({
      start: match.index,
      end: match.index + match[0].length,
      header: match[1],
      status: match[2],
      tail: match[3],
      body: match[4],
      path: match[1].replace(/^### /, '').trim(),
    });
  }
  return entries;
}

function render(entry: Entry, body: string, reduced: boolean): string {
  const status = reduced
    ? 'TRUNCATED current file; remainder omitted (reduced to fit the model context window)'
    : entry.status;
  return `${entry.header}${status}${entry.tail}\`\`\`\n${body}\n\`\`\`\n`;
}

function replaceEntry(prompt: string, entry: Entry, replacement: string): string {
  return prompt.slice(0, entry.start) + replacement + prompt.slice(entry.end);
}

/** Identifier-like words of the task (and failure) text, used to keep the lines that matter when trimming. */
function focusTerms(prompt: string): string[] {
  const focusText = [...prompt.matchAll(/^(?:Task|Objective): (.*)$/gm)].map(match => match[1]).join(' ')
    + ' ' + (prompt.split(/^Sanitized validation codes: /m)[1] ?? '').slice(0, 400);
  const words = focusText.match(/[A-Za-z_][A-Za-z0-9_]{3,}/g) ?? [];
  const stop = new Set(['this', 'that', 'with', 'from', 'when', 'should', 'file', 'code', 'make', 'after', 'before', 'would', 'have', 'into']);
  return [...new Set(words.map(word => word.toLowerCase()).filter(word => !stop.has(word)))].slice(0, 24);
}

/**
 * Keeps the head of the file (imports, declarations) and the windows around lines that mention the focus terms,
 * elided with `…` markers, to at most `cap` characters. Falls back to head + tail when nothing matches.
 */
export function trimBody(body: string, cap: number, terms: readonly string[]): string {
  if (body.length <= cap) return body;
  const lines = body.split('\n');
  const keep = new Array<boolean>(lines.length).fill(false);
  let used = 0;
  const take = (index: number): void => {
    if (index < 0 || index >= lines.length || keep[index]) return;
    keep[index] = true;
    used += lines[index].length + 1;
  };
  const headLines = Math.min(8, lines.length);
  for (let i = 0; i < headLines && used < cap * 0.2; i++) take(i);
  const hits = lines
    .map((line, index) => ({ index, score: terms.reduce((sum, term) => sum + (line.toLowerCase().includes(term) ? 1 : 0), 0) }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index);
  for (const hit of hits) {
    if (used >= cap) break;
    for (const offset of [0, -1, 1, -2, 2, -3, 3]) {
      if (used >= cap) break;
      take(hit.index + offset);
    }
  }
  if (hits.length === 0) {
    for (let i = lines.length - 1; i >= 0 && used < cap; i--) take(i);
  }
  const out: string[] = [];
  let previous = -1;
  lines.forEach((line, index) => {
    if (!keep[index]) return;
    if (previous >= 0 && index !== previous + 1) out.push('…');
    else if (previous < 0 && index > 0) out.push('…');
    out.push(line);
    previous = index;
  });
  if (previous >= 0 && previous < lines.length - 1) out.push('…');
  const joined = out.join('\n');
  return joined.length > cap + 200 ? `${joined.slice(0, cap)}\n…` : joined;
}

export function recompileForAdmission(
  prompt: string,
  measure: (candidate: string) => ContextPreflightResult,
  options: { maxPasses?: number } = {},
): AdmissionRecoveryResult {
  let current = prompt;
  let preflight = measure(current);
  const steps: AdmissionStep[] = [];
  if (preflight.ok) return { ok: true, prompt: current, steps, finalPreflight: preflight };

  const record = (step: AdmissionStep['step'], next: string, detail: string): void => {
    const after = measure(next);
    steps.push({ step, tokensBefore: preflight.projectedTotal, tokensAfter: after.projectedTotal, detail });
    current = next;
    preflight = after;
  };

  // Pass 1: the file listing is reconstructable with the tools and is the cheapest thing to lose.
  const listMatch = FILE_LIST_RE.exec(current);
  if (listMatch) {
    const names = listMatch[2].split(', ');
    if (names.length > KEPT_FILE_LIST) {
      const trimmed = `${listMatch[1]}${names.slice(0, KEPT_FILE_LIST).join(', ')} (+${names.length - KEPT_FILE_LIST} more not listed)`;
      record('file_list_trimmed', current.replace(FILE_LIST_RE, () => trimmed), `${names.length}->${KEPT_FILE_LIST} names`);
    }
  }

  const terms = focusTerms(current);
  const passes = options.maxPasses ?? MAX_PASSES;

  // Pass 2: trim repository bodies, largest first, toward a floor.
  for (let pass = 0; pass < passes && !preflight.ok; pass++) {
    const entries = findEntries(current).filter(entry => entry.body.length > BODY_FLOOR_CHARS);
    if (entries.length === 0) break;
    const overflowTokens = Math.max(1, preflight.projectedTotal - preflight.limit.effectiveLimit);
    // 2.6 chars/token is the planner's most conservative ratio: cut a little more than the overflow each pass.
    const overflowChars = Math.ceil(overflowTokens * 2.6 * 1.15);
    const largest = [...entries].sort((a, b) => b.body.length - a.body.length)[0];
    const cap = Math.max(BODY_FLOOR_CHARS, largest.body.length - overflowChars);
    if (cap >= largest.body.length) break;
    // Replace from the end so earlier offsets stay valid.
    const next = replaceEntry(current, largest, render(largest, trimBody(largest.body, cap, terms), true));
    record('file_bodies_trimmed', next, `${largest.path}: ${largest.body.length}->${Math.min(cap, largest.body.length)} chars`);
  }

  // Pass 3: whole entries, least relevant (last) first, always keeping the first.
  for (let pass = 0; pass < passes && !preflight.ok; pass++) {
    const entries = findEntries(current).filter(entry => !/^OMITTED/.test(entry.status));
    if (entries.length <= 1) break;
    const victim = entries[entries.length - 1];
    const omitted = `${victim.header}OMITTED to fit the model context window; no contents supplied. Do not modify this file from memory.\n`;
    record('entries_omitted', replaceEntry(current, victim, omitted), `${victim.path} omitted`);
  }

  if (preflight.ok) return { ok: true, prompt: current, steps, finalPreflight: preflight };
  return {
    ok: false,
    prompt: current,
    steps,
    reason: `the minimal request (contract, task and failure evidence with repository bodies at their floor) projects ${preflight.projectedTotal} tokens against a ${preflight.limit.effectiveLimit}-token envelope`,
    finalPreflight: preflight,
  };
}

/** Compact, content-free evidence string for the dispatch record. */
export function describeAdmission(result: AdmissionRecoveryResult): string | undefined {
  if (result.steps.length === 0) return undefined;
  const first = result.steps[0].tokensBefore;
  const last = result.steps[result.steps.length - 1].tokensAfter;
  return `admission_recompile:${result.ok ? 'fit' : 'unfit'}:${result.steps.map(step => step.step).join('>')}:${first}->${last}tok`;
}
