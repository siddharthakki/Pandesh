/**
 * Durable Gmail-organization task: "put mail from these senders under these labels", done in small, individually
 * approved, verified batches that survive a restart.
 *
 * - `createTask` lists the REAL Gmail message ids for every rule (sender keywords -> label), reads their headers,
 *   keeps only messages whose From really matches, and saves that manifest. The total is a verified count only when
 *   every listing finished; otherwise progress is reported without a total.
 * - `nextBatch` turns the next few pending messages of one label into an ordinary change plan (the approval card,
 *   apply, verify and undo of `gmailOrganize.ts` are unchanged). Calling it again returns the same open batch, so a
 *   restart or a repeated call never re-plans from scratch.
 * - `afterPlanSettled` checkpoints the manifest from Gmail's own re-read: a message counts as processed only when it
 *   was verified to carry the label. Failures are counted, retried, and a Google Retry-After is remembered.
 *
 * Labels are only ever ADDED. Nothing is archived, deleted or marked read.
 */
import * as crypto from 'node:crypto';
import type { ToolExecutionResult } from '../toolRunner';
import { invalidArgs, stringArray, succeeded, trimmedNonEmptyString } from './gwsGmailAdapter';
import { listIdsForTask, parseSender, planChanges, readHeadersForTask, userLabelIndex, type GmailChangePlan, type OrganizeEnv } from './gmailOrganize';

const TASK_ID_PREFIX = 'gtask_';
const DEFAULT_BATCH = 25;
const MAX_BATCH = 50;
const PER_RULE_CAP = 500;
const MAX_ATTEMPTS = 3;
const MAX_LABEL_NAME = 100;
const FORBIDDEN = new Set(['TRASH', 'SPAM', 'DRAFT', 'SENT', 'CHAT', 'UNREAD', 'INBOX', 'IMPORTANT', 'STARRED']);

export interface TaskRule { label: string; senders: string[] }
export type TaskMessageState = 'pending' | 'done' | 'already' | 'undone' | 'unavailable';

export interface TaskMessage {
  id: string;
  rule: number;
  from: string;
  subject: string;
  date: string;
  state: TaskMessageState;
  attempts: number;
  planId?: string;
}

export interface TaskBatchRecord { planId: string; label: string; count: number; status: 'planned' | 'applied' | 'undone' | 'failed'; at: string }

export interface GmailOrganizeTask {
  taskId: string;
  accountEmail: string;
  status: 'active' | 'complete';
  rules: TaskRule[];
  scope: string;
  batchSize: number;
  messages: TaskMessage[];
  /** True only when every rule's listing and header reads finished, so `messages.length` is the real total. */
  totalVerified: boolean;
  coverage: string;
  currentPlanId?: string;
  batches: TaskBatchRecord[];
  retries: number;
  lastError?: string;
  retryNotBefore?: string;
  createdAt: string;
  updatedAt: string;
}

export interface GmailTaskStore {
  save(task: GmailOrganizeTask): void;
  get(taskId: string): GmailOrganizeTask | undefined;
  findActive(accountEmail: string): GmailOrganizeTask[];
}

type TaskEnv = OrganizeEnv & { tasks: GmailTaskStore };

function iso(env: OrganizeEnv): string { return new Date((env.nowMs ?? Date.now)()).toISOString(); }

export function progressOf(task: GmailOrganizeTask): { processed: number; total: number | null; text: string; remaining: number; unavailable: number } {
  const processed = task.messages.filter((m) => m.state === 'done' || m.state === 'already').length;
  const unavailable = task.messages.filter((m) => m.state === 'unavailable').length;
  const remaining = task.messages.filter((m) => m.state === 'pending' || m.state === 'undone').length;
  const text = task.totalVerified
    ? `${processed} of ${task.messages.length} messages processed`
    : `${processed} messages processed so far (the full number of matching messages is not confirmed)`;
  return { processed, total: task.totalVerified ? task.messages.length : null, text: unavailable ? `${text}; ${unavailable} no longer available` : text, remaining, unavailable };
}

