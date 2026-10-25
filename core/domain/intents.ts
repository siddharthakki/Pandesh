/**
 * Intent kernel.
 *
 * An intent is the durable statement of what a task must achieve, plus the
 * deterministic checks that prove it — independent of which attempt or model is
 * running it. It exists so a task can outlive its executor: when Core restarts
 * mid-task, a successor attempt on a different model continues the SAME intent
 * from a checkpoint, and "done" is decided by inspecting the workspace, never by
 * what a model says.
 *
 * What an intent does NOT own (all reached by link, never copied):
 *   - attempts / model / permission context  → `attempts` via `requestId` and
 *                                              `predecessorAttemptId`
 *   - approvals, grants, mission auth         → keyed by `attemptId`; a successor
 *                                              inherits none of them
 *   - the task's outcome and evidence         → `task_outcomes`
 *   - the record of what tools ran            → `tool_invocations`
 *
 * Recovery rules:
 *   - Completed side effects are never replayed. The resume brief lists them as
 *     done and the successor is told to continue from what the checks say is
 *     still missing.
 *   - A tool call that started but never finished is UNCERTAIN. Core inspects its
 *     target on disk and hands the successor that fact; it never assumes the
 *     call did or did not happen.
 *   - Core only reads the workspace. It never reverts, deletes or rewrites
 *     anything, so unrelated user changes are untouched by recovery.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CoreDatabase } from '../db/connection';
import type { AttemptRecord } from '../shared/wireTypes';
import { getAttempt, rerouteAttempt } from './attempts';
import { getAttemptContext } from './attemptContext';
import { isTerminalAttemptStatus } from './attemptTransitions';
import { createCheckpoint, listCheckpointsForAttempt } from './checkpoints';
import { CoreError } from './errors';
import { newId, nowIso } from './ids';
import { recordRuntimeEvent } from './runtimeEvents';
import { ensureTaskOutcome, updateTaskOutcome, type TaskOutcomeEvidence } from './taskOutcomes';

export const INTENT_CHECKPOINT_KIND = 'intent_resume';
export const DEFAULT_MAX_RESUMES = 2;
const MAX_CHECKS = 10;
const MAX_CHECK_TEXT = 4_000;
const MAX_READ_BYTES = 1_048_576;
const MAX_HASH_BYTES = 16 * 1_048_576;
const MAX_BRIEF_CHARS = 3_800;

export type IntentCheck =
  | { kind: 'file_exists'; path: string }
  | { kind: 'file_contains'; path: string; text: string }
  | { kind: 'file_sha256'; path: string; sha256: string };

export type IntentStatus = 'active' | 'recovering' | 'verified' | 'unverified' | 'needs_review' | 'abandoned';

export interface IntentRecord {
  id: string;
  requestId: string;
  objective: string;
  workspaceRoot: string;
  checks: IntentCheck[];
  status: IntentStatus;
  resumeCount: number;
  maxResumes: number;
  verifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CheckResult {
  check: IntentCheck;
  passed: boolean;
  detail: string;
}

function rowToIntent(row: Record<string, unknown>): IntentRecord {
  return {
    id: String(row.id),
    requestId: String(row.requestId),
    objective: String(row.objective),
    workspaceRoot: String(row.workspaceRoot),
    checks: JSON.parse(String(row.checksJson)) as IntentCheck[],
    status: String(row.status) as IntentStatus,
    resumeCount: Number(row.resumeCount),
    maxResumes: Number(row.maxResumes),
    verifiedAt: row.verifiedAt == null ? null : String(row.verifiedAt),
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
  };
}

export function getIntent(db: CoreDatabase, id: string): IntentRecord {
  const row = db.get<Record<string, unknown>>('SELECT * FROM intents WHERE id = ?', [id]);
  if (!row) throw new CoreError('not_found', `intent '${id}' not found`);
  return rowToIntent(row);
}

export function getIntentByRequest(db: CoreDatabase, requestId: string): IntentRecord | undefined {
  const row = db.get<Record<string, unknown>>('SELECT * FROM intents WHERE requestId = ?', [requestId]);
  return row ? rowToIntent(row) : undefined;
}

/** Intents that still owe the user a result and may need recovery. */
export function listOpenIntents(db: CoreDatabase): IntentRecord[] {
  return db
    .all<Record<string, unknown>>("SELECT * FROM intents WHERE status IN ('active', 'recovering') ORDER BY createdAt ASC")
    .map(rowToIntent);
}

