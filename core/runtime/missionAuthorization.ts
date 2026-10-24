/**
 * Hands-off Mission V1 — Core-owned frozen mission authorization.
 *
 * Desktop may display the envelope. Only Core decides whether a later action
 * fits that frozen digest. A client `approved` value cannot widen this policy.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CoreDatabase } from '../db/connection';
import { createApproval, listApprovalsForAttempt } from '../domain/approvals';
import { newId, nowIso } from '../domain/ids';
import { CORE_POLICY_ACTOR } from './commandPolicy';
import { hasParentDirectorySegment, isAbsolutePathToken, isInsideWorkspace } from './commandPolicy';
import { isHostOwnedSearchPath } from './missionHostPaths';
import { resolveAnchoredEdit } from './textEditProposal';

export const AUTHORIZE_MISSION_TOOL = 'authorize_mission';
export const DEFAULT_MAX_FILES = 16;
export const DEFAULT_MAX_BYTES_PER_FILE = 256 * 1024;
export const DEFAULT_MAX_TOTAL_BYTES = 1024 * 1024;

const PROTECTED_PATH_RE = /(^|[\\/])(\.git|\.karkedikha)([\\/]|$)/i;
const SECRET_NAME_RE = /(^|[\\/])(\.env|\.env\..+|credentials(?:\.\w+)?|secrets?(?:\.\w+)?|id_rsa|.*\.(pem|key|p12|pfx))$/i;
const BINARY_EXT_RE = /\.(png|jpe?g|gif|webp|ico|exe|dll|so|dylib|bin|zip|gz|7z|pdf|woff2?|ttf|eot|mp3|mp4|wasm)$/i;

export interface MissionFileLimits {
  maxFiles: number;
  maxBytesPerFile: number;
  maxTotalBytes: number;
}

/**
 * One anchored text edit the human explicitly reviewed and froze into the
 * mission envelope at authorization time — before any model turn ran. `find`
 * must appear verbatim and exactly once in the baseline file; `replace` is
 * what it becomes. An empty `find` authorizes an exact full-content proposal
 * for a path that does not exist yet (baseline absent). This is the ONLY
 * thing `evaluateMissionAction` may use to auto-authorize a content mutation:
 * a proposal whose diff against the on-disk baseline is byte-for-byte this
 * edit and nothing else.
 */
export interface MissionFrozenEdit {
  /** Workspace-relative path this anchored edit applies to. */
  path: string;
  find: string;
  replace: string;
  /**
   * The file's whole-content SHA-256 (via `contentDigest`) at the moment the
   * human froze this edit into the mission envelope. Only used to
   * auto-authorize a `propose_text_edit` anchored on the exact same
   * (path, find, replace): even an exact anchor match is never
   * auto-authorized unless this digest is present AND still equals the
   * file's current content — otherwise the file moved since authorization
   * and the edit falls through to human diff review. Not required for, and
   * not consulted by, `propose_file_change`'s content-match auto-authorize.
   */
  baselineDigest?: string;
}

export interface MissionAuthorizationEnvelope {
  version: 1;
  repository: string;
  resolvedPath: string;
  objective: string;
  model: string;
  routingPolicy: 'local-only' | 'explicit-openrouter' | 'explicit-orcarouter' | 'explicit-cloud';
  selectedProvider?: string;
  spendCapUsd?: number;
  allowedMutationScope: string[];
  allowedActionClasses: string[];
  fileChangeLimits: MissionFileLimits;
  /** Edits explicitly frozen by the human at authorization time. Empty by
   * default: with no frozen edit, no content mutation can auto-authorize and
   * every propose_file_change requires human diff review. */
  frozenEdits: MissionFrozenEdit[];
  validationPlan: string;
  browserVerificationPlan: string;
  deliveryPolicy: string;
  deniedCapabilities: string[];
  pushAuthorized: false;
  networkAuthorized: false;
  installAuthorized: false;
}

export type MissionPolicyDecision = 'auto_authorize' | 'require_review' | 'deny';

export interface MissionPolicyResult {
  decision: MissionPolicyDecision;
  reason: string;
  normalizedPath?: string;
  contentDigest?: string;
  contentBytes?: number;
}

