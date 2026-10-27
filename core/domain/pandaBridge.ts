/**
 * Panda bridge: instructions that originate in a browser (ChatGPT) and are executed by Pandesh.
 *
 * Ownership:
 * - A browser extension is *paired* with Pandesh (one-time code shown in Pandesh, redeemed in the extension). The
 *   pairing token is stored only as a hash, so revoking a pairing takes effect on the very next request.
 * - A relayed task keeps the user's instruction byte-for-byte plus a reference to where it came from. Intake is
 *   idempotent (pairing + client request id), so a retried native message never creates a second task.
 * - Nothing leaves the PC without permission: a task is routed to a local executor by default; an executor that sends
 *   task data to an external model needs explicit consent recorded on the task, and a confidential task needs a second,
 *   separate override.
 * - Every status change is stored as a checkpoint, so the task and its results survive a restart.
 *
 * Execution itself is not here: it reuses the existing conversation, story, Kandev/ACP and approval infrastructure
 * (core/runtime/kandev/pandaBridge.ts).
 */
import * as crypto from 'node:crypto';
import type { CoreDatabase } from '../db/connection';
import { CoreError } from './errors';
import { newId, nowIso } from './ids';
import { appendMessage, createConversation } from './conversations';

export const BRIDGE_MAX_INSTRUCTION_CHARS = 20_000;
export const BRIDGE_MAX_CONTEXT_CHARS = 60_000;
const PAIRING_CODE_TTL_MS = 5 * 60_000;
const PAIRING_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_FAILED_REDEEMS = 5;

export type BridgeTaskStatus =
  | 'received' | 'awaiting_executor' | 'dispatching' | 'running' | 'awaiting_approval' | 'verifying'
  | 'paused' | 'needs_attention' | 'completed' | 'failed' | 'cancelled';
export const TERMINAL_BRIDGE_STATUSES: ReadonlySet<BridgeTaskStatus> = new Set(['completed', 'cancelled']);
export type BridgeControl = 'none' | 'paused' | 'cancelled';

export interface BridgeSourceRef {
  kind: 'chatgpt';
  /** Page address without query or fragment. */
  url?: string;
  conversationId?: string;
  title?: string;
  capturedAt?: string;
  via?: 'send_button' | 'panda_mode';
}

export interface BridgeTransferConsent {
  externalTransfer?: boolean;
  confidentialOverride?: boolean;
  includeContext?: boolean;
}

export interface BridgePairing {
  id: string;
  label: string;
  extensionId: string | null;
  createdAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
  revokedReason: string | null;
}

