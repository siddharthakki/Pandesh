/**
 * Local Core repository questions — the bounded read-only slice cleared in
 * docs/worker-adapter-contract-v0.md Section 14.3.
 *
 * This is the existing in-process Core path, not an external worker. It
 * answers a question about the selected repository using bounded search and
 * ranged reads, and it cannot mutate, commit, install, or run a shell command:
 * those tools are absent from the offered set and refused at dispatch.
 *
 * An answer is accepted only when every repository reference it cites is
 * supported by a read Core itself recorded as successful, and cited line
 * numbers are kept only when they fall inside a range Core read. That is a
 * provenance check on the citation, not a check that the answer is correct.
 */
import {
  boundText,
  readWorkspaceRange,
  type MissionObservation,
} from './missionObservations';
import { searchWorkspace } from './missionSearch';
import { resolveRepeatedRead, resolveRepeatedSearch } from './missionProgress';
import type { MissionLedgerEntry } from './missionCompaction';
import type { MissionEnvelope } from './scopedCommand';
import {
  MISSION_WALL_CLOCK_MS,
  evaluateMissionBudget,
  hydrateMissionBudget,
  type MissionBudget,
} from './missionBudget';
import {
  COPILOT_LOCAL_WORKER_ID,
  discoverCopilotLocal,
  type WorkerDiscoveryInput,
} from './workerDiscovery';

export const LOCAL_CORE_QUESTION_PROFILE = 'local-core-question';

/**
 * Anchors the budget to when the attempt first started running, not to when
 * this execution began, so a resumed attempt inherits the elapsed time it
 * already consumed instead of restarting the absolute deadline.
 */
export function localCoreBudgetAnchor(attempt: { startedAt: string | null; createdAt: string }): string {
  return attempt.startedAt ?? attempt.createdAt;
}

export function localCoreBudget(anchor: string): MissionBudget {
  return hydrateMissionBudget({ startedAt: anchor });
}

export function localCoreDeadlineMs(anchor: string): number {
  return Date.parse(anchor) + MISSION_WALL_CLOCK_MS;
}

/**
 * Re-checks the absolute deadline at the moment an answer is about to be
 * accepted. An answer produced by inference that ran past the deadline is
 * late and must not be delivered.
 */
export function answerAdmissible(
  budget: MissionBudget,
  nowMs = Date.now(),
): { ok: true } | { ok: false; reason: string } {
  const reason = evaluateMissionBudget(budget, nowMs);
  return reason ? { ok: false, reason } : { ok: true };
}

export function isLocalCoreQuestion(profile: string | undefined): boolean {
  return profile === LOCAL_CORE_QUESTION_PROFILE;
}

/** Worker options Desktop may show. Only `selectable` ones may be submitted. */
export interface WorkerOption {
  id: string;
  label: string;
  mode: 'read_only' | 'mutation';
  selectable: boolean;
  detail: string;
}

/**
 * Desktop worker catalog. Copilot Local is listed so the picker can show it
 * unavailable; discovery never makes it selectable while confinement is missing.
 */
export function listWorkerOptions(input?: WorkerDiscoveryInput): WorkerOption[] {
  const copilot = discoverCopilotLocal(input);
  return [
    {
      id: 'local-core',
      label: 'Pandesh — ask or act in the selected folder',
      mode: 'read_only',
      selectable: true,
      detail: 'Answers questions and carries out requested file and code tasks in the selected folder. Commands that delete data, publish, or change the system ask for approval first. No commit.',
    },
    {
      id: 'autonomous-mission',
      label: 'Autonomous mission — implement a change',
      mode: 'mutation',
      selectable: true,
      detail: 'The existing governed mission loop: approved mutation, validation, verification, diff review, and one local commit.',
    },
    {
      id: 'hermes',
      label: 'Hermes Agent — autonomous skills and multi-turn workflows',
      mode: 'mutation',
      selectable: true,
      detail: 'Official Hermes Runs API for autonomous skills, tool execution, and governed workflows.',
    },
    {
      id: COPILOT_LOCAL_WORKER_ID,
      label: 'Copilot Local (external worker)',
      mode: 'mutation',
      selectable: false,
      detail: copilot.reason,
    },
    {
      id: 'codex-cli',
      label: 'Codex CLI (external worker)',
      mode: 'mutation',
      selectable: false,
      detail: 'External worker execution is gated pending the confinement prerequisites in the WorkerAdapter contract.',
    },
    {
      id: 'claude-code',
      label: 'Claude Code (external worker)',
      mode: 'mutation',
      selectable: false,
      detail: 'External worker execution is gated pending the confinement prerequisites in the WorkerAdapter contract.',
    },
  ];
}