export interface MissionAuthorizationRecord {
  id: string;
  attemptId: string;
  digest: string;
  envelope: MissionAuthorizationEnvelope;
  status: 'pending' | 'authorized' | 'rejected';
  authorizedAt?: string;
  authorizedBy?: string;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function missionEnvelopeDigest(envelope: MissionAuthorizationEnvelope): string {
  return `sha256:${crypto.createHash('sha256').update(canonicalJson(envelope), 'utf8').digest('hex')}`;
}

export function contentDigest(content: string): string {
  return `sha256:${crypto.createHash('sha256').update(content, 'utf8').digest('hex')}`;
}

export function buildMissionEnvelope(input: {
  workspaceRoot: string;
  objective: string;
  model: string;
  selectedProvider?: string;
  spendCapUsd?: number;
  frozenEdits?: MissionFrozenEdit[];
}): MissionAuthorizationEnvelope {
  const resolvedPath = path.resolve(input.workspaceRoot);
  const explicitOpenRouter = input.selectedProvider === 'openrouter';
  const explicitOrcaRouter = input.selectedProvider === 'orcarouter';
  const explicitOtherCloud = !!input.selectedProvider && input.selectedProvider !== 'ollama' && !explicitOpenRouter && !explicitOrcaRouter;
  return {
    version: 1,
    repository: path.basename(resolvedPath),
    resolvedPath,
    objective: input.objective.trim(),
    model: input.model.trim(),
    routingPolicy: explicitOpenRouter ? 'explicit-openrouter' : explicitOrcaRouter ? 'explicit-orcarouter' : explicitOtherCloud ? 'explicit-cloud' : 'local-only',
    ...(explicitOpenRouter ? { selectedProvider: 'openrouter' as const } : {}),
    ...(explicitOrcaRouter ? { selectedProvider: 'orcarouter' as const } : {}),
    ...(explicitOtherCloud ? { selectedProvider: input.selectedProvider } : {}),
    ...(explicitOpenRouter && input.spendCapUsd !== undefined ? { spendCapUsd: input.spendCapUsd } : {}),
    allowedMutationScope: [
      'create or modify text files inside the selected repository',
    ],
    allowedActionClasses: [
      'bounded search',
      'ranged read_file',
      'propose_file_change for in-scope text files',
      'focused workspace validation',
      'host-owned behavioral verification',
      'diff review',
      'one local git commit',
    ],
    fileChangeLimits: {
      maxFiles: DEFAULT_MAX_FILES,
      maxBytesPerFile: DEFAULT_MAX_BYTES_PER_FILE,
      maxTotalBytes: DEFAULT_MAX_TOTAL_BYTES,
    },
    frozenEdits: input.frozenEdits ?? [],
    validationPlan: 'Run the repository focused tests after each approved mutation.',
    browserVerificationPlan: 'When .karkedikha/verification-plan.json exists, Core runs those host-owned browser checks at declared desktop and mobile widths.',
    deliveryPolicy: 'One local git commit in this repository after validation, verification, and diff review pass. Push is not authorized.',
    deniedCapabilities: [
      'deletion or rename',
      'paths outside the repository',
      'symlink or parent-directory escape',
      '.git/** and .karkedikha/**',
      'credentials, secrets, environment files, and protected configuration',
      'package installation',
      'arbitrary shell commands',
      'network access',
      'binary or oversized changes',
      'exceeding file or size limits',
      'push, merge, force, or history rewriting',
      'cloud fallback',
    ],
    pushAuthorized: false,
    networkAuthorized: false,
    installAuthorized: false,
  };
}

export function formatMissionEnvelopeCard(envelope: MissionAuthorizationEnvelope, digest: string): string {
  return [
    `Repository: ${envelope.repository}`,
    `Resolved path: ${envelope.resolvedPath}`,
    `Objective: ${envelope.objective}`,
    `Model: ${envelope.model}`,
    `Routing: ${envelope.routingPolicy}`,
    ...(envelope.spendCapUsd !== undefined ? [`Spend cap: $${envelope.spendCapUsd}`] : []),
    `Allowed mutation scope: ${envelope.allowedMutationScope.join('; ')}`,
    `Allowed action classes: ${envelope.allowedActionClasses.join('; ')}`,
    `File/change limits: ${envelope.fileChangeLimits.maxFiles} files, ${envelope.fileChangeLimits.maxBytesPerFile} bytes/file, ${envelope.fileChangeLimits.maxTotalBytes} bytes total`,
    ...(envelope.frozenEdits.length > 0
      ? [`Frozen edits (auto-authorized verbatim, nothing else): ${envelope.frozenEdits.map((edit) => `${edit.path}: ${JSON.stringify(edit.find)} -> ${JSON.stringify(edit.replace)}`).join('; ')}`]
      : ['Frozen edits: none — every propose_file_change requires human diff review']),
    `Validation: ${envelope.validationPlan}`,
    `Browser verification: ${envelope.browserVerificationPlan}`,
    `Delivery: ${envelope.deliveryPolicy}`,
    `Denied: ${envelope.deniedCapabilities.join('; ')}`,
    `Envelope digest: ${digest}`,
  ].join('\n');
}

function deny(reason: string, extra?: Partial<MissionPolicyResult>): MissionPolicyResult {
  return { decision: 'deny', reason, ...extra };
}

function review(reason: string, extra?: Partial<MissionPolicyResult>): MissionPolicyResult {
  return { decision: 'require_review', reason, ...extra };
}

function allow(reason: string, extra?: Partial<MissionPolicyResult>): MissionPolicyResult {
  return { decision: 'auto_authorize', reason, ...extra };
}

function readBaselineText(resolvedWorkspaceRoot: string, relativePath: string): string | undefined {
  try {
    return fs.readFileSync(path.join(resolvedWorkspaceRoot, relativePath), 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * The only deterministic path to auto-authorizing a `propose_file_change`:
 * the proposed content must be exactly what you get from applying one of the
 * envelope's frozen edits to the current on-disk baseline — nothing more,
 * nothing less. A truncated rewrite, an unrelated deletion, or any content
 * the human never explicitly froze all fail this match and fall through to
 * human review. `find` occurring anywhere other than exactly once is treated
 * as ambiguous and never matched.
 */
function matchesFrozenEdit(envelope: MissionAuthorizationEnvelope, relativePath: string, proposedContent: string): boolean {
  const candidates = envelope.frozenEdits.filter((edit) => edit.path === relativePath);
  if (candidates.length === 0) return false;
  const baseline = readBaselineText(envelope.resolvedPath, relativePath);
  for (const edit of candidates) {
    if (edit.find === '') {
      if (proposedContent === edit.replace) return true;
      continue;
    }
    if (baseline === undefined) continue;
    if (baseline.split(edit.find).length - 1 !== 1) continue;
    if (proposedContent === baseline.replace(edit.find, edit.replace)) return true;
  }
  return false;
}

/**
 * The only deterministic path to auto-authorizing a `propose_text_edit`: the
 * exact same (path, find, replace) anchor must have been frozen by the human
 * at authorization time, AND that frozen edit must carry the baseline digest
 * captured at that moment, AND the file's current whole-content digest must
 * still equal it. An anchor match alone is not enough — the file could have
 * been mutated since authorization in a way that still leaves `find`
 * occurring exactly once but changes what the edit actually does.
 */
function matchesFrozenTextEdit(
  envelope: MissionAuthorizationEnvelope,
  relativePath: string,
  find: string,
  replace: string,
  currentBaselineText: string,
): boolean {
  const candidates = envelope.frozenEdits.filter((edit) => (
    edit.path === relativePath && edit.find === find && edit.replace === replace
  ));
  if (candidates.length === 0) return false;
  const currentDigest = contentDigest(currentBaselineText);
  return candidates.some((edit) => edit.baselineDigest !== undefined && edit.baselineDigest === currentDigest);
}

function normalizeRelativePath(requestedPath: string, workspaceRoot: string): { ok: true; relative: string; resolved: string } | { ok: false; reason: string } {
  const trimmed = requestedPath.trim().replace(/\\/g, '/');
  if (!trimmed) return { ok: false, reason: 'empty path' };
  if (isHostOwnedSearchPath(trimmed) || PROTECTED_PATH_RE.test(trimmed)) {
    return { ok: false, reason: 'host-owned or protected path is not authorized' };
  }
  if (SECRET_NAME_RE.test(trimmed)) {
    return { ok: false, reason: 'credentials, secrets, or environment files are not authorized' };
  }
  if (hasParentDirectorySegment(trimmed) || isAbsolutePathToken(trimmed)) {
    return { ok: false, reason: 'path escape is not authorized' };
  }
  const resolved = path.resolve(workspaceRoot, trimmed);
  if (!isInsideWorkspace(workspaceRoot, resolved)) {
    return { ok: false, reason: 'path is outside the selected repository' };
  }
  return { ok: true, relative: trimmed.replace(/^\/+/, ''), resolved };
}

export function evaluateMissionAction(input: {
  envelope: MissionAuthorizationEnvelope;
  toolName: string;
  arguments: Record<string, unknown>;
  usedFiles?: number;
  usedBytes?: number;
}): MissionPolicyResult {
  const { envelope, toolName } = input;
  if (toolName === AUTHORIZE_MISSION_TOOL) {
    return review('mission authorization requires one explicit human approval');
  }
  if (toolName === 'read_file' || toolName === 'search') {
    return allow('bounded investigation is authorized by the frozen envelope');
  }
  if (toolName === 'inspect_page') {
    const page = normalizeRelativePath(String(input.arguments.path ?? ''), envelope.resolvedPath);
    if (!page.ok) return deny(page.reason);
    return allow('host-owned page inspection is authorized', { normalizedPath: page.relative });
  }
  if (toolName === 'host_verification') {
    return allow('host-owned behavioral verification is authorized by the frozen envelope');
  }
  if (toolName === 'run_check') {
    const check = String(input.arguments.check ?? '');
    if (check === 'test' || check === 'diff' || check === 'status' || check === 'commit') {
      return allow(`typed ${check} check is authorized by the frozen envelope`);
    }
    return review(`check '${check}' cannot be matched deterministically to the frozen envelope`);
  }
  if (toolName === 'finish' || toolName === 'ask_user') {
    return allow('mission completion actions are authorized by the frozen envelope');
  }
  if (toolName === 'run_command') {
    return deny('arbitrary shell commands are not authorized by the frozen envelope');
  }
  if (toolName === 'propose_text_edit') {
    const find = input.arguments.find;
    const replace = input.arguments.replace;
    if (typeof find !== 'string' || typeof replace !== 'string') {
      return deny('propose_text_edit requires find and replace text');
    }
    const page = normalizeRelativePath(String(input.arguments.path ?? ''), envelope.resolvedPath);
    if (!page.ok) return deny(page.reason, { normalizedPath: String(input.arguments.path ?? '') });
    if (BINARY_EXT_RE.test(page.relative)) {
      return deny('binary or non-text changes are not authorized', { normalizedPath: page.relative });
    }
    const baseline = readBaselineText(envelope.resolvedPath, page.relative);
    if (baseline === undefined) {
      return deny('propose_text_edit requires an existing file to anchor the edit against', { normalizedPath: page.relative });
    }
    const resolved = resolveAnchoredEdit(baseline, find, replace);
    if (!resolved.ok) {
      return deny(`anchored edit refused: ${resolved.reason}`, { normalizedPath: page.relative });
    }
    if (resolved.content.includes(' ')) {
      return deny('binary or non-text changes are not authorized', { normalizedPath: page.relative });
    }
    const bytes = Buffer.byteLength(resolved.content, 'utf8');
    const editDigest = contentDigest(resolved.content);
    if (bytes > envelope.fileChangeLimits.maxBytesPerFile) {
      return deny('proposed content exceeds the per-file size limit', {
        normalizedPath: page.relative, contentBytes: bytes, contentDigest: editDigest,
      });
    }
    const usedFiles = input.usedFiles ?? 0;
    const usedBytes = input.usedBytes ?? 0;
    if (usedFiles >= envelope.fileChangeLimits.maxFiles) {
      return deny('mission file-count limit would be exceeded', { normalizedPath: page.relative, contentBytes: bytes });
    }
    if (usedBytes + bytes > envelope.fileChangeLimits.maxTotalBytes) {
      return deny('mission total-size limit would be exceeded', { normalizedPath: page.relative, contentBytes: bytes });
    }
    if (matchesFrozenTextEdit(envelope, page.relative, find, replace, baseline)) {
      return allow('anchored edit is byte-for-byte an edit explicitly frozen in the mission authorization, with a still-current baseline', {
        normalizedPath: page.relative, contentBytes: bytes, contentDigest: editDigest,
      });
    }
    return review('anchored edit does not match an edit explicitly frozen in the mission authorization with a still-current baseline; human diff review is required', {
      normalizedPath: page.relative, contentBytes: bytes, contentDigest: editDigest,
    });
  }
  if (toolName !== 'propose_file_change') {
    return review(`action '${toolName}' cannot be matched deterministically to the frozen envelope`);
  }

  const requestedPath = String(input.arguments.path ?? '');
  const content = input.arguments.content;
  if (typeof content !== 'string') {
    return deny('propose_file_change requires text content');
  }
  if (input.arguments.delete === true || input.arguments.rename === true) {
    return deny('deletion or rename is not authorized by the frozen envelope');
  }
  const page = normalizeRelativePath(requestedPath, envelope.resolvedPath);
  if (!page.ok) return deny(page.reason, { normalizedPath: requestedPath });
  if (BINARY_EXT_RE.test(page.relative) || content.includes('\u0000')) {
    return deny('binary or non-text changes are not authorized', { normalizedPath: page.relative });
  }
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > envelope.fileChangeLimits.maxBytesPerFile) {
    return deny('proposed content exceeds the per-file size limit', {
      normalizedPath: page.relative,
      contentBytes: bytes,
      contentDigest: contentDigest(content),
    });
  }
  const usedFiles = input.usedFiles ?? 0;
  const usedBytes = input.usedBytes ?? 0;
  if (usedFiles >= envelope.fileChangeLimits.maxFiles) {
    return deny('mission file-count limit would be exceeded', { normalizedPath: page.relative, contentBytes: bytes });
  }
  if (usedBytes + bytes > envelope.fileChangeLimits.maxTotalBytes) {
    return deny('mission total-size limit would be exceeded', { normalizedPath: page.relative, contentBytes: bytes });
  }
  const digest = contentDigest(content);
  if (matchesFrozenEdit(envelope, page.relative, content)) {
    return allow('proposed content is byte-for-byte an edit explicitly frozen in the mission authorization', {
      normalizedPath: page.relative,
      contentBytes: bytes,
      contentDigest: digest,
    });
  }
  // Path, type, and size are in scope, but scope alone never proved the
  // CONTENT matches what the human authorized. Without a matching frozen
  // edit, the only safe move is human diff review — never inferred from a
  // model-written explanation, the filename, or how small the diff looks.
  return review('proposed content does not match an edit explicitly frozen in the mission authorization; human diff review is required', {
    normalizedPath: page.relative,
    contentBytes: bytes,
    contentDigest: digest,
  });
}

function parseEnvelope(raw: string): MissionAuthorizationEnvelope {
  return JSON.parse(raw) as MissionAuthorizationEnvelope;
}

export function getMissionAuthorization(db: CoreDatabase, attemptId: string): MissionAuthorizationRecord | null {
  const row = db.get<Record<string, unknown>>(
    'SELECT * FROM mission_authorizations WHERE attemptId = ? ORDER BY createdAt DESC LIMIT 1',
    [attemptId],
  );
  if (!row) return null;
  return {
    id: String(row.id),
    attemptId: String(row.attemptId),
    digest: String(row.digest),
    envelope: parseEnvelope(String(row.envelopeJson)),
    status: String(row.status) as MissionAuthorizationRecord['status'],
    authorizedAt: row.authorizedAt ? String(row.authorizedAt) : undefined,
    authorizedBy: row.authorizedBy ? String(row.authorizedBy) : undefined,
  };
}

export function isMissionAuthorized(db: CoreDatabase, attemptId: string): boolean {
  return getMissionAuthorization(db, attemptId)?.status === 'authorized';
}

export function usageForAuthorization(db: CoreDatabase, authorizationId: string): { usedFiles: number; usedBytes: number } {
  const row = db.get<{ files: number; bytes: number }>(
    `SELECT COUNT(*) AS files, COALESCE(SUM(contentBytes), 0) AS bytes
     FROM mission_authorized_actions
     WHERE authorizationId = ? AND action IN ('propose_file_change', 'propose_text_edit') AND policyDecision = 'auto_authorize'`,
    [authorizationId],
  );
  return { usedFiles: Number(row?.files ?? 0), usedBytes: Number(row?.bytes ?? 0) };
}

export function recordAuthorizedAction(db: CoreDatabase, input: {
  authorizationId: string;
  attemptId: string;
  action: string;
  normalizedPath?: string;
  envelopeDigest: string;
  contentDigest?: string;
  contentBytes?: number;
  policyDecision: MissionPolicyDecision;
  policyReason: string;
  evidence?: Record<string, unknown>;
}): void {
  db.run(
    `INSERT INTO mission_authorized_actions (
      id, authorizationId, attemptId, actor, action, normalizedPath, envelopeDigest,
      contentDigest, contentBytes, policyDecision, policyReason, evidenceJson, createdAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      newId('maact'),
      input.authorizationId,
      input.attemptId,
      CORE_POLICY_ACTOR,
      input.action,
      input.normalizedPath ?? null,
      input.envelopeDigest,
      input.contentDigest ?? null,
      input.contentBytes ?? null,
      input.policyDecision,
      input.policyReason,
      JSON.stringify(input.evidence ?? {}),
      nowIso(),
    ],
  );
}

export function markMissionAuthorized(db: CoreDatabase, attemptId: string, actor: string): MissionAuthorizationRecord | null {
  const current = getMissionAuthorization(db, attemptId);
  if (!current) return null;
  db.run(
    `UPDATE mission_authorizations SET status = 'authorized', authorizedAt = ?, authorizedBy = ? WHERE id = ?`,
    [nowIso(), actor, current.id],
  );
  return getMissionAuthorization(db, attemptId);
}

export function markMissionRejected(db: CoreDatabase, attemptId: string, actor: string): MissionAuthorizationRecord | null {
  const current = getMissionAuthorization(db, attemptId);
  if (!current) return null;
  db.run(
    `UPDATE mission_authorizations SET status = 'rejected', authorizedAt = ?, authorizedBy = ? WHERE id = ?`,
    [nowIso(), actor, current.id],
  );
  return getMissionAuthorization(db, attemptId);
}

export function auditAuthorizedMissionAction(db: CoreDatabase, input: {
  attemptId: string;
  action: string;
  arguments?: Record<string, unknown>;
  evidence?: Record<string, unknown>;
}): void {
  const verdict = evaluateAuthorizedDispatch(db, {
    attemptId: input.attemptId,
    toolName: input.action,
    arguments: input.arguments ?? {},
  });
  if (verdict.decision !== 'auto_authorize' || !verdict.authorization) return;
  recordAuthorizedAction(db, {
    authorizationId: verdict.authorization.id,
    attemptId: input.attemptId,
    action: input.action,
    normalizedPath: verdict.normalizedPath,
    envelopeDigest: verdict.authorization.digest,
    contentDigest: verdict.contentDigest,
    contentBytes: verdict.contentBytes,
    policyDecision: verdict.decision,
    policyReason: verdict.reason,
    evidence: input.evidence,
  });
}

export function requestMissionAuthorization(db: CoreDatabase, input: {
  attemptId: string;
  approvalAttemptId: string;
  clientId: string;
  actor: string;
  envelope: MissionAuthorizationEnvelope;
}): { authorizationId: string; approvalId: string; digest: string; cardText: string } {
  const digest = missionEnvelopeDigest(input.envelope);
  const existing = getMissionAuthorization(db, input.attemptId);
  if (existing) {
    const pending = listApprovalsForAttempt(db, input.approvalAttemptId).find((item) => (
      item.status === 'pending'
      && String((item.summary as Record<string, unknown>).toolName) === AUTHORIZE_MISSION_TOOL
    ));
    return {
      authorizationId: existing.id,
      approvalId: pending?.id ?? '',
      digest: existing.digest,
      cardText: formatMissionEnvelopeCard(existing.envelope, existing.digest),
    };
  }

  const authorizationId = newId('mauth');
  db.run(
    `INSERT INTO mission_authorizations (id, attemptId, digest, envelopeJson, status, createdAt)
     VALUES (?, ?, ?, ?, 'pending', ?)`,
    [authorizationId, input.attemptId, digest, JSON.stringify(input.envelope), nowIso()],
  );
  const cardText = formatMissionEnvelopeCard(input.envelope, digest);
  const approval = createApproval(db, {
    attemptId: input.approvalAttemptId,
    kind: 'mutation',
    summary: {
      toolName: AUTHORIZE_MISSION_TOOL,
      arguments: { digest, attemptId: input.attemptId },
      workspaceRoot: input.envelope.resolvedPath,
      pushAuthorized: false,
      networkAuthorized: false,
      installAuthorized: false,
      policyDecision: 'review_required',
      policyReason: 'mission authorization requires one explicit human approval',
    },
    presentation: {
      cardText,
      envelope: input.envelope,
      digest,
    },
    actor: input.actor,
    clientId: input.clientId,
  });
  return { authorizationId, approvalId: approval.id, digest, cardText };
}

export function evaluateAuthorizedDispatch(db: CoreDatabase, input: {
  attemptId: string;
  toolName: string;
  arguments: Record<string, unknown>;
}): MissionPolicyResult & { authorization?: MissionAuthorizationRecord } {
  const authorization = getMissionAuthorization(db, input.attemptId);
  if (!authorization || authorization.status !== 'authorized') {
    return review('no frozen mission authorization is in force');
  }
  const usage = usageForAuthorization(db, authorization.id);
  return {
    ...evaluateMissionAction({
      envelope: authorization.envelope,
      toolName: input.toolName,
      arguments: input.arguments,
      usedFiles: usage.usedFiles,
      usedBytes: usage.usedBytes,
    }),
    authorization,
  };
}
