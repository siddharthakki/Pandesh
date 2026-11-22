/**
 * What a relayed task asks for, as one structured value instead of a scatter of keyword checks.
 *
 * Kinds:
 * - `answer`: a reply; nothing on this PC is read or changed.
 * - `inspect`: a read-only look at a project (read files, run existing tests, report).
 * - `code`: a change to a project's files (A5: only ever in a private copy, after the owner's approval and review).
 * - `research`: find something out and report; never changes a project.
 * - `operation`: act on this PC or the outside world (restart, install, send, deploy...). Never done by a coding agent.
 *
 * The requester may DECLARE the kind (the MCP `intent` argument). A declaration only ever narrows what runs: declaring `code` is not an
 * authorization (the project must be read-write and the owner must approve), and declaring `inspect` or `answer` makes a task read-only
 * whatever its words say. Without a declaration the kind is DERIVED from the text.
 *
 * Why this exists (2026-11-22, ptask_c00d7741…): "implement divide(a,b) … do not edit the owner checkout, push, merge, deploy or install"
 * was read as a read-only inspection because "do not edit" appeared anywhere in the text. A prohibition aimed at something other than the
 * work itself (the owner's checkout, a push, a merge, a deployment) does not make a coding task read-only. And a task that asks for a change
 * AND says read-only is a contradiction to resolve with the requester, never a silent downgrade to an inspection.
 */
import { asksForChange, deriveMutationPolicy } from './mutationPolicy';

export const TASK_INTENT_KINDS = ['answer', 'inspect', 'code', 'research', 'operation'] as const;
export type TaskIntentKind = typeof TASK_INTENT_KINDS[number];

/** Names a requester may use for a declared kind (the MCP tool documents the first of each). */
const DECLARED_ALIASES: Record<string, TaskIntentKind> = {
  answer: 'answer', answer_only: 'answer', reply: 'answer',
  inspect: 'inspect', inspection: 'inspect', read_only: 'inspect', 'read-only': 'inspect', review: 'inspect',
  code: 'code', code_change: 'code', coding: 'code', change: 'code', implement: 'code',
  research: 'research',
  operation: 'operation', operational: 'operation', action: 'operation',
};

/** A declared kind in any accepted spelling, or null when absent or unknown (unknown is not silently guessed). */
export function parseDeclaredIntent(value: unknown): TaskIntentKind | null {
  if (typeof value !== 'string') return null;
  return DECLARED_ALIASES[value.trim().toLowerCase().replace(/\s+/g, '_')] ?? null;
}

export interface TaskIntent {
  kind: TaskIntentKind;
  source: 'declared' | 'derived';
  /** One line, for the audit trail and the owner: why this kind. */
  reason: string;
  /** Set when the task contradicts itself (a change AND read-only). Nothing may run until the requester says which. */
  conflict: string | null;
}

/** Clause boundaries. Commas are NOT boundaries: "do not edit the owner checkout, push, merge or install" is one prohibition. */
const CLAUSES = /[.;!?\n]+/;
const NEGATION = /\b(?:do not|don't|dont|never|must not|mustn't|should not|shouldn't|cannot|can't|without|no)\b/i;

/** Things a prohibition may protect without making the work itself read-only. */
const PROTECTED_TARGET = /\b(?:(?:the |my |your |their |his |her )?(?:owner'?s?|original|source|real|main|user'?s?|own|primary)\s+(?:checkout|repo(?:sitory)?|working (?:tree|copy|directory)|folder|copy|branch|project folder|clone)|(?:main|master|default) branch|push(?:es|ing)?|merg(?:e|es|ing)|deploy(?:s|ing|ment)?|install(?:s|ing)?|publish(?:es|ing)?|credentials?|secrets?|tokens?|production|remotes?|release)\b/i;

/** Objects that make a prohibition cover the work itself ("do not modify any files"). */
const WORK_OBJECT = /\b(?:any(?:thing| files?| code| source)?|all files|(?:the |this |these )?(?:files?|code(?:base)?|sources?|source code|tests?|implementation|module|function)|(?:the |this )(?:repo(?:sitory)?|project|workspace))\b/i;

/**
 * Drops prohibitions that protect only something other than the work ("do not edit the owner checkout, push, merge or install").
 * A prohibition that also names the work itself ("do not change any files or push") stays.
 */
export function withoutScopedProhibitions(text: string): string {
  return text.split(CLAUSES).map(clause => {
    const m = NEGATION.exec(clause);
    if (!m) return clause;
    const negated = clause.slice(m.index);
    if (!PROTECTED_TARGET.test(negated)) return clause;
    // Remove the protected targets, then see whether anything about the work itself is left in the prohibition.
    const rest = negated.replace(new RegExp(PROTECTED_TARGET.source, 'gi'), ' ');
    return WORK_OBJECT.test(rest) ? clause : clause.slice(0, m.index);
  }).join('. ');
}

/** Read-only wording that covers the work itself (after scoped prohibitions are removed). */
const EXPLICIT_READ_ONLY: RegExp[] = [
  /\bread[- ]only\b/i,
  /\b(?:inspection|report|answer|analysis|explanation|review)[- ]only\b/i,
  // "only inspect", "just explain"; not "owner-only review approval" (an approval rule, not a scope).
  /(?<![-\w])(?:only|just) (?:inspect|look|read|report|explain|answer|review|tell me)\b(?! (?:approval|gate|step))/i,
  /\b(?:do not|don't|dont|never|must not|mustn't|should not)\s+(?:modify|change|edit|write(?: to)?|touch|alter|update|patch|create|delete|make (?:any )?changes to|fix|implement)\b/i,
  /\bwithout (?:modifying|changing|editing|writing|touching|altering|making (?:any )?changes)\b/i,
  /\bno (?:code |file |workspace )?(?:changes|modifications|edits)\b/i,
];

