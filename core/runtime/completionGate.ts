/** Evidence reuse for the governed tool loop. A partial mutation never proves objective completion. */
export type CallKind = 'mutation' | 'read' | 'discovery' | 'validation' | 'other';

const DISCOVERY_COMMAND = /(?:^|[\s;&|(])(?:dir|ls|ll|tree|find|findstr|grep|egrep|rg|ag|cat|type|more|less|head|tail|sed|awk|wc|stat|get-childitem|gci|get-content|gc|select-string|sls|where|which|git\s+(?:ls-files|status|diff|log|show|grep))\b/i;
const VALIDATION_COMMAND = /\b(?:test|tests|tsc|compile|build|lint|eslint|prettier|pytest|vitest|jest|mocha|cargo|go\s+(?:test|build|vet)|mvn|gradle|dotnet\s+(?:test|build)|make|check|typecheck|validate)\b/i;

/** What kind of work a tool call is, from its name and arguments alone. */
export function classifyCallKind(toolName: string, args: Record<string, unknown>, isMutating: boolean): CallKind {
  if (isMutating) return 'mutation';
  if (toolName === 'read_file') return 'read';
  if (toolName === 'run_command' || toolName === 'run_check') {
    const command = String(args.command ?? args.cmd ?? '');
    // A validation command that also pipes through a listing tool is still a validation.
    if (VALIDATION_COMMAND.test(command) && !/^\s*(?:dir|ls|findstr|grep|find|cat|type)\b/i.test(command)) return 'validation';
    if (DISCOVERY_COMMAND.test(command)) return 'discovery';
    return 'other';
  }
  if (['list_files', 'list_directory', 'search_files', 'search_code', 'grep', 'glob', 'find_files'].includes(toolName)) return 'discovery';
  return 'other';
}

import * as fs from 'node:fs';
import * as path from 'node:path';
import { isInsideWorkspace } from './commandPolicy';
import type { LoopProgressState } from './loopProgress';

/** Approved workspace mutation tools recorded by the progress ledger. */
export const OBJECTIVE_MUTATION_TOOLS: ReadonlySet<string> = new Set(['propose_file_change', 'propose_text_edit']);

/**
 * Pre-write exploration budget. A mutation-intent task that keeps reading or searching without ever copying, editing or
 * running anything has no productive path to completion; paging through a large file never finishes inside the turn
 * bound (live: 14 sliding read_file windows over a 1,487-line file, then "exceeded 16 tool turns"). Reads of NEW ranges
 * count as progress for loop-detection, so this is the bound that applies to them.
 */
export const EXPLORATION_NUDGE_AT = 4;
export const EXPLORATION_LIMIT = 8;
/** Absolute ceiling on read/search calls without a change, however targeted they are. */
export const EXPLORATION_HARD_LIMIT = 16;
/** A read of at most this many lines is a targeted look at one region, not paging through the file. */
export const TARGETED_READ_MAX_LINES = 150;

export type ExplorationAction = 'ok' | 'nudge' | 'refuse';

const TARGETED_SEARCH = /^\s*(?:findstr|grep|egrep|rg|ag|select-string|sls)\b/i;
const normalizedPath = (args: Record<string, unknown>): string => String(args.path ?? '').replace(/[\\]/g, '/').toLowerCase();

/**
 * What one read/discovery call costs against the 4/8 budget. The budget exists to stop unproductive repetition (paging
 * through a large file window by window, listing again and again), not to stop the evidence an edit needs, so:
 *  - the first read of a file in this stretch is free (several files are legitimate inspection);
 *  - a bounded read (startLine..endLine within TARGETED_READ_MAX_LINES) and a targeted search are exactly what the nudge
 *    asks for, so they are free here and bounded only by EXPLORATION_HARD_LIMIT;
 *  - everything else (unbounded or wide re-reads of a known file, broad listings) costs 1.
 */
export function explorationCallCost(state: LoopProgressState, kind: CallKind, toolName: string, args: Record<string, unknown>): 0 | 1 {
  if (kind === 'read') {
    const path = normalizedPath(args);
    if (path && !(state.explorationPaths ?? []).includes(path)) return 0;
    const start = Number(args.startLine);
    const end = Number(args.endLine);
    return Number.isFinite(start) && Number.isFinite(end) && end >= start && end - start + 1 <= TARGETED_READ_MAX_LINES ? 0 : 1;
  }
  const command = String(args.command ?? args.cmd ?? '');
  return kind === 'discovery' && (toolName === 'run_command' || toolName === 'run_check') && TARGETED_SEARCH.test(command) ? 0 : 1;
}

/** What to do with the next read/discovery call, given what has already run since the last write-class action. */
export function explorationBudgetAction(state: LoopProgressState, nextCost: 0 | 1 = 1): ExplorationAction {
  const spent = state.explorationSpent ?? state.explorationCalls ?? 0;
  if ((state.explorationCalls ?? 0) >= EXPLORATION_HARD_LIMIT) return 'refuse';
  if (nextCost === 1 && spent >= EXPLORATION_LIMIT) return 'refuse';
  if (spent >= EXPLORATION_NUDGE_AT && !state.explorationNudged) return 'nudge';
  return 'ok';
}

/** Records one admitted exploration call; a read marks its file as seen. */
export function noteExplorationCall(state: LoopProgressState, kind: CallKind, args: Record<string, unknown>, cost: 0 | 1): void {
  state.explorationCalls = (state.explorationCalls ?? 0) + 1;
  state.explorationSpent = (state.explorationSpent ?? 0) + cost;
  const path = kind === 'read' ? normalizedPath(args) : '';
  if (path) state.explorationPaths = [...new Set([...(state.explorationPaths ?? []), path])].slice(-32);
}

/** Any write-class action is forward motion: the next stretch of reading gets a fresh allowance and a fresh nudge. */
export function resetExplorationBudget(state: LoopProgressState): void {
  state.explorationCalls = 0;
  state.explorationSpent = 0;
  state.explorationNudged = false;
  state.explorationPaths = [];
}

export function explorationNudgeMessage(ran: number): string {
  return `STRATEGY_CHANGE ${JSON.stringify({
    message: `You have spent ${ran} calls reading or searching and have changed nothing. Do not read the whole file: a large file cannot be paged through or rewritten in one reply. For "make a copy and change it": (1) create the copy now with run_command (Windows: copy "<original>" "<copy>"), leaving the original untouched; (2) locate each region with a targeted search (findstr /n or grep -n on the COPY) and read only that small range; (3) change the COPY with several small propose_text_edit calls (find text must occur exactly once), never one giant propose_file_change; (4) then run a validation command on the copy. Bounded reads (up to ${TARGETED_READ_MAX_LINES} lines) and targeted searches stay allowed; wide or repeated reads are refused after ${EXPLORATION_LIMIT} wide calls.`,
    failedOperation: 'unbounded_exploration',
    signature: 'exploration_budget',
    resultCategory: 'exploration_budget',
    modelEscalated: false,
  })}`;
}

export function explorationRefusedMessage(toolName: string): string {
  return `[${toolName}] REFUSED: the read/search budget for this task (${EXPLORATION_LIMIT} wide, or ${EXPLORATION_HARD_LIMIT} total, read/search calls without a change) is spent. Nothing was run. Act now: copy the file with run_command, then use propose_text_edit on the copy, or state plainly what you could not do.`;
}

export function refusedExplorationMessage(toolName: string, reason: string): string {
  return `[${toolName}] REFUSED as redundant: ${reason}. Nothing was run. Reuse the recorded evidence or continue with a different target.`;
}

export function normalizeEvidencePath(raw: string): string {
  return String(raw ?? '').replace(/[\\]/g, '/').replace(/^\.\//, '').replace(/^\/+/, '').toLowerCase();
}

/** A whole-file read has no range arguments. */
export function isFullRead(args: Record<string, unknown>): boolean {
  return ['offset', 'limit', 'start_line', 'end_line', 'startLine', 'endLine', 'line_start', 'line_end', 'range'].every((key) => args[key] === undefined);
}

/** A read of unchanged content: the same path was already read in full at this revision. */
export function redundantReadReason(state: LoopProgressState, args: Record<string, unknown>): string | undefined {
  const path = normalizeEvidencePath(String(args.path ?? ''));
  if (!path) return undefined;
  const readAt = state.fullReads?.[path];
  if (readAt !== undefined && readAt === state.revision) return `'${String(args.path)}' was already read in full and has not changed since`;
  return undefined;
}

export function noteSuccessfulRead(state: LoopProgressState, args: Record<string, unknown>, delivery: { complete: boolean } = { complete: true }): void {
  const path = normalizeEvidencePath(String(args.path ?? ''));
  // A whole-file read cut at the tool limit delivered a prefix, not the file: it must not read as "read in full".
  if (!path || !isFullRead(args) || !delivery.complete) return;
  state.fullReads = { ...(state.fullReads ?? {}), [path]: state.revision };
}

/** Discovery allowance when a host context pack already supplied the relevant files. */
export const DISCOVERY_ALLOWANCE_WITH_PACK = 2;

export function redundantDiscoveryReason(state: LoopProgressState, packPaths: readonly string[]): string | undefined {
  const ran = state.discoveryCommands ?? 0;
  if (packPaths.length > 0 && ran >= DISCOVERY_ALLOWANCE_WITH_PACK) {
    return `the host already supplied ${packPaths.length} relevant file${packPaths.length === 1 ? '' : 's'} (${packPaths.slice(0, 4).join(', ')}) and ${ran} discovery commands have already run`;
  }
  return undefined;
}


const PATH_TOKEN = /(?:[A-Za-z]:)?[\w@.\-\/]*[\w@\-]\.[A-Za-z][A-Za-z0-9]{0,7}\b/g;
const REFERENCE_ONLY_BEFORE = /\b(?:inspect(?:ing)?|check(?:ing)?|review(?:ing)?|verify(?:ing)?|explain(?:ing)?|examin(?:e|ing)|look(?:ing)? at|open(?:ing)?|view(?:ing)?|reading|match(?:es|ing)?|like|from|based on|same as|see|per|using|reference|copy|consistent with|follow(?:ing)?|read|read-only|compare[sd]? (?:to|with))\s*$/i;

const CHANGE_VERB = '(?:modify|modifying|edit|editing|change|changing|alter|altering|touch|touching|update|updating|overwrite|overwriting|rewrite|rewriting|delete|deleting|remove|removing|rename|renaming)';
/** A negated change verb or an explicit keep-as-is instruction before a path: "do not modify a.py", "never touch a.py", "leave a.py". */
const PROTECT_BEFORE = new RegExp(`(?:\\b(?:do(?:es)? not|don't|dont|never|must not|mustn't|should not|shouldn't|cannot|can't|without|avoid|refrain from)\\s+(?:\\w+\\s+)?${CHANGE_VERB}|\\b(?:leave|leaving|keep|keeping|preserve|preserving)|\\bread[- ]only|\\boff[- ]limits)\\b(?:[^.;\\n]|\\.(?=\\w))*$`, 'i');
/** The objective asks for the file to be gone afterwards: "delete a.txt", "remove a.txt", the source of "rename a.txt to b.txt". */
const REMOVE_BEFORE = /\b(?:delete|remove|erase|rename|move)\s+(?:the\s+)?(?:file\s+)?$/i;
/** A path in a coordinated list ("a.txt and b.txt", "a.txt, b.txt") shares the role cue of the path before it. */
const LIST_CONTINUATION = /^\s*(?:,\s*(?:and\s+|or\s+)?|\s(?:and|or|&)\s+)(?:the\s+)?$/i;
/** Quoting around a path (`a.txt`, "a.txt") is not part of the cue before or after it. */
const unquoteEnd = (value: string) => value.replace(/[`'"(\[]+$/, '');
const unquoteStart = (value: string) => value.replace(/^[`'")\]]+/, '');
/** A keep-as-is statement directly after a path: "a.py unchanged", "a.py must remain untouched", "a.py should not be modified". */
const CHANGED_PARTICIPLE = '(?:modified|edited|changed|altered|touched|updated|overwritten|rewritten|deleted|removed|renamed)';
const PROTECT_AFTER = new RegExp(`^(?:[\\s,(:-]*(?:(?:must|should|needs? to|has to|is to|shall|will)\\s+)?(?:(?:remain|stay|be)\\s+)?(?:left\\s+)?(?:(?:unchanged|untouched|unmodified|as[- ]is|alone|read[- ]only)\\b|not\\s+(?:be\\s+)?(?:${CHANGE_VERB}|${CHANGED_PARTICIPLE})\\b)|,?\\s*(?:but\\s+)?(?:do(?:es)? not|don't|never|must not|should not)\\s+${CHANGE_VERB}\\s+(?:it|this|that|the file)\\b)`, 'i');
/** Validation use: the file is run or tested, not changed ("run tests in a.py", "pytest a.py"). */
const VALIDATION_BEFORE = /\b(?:run(?:ning)?|execute|executing|pytest|test(?:s|ing)?|rerun|re-run)\s+(?:\w+\s+)?(?:in|on|against|for|from|with)?\s*$/i;
const ONLY_MODIFY = new RegExp(`\\bonly\\s+(?:${CHANGE_VERB})\\b(?:[^.;\\n]|\\.(?=\\w))*$`, 'i');

export interface ObjectiveFileRoles {
  /** Files the objective directs to be changed. */
  required: string[];
  /** Files the objective forbids changing ("do not modify", "leave unchanged", "read-only"). */
  protectedFiles: string[];
  /** Files named only to be read, inspected or run; they may be, but need not be, changed. */
  reference: string[];
  /** Files the objective asks to be deleted, or renamed/moved away: delivered only when they are gone. */
  removed: string[];
  /** "Only modify Y": when present, no file outside this set may be changed. */
  onlyScope: string[] | null;
  /** Whether all existing files are protected from modification */
  protectExistingFiles?: boolean;
  /** Explicit expected content parsed from the objective */
  expectedContent?: string;
}

const PROTECT_EXISTING_FILES = /(?:do(?:es)?\s+not|don't|dont|never|must\s+not|cannot|without|avoid)\s+(?:modify|edit|change|touch|update|overwrite)\s+(?:any\s+(?:other\s+)?existing\s+files?|other\s+existing\s+files?|existing\s+files?)|(?:or\s+any\s+other\s+existing\s+file|no\s+other\s+existing\s+file)|(?:leave|keep)\s+(?:existing\s+files?|other\s+existing\s+files?)\s+(?:untouched|unchanged|intact|read[- ]only)/i;

export function extractExpectedContent(taskInput: string): string | undefined {
  const text = String(taskInput ?? '');
  const codeBlock = text.match(/```(?:[a-zA-Z0-9_-]*\r?\n)?([\s\S]*?)```/);
  if (codeBlock && codeBlock[1] && codeBlock[1].trim()) {
    return codeBlock[1].trim();
  }
  const contentMarker = /(?:(?:exact\s+)?contents?\s+(?:must\s+be|should\s+be|is)?|containing\s+exactly|with\s+(?:exact\s+)?contents?):\s*\r?\n*([\s\S]*?)(?:\r?\n\s*\r?\n\s*(?:Do not|Don't|Request|Report|Read|Please|Note|Ensure|Never|Without\b)|$)/i;
  const cm = text.match(contentMarker);
  if (cm && cm[1] && cm[1].trim()) {
    return cm[1].trim();
  }
  const quoted = text.match(/with\s+(?:exact\s+)?content\s+["']([^"']+)["']/i);
  if (quoted && quoted[1] && quoted[1].trim()) {
    return quoted[1].trim();
  }
  return undefined;
}

/** Start of the clause a path sits in: sentence ends, semicolons, newlines and a contrasting "but" bound the reach of a cue. */
function clauseStart(text: string, index: number): number {
  const head = text.slice(0, index);
  let start = 0;
  for (const m of head.matchAll(/[.;\n]\s|[;\n]|,?\s+but\s+|,?\s+(?:and|then)\s+(?=(?:also\s+)?(?:run|execute|modify|edit|change|update|create|add|fix|inspect|read|review)\b)/gi)) {
    start = (m.index ?? 0) + m[0].length;
  }
  return start;
}

/**
 * Classify every file the objective names. A path preceded by a negated change verb, a leave/keep instruction or a
 * read-only marker (or followed by "unchanged" / "must not be modified") is protected; one introduced as something to
 * read, inspect, compare against or run tests in is reference material; everything else is a required change.
 */
export function objectiveFileRoles(taskInput: string): ObjectiveFileRoles {
  const text = String(taskInput ?? '');
  type Role = 'required' | 'protected' | 'reference' | 'removed';
  const roles = new Map<string, Role>();
  const rank = { required: 0, reference: 1, removed: 2, protected: 3 } as const;
  const onlyScope: string[] = [];
  let previous: { end: number; role: Role } | null = null;
  for (const match of text.matchAll(PATH_TOKEN)) {
    const raw = match[0];
    if (/^\d+\.\d+$/.test(raw) || /^(?:e\.g|i\.e)\.?$/i.test(raw) || /^https?:/i.test(raw)) continue;
    const index = match.index ?? 0;
    const clause = unquoteEnd(text.slice(clauseStart(text, index), index));
    const after = unquoteStart(text.slice(index + raw.length, index + raw.length + 60));
    const before = unquoteEnd(text.slice(Math.max(0, index - 24), index));
    let role: Role = 'required';
    if (PROTECT_BEFORE.test(clause) || PROTECT_AFTER.test(after)) role = 'protected';
    else if (previous && (previous.role === 'reference' || previous.role === 'removed')
      && LIST_CONTINUATION.test(unquoteStart(unquoteEnd(text.slice(previous.end, index))))) role = previous.role;
    else if (REMOVE_BEFORE.test(before)) role = 'removed';
    else if (REFERENCE_ONLY_BEFORE.test(before) || VALIDATION_BEFORE.test(clause)) role = 'reference';
    previous = { end: index + raw.length, role };
    const key = normalizeEvidencePath(raw);
    if (role === 'required' && ONLY_MODIFY.test(clause)) onlyScope.push(key);
    const prior = roles.get(key);
    // A file that is both protected and otherwise mentioned stays protected: the prohibition is the stricter statement.
    if (!prior || rank[role] > rank[prior]) roles.set(key, role);
  }
  const pick = (role: Role) => [...roles.entries()].filter(([, v]) => v === role).map(([k]) => k);
  return {
    required: pick('required'),
    protectedFiles: pick('protected'),
    reference: pick('reference'),
    removed: pick('removed'),
    onlyScope: onlyScope.length > 0 ? onlyScope : null,
    protectExistingFiles: PROTECT_EXISTING_FILES.test(text),
    expectedContent: extractExpectedContent(text),
  };
}

/**
 * Files the request explicitly names as targets to change. Only meaningful for two or more: a single named file
 * is already covered by the one-proposal check. A path introduced as reference material ("like a.ts"), or one the
 * objective forbids changing ("do not modify a.ts"), is not a target.
 */
export function explicitMutationTargets(taskInput: string): string[] {
  return objectiveFileRoles(taskInput).required;
}

function pathMatches(target: string, applied: string): boolean {
  return applied === target || applied.endsWith(`/${target}`) || target.endsWith(`/${applied}`);
}

/**
 * Explicit targets with no applied mutation yet. A target is satisfied by an applied path equal to it or ending in it.
 * `minTargets` is the number of named files below which the check stays silent (the one-proposal check covers a lone file).
 */
export function outstandingMutationTargets(targets: readonly string[], appliedPaths: readonly string[], minTargets = 2): string[] {
  if (targets.length < 1 || targets.length < minTargets) return [];
  const applied = appliedPaths.map(normalizeEvidencePath);
  return targets.filter((target) => !applied.some((path) => pathMatches(target, path)));
}

export interface ObjectiveFileVerdict {
  /** Required files with no applied change. */
  outstanding: string[];
  /** Applied changes the objective forbade (protected files, or files outside an "only modify" scope). */
  violations: string[];
}

/** The single objective-vs-applied-changes check: missing required edits and forbidden edits. */
export function evaluateObjectiveFiles(taskInput: string, appliedPaths: readonly string[]): ObjectiveFileVerdict {
  const roles = objectiveFileRoles(taskInput);
  const outstanding = outstandingMutationTargets(roles.required, appliedPaths, 1);
  const applied = [...new Set(appliedPaths.map(normalizeEvidencePath).filter(Boolean))];
  const violations = applied.filter((path) =>
    roles.protectedFiles.some((target) => pathMatches(target, path))
    || (roles.onlyScope !== null && !roles.onlyScope.some((target) => pathMatches(target, path))));
  return { outstanding, violations };
}

export interface WorkspaceDeliveryVerdict {
  delivered: boolean;
  missingFiles: string[];
  contentMismatches: Array<{ path: string; expected: string; actual: string }>;
  protectedViolations: string[];
  failureReason?: string;
}

/** Whether a shell command names `target` as one of its own path arguments (not merely a file of the same name elsewhere). */
export function commandNamesPath(command: string, target: string): boolean {
  const normalizedCommand = String(command ?? '').replace(/\\/g, '/').toLowerCase();
  const normalizedTarget = normalizeEvidencePath(target);
  if (!normalizedTarget) return false;
  const escaped = normalizedTarget.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[\\s"'\`=>(])(?:\\./)?${escaped}(?=$|[\\s"'\`;&|)<>])`).test(normalizedCommand);
}

/**
 * Objective files an approved, executed file-changing command demonstrably delivered: the command names the file, and the
 * workspace now has it (a required file) or no longer has it (a removal). A file that merely already existed, one created
 * outside the workspace (a temporary worktree), or one touched by a command that failed is not evidence.
 */
export function commandDeliveredTargets(workspaceRoot: string, taskInput: string, executedFileCommands: readonly string[]): string[] {
  if (executedFileCommands.length === 0) return [];
  const roles = objectiveFileRoles(taskInput);
  const root = path.resolve(workspaceRoot);
  const named = (target: string) => executedFileCommands.some((command) => commandNamesPath(command, target));
  const onDisk = (target: string) => {
    const resolved = path.resolve(root, target);
    return isInsideWorkspace(root, resolved) && fs.existsSync(resolved);
  };
  return [
    ...roles.required.filter((target) => named(target) && onDisk(target)),
    ...roles.removed.filter((target) => named(target) && !onDisk(target)),
  ];
}

export function evaluateWorkspaceDelivery(
  workspaceRoot: string,
  taskInput: string,
  appliedPaths: readonly string[],
): WorkspaceDeliveryVerdict {
  const roles = objectiveFileRoles(taskInput);
  const root = path.resolve(workspaceRoot);
  const missingFiles: string[] = [];
  const contentMismatches: Array<{ path: string; expected: string; actual: string }> = [];
  const protectedViolations: string[] = [];

  const applied = [...new Set(appliedPaths.map(normalizeEvidencePath).filter(Boolean))];

  for (const p of applied) {
    if (roles.protectedFiles.some((target) => pathMatches(target, p))) {
      protectedViolations.push(p);
    }
    if (roles.onlyScope !== null && !roles.onlyScope.some((target) => pathMatches(target, p))) {
      protectedViolations.push(p);
    }
  }

  // A removal is delivered when the file is gone AND an executed action named it; absence alone may predate the attempt.
  for (const target of roles.removed) {
    const candidate = path.resolve(root, target);
    const stillPresent = isInsideWorkspace(root, candidate) && fs.existsSync(candidate);
    if (stillPresent || !applied.some((p) => pathMatches(target, p))) missingFiles.push(target);
  }

  for (const target of roles.required) {
    const hasApplied = applied.some((p) => pathMatches(target, p));
    let resolvedOnDisk: string | null = null;
    const directCandidate = path.resolve(root, target);
    if (isInsideWorkspace(root, directCandidate) && fs.existsSync(directCandidate)) {
      resolvedOnDisk = directCandidate;
    } else {
      const matched = applied.find((p) => pathMatches(target, p));
      if (matched) {
        const candidate = path.resolve(root, matched);
        if (isInsideWorkspace(root, candidate) && fs.existsSync(candidate)) {
          resolvedOnDisk = candidate;
        }
      }
    }

    if (!resolvedOnDisk || !hasApplied) {
      missingFiles.push(target);
      continue;
    }

    if (roles.expectedContent) {
      try {
        const actual = fs.readFileSync(resolvedOnDisk, 'utf8');
        const normActual = actual.replace(/\r\n/g, '\n').trim();
        const normExpected = roles.expectedContent.replace(/\r\n/g, '\n').trim();
        if (normActual !== normExpected) {
          contentMismatches.push({ path: target, expected: normExpected, actual: normActual });
        }
      } catch {
        missingFiles.push(target);
      }
    }
  }

  if (protectedViolations.length > 0) {
    return {
      delivered: false,
      missingFiles,
      contentMismatches,
      protectedViolations,
      failureReason: `the objective forbade changing these files but they were modified: ${protectedViolations.join(', ')}`,
    };
  }

  if (missingFiles.length > 0) {
    return {
      delivered: false,
      missingFiles,
      contentMismatches,
      protectedViolations,
      failureReason: `these explicitly requested files have no applied change: ${missingFiles.join(', ')}`,
    };
  }

  if (contentMismatches.length > 0) {
    const file = contentMismatches[0];
    return {
      delivered: false,
      missingFiles,
      contentMismatches,
      protectedViolations,
      failureReason: `file content does not match requested exact content: ${file.path}`,
    };
  }

  return {
    delivered: true,
    missingFiles: [],
    contentMismatches: [],
    protectedViolations: [],
  };
}

/**
 * Completion of a conditional objective ("Fix only if tests fail"):
 *  - FIXED_AND_VERIFIED: the condition was established BEFORE the first change, an authorized change executed, and the
 *    last validation after the last change passed (for an inspection condition with no validation gate, the change's
 *    workspace delivery check is the verification the executor applies).
 *  - NO_CHANGE_REQUIRED: the condition was actually evaluated, it did not hold, and nothing was changed.
 *  - INCOMPLETE: anything else — the condition was never evaluated, it held but no change was delivered, a change was
 *    made without establishing it, the validation after the change is missing or failing, or the objective conflicts.
 * The model's final prose is never an input: a claim that the tests failed, passed or were fixed proves nothing.
 */
export type ConditionalCompletionVerdict = 'FIXED_AND_VERIFIED' | 'NO_CHANGE_REQUIRED' | 'INCOMPLETE';

/** One recorded, executed tool invocation of the attempt, in execution order. */
export type ConditionalEvidenceStep =
  | { kind: 'validation'; passed: boolean }
  | { kind: 'mutation' }
  | { kind: 'inspection' };

export interface ConditionalCondition {
  kind: 'validation' | 'inspection';
  polarity: 'failure' | 'success';
  conflict: string | null;
}

export function evaluateConditionalCompletion(
  condition: ConditionalCondition,
  steps: readonly ConditionalEvidenceStep[],
): { verdict: ConditionalCompletionVerdict; reason: string } {
  const incomplete = (reason: string) => ({ verdict: 'INCOMPLETE' as const, reason });
  if (condition.conflict) return incomplete(`conflicting instructions: ${condition.conflict}`);
  const firstChange = steps.findIndex((step) => step.kind === 'mutation');
  const lastChange = steps.map((step) => step.kind).lastIndexOf('mutation');
  const before = firstChange < 0 ? steps : steps.slice(0, firstChange);
  const validations = (list: readonly ConditionalEvidenceStep[]) =>
    list.filter((step): step is { kind: 'validation'; passed: boolean } => step.kind === 'validation');
  const holds = (step: { passed: boolean }) => (condition.polarity === 'failure' ? !step.passed : step.passed);

  if (condition.kind === 'validation') {
    const runs = validations(before);
    if (firstChange < 0) {
      const latest = runs[runs.length - 1];
      if (!latest) return incomplete('the condition was never evaluated: no validation command ran');
      if (holds(latest)) return incomplete('the condition holds (the latest validation run establishes it) but no authorized change was delivered');
      return { verdict: 'NO_CHANGE_REQUIRED', reason: 'a recorded validation run shows the condition does not hold, and nothing was changed' };
    }
    if (!runs.some(holds)) {
      return incomplete(runs.length === 0
        ? 'a change was made without first establishing the condition with a validation run'
        : 'a change was made although the recorded validation runs show the condition did not hold');
    }
  } else if (!before.some((step) => step.kind === 'inspection' || step.kind === 'validation')) {
    return incomplete(firstChange < 0
      ? 'the condition was never evaluated: nothing in the workspace was inspected'
      : 'a change was made without first inspecting the workspace to establish the condition');
  } else if (firstChange < 0) {
    return { verdict: 'NO_CHANGE_REQUIRED', reason: 'the workspace was inspected and nothing was changed' };
  }

  const after = validations(steps.slice(lastChange + 1));
  const final = after[after.length - 1];
  if (condition.kind === 'validation' && !final) return incomplete('no validation ran after the change, so the fix is not verified');
  if (final && !final.passed) return incomplete('the latest validation after the change failed');
  return { verdict: 'FIXED_AND_VERIFIED', reason: final ? 'the condition was established, the change was applied and validation after it passed' : 'the condition was inspected and the change was applied' };
}

const REFUSAL = /^\W*(?:(?:sorry|unfortunately|apologies)[,.\s-]*)?(?:i\s+(?:can(?:no|')t|cannot|am\s+(?:unable|not\s+able)|'m\s+(?:unable|not\s+able)|was\s+(?:unable|not\s+able)|could\s*n[o']t|couldn't|won't|will\s+not)|(?:it\s+is|it's)\s+not\s+possible|unable\s+to)\b/i;
const INCOMPLETE_ADMISSION = /\b(?:not\s+(?:yet\s+)?(?:fully\s+)?(?:done|complete[d]?|finished|implemented)|(?<!no\s)(?<!nothing\s)(?:remaining|outstanding)\s+(?:work|files?|changes?|steps?|tasks?)|still\s+(?:need|needs|remain|remains|to\s+do)|(?:only|just)\s+(?:the\s+)?(?:first|one|two)\s+(?:file|change|of)|(?:i\s+)?(?:did\s+not|didn't|have\s+not|haven't)\s+(?:finish|complete|get\s+to|make|apply)|could\s+not\s+(?:finish|complete))\b/i;

/** A final answer that plainly refuses or admits unfinished work cannot be a semantic completion of a mutation task. */
export function isObviousRefusalOrIncomplete(text: string): boolean {
  const value = String(text ?? '').trim();
  if (!value) return false;
  return REFUSAL.test(value) || INCOMPLETE_ADMISSION.test(value);
}