/** All attempts for the request, oldest first. The chain is linked by `predecessorAttemptId`. */
export function listIntentAttempts(db: CoreDatabase, requestId: string): AttemptRecord[] {
  return db
    .all<{ id: string }>('SELECT id FROM attempts WHERE requestId = ? ORDER BY createdAt ASC, rowid ASC', [requestId])
    .map((row) => getAttempt(db, row.id));
}

/** The attempt at the end of the chain — the one with no successor. */
export function latestIntentAttempt(db: CoreDatabase, requestId: string): AttemptRecord | undefined {
  const row = db.get<{ id: string }>(
    `SELECT a.id FROM attempts a
      WHERE a.requestId = ? AND NOT EXISTS (SELECT 1 FROM attempts s WHERE s.predecessorAttemptId = a.id)
      ORDER BY a.createdAt DESC, a.rowid DESC LIMIT 1`,
    [requestId],
  );
  return row ? getAttempt(db, row.id) : undefined;
}

// ---------------------------------------------------------------------------
// Deterministic checks
// ---------------------------------------------------------------------------

/** Lexical containment: `rel` must resolve inside `root`. Returns the absolute path or null. */
function resolveInside(root: string, rel: string): string | null {
  if (typeof rel !== 'string' || rel.trim() === '' || rel.includes('\0')) return null;
  const rootAbs = path.resolve(root);
  const abs = path.resolve(rootAbs, rel);
  const relative = path.relative(rootAbs, abs);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return abs;
}

/** Containment that also follows symlinks, so a link inside the workspace cannot point a check outside it. */
function resolveInsideReal(root: string, rel: string): string | null {
  const abs = resolveInside(root, rel);
  if (!abs) return null;
  if (!fs.existsSync(abs)) return abs;
  try {
    const realRoot = fs.realpathSync(root);
    const realTarget = fs.realpathSync(abs);
    const relative = path.relative(realRoot, realTarget);
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return null;
    return abs;
  } catch {
    return null;
  }
}

export function validateChecks(workspaceRoot: string, checks: unknown): IntentCheck[] {
  if (!Array.isArray(checks) || checks.length === 0) {
    throw new CoreError('invalid_request', 'an intent needs at least one deterministic completion check');
  }
  if (checks.length > MAX_CHECKS) {
    throw new CoreError('invalid_request', `an intent may have at most ${MAX_CHECKS} checks`);
  }
  return checks.map((raw, index): IntentCheck => {
    const c = (raw ?? {}) as Record<string, unknown>;
    const where = `checks[${index}]`;
    const relPath = typeof c.path === 'string' ? c.path : '';
    if (!resolveInside(workspaceRoot, relPath)) {
      throw new CoreError('invalid_request', `${where}.path must be a file path inside the task workspace`);
    }
    if (c.kind === 'file_exists') return { kind: 'file_exists', path: relPath };
    if (c.kind === 'file_contains') {
      if (typeof c.text !== 'string' || c.text.length === 0 || c.text.length > MAX_CHECK_TEXT) {
        throw new CoreError('invalid_request', `${where}.text must be a non-empty string of at most ${MAX_CHECK_TEXT} characters`);
      }
      return { kind: 'file_contains', path: relPath, text: c.text };
    }
    if (c.kind === 'file_sha256') {
      if (typeof c.sha256 !== 'string' || !/^[0-9a-fA-F]{64}$/.test(c.sha256)) {
        throw new CoreError('invalid_request', `${where}.sha256 must be a 64-character hex digest`);
      }
      return { kind: 'file_sha256', path: relPath, sha256: c.sha256.toLowerCase() };
    }
    throw new CoreError('invalid_request', `${where}.kind must be file_exists, file_contains or file_sha256`);
  });
}