export const WORKER_OPTIONS: readonly WorkerOption[] = listWorkerOptions();

export function findWorkerOption(id: string, input?: WorkerDiscoveryInput): WorkerOption | undefined {
  return listWorkerOptions(input).find((option) => option.id === id);
}

/**
 * Fail closed on any worker that is not implemented and selectable. An
 * unknown id is refused rather than defaulting to a usable worker.
 */
export function resolveWorkerProfile(
  id: string,
  input?: WorkerDiscoveryInput,
): { ok: true; profile: string } | { ok: false; reason: string } {
  const option = findWorkerOption(id, input);
  if (!option) return { ok: false, reason: `unknown worker '${id}'` };
  if (!option.selectable) return { ok: false, reason: `worker '${id}' is not implemented: ${option.detail}` };
  if (option.id === 'hermes') return { ok: true, profile: 'hermes' };
  return { ok: true, profile: option.id === 'local-core' ? LOCAL_CORE_QUESTION_PROFILE : 'autonomous-mission' };
}

export const LOCAL_CORE_ACTIONS = ['search', 'read_file', 'answer'] as const;
export type LocalCoreActionName = (typeof LOCAL_CORE_ACTIONS)[number];

export interface LocalCoreReference {
  path: string;
  startLine?: number;
  endLine?: number;
}

export type LocalCoreAction =
  | { action: 'search'; query: string; path?: string }
  | { action: 'read_file'; path: string; startLine?: number; endLine?: number }
  | { action: 'answer'; summary: string; references: LocalCoreReference[] };

export type LocalCoreDecodeResult =
  | { ok: true; action: LocalCoreAction; extraRejected: number }
  | { ok: false; errors: string[]; extraRejected: number };

export function isLocalCoreActionName(value: string): value is LocalCoreActionName {
  return (LOCAL_CORE_ACTIONS as readonly string[]).includes(value);
}

/**
 * The dispatch-level read-only gate.
 *
 * Enforcement does not depend on the prompt or on which tools were offered:
 * any tool outside the read-only set is refused here, before execution, even
 * if the model emits it. Mutating, delivery, and shell tool names are named
 * explicitly so their refusal is unambiguous in evidence.
 */
export function enforceReadOnlyTool(toolName: string): { allow: true } | { allow: false; reason: string } {
  if (isLocalCoreActionName(toolName)) return { allow: true };
  const known: Record<string, string> = {
    propose_file_change: 'file mutation',
    run_check: 'repository checks and commits',
    run_command: 'shell commands',
    finish: 'mission delivery',
    authorize_mission: 'mission authorization',
    inspect_page: 'browser inspection',
    host_verification: 'behavioral verification',
    ask_user: 'mission clarification',
  };
  const described = known[toolName] ? `${known[toolName]} is` : `'${toolName}' is`;
  return {
    allow: false,
    reason: `${described} not available for a Local Core repository question; this request is read-only`,
  };
}

function asPositiveInt(value: unknown): number | undefined {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) return undefined;
  return n;
}

function decodeReferences(value: unknown): LocalCoreReference[] | string {
  if (value === undefined || value === null) return [];
  const raw = Array.isArray(value) ? value : [value];
  const references: LocalCoreReference[] = [];
  for (const item of raw) {
    if (typeof item === 'string') {
      const path = item.trim();
      if (path) references.push({ path });
      continue;
    }
    if (!item || typeof item !== 'object') return 'answer references must be paths or {path,startLine,endLine} objects';
    const record = item as Record<string, unknown>;
    const path = String(record.path ?? '').trim();
    if (!path) return 'each answer reference requires a path';
    references.push({ path, startLine: asPositiveInt(record.startLine), endLine: asPositiveInt(record.endLine) });
  }
  return references;
}

function decodeOne(name: string, args: Record<string, unknown>): LocalCoreAction | string {
  const gate = enforceReadOnlyTool(name);
  if (!gate.allow) return gate.reason;
  if (name === 'search') {
    const query = String(args.query ?? '').trim();
    if (!query) return 'search requires a non-empty query';
    const path = typeof args.path === 'string' && args.path.trim() ? args.path.trim() : undefined;
    return { action: 'search', query, path };
  }
  if (name === 'read_file') {
    const path = String(args.path ?? '').trim();
    if (!path) return 'read_file requires a path';
    const startLine = asPositiveInt(args.startLine);
    const endLine = asPositiveInt(args.endLine);
    if (startLine && endLine && endLine < startLine) return 'read_file endLine must be >= startLine';
    return { action: 'read_file', path, startLine, endLine };
  }
  const summary = String(args.summary ?? args.answer ?? '').trim();
  if (!summary) return 'answer requires a summary';
  const references = decodeReferences(args.references ?? args.citations);
  if (typeof references === 'string') return references;
  if (references.length === 0) return 'answer requires at least one repository reference you have read';
  return { action: 'answer', summary, references };
}

