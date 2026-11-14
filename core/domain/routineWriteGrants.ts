/**
 * Standing write grants for unattended routines.
 *
 * The owner may grant ONE scheduled routine, once, the right to write text files inside ONE folder, so its run does not
 * wait for an approval card every day. The grant freezes the instruction, folder (real path), model, allowed operations
 * and limits into a fingerprint. If any of those change, or the grant is revoked or the routine is cancelled, the grant
 * stops applying and the routine goes back to asking. It covers `write_file` only: shell commands, installs, deletion,
 * external messages, calendar changes and every path outside the folder are never covered. Core's tool layer enforces it
 * (see `authorizeFileWrite` in piAgentEngine); a model, a tool or the scheduler can never create one.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CoreDatabase } from '../db/connection';
import { CoreError } from './errors';
import { newId, nowIso } from './ids';
import { getScheduledTask, type ScheduledTaskRecord } from './scheduledTasks';
import { recordRuntimeEvent } from './runtimeEvents';

export const GRANTABLE_OPERATIONS = ['write_file'] as const;
export type GrantOperation = typeof GRANTABLE_OPERATIONS[number];

export const GRANT_LIMIT_CAPS = { maxFiles: 16, maxBytesPerFile: 256 * 1024, maxTotalBytes: 1024 * 1024 } as const;
export const GRANT_DEFAULT_LIMITS = { maxFiles: 8, maxBytesPerFile: 64 * 1024, maxTotalBytes: 256 * 1024 } as const;

export interface GrantLimits { maxFiles: number; maxBytesPerFile: number; maxTotalBytes: number }

export interface FrozenGrant {
  taskId: string;
  instructionDigest: string;
  folder: string; // the real path the owner approved
  model: string;
  operations: GrantOperation[];
  limits: GrantLimits;
}

export interface RoutineWriteGrant {
  id: string;
  taskId: string;
  fingerprint: string;
  frozen: FrozenGrant;
  status: 'active' | 'revoked';
  grantedBy: string;
  grantedAt: string;
  revokedBy: string | null;
  revokedAt: string | null;
  revokeReason: string | null;
}

const sha = (text: string): string => `sha256:${crypto.createHash('sha256').update(text, 'utf8').digest('hex')}`;
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const r = value as Record<string, unknown>;
    return `{${Object.keys(r).sort().map((k) => `${JSON.stringify(k)}:${canonical(r[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
const fingerprintOf = (frozen: FrozenGrant): string => sha(canonical(frozen));
const sameFolder = (a: string, b: string): boolean => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

function realFolder(folder: string): string | null {
  try { return fs.realpathSync.native(path.resolve(folder)); } catch { return null; }
}

function mapGrant(row: Record<string, unknown>): RoutineWriteGrant {
  return {
    id: String(row.id), taskId: String(row.taskId), fingerprint: String(row.fingerprint),
    frozen: JSON.parse(String(row.frozenJson)) as FrozenGrant,
    status: row.status === 'active' ? 'active' : 'revoked',
    grantedBy: String(row.grantedBy), grantedAt: String(row.grantedAt),
    revokedBy: (row.revokedBy as string | null) ?? null, revokedAt: (row.revokedAt as string | null) ?? null, revokeReason: (row.revokeReason as string | null) ?? null,
  };
}

/** The frozen facts of a task as they stand now (used both to create a grant and to check it still matches). */
export function currentFrozenFacts(task: ScheduledTaskRecord, operations: GrantOperation[], limits: GrantLimits): FrozenGrant | { error: string } {
  const scope = task.scope as { workspaceRoot?: unknown; workspaceAccess?: unknown } | null;
  const root = scope && typeof scope.workspaceRoot === 'string' ? scope.workspaceRoot : '';
  if (!root) return { error: 'this routine has no folder; a standing write permission is bound to one folder' };
  if (scope?.workspaceAccess !== 'read_write') return { error: 'the routine was not created with write access to its folder' };
  const folder = realFolder(root);
  if (!folder) return { error: 'the routine\'s folder does not exist' };
  return { taskId: task.id, instructionDigest: sha(task.instruction), folder, model: String(task.model ?? ''), operations: [...operations].sort() as GrantOperation[], limits };
}