function describeCheck(check: IntentCheck): string {
  if (check.kind === 'file_exists') return `file_exists ${check.path}`;
  if (check.kind === 'file_contains') return `file_contains ${check.path} "${check.text.slice(0, 60)}"`;
  return `file_sha256 ${check.path}`;
}

/**
 * Evaluates the checks against the workspace as it is right now. Read-only, and
 * the only authority on whether the intent is satisfied.
 */
export function evaluateChecks(workspaceRoot: string, checks: IntentCheck[]): CheckResult[] {
  return checks.map((check): CheckResult => {
    const abs = resolveInsideReal(workspaceRoot, check.path);
    if (!abs) return { check, passed: false, detail: 'path is outside the task workspace' };
    let stat: fs.Stats;
    try {
      stat = fs.statSync(abs);
    } catch {
      return { check, passed: false, detail: 'file does not exist' };
    }
    if (!stat.isFile()) return { check, passed: false, detail: 'path is not a regular file' };
    if (check.kind === 'file_exists') return { check, passed: true, detail: `present (${stat.size} bytes)` };
    try {
      if (check.kind === 'file_contains') {
        if (stat.size > MAX_READ_BYTES) return { check, passed: false, detail: `file is larger than ${MAX_READ_BYTES} bytes; not inspected` };
        const text = fs.readFileSync(abs, 'utf8');
        return text.includes(check.text)
          ? { check, passed: true, detail: 'expected text found' }
          : { check, passed: false, detail: 'file exists but the expected text is not in it' };
      }
      if (stat.size > MAX_HASH_BYTES) return { check, passed: false, detail: `file is larger than ${MAX_HASH_BYTES} bytes; not hashed` };
      const digest = crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
      return digest === check.sha256
        ? { check, passed: true, detail: 'digest matches' }
        : { check, passed: false, detail: `digest differs (${digest.slice(0, 12)}…)` };
    } catch (err) {
      return { check, passed: false, detail: `could not be read: ${err instanceof Error ? err.message : String(err)}` };
    }
  });
}

// ---------------------------------------------------------------------------
// Intent creation
// ---------------------------------------------------------------------------

export interface CreateIntentInput {
  requestId: string;
  checks: unknown;
  objective?: string;
  maxResumes?: number;
  actor: string;
}

export function createIntent(db: CoreDatabase, input: CreateIntentInput): IntentRecord {
  return db.transaction(() => {
    const request = db.get<{ id: string; currentMessage: string; conversationId: string | null }>(
      'SELECT id, currentMessage, conversationId FROM requests WHERE id = ?',
      [input.requestId],
    );
    if (!request) throw new CoreError('not_found', `request '${input.requestId}' not found`);
    const existing = getIntentByRequest(db, input.requestId);
    if (existing) return existing;

    const latest = latestIntentAttempt(db, input.requestId);
    if (!latest) throw new CoreError('invalid_request', 'a request must have an attempt before it can carry an intent');
    const workspaceRoot = getAttemptContext(db, latest.id).workspaceRoot;
    if (!workspaceRoot) throw new CoreError('invalid_request', 'an intent needs a task workspace; this request has none');

    const checks = validateChecks(workspaceRoot, input.checks);
    const maxResumes = input.maxResumes ?? DEFAULT_MAX_RESUMES;
    if (!Number.isInteger(maxResumes) || maxResumes < 0 || maxResumes > 5) {
      throw new CoreError('invalid_request', 'maxResumes must be an integer between 0 and 5');
    }
    const objective = (input.objective ?? request.currentMessage).replace(/\s+/g, ' ').trim().slice(0, 1_000);
    const id = newId('intent');
    const now = nowIso();
    db.run(
      `INSERT INTO intents (id, requestId, objective, workspaceRoot, checksJson, status, resumeCount, maxResumes, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, 'active', 0, ?, ?, ?)`,
      [id, input.requestId, objective, workspaceRoot, JSON.stringify(checks), maxResumes, now, now],
    );
    recordRuntimeEvent(db, {
      domain: 'attempt',
      entityId: latest.id,
      eventType: 'intent_created',
      actor: input.actor,
      metadata: { intentId: id, requestId: input.requestId, checks: checks.map(describeCheck) },
    });
    return getIntent(db, id);
  });
}