/** An explicit request to change code: words that only make sense for a code change. */
const CODING_REQUEST = /\b(?:coding task|code change|implement(?:s|ing)?|refactor(?:s|ing)?|(?:add|write|create)\s+(?:a |an |the |some |new |unit |focused )*(?:function|method|module|class|tests?|test cases?|feature|endpoint|option|flag|file|component|script)|fix(?:es|ing)?\s+(?:the |a |this |that |its )?(?:bug|defect|issue|failing|broken|error|regression)|make (?:the|this|a) (?:change|fix))\b/i;

const RESEARCH = /\b(?:research|look up|find out|search (?:the web|online)|what are the (?:best|options)|compare (?:options|tools|libraries|providers))\b/i;
const OPERATION = /^\s*(?:please\s+)?(?:restart|reboot|shut ?down|start|stop|kill|deploy|install|uninstall|upgrade|send|email|post|publish|pay|buy|book|schedule|delete|move|copy|rename|run)\b/i;

/** Clauses that forbid something, removed so that "do not fix them" never counts as a request to fix. */
const NEGATED_CLAUSE = /\b(?:do not|don't|dont|never|must not|mustn't|should not|without)\b[^.;!?\n]*/gi;

/** Derives the kind from the text alone. */
export function deriveTaskIntent(instruction: string): TaskIntent {
  const text = String(instruction ?? '');
  const scoped = withoutScopedProhibitions(text);
  const readOnly = EXPLICIT_READ_ONLY.some(re => re.test(scoped));
  const affirmative = scoped.replace(NEGATED_CLAUSE, ' ');
  const coding = CODING_REQUEST.test(affirmative);
  const change = coding || asksForChange(scoped);
  if (readOnly && coding) {
    return { kind: 'inspect', source: 'derived', reason: 'it asks for a code change and also says read-only', conflict: 'This task both asks for a code change and says it must not change anything. Nothing ran. Say which one you want: a read-only inspection, or a code change.' };
  }
  if (readOnly || deriveMutationPolicy(scoped) === 'denied') return { kind: 'inspect', source: 'derived', reason: 'it asks for a read-only look and no change', conflict: null };
  if (coding) return { kind: 'code', source: 'derived', reason: 'it explicitly asks for a code change', conflict: null };
  if (OPERATION.test(affirmative) && !/\btests?\b/i.test(affirmative)) return { kind: 'operation', source: 'derived', reason: 'it asks Pandesh to act on this PC or the outside world', conflict: null };
  if (change) return { kind: 'code', source: 'derived', reason: 'it asks for a change', conflict: null };
  if (RESEARCH.test(affirmative)) return { kind: 'research', source: 'derived', reason: 'it asks to find something out', conflict: null };
  return { kind: 'answer', source: 'derived', reason: 'it asks for an answer and no change', conflict: null };
}

/**
 * The kind that governs the task. A declaration wins when it narrows (inspect/answer/research) and when it agrees; a declared `code` task
 * that says read-only in its own text is a contradiction, not a change.
 */
export function resolveTaskIntent(instruction: string, declared: TaskIntentKind | null | undefined): TaskIntent {
  const derived = deriveTaskIntent(instruction);
  if (!declared) return derived;
  if (declared === 'code') {
    const scoped = withoutScopedProhibitions(instruction);
    if (EXPLICIT_READ_ONLY.some(re => re.test(scoped))) {
      return { kind: 'inspect', source: 'declared', reason: 'declared a code change, but the text says read-only', conflict: 'This task was sent as a code change, but its text says it must not change anything. Nothing ran. Send it again as a read-only inspection, or remove the read-only wording.' };
    }
    return { kind: 'code', source: 'declared', reason: 'the requester declared a code change', conflict: null };
  }
  if (declared === 'operation') return { kind: 'operation', source: 'declared', reason: 'the requester declared an operational action', conflict: null };
  // answer / inspect / research: read-only whatever the words say (narrowing is always safe).
  return { kind: declared, source: 'declared', reason: `the requester declared ${declared === 'inspect' ? 'a read-only inspection' : declared === 'research' ? 'research' : 'an answer'}`, conflict: null };
}

/**
 * Does the task ask for NEW tests ("with tests for…", "add unit tests")? Then a change without a new passing test is not the requested
 * outcome. "Keep the existing tests passing" does not ask for new tests.
 */
export function asksForTests(instruction: string): boolean {
  const affirmative = String(instruction ?? '').replace(NEGATED_CLAUSE, ' ');
  return /\b(?:add|adds|adding|write|writing|create|include|including|with|new)\s+(?:(?!keep\b|existing\b|current\b|all\b|the existing\b)\w+[\s-]+){0,2}tests?\b|\btests? (?:for|covering|that cover)\b/i.test(affirmative);
}

/** Kinds that never change a project's files. */
export const isReadOnlyIntent = (kind: TaskIntentKind): boolean => kind === 'answer' || kind === 'inspect' || kind === 'research';