function validateLimits(input: Partial<GrantLimits> | undefined): GrantLimits {
  const pick = (v: unknown, def: number, cap: number, name: string): number => {
    if (v === undefined) return def;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > cap) throw new CoreError('invalid_request', `${name} must be a whole number from 1 to ${cap}`);
    return v;
  };
  return {
    maxFiles: pick(input?.maxFiles, GRANT_DEFAULT_LIMITS.maxFiles, GRANT_LIMIT_CAPS.maxFiles, 'maxFiles'),
    maxBytesPerFile: pick(input?.maxBytesPerFile, GRANT_DEFAULT_LIMITS.maxBytesPerFile, GRANT_LIMIT_CAPS.maxBytesPerFile, 'maxBytesPerFile'),
    maxTotalBytes: pick(input?.maxTotalBytes, GRANT_DEFAULT_LIMITS.maxTotalBytes, GRANT_LIMIT_CAPS.maxTotalBytes, 'maxTotalBytes'),
  };
}

export function getActiveGrant(db: CoreDatabase, taskId: string): RoutineWriteGrant | null {
  const row = db.get<Record<string, unknown>>("SELECT * FROM routine_write_grants WHERE taskId = ? AND status = 'active' ORDER BY grantedAt DESC LIMIT 1", [taskId]);
  return row ? mapGrant(row) : null;
}

export function listGrants(db: CoreDatabase, taskId: string): RoutineWriteGrant[] {
  return db.all<Record<string, unknown>>('SELECT * FROM routine_write_grants WHERE taskId = ? ORDER BY grantedAt DESC', [taskId]).map(mapGrant);
}

/** Creates the grant. The caller (a host-only route) has verified a person is acting; replaces any earlier active grant. */
export function createGrant(db: CoreDatabase, input: { taskId: string; operations?: string[]; limits?: Partial<GrantLimits>; grantedBy: string }): RoutineWriteGrant {
  const task = getScheduledTask(db, input.taskId);
  if (!task.enabled) throw new CoreError('invalid_transition', 'the routine is not active');
  if (task.routine) throw new CoreError('invalid_request', 'Core-run routines have their own scope; a standing write permission is for routines the model carries out');
  const requested = input.operations ?? ['write_file'];
  const bad = requested.filter((o) => !(GRANTABLE_OPERATIONS as readonly string[]).includes(o));
  if (bad.length || requested.length === 0) throw new CoreError('invalid_request', `only these operations can be granted: ${GRANTABLE_OPERATIONS.join(', ')} (not: ${bad.join(', ') || 'none given'})`);
  const limits = validateLimits(input.limits);
  const frozen = currentFrozenFacts(task, [...new Set(requested)] as GrantOperation[], limits);
  if ('error' in frozen) throw new CoreError('invalid_request', frozen.error);
  const at = nowIso();
  const id = newId('rgrant');
  db.transaction(() => {
    for (const old of db.all<{ id: string }>("SELECT id FROM routine_write_grants WHERE taskId = ? AND status = 'active'", [task.id])) {
      db.run("UPDATE routine_write_grants SET status = 'revoked', revokedBy = ?, revokedAt = ?, revokeReason = ? WHERE id = ?", [input.grantedBy, at, 'replaced by a new grant', old.id]);
    }
    db.run('INSERT INTO routine_write_grants (id, taskId, fingerprint, frozenJson, status, grantedBy, grantedAt) VALUES (?, ?, ?, ?, ?, ?, ?)', [id, task.id, fingerprintOf(frozen), JSON.stringify(frozen), 'active', input.grantedBy, at]);
    recordRuntimeEvent(db, { domain: 'authorization', entityId: task.id, eventType: 'routine_write_grant_created', actor: input.grantedBy, metadata: { grantId: id, folder: frozen.folder, operations: frozen.operations, limits } });
  });
  return listGrants(db, task.id).find((g) => g.id === id)!;
}