// ---------------------------------------------------------------------------
// Ledger inspection and checkpoint
// ---------------------------------------------------------------------------

/**
 * Tools that leave no effect on the workspace or the world: pure observers, plus Core's own task bookkeeping.
 * Anything not listed is treated as capable of mutating (fail safe).
 */
const READ_ONLY_TOOLS = new Set([
  'update_task_outcome',
  'read_file', 'list_directory', 'search_files', 'get_project_context', 'resolve_time', 'get_system_info',
  'list_system_drives', 'find_project_roots', 'search_recent_projects', 'find_duplicate_files', 'list_reminders',
  'list_commitments', 'list_scheduled_tasks', 'get_briefing_data', 'dev_stories_status', 'web_research',
]);

export interface LedgerEffect {
  attemptId: string;
  toolName: string;
  /** Workspace-relative target when the call named one (write_file). */
  target: string | null;
  state: 'completed' | 'failed' | 'uncertain';
  /** For an uncertain write: what is actually on disk now, observed by Core. */
  observedOnDisk?: string;
}

function targetOf(workspaceRoot: string, argsSummary: unknown): string | null {
  const args = (argsSummary ?? {}) as Record<string, unknown>;
  const raw = typeof args.filePath === 'string' ? args.filePath : typeof args.path === 'string' ? args.path : null;
  if (!raw) return null;
  const abs = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(workspaceRoot, raw);
  const relative = path.relative(path.resolve(workspaceRoot), abs);
  return relative === '' || relative.startsWith('..') || path.isAbsolute(relative) ? raw : relative;
}

function observeTarget(workspaceRoot: string, target: string | null): string | undefined {
  if (!target) return undefined;
  const abs = resolveInsideReal(workspaceRoot, target);
  if (!abs) return 'target is outside the workspace; not inspected';
  try {
    const stat = fs.statSync(abs);
    return stat.isFile() ? `file exists (${stat.size} bytes)` : 'path exists but is not a regular file';
  } catch {
    return 'file does not exist';
  }
}

/** What the attempt chain did, from the durable tool ledger — not from any transcript. */
export function inspectLedger(db: CoreDatabase, intent: IntentRecord): LedgerEffect[] {
  const effects: LedgerEffect[] = [];
  for (const attempt of listIntentAttempts(db, intent.requestId)) {
    const rows = db.all<{ toolName: string; status: string; argsSummary: string }>(
      'SELECT toolName, status, argsSummary FROM tool_invocations WHERE attemptId = ? ORDER BY startedAt ASC, rowid ASC',
      [attempt.id],
    );
    for (const row of rows) {
      if (READ_ONLY_TOOLS.has(row.toolName)) continue;
      let args: unknown = {};
      try { args = JSON.parse(row.argsSummary); } catch { /* bounded-evidence marker or malformed: no target */ }
      const target = targetOf(intent.workspaceRoot, args);
      const state: LedgerEffect['state'] =
        row.status === 'succeeded' ? 'completed' : row.status === 'failed' || row.status === 'cancelled' ? 'failed' : 'uncertain';
      effects.push({
        attemptId: attempt.id,
        toolName: row.toolName,
        target,
        state,
        ...(state === 'uncertain' ? { observedOnDisk: observeTarget(intent.workspaceRoot, target) } : {}),
      });
    }
  }
  return effects;
}

export interface IntentSnapshot {
  intent: IntentRecord;
  attempts: Array<{ id: string; status: string; model: string; failureReason: string | null }>;
  effects: LedgerEffect[];
  checks: CheckResult[];
  allPassed: boolean;
}

/** The current truth about an intent, assembled from durable state and a live read of the workspace. */
export function snapshotIntent(db: CoreDatabase, intentId: string): IntentSnapshot {
  const intent = getIntent(db, intentId);
  const attempts = listIntentAttempts(db, intent.requestId).map((a) => ({
    id: a.id,
    status: a.status,
    model: getAttemptContext(db, a.id).selectedModel,
    failureReason: a.failureReason ?? null,
  }));
  const checks = evaluateChecks(intent.workspaceRoot, intent.checks);
  return { intent, attempts, effects: inspectLedger(db, intent), checks, allPassed: checks.every((c) => c.passed) };
}