/** Exactly one action per turn. Extra calls are counted and never executed. */
export function decodeLocalCoreTurn(
  calls: Array<{ name: string; arguments?: Record<string, unknown> }>,
): LocalCoreDecodeResult {
  const extraRejected = Math.max(0, calls.length - 1);
  if (calls.length === 0) {
    return { ok: false, errors: ['exactly one action is required per turn'], extraRejected: 0 };
  }
  const decoded = decodeOne(calls[0].name, calls[0].arguments ?? {});
  if (typeof decoded === 'string') return { ok: false, errors: [decoded], extraRejected };
  if (calls.length > 1) {
    return { ok: false, errors: [`exactly one action is required per turn; rejected ${extraRejected} extra call(s)`], extraRejected };
  }
  return { ok: true, action: decoded, extraRejected: 0 };
}

export const LOCAL_CORE_TOOL_DEFINITIONS = [
  {
    name: 'search',
    description: 'Search the selected repository for a query. Optional path scopes the search.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        path: { type: 'string' },
      },
      required: ['query'],
    },
  },
  {
    name: 'read_file',
    description: 'Read a repository file. Optional startLine/endLine (1-based, inclusive) return a ranged excerpt.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        startLine: { type: 'number' },
        endLine: { type: 'number' },
      },
      required: ['path'],
    },
  },
  {
    name: 'answer',
    description: 'Answer the question. Every reference must be a file you already read successfully in this session.',
    parameters: {
      type: 'object',
      properties: {
        summary: { type: 'string' },
        references: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              startLine: { type: 'number' },
              endLine: { type: 'number' },
            },
            required: ['path'],
          },
        },
      },
      required: ['summary', 'references'],
    },
  },
] as const;

export const LOCAL_CORE_SYSTEM_PROMPT =
  'You are KarkeDikha answering a question about the selected repository through Core. '
  + 'Emit exactly one action per turn: search, read_file, or answer. '
  + 'This request is read-only. You cannot change files, run commands, run tests, or commit; those actions are refused by Core, not just discouraged. '
  + 'Investigate with bounded search and ranged reads, then call answer. '
  + 'Every reference in your answer must be a file you already read successfully in this session, or Core will reject the answer and ask you to read it first.';

/** A read Core observed succeeding. The only basis for an accepted reference. */
export interface LocalCoreRead {
  path: string;
  range?: string;
  fingerprint?: string;
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '').toLowerCase();
}

interface ReadRange {
  start: number;
  end: number;
}

function parseReadRange(range: string | undefined): ReadRange | null {
  const match = /^(\d+)-(\d+)$/.exec(range ?? '');
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  return Number.isFinite(start) && Number.isFinite(end) && end >= start ? { start, end } : null;
}

function rangeCovered(reference: LocalCoreReference, ranges: readonly ReadRange[]): boolean {
  if (!reference.startLine) return true;
  const start = reference.startLine;
  const end = reference.endLine && reference.endLine >= start ? reference.endLine : start;
  return ranges.some((range) => range.start <= start && end <= range.end);
}

export function recordSuccessfulRead(reads: readonly LocalCoreRead[], observation: MissionObservation): LocalCoreRead[] {
  if (observation.action !== 'read_file' || !observation.ok || !observation.path) return [...reads];
  const entry: LocalCoreRead = { path: observation.path, range: observation.range, fingerprint: observation.fingerprint };
  if (reads.some((item) => normalizePath(item.path) === normalizePath(entry.path) && item.range === entry.range)) {
    return [...reads];
  }
  return [...reads, entry];
}

export interface ReferenceCheck {
  ok: boolean;
  /** Cited paths Core never read successfully. These reject the answer. */
  unsupportedPaths: string[];
  /** Cited line numbers outside every range Core read. These are dropped. */
  droppedRanges: string[];
  /** References with unverified line numbers removed. */
  references: LocalCoreReference[];
  reason?: string;
}