export function revokeGrant(db: CoreDatabase, taskId: string, by: string, reason: string): number {
  const at = nowIso();
  let n = 0;
  db.transaction(() => {
    for (const g of db.all<{ id: string }>("SELECT id FROM routine_write_grants WHERE taskId = ? AND status = 'active'", [taskId])) {
      db.run("UPDATE routine_write_grants SET status = 'revoked', revokedBy = ?, revokedAt = ?, revokeReason = ? WHERE id = ?", [by, at, reason.slice(0, 300), g.id]);
      recordRuntimeEvent(db, { domain: 'authorization', entityId: taskId, eventType: 'routine_write_grant_revoked', actor: by, metadata: { grantId: g.id, reason: reason.slice(0, 300) } });
      n += 1;
    }
  });
  return n;
}

export type GrantCheck =
  | { ok: true; grant: RoutineWriteGrant }
  | { ok: false; reason: string; grantId?: string };

/**
 * Whether a standing grant covers a write in `workspaceRoot` by a run of task `taskId` right now. Anything that differs
 * from what the owner approved (instruction, folder, model, operations, limits), a revoked or cancelled routine, or a
 * folder that was swapped for another real path makes the grant not apply, and the write goes to a human.
 */
export function checkGrantForWrite(db: CoreDatabase, taskId: string, workspaceRoot: string): GrantCheck {
  const grant = getActiveGrant(db, taskId);
  if (!grant) return { ok: false, reason: 'no standing write permission for this routine' };
  let task: ScheduledTaskRecord;
  try { task = getScheduledTask(db, taskId); } catch { return { ok: false, reason: 'the routine no longer exists', grantId: grant.id }; }
  if (!task.enabled) return { ok: false, reason: 'the routine is cancelled', grantId: grant.id };
  const now = currentFrozenFacts(task, grant.frozen.operations, grant.frozen.limits);
  if ('error' in now) return { ok: false, reason: now.error, grantId: grant.id };
  if (fingerprintOf(now) !== grant.fingerprint) return { ok: false, reason: 'the routine changed since the permission was given (instruction, folder, model or limits); it needs to be approved again', grantId: grant.id };
  const real = realFolder(workspaceRoot);
  if (!real || !sameFolder(real, grant.frozen.folder)) return { ok: false, reason: 'the write is not in the folder the permission was given for', grantId: grant.id };
  return { ok: true, grant };
}

/** The task a scheduler-origin attempt belongs to: the scheduler names its requests `sched:<taskId>:<time>`. */
export function scheduledTaskOfAttempt(db: CoreDatabase, attemptId: string): string | null {
  const row = db.get<{ clientId: string; correlationId: string }>('SELECT r.clientId AS clientId, r.correlationId AS correlationId FROM attempts a JOIN requests r ON r.id = a.requestId WHERE a.id = ?', [attemptId]);
  if (!row || row.clientId !== 'core:scheduler') return null;
  const m = /^sched:(.+):\d+$/.exec(row.correlationId);
  return m ? m[1] : null;
}