/**
 * The text a successor is shown instead of a transcript. Built only from the
 * ledger and from checks Core just ran. Bounded so it can be stored on the
 * checkpoint row and prepended to a prompt.
 */
export function buildResumeBrief(snapshot: IntentSnapshot, failedModel: string, successorModel: string): string {
  const done = snapshot.effects.filter((e) => e.state === 'completed');
  const uncertain = snapshot.effects.filter((e) => e.state === 'uncertain');
  const lines: string[] = [
    '[RESUMING AN INTERRUPTED TASK]',
    `The previous run (model ${failedModel}) was interrupted when the host restarted. You (${successorModel}) are continuing the same task.`,
    'Core has inspected the workspace itself. Trust this section over any assumption.',
    '',
    'Already done by the previous run — do NOT repeat these:',
    ...(done.length ? done.map((e) => `- ${e.toolName}${e.target ? ` ${e.target}` : ''}: completed`) : ['- nothing recorded as completed']),
  ];
  if (uncertain.length) {
    lines.push('', 'In flight when the run stopped — outcome uncertain. Check the file before acting; do not assume it was or was not written:');
    for (const e of uncertain) lines.push(`- ${e.toolName}${e.target ? ` ${e.target}` : ''}: Core observed: ${e.observedOnDisk ?? 'no target to inspect'}`);
  }
  lines.push('', 'Completion checks right now (these decide whether the task is finished, not your own report):');
  for (const r of snapshot.checks) lines.push(`- ${r.passed ? 'PASS' : 'FAIL'} ${describeCheck(r.check)} — ${r.detail}`);
  lines.push(
    '',
    'Do only what is needed to make the FAIL lines pass. Do not modify, delete or overwrite any other file, including files that already satisfy a PASS line.',
    'Work only inside the task workspace.',
    '[END OF RESUME NOTE — the original request follows]',
  );
  const brief = lines.join('\n');
  return brief.length <= MAX_BRIEF_CHARS ? brief : `${brief.slice(0, MAX_BRIEF_CHARS - 1)}…`;
}

/** The resume note for a successor attempt, or undefined when it was not created by an intent resume. */
export function resumeBriefForAttempt(db: CoreDatabase, attemptId: string): string | undefined {
  const attempt = getAttempt(db, attemptId);
  if (!attempt.predecessorAttemptId) return undefined;
  const checkpoints = listCheckpointsForAttempt(db, attempt.predecessorAttemptId).filter((c) => c.kind === INTENT_CHECKPOINT_KIND);
  const latest = checkpoints[checkpoints.length - 1];
  const brief = latest?.metadata?.brief;
  return typeof brief === 'string' && brief.length > 0 ? brief : undefined;
}

// ---------------------------------------------------------------------------
// Settlement and verification
// ---------------------------------------------------------------------------

function criterionEvidence(results: CheckResult[]): TaskOutcomeEvidence[] {
  return results.filter((r) => r.passed).map((r) => ({ kind: 'check', reference: describeCheck(r.check).slice(0, 200) }));
}

/** Writes the verified result onto the existing task outcome of the latest attempt. */
function linkTaskOutcome(db: CoreDatabase, intent: IntentRecord, results: CheckResult[], verified: boolean, attemptStatus: string | undefined): void {
  const latest = latestIntentAttempt(db, intent.requestId);
  if (!latest) return;
  const request = db.get<{ conversationId: string | null }>('SELECT conversationId FROM requests WHERE id = ?', [intent.requestId]);
  ensureTaskOutcome(db, {
    attemptId: latest.id,
    conversationId: request?.conversationId ?? null,
    requestId: intent.requestId,
    objective: intent.objective,
  });
  if (verified) {
    updateTaskOutcome(db, {
      attemptId: latest.id,
      status: 'satisfied',
      evidence: criterionEvidence(results),
      blocker: null,
      nextAction: null,
      summary: 'Verified by Core: every completion check passed against the workspace.',
    });
    return;
  }
  const failing = results.filter((r) => !r.passed).map((r) => `${describeCheck(r.check)} (${r.detail})`);
  updateTaskOutcome(db, {
    attemptId: latest.id,
    status: 'partial',
    evidence: criterionEvidence(results),
    blocker: `Not verified${attemptStatus === 'completed' ? ' even though the run reported completion' : ''}: ${failing.join('; ')}`.slice(0, 1_000),
    nextAction: 'Resume the intent on another model, or finish the failing checks by hand.',
    summary: 'Core checked the workspace and the completion checks do not all pass.',
  });
}