export interface BridgeTaskRecord {
  id: string;
  pairingId: string;
  clientRequestId: string;
  instruction: string;
  instructionSha256: string;
  sourceRef: BridgeSourceRef;
  contextText: string | null;
  contextConfirmed: boolean;
  sensitivity: 'normal' | 'confidential';
  sensitivityReasons: string[];
  conversationId: string | null;
  projectId: string | null;
  storyId: string | null;
  attemptId: string | null;
  executor: string | null;
  model: string | null;
  routing: 'explicit' | 'auto' | null;
  externalConsent: (BridgeTransferConsent & { grantedBy: string; grantedAt: string }) | null;
  workspacePath: string | null;
  status: BridgeTaskStatus;
  statusDetail: string | null;
  control: BridgeControl;
  result: BridgeTaskResult | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface BridgeTaskResult {
  verification: 'independent' | 'human-reviewed' | 'worker-only' | null;
  evidence: string | null;
  changedFiles: string[];
  commit: string | null;
  pendingApprovals: Array<{ pendingId: string; what: string }>;
  activity: Array<{ at: string; kind: string; text: string }>;
  timeline: Array<{ at: string; event: string; text: string }>;
}

const sha256 = (text: string) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

// ------------------------------------------------------------------ pairing

/** A one-time code shown in Pandesh. Only its hash is stored. */
export function createPairingCode(db: CoreDatabase, now = Date.now()): { code: string; expiresAt: string } {
  const bytes = crypto.randomBytes(8);
  const code = Array.from(bytes, b => PAIRING_CODE_ALPHABET[b % PAIRING_CODE_ALPHABET.length]).join('');
  const expiresAt = new Date(now + PAIRING_CODE_TTL_MS).toISOString();
  db.run('DELETE FROM bridge_pairing_codes WHERE expiresAt < ? OR consumedAt IS NOT NULL', [new Date(now).toISOString()]);
  db.run('INSERT INTO bridge_pairing_codes (codeHash, createdAt, expiresAt) VALUES (?, ?, ?)', [sha256(code), new Date(now).toISOString(), expiresAt]);
  return { code, expiresAt };
}

let failedRedeems = 0;

/** Exchanges a pairing code for a long-lived pairing token. The code works once; repeated wrong guesses burn every open code. */
export function redeemPairingCode(db: CoreDatabase, input: { code: string; label?: string; extensionId?: string }, now = Date.now()): { pairing: BridgePairing; token: string } {
  const code = String(input.code ?? '').trim().toUpperCase();
  const row = db.get<{ codeHash: string; expiresAt: string; consumedAt: string | null }>('SELECT * FROM bridge_pairing_codes WHERE codeHash = ?', [sha256(code)]);
  if (!row || row.consumedAt || Date.parse(row.expiresAt) < now) {
    failedRedeems += 1;
    if (failedRedeems >= MAX_FAILED_REDEEMS) {
      db.run('UPDATE bridge_pairing_codes SET consumedAt = ? WHERE consumedAt IS NULL', [new Date(now).toISOString()]);
      failedRedeems = 0;
    }
    throw new CoreError('unauthenticated', 'the pairing code is invalid, expired or already used');
  }
  failedRedeems = 0;
  const token = crypto.randomBytes(32).toString('base64url');
  const id = newId('pair');
  const at = new Date(now).toISOString();
  db.transaction(() => {
    db.run('UPDATE bridge_pairing_codes SET consumedAt = ? WHERE codeHash = ?', [at, row.codeHash]);
    db.run(
      'INSERT INTO bridge_pairings (id, label, extensionId, tokenHash, createdAt) VALUES (?, ?, ?, ?, ?)',
      [id, String(input.label ?? 'Browser').slice(0, 80) || 'Browser', input.extensionId ? String(input.extensionId).slice(0, 64) : null, sha256(token), at],
    );
  });
  return { pairing: getPairing(db, id), token };
}

function rowToPairing(r: Record<string, unknown>): BridgePairing {
  return {
    id: String(r.id), label: String(r.label), extensionId: (r.extensionId as string) ?? null, createdAt: String(r.createdAt),
    lastSeenAt: (r.lastSeenAt as string) ?? null, revokedAt: (r.revokedAt as string) ?? null, revokedReason: (r.revokedReason as string) ?? null,
  };
}

export function getPairing(db: CoreDatabase, id: string): BridgePairing {
  const row = db.get<Record<string, unknown>>('SELECT * FROM bridge_pairings WHERE id = ?', [id]);
  if (!row) throw new CoreError('not_found', `pairing '${id}' not found`);
  return rowToPairing(row);
}

export function listPairings(db: CoreDatabase): BridgePairing[] {
  return db.all<Record<string, unknown>>('SELECT * FROM bridge_pairings ORDER BY createdAt DESC').map(rowToPairing);
}

/** Resolves a pairing token. A revoked or unknown token never authenticates, so revocation is immediate. */
export function authenticatePairing(db: CoreDatabase, token: string | undefined | null): BridgePairing {
  if (!token) throw new CoreError('unauthenticated', 'this browser is not paired with Pandesh');
  const row = db.get<Record<string, unknown>>('SELECT * FROM bridge_pairings WHERE tokenHash = ?', [sha256(token)]);
  if (!row || row.revokedAt) throw new CoreError('unauthenticated', 'this browser pairing was revoked or is unknown; pair it again from Pandesh');
  db.run('UPDATE bridge_pairings SET lastSeenAt = ? WHERE id = ?', [nowIso(), String(row.id)]);
  return rowToPairing(row);
}

export function revokePairing(db: CoreDatabase, id: string, reason = 'revoked'): BridgePairing {
  const existing = getPairing(db, id);
  if (!existing.revokedAt) db.run('UPDATE bridge_pairings SET revokedAt = ?, revokedReason = ? WHERE id = ?', [nowIso(), reason.slice(0, 200), id]);
  return getPairing(db, id);
}

// ------------------------------------------------------------------ sensitivity

const SENSITIVE_PATTERNS: Array<{ reason: string; re: RegExp }> = [
  { reason: 'private key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { reason: 'cloud access key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { reason: 'API token', re: /\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|xox[abprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,})\b/ },
  { reason: 'bearer or JWT token', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/ },
  { reason: 'credentials in a connection string', re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i },
  { reason: 'password or secret assignment', re: /\b(?:password|passwd|pwd|secret|api[_ -]?key|access[_ -]?token)\b\s*[:=]\s*\S{4,}/i },
  { reason: 'government identifier', re: /\b\d{3}-\d{2}-\d{4}\b/ },
  { reason: 'marked confidential', re: /\b(?:confidential|do not share|internal use only|under nda|attorney[- ]client|trade secret)\b/i },
];

function luhnValid(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = Number(digits[i]);
    if (alt) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

/** Conservative, local, model-free: when in doubt the task is treated as confidential and cannot go to an external model without an override. */
export function classifySensitivity(text: string, userMarked = false): { sensitivity: 'normal' | 'confidential'; reasons: string[] } {
  const reasons = SENSITIVE_PATTERNS.filter(p => p.re.test(text)).map(p => p.reason);
  for (const m of text.matchAll(/\b(?:\d[ -]?){13,19}\b/g)) {
    const digits = m[0].replace(/\D/g, '');
    if (digits.length >= 13 && digits.length <= 19 && luhnValid(digits)) { reasons.push('payment card number'); break; }
  }
  if (userMarked) reasons.push('marked confidential by you');
  return { sensitivity: reasons.length ? 'confidential' : 'normal', reasons: [...new Set(reasons)] };
}

export interface ExecutorTransferInfo { id: string; label: string; external: boolean }

export type TransferDecision = { allowed: true } | { allowed: false; code: 'external_consent_required' | 'confidential_override_required'; message: string };

/**
 * The single gate between a task and an executor that sends task data to an external model. Local executors are always
 * allowed. An external one needs explicit consent for this task, and a confidential task needs a separate override.
 */
export function evaluateTransferPolicy(task: Pick<BridgeTaskRecord, 'sensitivity' | 'sensitivityReasons'>, executor: ExecutorTransferInfo, consent: BridgeTransferConsent | undefined): TransferDecision {
  if (!executor.external) return { allowed: true };
  if (consent?.externalTransfer !== true) {
    return { allowed: false, code: 'external_consent_required', message: `${executor.label} sends this task to an external model. Nothing was sent. Approve the transfer for this task in Pandesh, or choose a local executor.` };
  }
  if (task.sensitivity === 'confidential' && consent.confidentialOverride !== true) {
    return { allowed: false, code: 'confidential_override_required', message: `This task looks confidential (${task.sensitivityReasons.join(', ')}). Nothing was sent to ${executor.label}. Confirm the confidential override explicitly, or choose a local executor.` };
  }
  return { allowed: true };
}

// ------------------------------------------------------------------ tasks

function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string' || !raw) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

function rowToTask(r: Record<string, unknown>): BridgeTaskRecord {
  return {
    id: String(r.id), pairingId: String(r.pairingId), clientRequestId: String(r.clientRequestId),
    instruction: String(r.instruction), instructionSha256: String(r.instructionSha256),
    sourceRef: parseJson<BridgeSourceRef>(r.sourceRef, { kind: 'chatgpt' }),
    contextText: (r.contextText as string) ?? null, contextConfirmed: Number(r.contextConfirmed) === 1,
    sensitivity: r.sensitivity === 'confidential' ? 'confidential' : 'normal',
    sensitivityReasons: parseJson<string[]>(r.sensitivityReasons, []),
    conversationId: (r.conversationId as string) ?? null, projectId: (r.projectId as string) ?? null,
    storyId: (r.storyId as string) ?? null, attemptId: (r.attemptId as string) ?? null,
    executor: (r.executor as string) ?? null, model: (r.model as string) ?? null,
    routing: (r.routing as 'explicit' | 'auto' | null) ?? null,
    externalConsent: parseJson(r.externalConsent, null),
    workspacePath: (r.workspacePath as string) ?? null,
    status: r.status as BridgeTaskStatus, statusDetail: (r.statusDetail as string) ?? null,
    control: (r.control as BridgeControl) ?? 'none', result: parseJson<BridgeTaskResult | null>(r.result, null),
    createdAt: String(r.createdAt), updatedAt: String(r.updatedAt), completedAt: (r.completedAt as string) ?? null,
  };
}

export function getBridgeTask(db: CoreDatabase, id: string): BridgeTaskRecord {
  const row = db.get<Record<string, unknown>>('SELECT * FROM bridge_tasks WHERE id = ?', [id]);
  if (!row) throw new CoreError('not_found', `task '${id}' not found`);
  return rowToTask(row);
}

export function listBridgeTasks(db: CoreDatabase, filter: { pairingId?: string; limit?: number } = {}): BridgeTaskRecord[] {
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
  const rows = filter.pairingId
    ? db.all<Record<string, unknown>>('SELECT * FROM bridge_tasks WHERE pairingId = ? ORDER BY createdAt DESC LIMIT ?', [filter.pairingId, limit])
    : db.all<Record<string, unknown>>('SELECT * FROM bridge_tasks ORDER BY createdAt DESC LIMIT ?', [limit]);
  return rows.map(rowToTask);
}

export interface SubmitBridgeTaskInput {
  clientRequestId: string;
  instruction: string;
  sourceRef?: Partial<BridgeSourceRef>;
  /** Optional page conversation text. Accepted only when the user confirmed sharing it. */
  context?: { text: string; userConfirmed: boolean };
  markedConfidential?: boolean;
}

function cleanSourceRef(ref: Partial<BridgeSourceRef> | undefined): BridgeSourceRef {
  let url: string | undefined;
  if (typeof ref?.url === 'string') {
    try {
      const u = new URL(ref.url);
      if (u.protocol === 'https:') url = `${u.origin}${u.pathname}`.slice(0, 300);
    } catch { /* not a URL: dropped */ }
  }
  return {
    kind: 'chatgpt',
    ...(url ? { url } : {}),
    ...(typeof ref?.conversationId === 'string' && /^[\w-]{1,80}$/.test(ref.conversationId) ? { conversationId: ref.conversationId } : {}),
    ...(typeof ref?.title === 'string' ? { title: ref.title.slice(0, 120) } : {}),
    capturedAt: typeof ref?.capturedAt === 'string' && !Number.isNaN(Date.parse(ref.capturedAt)) ? new Date(ref.capturedAt).toISOString() : nowIso(),
    via: ref?.via === 'panda_mode' ? 'panda_mode' : 'send_button',
  };
}

/**
 * Receives one instruction. Returns the durable task immediately; nothing runs until an executor is chosen.
 * `duplicate` is true when the same pairing already delivered this request (retry). Identical text under a new request id is a new task.
 */
export function submitBridgeTask(db: CoreDatabase, pairing: BridgePairing, input: SubmitBridgeTaskInput): { task: BridgeTaskRecord; duplicate: boolean } {
  const clientRequestId = String(input.clientRequestId ?? '');
  if (!/^[\w.:-]{8,100}$/.test(clientRequestId)) throw new CoreError('invalid_request', "'clientRequestId' is required (8-100 characters of letters, digits, '.', ':', '_' or '-')");
  if (typeof input.instruction !== 'string' || input.instruction.trim().length === 0) throw new CoreError('invalid_request', 'the instruction is empty');
  if (input.instruction.length > BRIDGE_MAX_INSTRUCTION_CHARS) throw new CoreError('invalid_request', `the instruction is longer than ${BRIDGE_MAX_INSTRUCTION_CHARS} characters`);
  if (input.context !== undefined && input.context !== null) {
    if (input.context.userConfirmed !== true) throw new CoreError('invalid_request', 'conversation context is only accepted after the user confirmed sharing it');
    if (typeof input.context.text !== 'string' || input.context.text.length > BRIDGE_MAX_CONTEXT_CHARS) throw new CoreError('invalid_request', `shared context must be text of at most ${BRIDGE_MAX_CONTEXT_CHARS} characters`);
  }

  return db.transaction(() => {
    const existing = db.get<Record<string, unknown>>('SELECT * FROM bridge_tasks WHERE pairingId = ? AND clientRequestId = ?', [pairing.id, clientRequestId]);
    if (existing) return { task: rowToTask(existing), duplicate: true };

    const digest = sha256(input.instruction);

    const { sensitivity, reasons } = classifySensitivity(input.instruction + (input.context?.text ? `\n${input.context.text}` : ''), input.markedConfidential === true);
    const sourceRef = cleanSourceRef(input.sourceRef);
    const id = newId('ptask');
    const now = nowIso();
    const title = input.instruction.replace(/\s+/g, ' ').trim().slice(0, 80);
    const conversation = createConversation(db, { mode: 'saath_kar', title: `ChatGPT → Panda: ${title}`, actor: `panda-bridge:${pairing.id}` });
    // The exact instruction is the user turn of the Pandesh conversation; progress and the final report land beneath it.
    appendMessage(db, conversation.id, { role: 'user', content: input.instruction, actor: `panda-bridge:${pairing.id}`, clientId: `panda-bridge:${pairing.id}` });
    db.run(
      `INSERT INTO bridge_tasks (id, pairingId, clientRequestId, instruction, instructionSha256, sourceRef, contextText, contextConfirmed,
         sensitivity, sensitivityReasons, conversationId, status, statusDetail, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'awaiting_executor', ?, ?, ?)`,
      [
        id, pairing.id, clientRequestId, input.instruction, digest, JSON.stringify(sourceRef),
        input.context ? input.context.text : null, input.context ? 1 : 0, sensitivity, JSON.stringify(reasons), conversation.id,
        'Received. Choose an executor to start the work.', now, now,
      ],
    );
    addCheckpoint(db, id, 'received', 'Received from ChatGPT.', { sha256: digest });
    addCheckpoint(db, id, 'awaiting_executor', 'Received. Choose an executor to start the work.');
    return { task: getBridgeTask(db, id), duplicate: false };
  });
}

// ------------------------------------------------------------------ status and checkpoints

function addCheckpoint(db: CoreDatabase, taskId: string, status: BridgeTaskStatus, detail: string | null, snapshot?: unknown): void {
  db.run('INSERT INTO bridge_task_checkpoints (taskId, status, detail, snapshot, createdAt) VALUES (?, ?, ?, ?, ?)', [
    taskId, status, detail, snapshot === undefined ? null : JSON.stringify(snapshot), nowIso(),
  ]);
}

export function listCheckpoints(db: CoreDatabase, taskId: string, limit = 100): Array<{ id: number; status: BridgeTaskStatus; detail: string | null; createdAt: string }> {
  return db.all<{ id: number; status: BridgeTaskStatus; detail: string | null; createdAt: string }>(
    'SELECT id, status, detail, createdAt FROM bridge_task_checkpoints WHERE taskId = ? ORDER BY id DESC LIMIT ?', [taskId, limit],
  ).reverse();
}

/** Records a status change (and a checkpoint) only when something actually changed. Returns whether it wrote. */
export function recordBridgeStatus(db: CoreDatabase, taskId: string, status: BridgeTaskStatus, detail: string | null, result?: BridgeTaskResult | null): boolean {
  return db.transaction(() => {
    const current = getBridgeTask(db, taskId);
    const resultJson = result === undefined ? undefined : JSON.stringify(result);
    const resultChanged = resultJson !== undefined && resultJson !== (current.result ? JSON.stringify(current.result) : undefined);
    if (current.status === status && (current.statusDetail ?? null) === (detail ?? null) && !resultChanged) return false;
    if (TERMINAL_BRIDGE_STATUSES.has(current.status) && current.status !== status) return false;
    const now = nowIso();
    db.run(
      'UPDATE bridge_tasks SET status = ?, statusDetail = ?, result = COALESCE(?, result), updatedAt = ?, completedAt = ? WHERE id = ?',
      [status, detail, resultJson ?? null, now, TERMINAL_BRIDGE_STATUSES.has(status) ? (current.completedAt ?? now) : current.completedAt, taskId],
    );
    if (current.status !== status || (current.statusDetail ?? null) !== (detail ?? null)) addCheckpoint(db, taskId, status, detail, result ?? undefined);
    return true;
  });
}

export function setBridgeControl(db: CoreDatabase, taskId: string, control: BridgeControl): void {
  db.run('UPDATE bridge_tasks SET control = ?, updatedAt = ? WHERE id = ?', [control, nowIso(), taskId]);
}

/**
 * Claims the right to dispatch. Exactly one caller wins; a retry, a double click or a second browser sees `false`
 * and must not start another execution.
 */
export function claimBridgeDispatch(db: CoreDatabase, taskId: string, routing: { executor: string; model: string | null; routing: 'explicit' | 'auto'; consent: BridgeTransferConsent | null; grantedBy: string }): boolean {
  const now = nowIso();
  const res = db.run(
    `UPDATE bridge_tasks SET status = 'dispatching', statusDetail = ?, executor = ?, model = ?, routing = ?, externalConsent = ?, updatedAt = ?
      WHERE id = ? AND status IN ('awaiting_executor','failed')`,
    [`Starting ${routing.executor}.`, routing.executor, routing.model, routing.routing, routing.consent ? JSON.stringify({ ...routing.consent, grantedBy: routing.grantedBy, grantedAt: now }) : null, now, taskId],
  );
  const won = Number(res.changes) === 1;
  if (won) addCheckpoint(db, taskId, 'dispatching', `Starting ${routing.executor}${routing.model ? ` (${routing.model})` : ''}.`);
  return won;
}

export function attachBridgeExecution(db: CoreDatabase, taskId: string, link: { projectId?: string | null; storyId?: string | null; attemptId?: string | null; workspacePath?: string | null }): void {
  db.run(
    'UPDATE bridge_tasks SET projectId = COALESCE(?, projectId), storyId = COALESCE(?, storyId), attemptId = COALESCE(?, attemptId), workspacePath = COALESCE(?, workspacePath), updatedAt = ? WHERE id = ?',
    [link.projectId ?? null, link.storyId ?? null, link.attemptId ?? null, link.workspacePath ?? null, nowIso(), taskId],
  );
}

// ------------------------------------------------------------------ views

/** What leaves Core for a browser or a phone: no filesystem paths, no tokens, no shared context text. */
export function toBridgeTaskView(task: BridgeTaskRecord, checkpoints?: ReturnType<typeof listCheckpoints>) {
  return {
    id: task.id,
    status: task.status,
    statusDetail: task.statusDetail,
    instruction: task.instruction,
    instructionSha256: task.instructionSha256,
    sourceRef: task.sourceRef,
    contextShared: task.contextConfirmed,
    sensitivity: task.sensitivity,
    sensitivityReasons: task.sensitivityReasons,
    executor: task.executor,
    model: task.model,
    routing: task.routing,
    externalTransfer: task.externalConsent?.externalTransfer === true,
    control: task.control,
    conversationId: task.conversationId,
    storyId: task.storyId,
    attemptId: task.attemptId,
    result: task.result,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    completedAt: task.completedAt,
    openInPandesh: { conversationId: task.conversationId, taskId: task.id },
    ...(checkpoints ? { checkpoints } : {}),
  };
}