export function recordGrantUse(db: CoreDatabase, input: { grantId: string; taskId: string; attemptId: string; path: string; contentDigest: string; contentBytes: number; readbackMatched: boolean }): void {
  db.run('INSERT INTO routine_write_grant_uses (id, grantId, taskId, attemptId, path, contentDigest, contentBytes, readbackMatched, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [newId('rguse'), input.grantId, input.taskId, input.attemptId, input.path, input.contentDigest, input.contentBytes, input.readbackMatched ? 1 : 0, nowIso()]);
}

/**
 * Independent check at the end of a run: re-read every file the grant wrote in this run's attempt chain and compare it
 * with the digest recorded at write time. Returns what was found, so the run's audit does not rest on the model's report.
 */
export function verifyGrantRun(db: CoreDatabase, attemptId: string): { uses: number; matched: number; problems: string[] } {
  const rows = db.all<{ id: string; path: string; contentDigest: string }>(
    `SELECT id, path, contentDigest FROM routine_write_grant_uses WHERE attemptId IN (SELECT id FROM attempts WHERE requestId = (SELECT requestId FROM attempts WHERE id = ?))`, [attemptId]);
  const problems: string[] = [];
  let matched = 0;
  const at = nowIso();
  for (const r of rows) {
    let check: string;
    try { check = sha(fs.readFileSync(r.path, 'utf8')) === r.contentDigest ? 'match' : 'changed_after_write'; } catch { check = 'missing'; }
    if (check === 'match') matched += 1; else problems.push(`${path.basename(r.path)}: ${check}`);
    db.run('UPDATE routine_write_grant_uses SET finalCheck = ?, finalCheckedAt = ? WHERE id = ?', [check, at, r.id]);
  }
  return { uses: rows.length, matched, problems };
}

export { sha as grantContentDigest };

/** Deterministic counts for a directory listing, so a routine that has to count files never tallies them itself. */
export function countDirectoryEntries(entries: Array<{ name: string; isFile(): boolean; isDirectory(): boolean }>, includeHidden = false): { fileCount: number; folderCount: number; countNote: string } {
  const shown = entries.filter((e) => includeHidden || !e.name.startsWith('.'));
  const fileCount = shown.filter((e) => e.isFile()).length;
  const folderCount = shown.filter((e) => e.isDirectory()).length;
  return { fileCount, folderCount, countNote: `Exact counts computed by the tool${includeHidden ? '' : ' (hidden entries excluded)'}: ${fileCount} file(s), ${folderCount} folder(s). Use these numbers; do not count the items yourself.` };
}

/**
 * Independent semantic check of what a routine wrote, separate from the model and from the write-time read-back: a read-back only
 * proves the file holds what was written, not that what was written is right. For a "count the files in <folder>" routine whose
 * output is a bare number, Core recounts the folder on disk and compares. A routine whose result Core cannot recompute is not
 * semantically checked (checked = 0), and that is reported as such, never as verified.
 */
export function verifyRoutineSemantics(db: CoreDatabase, attemptId: string, instruction: string, workspaceRoot: string | null): { checked: number; problems: string[] } {
  if (!workspaceRoot || !/\bcount\b[^.]*\bfiles?\b/i.test(instruction)) return { checked: 0, problems: [] };
  const rows = db.all<{ path: string }>(
    `SELECT path FROM routine_write_grant_uses WHERE attemptId IN (SELECT id FROM attempts WHERE requestId = (SELECT requestId FROM attempts WHERE id = ?))`, [attemptId]);
  // The folder the instruction NAMES decides what is recounted. What the model happened to list last does not: a routine that lists
  // the workspace root after the inbox must not be judged against the root (found by the release-candidate smoke).
  // Containment is decided on REAL paths: a junction or symlink inside the folder that points outside it must not be recounted.
  const real = (f: string): string | null => { try { return fs.realpathSync.native(f); } catch { return null; } };
  const inside = (f: string): boolean => {
    const root = real(workspaceRoot); const target = real(f);
    if (!root || !target) return false;
    const rel = path.relative(root, target);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  };
  let folder: string | null = null;
  const named = /\bin the ['"`]?([\w./\\-]+)['"`]? (?:folder|directory)\b/i.exec(instruction);
  if (named) { const f = path.resolve(workspaceRoot, named[1]); if (inside(f)) folder = real(f); }
  // No folder named: not recounted. A listing is not evidence of which folder the count was for.
  if (!folder) return { checked: 0, problems: [] };
  let actual: number;
  try { actual = countDirectoryEntries(fs.readdirSync(folder, { withFileTypes: true })).fileCount; } catch { return { checked: 0, problems: [`${path.basename(folder)}: cannot be recounted`] }; }
  const problems: string[] = []; let checked = 0;
  for (const r of rows) {
    let text: string; try { text = fs.readFileSync(r.path, 'utf8').trim(); } catch { continue; }
    if (!/^\d+$/.test(text)) continue;
    checked += 1;
    if (Number(text) !== actual) problems.push(`${path.basename(r.path)} says ${text} but ${path.basename(folder)} holds ${actual} file(s)`);
  }
  return { checked, problems };
}