export type SettleResult = { intent: IntentRecord; results: CheckResult[] };

/**
 * Settles an intent after an attempt in its chain reached a terminal state.
 *
 * The workspace decides, not the model: passing checks verify the intent even if
 * the attempt itself failed (the work was done before it stopped); failing
 * checks keep a model's claim of completion from counting. A user cancellation
 * is the user's decision and is never recovered.
 */
export function settleIntentAfterAttempt(db: CoreDatabase, attemptId: string, actor: string): SettleResult | undefined {
  const attempt = getAttempt(db, attemptId);
  const intent = getIntentByRequest(db, attempt.requestId);
  if (!intent) return undefined;
  if (intent.status === 'verified' || intent.status === 'abandoned') return { intent, results: [] };
  if (!isTerminalAttemptStatus(attempt.status)) return { intent, results: [] };
  // Only the end of the chain settles; a superseded attempt finishing late must not.
  const latest = latestIntentAttempt(db, intent.requestId);
  if (latest && latest.id !== attempt.id) return { intent, results: [] };

  const results = evaluateChecks(intent.workspaceRoot, intent.checks);
  const allPassed = results.every((r) => r.passed);
  let next: IntentStatus;
  if (allPassed) next = 'verified';
  else if (attempt.status === 'cancelled' || attempt.cancelRequestedAt) next = 'abandoned';
  else if (attempt.status === 'completed') next = 'unverified';
  else next = 'active';

  return db.transaction(() => {
    const now = nowIso();
    db.run('UPDATE intents SET status = ?, verifiedAt = ?, updatedAt = ? WHERE id = ?', [
      next, next === 'verified' ? now : null, now, intent.id,
    ]);
    recordRuntimeEvent(db, {
      domain: 'attempt',
      entityId: attempt.id,
      eventType: 'intent_settled',
      actor,
      metadata: {
        intentId: intent.id,
        status: next,
        attemptStatus: attempt.status,
        checks: results.map((r) => `${r.passed ? 'PASS' : 'FAIL'} ${describeCheck(r.check)}`),
      },
    });
    if (next !== 'abandoned') linkTaskOutcome(db, intent, results, allPassed, attempt.status);
    return { intent: getIntent(db, intent.id), results };
  });
}

// ---------------------------------------------------------------------------
// Resume
// ---------------------------------------------------------------------------

export type ResumeOutcome =
  | { kind: 'already_satisfied'; intent: IntentRecord; results: CheckResult[] }
  | { kind: 'needs_review'; intent: IntentRecord; reason: string }
  | { kind: 'resumed'; intent: IntentRecord; successor: AttemptRecord; checkpointId: string };

export interface ResumeIntentInput {
  intentId: string;
  /** The model that takes over. Must not be one this intent has already used. */
  model: string;
  actor: string;
  reason?: string;
}

/** Models already used in the intent's chain, as `provider::model`. */
export function usedModels(db: CoreDatabase, requestId: string): Set<string> {
  return new Set(
    listIntentAttempts(db, requestId).map((a) => {
      const c = getAttemptContext(db, a.id);
      return `${c.selectedProvider}::${c.selectedModel}`;
    }),
  );
}

/**
 * Continues an intent on a different model from a checkpoint.
 *
 * Order matters: inspect first, act second. If the checks already pass there is
 * nothing to resume (and nothing is re-run). Otherwise Core records a checkpoint
 * from the ledger and the workspace, then creates a successor through
 * `rerouteAttempt`, which re-freezes the predecessor's workspace, allowed tools
 * and approval policy and carries over no approval, grant or transcript — the
 * successor passes every permission gate on its own.
 */