function normalizeRules(raw: unknown): { ok: true; rules: TaskRule[] } | { ok: false; reason: string } {
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, reason: 'gmail_create_task: "rules" must list at least one { label, senders } pair' };
  const rules: TaskRule[] = [];
  for (const entry of raw) {
    const rule = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
    const label = trimmedNonEmptyString(rule.label);
    const senders = [...new Set(stringArray(rule.senders).map((s) => s.toLowerCase()))];
    if (!label || label.length > MAX_LABEL_NAME || /[\u0000-\u001f]/.test(label)) return { ok: false, reason: 'gmail_create_task: every rule needs a valid "label" name' };
    if (FORBIDDEN.has(label.toUpperCase().replace(/\s+/g, '_'))) return { ok: false, reason: `gmail_create_task: the "${label}" label is never changed by Pandesh` };
    if (senders.length === 0) return { ok: false, reason: `gmail_create_task: rule "${label}" needs at least one sender` };
    if (senders.some((s) => s.length < 2 || s.length > 60 || /["()\\]/.test(s))) return { ok: false, reason: `gmail_create_task: rule "${label}" has an invalid sender keyword` };
    rules.push({ label, senders });
  }
  return { ok: true, rules };
}

function fromMatches(from: string, senders: string[]): boolean {
  const haystack = from.toLowerCase();
  return senders.some((s) => haystack.includes(s));
}

function sameRules(a: TaskRule[], b: TaskRule[]): boolean {
  const key = (rules: TaskRule[]) => JSON.stringify(rules.map((r) => [r.label.toLowerCase(), [...r.senders].sort()]).sort());
  return key(a) === key(b);
}

function plain(result: ToolExecutionResult): Record<string, unknown> | null {
  try { return JSON.parse(result.output) as Record<string, unknown>; } catch { return null; }
}

function snapshot(task: GmailOrganizeTask): Record<string, unknown> {
  const p = progressOf(task);
  const byLabel = task.rules.map((r, i) => {
    const mine = task.messages.filter((m) => m.rule === i);
    return { label: r.label, senders: r.senders, found: mine.length, processed: mine.filter((m) => m.state === 'done' || m.state === 'already').length, remaining: mine.filter((m) => m.state === 'pending' || m.state === 'undone').length };
  });
  return {
    taskId: task.taskId,
    status: task.status,
    account: task.accountEmail,
    progress: p.text,
    processed: p.processed,
    total: p.total,
    remaining: p.remaining,
    byLabel,
    batchSize: task.batchSize,
    batches: task.batches.slice(-5),
    openBatchPlanId: task.currentPlanId ?? null,
    retries: task.retries,
    ...(task.lastError ? { lastError: task.lastError } : {}),
    ...(task.retryNotBefore ? { retryNotBefore: task.retryNotBefore } : {}),
  };
}

/** Lists, reads and saves the manifest. Changes nothing in Gmail. */
export async function createTask(rawArgs: Record<string, unknown>, env: TaskEnv): Promise<ToolExecutionResult> {
  const args = rawArgs && typeof rawArgs.arguments === 'object' && rawArgs.arguments !== null && !Array.isArray(rawArgs.arguments) ? rawArgs.arguments as Record<string, unknown> : rawArgs;
  const normalized = normalizeRules(args.rules);
  if (!normalized.ok) return invalidArgs(normalized.reason);
  const batchSize = Math.min(MAX_BATCH, Math.max(1, Math.floor(Number(args.batchSize)) || DEFAULT_BATCH));
  const scope = trimmedNonEmptyString(args.scope) ?? '';

  // A repeated request resumes the task that already exists: it never starts planning over.
  const existing = env.tasks.findActive(env.accountEmail).find((t) => sameRules(t.rules, normalized.rules) && t.scope === scope);
  if (existing) return succeeded('gmail_task_resumed', { ...snapshot(existing), resumed: true, next: 'This task already exists. Do not ask the user again; call gmail_task_next_batch with this taskId.' });

  const started = (env.nowMs ?? Date.now)();
  const deadline = started + 150_000;
  const messages: TaskMessage[] = [];
  const claimed = new Set<string>();
  let complete = true;
  let excluded = 0;
  let duplicates = 0;
  const labelIds = await userLabelIndex(env);
  if (!labelIds.ok) return labelIds.result;

  for (let i = 0; i < normalized.rules.length; i += 1) {
    const rule = normalized.rules[i];
    const query = `from:(${rule.senders.join(' OR ')})${scope ? ` ${scope}` : ''}`;
    const listed = await listIdsForTask(env, query, PER_RULE_CAP, deadline);
    if (listed.failure && listed.stubs.length === 0) return listed.failure;
    const read = await readHeadersForTask(env, listed.stubs, deadline);
    if (!listed.exhausted || read.failed > 0 || read.stoppedBecause !== 'complete') complete = false;
    const labelId = labelIds.byName.get(rule.label.toLowerCase());
    for (const m of read.messages) {
      if (!fromMatches(m.from, rule.senders)) { excluded += 1; continue; }
      if (claimed.has(m.id)) { duplicates += 1; continue; }
      claimed.add(m.id);
      messages.push({ id: m.id, rule: i, from: m.from.slice(0, 200), subject: m.subject, date: m.date, state: labelId && m.priorLabelIds.includes(labelId) ? 'already' : 'pending', attempts: 0 });
    }
  }
  if (messages.length === 0) return succeeded('gmail_task_empty', { found: 0, message: 'No messages from those senders were found in this account, so no task was created.', nothingChanged: true });

  const at = iso(env);
  const task: GmailOrganizeTask = {
    taskId: `${TASK_ID_PREFIX}${crypto.randomUUID()}`,
    accountEmail: env.accountEmail,
    status: 'active',
    rules: normalized.rules,
    scope,
    batchSize,
    messages,
    totalVerified: complete,
    coverage: complete ? `Complete: ${messages.length} messages found by listing every matching message id.` : `PARTIAL: ${messages.length} messages found; a listing stopped early, so more may exist.`,
    batches: [],
    retries: 0,
    createdAt: at,
    updatedAt: at,
  };
  env.tasks.save(task);
  return succeeded('gmail_task_created', {
    ...snapshot(task),
    coverage: task.coverage,
    ignoredNotFromThoseSenders: excluded,
    matchedMoreThanOneRule: duplicates,
    nothingChanged: true,
    next: 'The task is saved. Call gmail_task_next_batch to get the first small batch, show its exact messages, then call gmail_apply_plan for it; the user approves each batch. Labels are only added; nothing is archived.',
  });
}

export async function taskStatus(rawArgs: Record<string, unknown>, env: TaskEnv): Promise<ToolExecutionResult> {
  const found = loadTask(rawArgs, env);
  if (!found.ok) return found.result;
  return succeeded('gmail_task_status', snapshot(found.task));
}

function loadTask(rawArgs: Record<string, unknown>, env: TaskEnv): { ok: true; task: GmailOrganizeTask } | { ok: false; result: ToolExecutionResult } {
  const args = rawArgs && typeof rawArgs.arguments === 'object' && rawArgs.arguments !== null && !Array.isArray(rawArgs.arguments) ? rawArgs.arguments as Record<string, unknown> : rawArgs;
  const taskId = trimmedNonEmptyString(args.taskId) ?? env.tasks.findActive(env.accountEmail)[0]?.taskId;
  if (!taskId) return { ok: false, result: invalidArgs('gmail_task_*: no active Gmail task exists; create one with gmail_create_task') };
  const task = env.tasks.get(taskId);
  if (!task) return { ok: false, result: invalidArgs(`gmail_task_*: no task "${taskId}" exists`) };
  if (task.accountEmail.toLowerCase() !== env.accountEmail.toLowerCase()) return { ok: false, result: invalidArgs('that task belongs to a different Google account') };
  return { ok: true, task };
}

/** The next open batch: the same plan again if one is waiting, otherwise a fresh plan from the pending messages. */
export async function nextBatch(rawArgs: Record<string, unknown>, env: TaskEnv): Promise<ToolExecutionResult> {
  const found = loadTask(rawArgs, env);
  if (!found.ok) return found.result;
  const task = found.task;
  if (!env.hasModifyScope()) return { status: 'failed', exitCode: null, output: 'NOT DONE. Inbox organization needs one extra Google permission (gmail.modify). Open Connections → Google → "Allow inbox organization", approve it in the browser, then try again. Nothing was changed.', resultCategory: 'gmail_modify_scope_missing' };
  const now = (env.nowMs ?? Date.now)();
  if (task.retryNotBefore && Date.parse(task.retryNotBefore) > now) {
    return succeeded('gmail_task_waiting', { ...snapshot(task), waiting: true, message: `Google asked us to wait until ${task.retryNotBefore}. Nothing was changed. Resume then; do not start over.` });
  }

  if (task.currentPlanId) {
    const open = env.store.get(task.currentPlanId);
    if (open && open.status === 'planned' && Date.parse(open.expiresAt) > now) {
      return succeeded('gmail_task_batch_ready', { ...snapshot(task), resumed: true, planId: open.planId, planDigest: open.digest, willChange: open.messages.length, change: open.operation.summary, next: 'This batch is already prepared. Call gmail_apply_plan with planId and planDigest; the approval card lists the exact messages.' });
    }
    task.currentPlanId = undefined;
  }

  const pending = task.messages.filter((m) => (m.state === 'pending' || m.state === 'undone') && m.attempts < MAX_ATTEMPTS);
  if (pending.length === 0) {
    task.status = 'complete';
    task.updatedAt = iso(env);
    env.tasks.save(task);
    return succeeded('gmail_task_complete', { ...snapshot(task), message: 'Nothing is left to label.' });
  }
  const rule = pending[0].rule;
  const batch = pending.filter((m) => m.rule === rule).slice(0, task.batchSize);
  const label = task.rules[rule].label;
  const planned = await planChanges({ messageIds: batch.map((m) => m.id), maxMessages: task.batchSize, operation: { addLabels: [label] } }, env);
  if (planned.status !== 'succeeded') return planned;
  const body = plain(planned);
  if (!body) return planned;

  const already = new Set(stringArray(body.alreadyInThatStateIds));
  const unreadable = new Set(stringArray(body.unreadableIds));
  for (const m of batch) {
    if (already.has(m.id)) m.state = 'already';
    else if (unreadable.has(m.id)) { m.attempts += 1; if (m.attempts >= MAX_ATTEMPTS) m.state = 'unavailable'; }
  }
  const planId = typeof body.planId === 'string' ? body.planId : null;
  if (planId) {
    const index = task.batches.length + 1;
    const plan = env.store.update(planId, { taskId: task.taskId, taskBatch: { index, label } });
    task.currentPlanId = planId;
    task.batches.push({ planId, label, count: plan?.messages.length ?? batch.length, status: 'planned', at: iso(env) });
  }
  task.updatedAt = iso(env);
  env.tasks.save(task);
  if (!planId) return succeeded('gmail_task_batch_empty', { ...snapshot(task), message: 'Every message in that batch already carries the label or could not be read. Call gmail_task_next_batch again.' });
  return succeeded('gmail_task_batch_ready', {
    ...snapshot(task),
    planId,
    planDigest: body.planDigest,
    label,
    willChange: body.willChange,
    messages: (env.store.get(planId)?.messages ?? []).map((m) => ({ id: m.id, from: parseSender(m.from).name, subject: m.subject, date: m.date })),
    change: body.change,
    undo: 'The labels every message has now are saved in this batch; gmail_undo_plan with this planId restores them after it is applied.',
    next: 'Call gmail_apply_plan with this planId and planDigest. The user sees one approval card listing exactly these messages. Do not archive anything.',
  });
}

/** Checkpoints the task from what Gmail really did. Returns the progress line for the apply result. */
export function settleTaskBatch(tasks: GmailTaskStore, nowMs: () => number, plan: GmailChangePlan, event: 'applied' | 'apply_failed' | 'undone', detail?: string): string | void {
  if (!plan.taskId) return;
  const task = tasks.get(plan.taskId);
  if (!task) return;
  const at = new Date(nowMs()).toISOString();
  const ids = new Set(plan.messages.map((m) => m.id));
  const record = task.batches.find((b) => b.planId === plan.planId);
  if (event === 'applied') {
    const verified = new Set(plan.verification?.matchedIds ?? []);
    for (const m of task.messages) {
      if (!ids.has(m.id)) continue;
      if (verified.has(m.id)) { m.state = 'done'; m.planId = plan.planId; } else if (plan.verification?.missing.includes(m.id)) m.state = 'unavailable';
      else m.attempts += 1;
    }
    if (record) record.status = 'applied';
    task.currentPlanId = undefined;
    task.retryNotBefore = undefined;
    if (verified.size === plan.messages.length) task.lastError = undefined;
    else task.lastError = `${plan.messages.length - verified.size} message(s) in the last batch could not be verified in Gmail and will be retried.`;
  } else if (event === 'undone') {
    for (const m of task.messages) if (ids.has(m.id) && m.state === 'done') m.state = 'undone';
    if (record) record.status = 'undone';
  } else {
    task.retries += 1;
    task.lastError = (detail ?? 'Gmail refused the change').slice(0, 300);
    const wait = /retryAfterMs=(\d+)/.exec(detail ?? '');
    if (wait) task.retryNotBefore = new Date(nowMs() + Number(wait[1])).toISOString();
    if (record) record.status = 'failed';
  }
  if (!task.messages.some((m) => (m.state === 'pending' || m.state === 'undone') && m.attempts < MAX_ATTEMPTS)) task.status = 'complete';
  task.updatedAt = at;
  tasks.save(task);
  return event === 'applied' ? progressOf(task).text : undefined;
}