/**
 * Checks that each cited path, and each cited line range, corresponds to
 * something Core itself read successfully.
 *
 * This establishes only provenance: that the cited location was actually read
 * during this session. It does not check that the answer's claims about that
 * location are correct, and must not be reported as if it did.
 *
 * A path Core never read rejects the answer. A line range outside every range
 * Core read is dropped from the citation rather than rejecting the answer, so
 * the surviving citation never points at lines that were not read.
 */
export function checkAnswerReferences(
  references: readonly LocalCoreReference[],
  reads: readonly LocalCoreRead[],
): ReferenceCheck {
  const rangesByPath = new Map<string, ReadRange[]>();
  for (const read of reads) {
    const key = normalizePath(read.path);
    const parsed = parseReadRange(read.range);
    const existing = rangesByPath.get(key) ?? [];
    if (parsed) existing.push(parsed);
    rangesByPath.set(key, existing);
  }

  const unsupportedPaths: string[] = [];
  const droppedRanges: string[] = [];
  const normalized: LocalCoreReference[] = [];

  for (const reference of references) {
    const key = normalizePath(reference.path);
    if (!rangesByPath.has(key)) {
      unsupportedPaths.push(reference.path);
      continue;
    }
    if (rangeCovered(reference, rangesByPath.get(key) ?? [])) {
      normalized.push(reference);
      continue;
    }
    const cited = reference.endLine && reference.endLine !== reference.startLine
      ? `${reference.path}:${reference.startLine}-${reference.endLine}`
      : `${reference.path}:${reference.startLine}`;
    droppedRanges.push(cited);
    normalized.push({ path: reference.path });
  }

  if (unsupportedPaths.length > 0) {
    return {
      ok: false,
      unsupportedPaths,
      droppedRanges,
      references: normalized,
      reason: `answer rejected: ${unsupportedPaths.join(', ')} ${unsupportedPaths.length === 1 ? 'was' : 'were'} cited but never read successfully; read the file first, then answer`,
    };
  }
  return { ok: true, unsupportedPaths, droppedRanges, references: normalized };
}

export function formatLocalCoreAnswer(summary: string, references: readonly LocalCoreReference[]): string {
  const cited = references.map((reference) => {
    const range = reference.startLine
      ? `:${reference.startLine}${reference.endLine && reference.endLine !== reference.startLine ? `-${reference.endLine}` : ''}`
      : '';
    return `- ${reference.path}${range}`;
  });
  return [
    summary,
    '',
    'References (read by Core during this request; Core did not check the',
    'claims above against them):',
    cited.join('\n'),
  ].join('\n');
}

export interface LocalCoreExecution {
  observation: MissionObservation;
  reads: LocalCoreRead[];
  answer?: string;
  /** Citations whose line numbers were dropped as unverified. */
  droppedRanges?: string[];
}

/**
 * Executes one read-only action. There is no branch here that writes, stages,
 * commits, spawns, or reaches the network.
 */
export function executeLocalCoreAction(input: {
  action: LocalCoreAction;
  envelope: MissionEnvelope;
  reads: readonly LocalCoreRead[];
  ledger?: readonly MissionLedgerEntry[];
}): LocalCoreExecution {
  const { action, envelope } = input;
  const reads = [...input.reads];

  if (action.action === 'search') {
    const repeated = resolveRepeatedSearch(action, input.ledger ?? []);
    if (repeated) return { observation: repeated, reads };
    return {
      observation: searchWorkspace({ workspaceRoot: envelope.workspaceRoot, query: action.query, scopePath: action.path }),
      reads,
    };
  }

  if (action.action === 'read_file') {
    const repeated = resolveRepeatedRead(action, input.ledger ?? []);
    if (repeated) return { observation: repeated, reads: recordSuccessfulRead(reads, repeated) };
    const observation = readWorkspaceRange({
      workspaceRoot: envelope.workspaceRoot,
      requestedPath: action.path,
      startLine: action.startLine,
      endLine: action.endLine,
    });
    return { observation, reads: recordSuccessfulRead(reads, observation) };
  }

  const checked = checkAnswerReferences(action.references, reads);
  if (!checked.ok) {
    return {
      observation: {
        action: 'answer',
        resultCount: 0,
        truncated: false,
        ok: false,
        output: checked.reason ?? 'answer rejected',
      },
      reads,
    };
  }
  const answer = formatLocalCoreAnswer(action.summary, checked.references);
  const bounded = boundText(answer);
  return {
    observation: {
      action: 'answer',
      resultCount: checked.references.length,
      truncated: bounded.truncated,
      ok: true,
      output: bounded.text,
    },
    reads,
    answer,
    droppedRanges: checked.droppedRanges,
  };
}