export function resumeIntent(db: CoreDatabase, input: ResumeIntentInput): ResumeOutcome {
  const intent = getIntent(db, input.intentId);
  if (intent.status !== 'active' && intent.status !== 'recovering') {
    throw new CoreError('invalid_transition', `intent is '${intent.status}' and cannot be resumed`);
  }
  const latest = latestIntentAttempt(db, intent.requestId);
  if (!latest) throw new CoreError('invalid_transition', 'intent has no attempt to resume from');
  if (latest.status !== 'failed' || latest.cancelRequestedAt) {
    throw new CoreError('invalid_transition', `latest attempt is '${latest.status}'; only a failed, uncancelled attempt can be resumed`);
  }

  // Inspect before doing anything: the work may already be complete.
  const results = evaluateChecks(intent.workspaceRoot, intent.checks);
  if (results.every((r) => r.passed)) {
    const settled = settleIntentAfterAttempt(db, latest.id, input.actor);
    return { kind: 'already_satisfied', intent: settled?.intent ?? getIntent(db, intent.id), results };
  }

  if (intent.resumeCount >= intent.maxResumes) {
    const reason = `resume limit reached (${intent.resumeCount}/${intent.maxResumes}); a person needs to look at this`;
    db.run("UPDATE intents SET status = 'needs_review', updatedAt = ? WHERE id = ?", [nowIso(), intent.id]);
    recordRuntimeEvent(db, { domain: 'attempt', entityId: latest.id, eventType: 'intent_needs_review', actor: input.actor, metadata: { intentId: intent.id, reason } });
    return { kind: 'needs_review', intent: getIntent(db, intent.id), reason };
  }

  const predecessorContext = getAttemptContext(db, latest.id);
  if (!predecessorContext.workspaceRoot || path.resolve(predecessorContext.workspaceRoot) !== path.resolve(intent.workspaceRoot)) {
    throw new CoreError('invalid_transition', 'the attempt workspace no longer matches the intent workspace; refusing to resume');
  }
  const model = String(input.model ?? '').trim();
  if (!model) throw new CoreError('invalid_request', 'a successor model is required');
  if (usedModels(db, intent.requestId).has(`${predecessorContext.selectedProvider}::${model}`)) {
    throw new CoreError('invalid_request', `model '${model}' already worked on this intent; a different model must take over`);
  }

  const snapshot = snapshotIntent(db, intent.id);
  const brief = buildResumeBrief(snapshot, predecessorContext.selectedModel, model);

  return db.transaction(() => {
    const checkpoint = createCheckpoint(db, {
      attemptId: latest.id,
      kind: INTENT_CHECKPOINT_KIND,
      actor: input.actor,
      metadata: {
        intentId: intent.id,
        failedModel: predecessorContext.selectedModel,
        successorModel: model,
        completed: snapshot.effects.filter((e) => e.state === 'completed').length,
        uncertain: snapshot.effects.filter((e) => e.state === 'uncertain').length,
        checksPassing: snapshot.checks.filter((c) => c.passed).length,
        checksTotal: snapshot.checks.length,
        brief,
      },
    });
    const successor = rerouteAttempt(db, {
      predecessorAttemptId: latest.id,
      actor: input.actor,
      provider: predecessorContext.selectedProvider,
      model,
      fingerprint: `intent-resume:${checkpoint.id}`,
      reason: input.reason ?? 'Intent resumed on another model after the previous run was interrupted',
      rerouteIndex: intent.resumeCount + 1,
    });
    db.run("UPDATE intents SET status = 'recovering', resumeCount = resumeCount + 1, updatedAt = ? WHERE id = ?", [nowIso(), intent.id]);
    recordRuntimeEvent(db, {
      domain: 'attempt',
      entityId: successor.id,
      eventType: 'intent_resumed',
      actor: input.actor,
      metadata: {
        intentId: intent.id,
        predecessorAttemptId: latest.id,
        checkpointId: checkpoint.id,
        failedModel: predecessorContext.selectedModel,
        successorModel: model,
      },
    });
    return { kind: 'resumed' as const, intent: getIntent(db, intent.id), successor, checkpointId: checkpoint.id };
  });
}
