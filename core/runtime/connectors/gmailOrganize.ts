/**
 * Gmail inbox organization: analysis, bulk preview, approved application, verification and undo.
 *
 * Shape (everything deterministic, nothing guessed):
 * - `analyzeInbox` (read): pages through a bounded number of matching messages, reads their headers with bounded
 *   concurrency and aggregates counts by sender, Gmail category and a documented class. It always says how much of
 *   the mailbox it actually examined: a sample is never described as the whole window.
 * - `planChanges` (read): lists the matching messages, captures the labels each one carries NOW, and stores that as
 *   a plan with a digest. Nothing in the mailbox changes. This is the bulk preview.
 * - `applyPlan` (execute, approval card built by `describePlanForApproval`): batch-modifies the planned messages,
 *   then re-reads every one and reports how many really match the expected labels.
 * - `undoPlan` (execute): restores the labels the plan changed, from the captured prior state, and verifies it.
 *
 * Never deletes, trashes or marks spam; those labels are refused. Email text is untrusted data.
 */
import * as crypto from 'node:crypto';
import type { ToolExecutionResult } from '../toolRunner';
import { callGws, invalidArgs, mapWithConcurrency, stringArray, succeeded, trimmedNonEmptyString, type CallDeps } from './gwsGmailAdapter';

export const GMAIL_MODIFY_SCOPE = 'https://www.googleapis.com/auth/gmail.modify';

const LIST_PAGE_SIZE = 500;
const ANALYZE_DEFAULT_MESSAGES = 300;
const ANALYZE_MAX_MESSAGES = 1000;
const PLAN_DEFAULT_MESSAGES = 100;
const PLAN_MAX_MESSAGES = 500;
const BATCH_MODIFY_CHUNK = 500;
const READ_CONCURRENCY = 8;
const DEFAULT_TIME_BUDGET_MS = 75_000;
const PLAN_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_LABEL_NAME = 100;
const PLAN_ID_PREFIX = 'gplan_';

export const CATEGORY_LABELS: Record<string, string> = {
  personal: 'CATEGORY_PERSONAL',
  social: 'CATEGORY_SOCIAL',
  promotions: 'CATEGORY_PROMOTIONS',
  updates: 'CATEGORY_UPDATES',
  forums: 'CATEGORY_FORUMS',
};
const CATEGORY_LABEL_IDS = new Set(Object.values(CATEGORY_LABELS));
/** System labels a plan may add or remove. TRASH, SPAM, DRAFT, SENT and the rest are never touched. */
const ALLOWED_SYSTEM_LABELS = new Set(['INBOX', 'STARRED', 'IMPORTANT', ...CATEGORY_LABEL_IDS]);
const FORBIDDEN_LABELS = new Set(['TRASH', 'SPAM', 'DRAFT', 'SENT', 'CHAT', 'UNREAD']);

export type MessageClass = 'important' | 'personal' | 'work' | 'updates' | 'promotions' | 'noise' | 'other';
export const MESSAGE_CLASSES: MessageClass[] = ['important', 'personal', 'work', 'updates', 'promotions', 'noise', 'other'];

// ─────────────────────────────── plan model ────────────────────────────────

export interface PlannedMessage {
  id: string;
  threadId: string;
  from: string;
  subject: string;
  date: string;
  priorLabelIds: string[];
  class: MessageClass;
}

export interface PlanOperation {
  addLabelIds: string[];
  removeLabelIds: string[];
  /** User labels that do not exist yet and will be created when the plan is applied. */
  createLabels: string[];
  /** Plain-language description shown on the approval card. */
  summary: string;
}

export type PlanStatus = 'planned' | 'applied' | 'applied_unverified' | 'undone' | 'undo_unverified';

export interface PlanVerification {
  checked: number;
  matched: number;
  mismatched: Array<{ id: string; expected: string[]; actual: string[] }>;
  missing: string[];
  failedLookups: number;
}

export interface GmailChangePlan {
  planId: string;
  accountEmail: string;
  status: PlanStatus;
  digest: string;
  query: string;
  coverage: { listed: number; estimatedTotal: number | null; exhausted: boolean; statement: string };
  operation: PlanOperation;
  messages: PlannedMessage[];
  createdAt: string;
  expiresAt: string;
  appliedAt?: string;
  undoneAt?: string;
  createdLabelIds?: Record<string, string>;
  verification?: PlanVerification;
  undoVerification?: PlanVerification;
}

export interface GmailOrganizeStore {
  save(plan: GmailChangePlan): void;
  get(planId: string): GmailChangePlan | undefined;
  update(planId: string, patch: Partial<GmailChangePlan>): GmailChangePlan | undefined;
}

export interface OrganizeEnv {
  deps: CallDeps;
  accountEmail: string;
  store: GmailOrganizeStore;
  hasModifyScope: () => boolean;
  nowMs?: () => number;
  /** Optional progress sink (wired to Core's runtime events). Never carries message content. */
  onProgress?: (event: { tool: string; phase: string; done: number; total?: number }) => void;
}

// ───────────────────────────── header + classification ─────────────────────────────

interface GmailMetaMessage {
  id?: string;
  threadId?: string;
  labelIds?: string[];
  payload?: { headers?: Array<{ name?: string; value?: string }> };
}

const HEADERS = ['From', 'Subject', 'Date', 'List-Unsubscribe', 'Precedence'];
const AUTOMATED_SENDER = /(?:^|[._-])(?:no[-_.]?reply|do[-_.]?not[-_.]?reply|donotreply|notifications?|mailer(?:-daemon)?|newsletter|news|updates?|info|alerts?|digest|bounce|automated)(?:[._@-]|$)/i;
const PROMO_WORDS = /\b(?:sale|% ?off|discount|deal|deals|offer|offers|coupon|promo|save up to|limited time|free shipping|newsletter|exclusive|black friday|voucher)\b/i;
const CONSUMER_DOMAINS = new Set(['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'yahoo.com', 'icloud.com', 'me.com', 'web.de', 'gmx.de', 'gmx.net', 'gmx.com', 'proton.me', 'protonmail.com', 'aol.com']);

function headerValue(message: GmailMetaMessage, name: string): string {
  const wanted = name.toLowerCase();
  const found = (message.payload?.headers ?? []).find((h) => String(h.name ?? '').toLowerCase() === wanted);
  return typeof found?.value === 'string' ? found.value : '';
}

/** `"Name" <a@b.c>` → { name, address, domain }. */
export function parseSender(raw: string): { name: string; address: string; domain: string } {
  const match = /<([^>]+)>/.exec(raw);
  const address = (match ? match[1] : raw).trim().toLowerCase().replace(/^"+|"+$/g, '');
  const name = (match ? raw.slice(0, raw.indexOf('<')) : '').trim().replace(/^"+|"+$/g, '') || address;
  const domain = address.includes('@') ? address.slice(address.lastIndexOf('@') + 1) : '';
  return { name, address, domain };
}

export interface ClassifyContext {
  accountDomain: string;
  workDomains: string[];
}

export function classifyMessage(input: { labelIds: string[]; from: string; subject: string; listUnsubscribe: boolean; precedence: string }, ctx: ClassifyContext): MessageClass {
  const labels = new Set(input.labelIds);
  const sender = parseSender(input.from);
  const bulk = input.listUnsubscribe || /^(?:bulk|list|junk)$/i.test(input.precedence.trim()) || AUTOMATED_SENDER.test(sender.address.split('@')[0] ?? '');
  if (labels.has('CATEGORY_PROMOTIONS')) return 'promotions';
  if (labels.has('STARRED') || (labels.has('IMPORTANT') && !bulk)) return 'important';
  const orgDomains = new Set([...ctx.workDomains.map((d) => d.toLowerCase()), ...(ctx.accountDomain && !CONSUMER_DOMAINS.has(ctx.accountDomain) ? [ctx.accountDomain] : [])]);
  if (!bulk && sender.domain && orgDomains.has(sender.domain)) return 'work';
  if (!bulk && (labels.has('CATEGORY_PERSONAL') || !input.labelIds.some((l) => CATEGORY_LABEL_IDS.has(l)))) return 'personal';
  // Bulk mail with promotional wording is a promotion even when Gmail filed it under Updates.
  if (bulk && PROMO_WORDS.test(input.subject)) return 'promotions';
  if (labels.has('CATEGORY_UPDATES') || labels.has('CATEGORY_FORUMS')) return 'updates';
  if (bulk || labels.has('CATEGORY_SOCIAL')) return 'noise';
  return 'other';
}

function categoryOf(labelIds: string[]): string {
  const found = labelIds.find((l) => CATEGORY_LABEL_IDS.has(l));
  return found ? found.replace('CATEGORY_', '').toLowerCase() : 'none';
}

interface ReadMessage extends PlannedMessage {
  inInbox: boolean;
  unsubscribe: boolean;
}

function toReadMessage(raw: GmailMetaMessage, stub: { id: string; threadId?: string }, ctx: ClassifyContext): ReadMessage {
  const labelIds = Array.isArray(raw.labelIds) ? raw.labelIds.filter((l): l is string => typeof l === 'string') : [];
  const from = headerValue(raw, 'From');
  const subject = headerValue(raw, 'Subject');
  const unsubscribe = headerValue(raw, 'List-Unsubscribe').length > 0;
  return {
    id: String(raw.id ?? stub.id),
    threadId: String(raw.threadId ?? stub.threadId ?? ''),
    from,
    subject: subject.slice(0, 200),
    date: headerValue(raw, 'Date'),
    priorLabelIds: labelIds,
    class: classifyMessage({ labelIds, from, subject, listUnsubscribe: unsubscribe, precedence: headerValue(raw, 'Precedence') }, ctx),
    inInbox: labelIds.includes('INBOX'),
    unsubscribe,
  };
}

function classifyContext(accountEmail: string, args: Record<string, unknown>): ClassifyContext {
  return {
    accountDomain: parseSender(accountEmail).domain,
    workDomains: stringArray(args.workDomains).map((d) => d.toLowerCase()),
  };
}

// ───────────────────────────── listing + reading ─────────────────────────────

interface ListedIds {
  stubs: Array<{ id: string; threadId?: string }>;
  estimate: number | null;
  exhausted: boolean;
  failure?: ToolExecutionResult;
  stoppedBecause: 'complete' | 'message_cap' | 'time_budget' | 'cancelled' | 'error';
}

async function listMessageIds(env: OrganizeEnv, tool: string, query: string | null, cap: number, deadlineMs: number): Promise<ListedIds> {
  const now = env.nowMs ?? Date.now;
  const stubs: Array<{ id: string; threadId?: string }> = [];
  let estimate: number | null = null;
  let pageToken: string | undefined;
  for (let page = 0; page < 40; page += 1) {
    if (now() > deadlineMs) return { stubs, estimate, exhausted: false, stoppedBecause: 'time_budget' };
    const params: Record<string, unknown> = { userId: 'me', maxResults: Math.min(LIST_PAGE_SIZE, cap - stubs.length) };
    if (query) params.q = query;
    if (pageToken) params.pageToken = pageToken;
    const outcome = await callGws(env.deps, ['gmail', 'users', 'messages', 'list', '--params', JSON.stringify(params)], `${tool}_list_failed`);
    if (!outcome.ok) return { stubs, estimate, exhausted: false, failure: outcome.result, stoppedBecause: outcome.result.resultCategory === 'gws_cancelled' ? 'cancelled' : 'error' };
    const data = outcome.data as { messages?: Array<{ id?: string; threadId?: string }>; resultSizeEstimate?: number; nextPageToken?: string } | null;
    if (page === 0 && typeof data?.resultSizeEstimate === 'number') estimate = data.resultSizeEstimate;
    for (const m of data?.messages ?? []) if (typeof m.id === 'string') stubs.push({ id: m.id, threadId: m.threadId });
    env.onProgress?.({ tool, phase: 'listing', done: stubs.length, total: estimate ?? undefined });
    pageToken = data?.nextPageToken;
    if (!pageToken) return { stubs, estimate, exhausted: true, stoppedBecause: 'complete' };
    if (stubs.length >= cap) return { stubs, estimate, exhausted: false, stoppedBecause: 'message_cap' };
  }
  return { stubs, estimate, exhausted: false, stoppedBecause: 'message_cap' };
}

async function readMetadata(env: OrganizeEnv, tool: string, stubs: Array<{ id: string; threadId?: string }>, ctx: ClassifyContext, deadlineMs: number): Promise<{ messages: ReadMessage[]; failed: number; stoppedBecause: 'complete' | 'time_budget' | 'cancelled' }> {
  const now = env.nowMs ?? Date.now;
  let done = 0;
  let timedOut = false;
  let cancelled = false;
  const results = await mapWithConcurrency(stubs, READ_CONCURRENCY, async (stub) => {
    if (now() > deadlineMs) { timedOut = true; return undefined; }
    const outcome = await callGws(env.deps, ['gmail', 'users', 'messages', 'get', '--params', JSON.stringify({ userId: 'me', id: stub.id, format: 'metadata', metadataHeaders: HEADERS })], `${tool}_metadata_failed`);
    done += 1;
    if (done % 25 === 0) env.onProgress?.({ tool, phase: 'reading', done, total: stubs.length });
    if (!outcome.ok) {
      if (outcome.result.resultCategory === 'gws_cancelled') cancelled = true;
      return null;
    }
    return toReadMessage(outcome.data as GmailMetaMessage, stub, ctx);
  });
  const messages = results.filter((r): r is ReadMessage => Boolean(r));
  const attempted = results.filter((r) => r !== undefined).length;
  return { messages, failed: attempted - messages.length, stoppedBecause: cancelled ? 'cancelled' : timedOut ? 'time_budget' : 'complete' };
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= min ? Math.min(Math.floor(n), max) : fallback;
}

function coverageStatement(input: { examined: number; failed: number; estimate: number | null; exhausted: boolean; stoppedBecause: string; query: string; cap: number }): string {
  const { examined, failed, estimate, exhausted, stoppedBecause, query, cap } = input;
  const window = query ? `matching "${query}"` : 'in the mailbox';
  if (exhausted && failed === 0 && stoppedBecause === 'complete') return `Complete: examined all ${examined} messages ${window}.`;
  const reason = stoppedBecause === 'message_cap' ? `it stopped at the ${cap}-message limit`
    : stoppedBecause === 'time_budget' ? 'it stopped when its time budget ran out'
      : stoppedBecause === 'cancelled' ? 'it was cancelled'
        : stoppedBecause === 'error' ? 'a Gmail request failed'
          : failed > 0 ? `${failed} message lookups failed` : 'not every message could be read';
  const total = estimate !== null ? ` of about ${estimate} ${window} (Gmail's own estimate)` : ` ${window}`;
  return `PARTIAL: examined ${examined}${total}; ${reason}. Do not describe this as the whole mailbox or the whole period.`;
}

// ──────────────────────────────── analyze ────────────────────────────────

export async function analyzeInbox(rawArgs: Record<string, unknown>, env: OrganizeEnv): Promise<ToolExecutionResult> {
  const args = unwrapArgs(rawArgs);
  const now = env.nowMs ?? Date.now;
  const started = now();
  const query = trimmedNonEmptyString(args.query) ?? 'newer_than:30d';
  const cap = clampInt(args.maxMessages, ANALYZE_DEFAULT_MESSAGES, 1, ANALYZE_MAX_MESSAGES);
  const budget = clampInt(args.timeBudgetMs, DEFAULT_TIME_BUDGET_MS, 5_000, 180_000);
  const deadline = started + budget;
  const ctx = classifyContext(env.accountEmail, args);

  const listed = await listMessageIds(env, 'gmail_analyze_inbox', query, cap, deadline);
  if (listed.failure && listed.stubs.length === 0) return listed.failure;
  const read = await readMetadata(env, 'gmail_analyze_inbox', listed.stubs, ctx, deadline);

  const byClass: Record<string, number> = Object.fromEntries(MESSAGE_CLASSES.map((c) => [c, 0]));
  const byCategory: Record<string, number> = {};
  const senders = new Map<string, { name: string; address: string; count: number; classes: Record<string, number>; unsubscribe: boolean; inInbox: number }>();
  const samples: Record<string, Array<{ id: string; from: string; subject: string; date: string }>> = {};
  for (const m of read.messages) {
    byClass[m.class] += 1;
    const category = categoryOf(m.priorLabelIds);
    byCategory[category] = (byCategory[category] ?? 0) + 1;
    const sender = parseSender(m.from);
    const entry = senders.get(sender.address) ?? { name: sender.name, address: sender.address, count: 0, classes: {}, unsubscribe: false, inInbox: 0 };
    entry.count += 1;
    entry.classes[m.class] = (entry.classes[m.class] ?? 0) + 1;
    entry.unsubscribe = entry.unsubscribe || m.unsubscribe;
    if (m.inInbox) entry.inInbox += 1;
    senders.set(sender.address, entry);
    const bucket = (samples[m.class] ??= []);
    if (bucket.length < 3) bucket.push({ id: m.id, from: m.from, subject: m.subject, date: m.date });
  }
  const topSenders = [...senders.values()].sort((a, b) => b.count - a.count || a.address.localeCompare(b.address)).slice(0, 25)
    .map((s) => ({ sender: s.name, address: s.address, count: s.count, mainClass: Object.entries(s.classes).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'other', inInbox: s.inInbox, hasUnsubscribe: s.unsubscribe }));

  const stoppedBecause = listed.stoppedBecause !== 'complete' ? listed.stoppedBecause
    : read.stoppedBecause !== 'complete' ? read.stoppedBecause : 'complete';
  const statement = coverageStatement({ examined: read.messages.length, failed: read.failed, estimate: listed.estimate, exhausted: listed.exhausted, stoppedBecause, query, cap });
  const complete = listed.exhausted && read.failed === 0 && stoppedBecause === 'complete';
  return succeeded('gmail_analysis_succeeded', {
    query,
    coverage: { listed: listed.stubs.length, examined: read.messages.length, failedLookups: read.failed, estimatedTotal: listed.estimate, complete, stoppedBecause, statement },
    byClass,
    byGmailCategory: byCategory,
    topSenders,
    samples,
    classification: 'Heuristic and deterministic: Gmail category labels, STARRED/IMPORTANT, List-Unsubscribe/Precedence headers, automated sender names, promotional words, and the account/work domain. Counts are exact for the examined messages only.',
    elapsedMs: now() - started,
    nothingChanged: true,
  });
}

// ───────────────────────────────── plan ─────────────────────────────────

interface LabelCatalog { byName: Map<string, string>; ids: Set<string> }

async function loadUserLabels(env: OrganizeEnv, tool: string): Promise<{ ok: true; catalog: LabelCatalog } | { ok: false; result: ToolExecutionResult }> {
  const outcome = await callGws(env.deps, ['gmail', 'users', 'labels', 'list', '--params', JSON.stringify({ userId: 'me' })], `${tool}_labels_failed`);
  if (!outcome.ok) return { ok: false, result: outcome.result };
  const labels = ((outcome.data as { labels?: Array<{ id?: string; name?: string; type?: string }> } | null)?.labels ?? []);
  const byName = new Map<string, string>();
  const ids = new Set<string>();
  for (const l of labels) {
    if (typeof l.id !== 'string' || typeof l.name !== 'string') continue;
    ids.add(l.id);
    if (l.type === 'user') byName.set(l.name.toLowerCase(), l.id);
  }
  return { ok: true, catalog: { byName, ids } };
}

type LabelResolution = { ok: true; id: string | null; create: string | null } | { ok: false; reason: string };

function resolveLabel(raw: string, catalog: LabelCatalog, allowCreate: boolean, action: 'add' | 'remove'): LabelResolution {
  const name = raw.trim();
  const upper = name.toUpperCase().replace(/\s+/g, '_');
  if (FORBIDDEN_LABELS.has(upper)) return { ok: false, reason: `the "${upper}" label is never changed by Pandesh (no deleting, trashing, spam-marking or read-state changes)` };
  if (ALLOWED_SYSTEM_LABELS.has(upper)) {
    if (upper === 'INBOX' && action === 'add') return { ok: false, reason: 'adding INBOX is not supported; use archive to take messages out of the inbox' };
    return { ok: true, id: upper, create: null };
  }
  if (upper.startsWith('CATEGORY_')) return { ok: false, reason: `unknown Gmail category "${upper}"` };
  if (!name || name.length > MAX_LABEL_NAME || /[\u0000-\u001f]/.test(name)) return { ok: false, reason: `"${name.slice(0, 40)}" is not a valid label name` };
  const existing = catalog.byName.get(name.toLowerCase());
  if (existing) return { ok: true, id: existing, create: null };
  if (action === 'remove') return { ok: false, reason: `there is no label named "${name}" to remove` };
  if (!allowCreate) return { ok: false, reason: `there is no label named "${name}"` };
  return { ok: true, id: null, create: name };
}

function describeOperation(op: { addLabelIds: string[]; removeLabelIds: string[]; createLabels: string[]; category?: string; archive: boolean; addNames: string[]; removeNames: string[] }): string {
  const parts: string[] = [];
  if (op.category) parts.push(`move to Gmail ${op.category[0].toUpperCase()}${op.category.slice(1)} (adds that category and removes the other categories)`);
  if (op.archive) parts.push('archive (remove from the inbox, keep in All Mail)');
  const plainAdds = op.addNames.filter((n) => !CATEGORY_LABEL_IDS.has(n.toUpperCase()));
  if (plainAdds.length) parts.push(`add label${plainAdds.length === 1 ? '' : 's'} ${plainAdds.map((n) => `"${n}"`).join(', ')}${op.createLabels.length ? ` (new: ${op.createLabels.map((n) => `"${n}"`).join(', ')})` : ''}`);
  const plainRemoves = op.removeNames.filter((n) => n.toUpperCase() !== 'INBOX' || !op.archive);
  if (plainRemoves.length) parts.push(`remove label${plainRemoves.length === 1 ? '' : 's'} ${plainRemoves.map((n) => `"${n}"`).join(', ')}`);
  return parts.join('; ');
}

function digestOf(accountEmail: string, op: PlanOperation, messages: PlannedMessage[]): string {
  const canonical = JSON.stringify({
    a: accountEmail.toLowerCase(),
    add: [...op.addLabelIds].sort(),
    remove: [...op.removeLabelIds].sort(),
    create: [...op.createLabels].sort(),
    m: messages.map((m) => [m.id, [...m.priorLabelIds].sort()]).sort((x, y) => String(x[0]).localeCompare(String(y[0]))),
  });
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

function unwrapArgs(args: Record<string, unknown>): Record<string, unknown> {
  if (args && typeof args.arguments === 'object' && args.arguments !== null && !Array.isArray(args.arguments)) {
    return args.arguments as Record<string, unknown>;
  }
  return args;
}

export async function planChanges(rawArgs: Record<string, unknown>, env: OrganizeEnv): Promise<ToolExecutionResult> {
  const args = unwrapArgs(rawArgs);
  const now = env.nowMs ?? Date.now;
  const started = now();
  const query = trimmedNonEmptyString(args.query);
  const explicitIds = stringArray(args.messageIds);
  if (!query && explicitIds.length === 0) return invalidArgs('gmail_plan_changes: provide a Gmail "query" (for example "category:promotions newer_than:30d") or "messageIds"');
  const cap = clampInt(args.maxMessages, PLAN_DEFAULT_MESSAGES, 1, PLAN_MAX_MESSAGES);
  const deadline = started + clampInt(args.timeBudgetMs, DEFAULT_TIME_BUDGET_MS, 5_000, 180_000);

  const opArg = (args.operation && typeof args.operation === 'object' ? args.operation : {}) as Record<string, unknown>;
  const categoryRaw = trimmedNonEmptyString(opArg.moveToCategory)?.toLowerCase();
  if (categoryRaw && !CATEGORY_LABELS[categoryRaw]) return invalidArgs(`gmail_plan_changes: moveToCategory must be one of ${Object.keys(CATEGORY_LABELS).join(', ')}`);
  const archive = opArg.archive === true;
  const addNames = stringArray(opArg.addLabels);
  const removeNames = stringArray(opArg.removeLabels);
  if (!categoryRaw && !archive && addNames.length === 0 && removeNames.length === 0) {
    return invalidArgs('gmail_plan_changes: "operation" needs at least one of moveToCategory, archive, addLabels, removeLabels');
  }

  const labels = await loadUserLabels(env, 'gmail_plan_changes');
  if (!labels.ok) return labels.result;
  const add = new Set<string>();
  const remove = new Set<string>();
  const create = new Set<string>();
  if (categoryRaw) {
    add.add(CATEGORY_LABELS[categoryRaw]);
    for (const id of CATEGORY_LABEL_IDS) if (id !== CATEGORY_LABELS[categoryRaw]) remove.add(id);
  }
  if (archive) remove.add('INBOX');
  for (const [names, target, action] of [[addNames, add, 'add'], [removeNames, remove, 'remove']] as const) {
    for (const name of names) {
      const resolved = resolveLabel(name, labels.catalog, true, action);
      if (!resolved.ok) return invalidArgs(`gmail_plan_changes: ${resolved.reason}`);
      if (resolved.id) target.add(resolved.id);
      if (resolved.create) create.add(resolved.create);
    }
  }
  for (const id of add) if (remove.has(id)) return invalidArgs('gmail_plan_changes: the same label cannot be both added and removed');

  const ctx = classifyContext(env.accountEmail, args);
  let stubs: Array<{ id: string; threadId?: string }>;
  let estimate: number | null = null;
  let exhausted = true;
  let stoppedBecause: string = 'complete';
  if (explicitIds.length) {
    stubs = [...new Set(explicitIds)].slice(0, cap).map((id) => ({ id }));
    exhausted = stubs.length === new Set(explicitIds).size;
    stoppedBecause = exhausted ? 'complete' : 'message_cap';
  } else {
    const listed = await listMessageIds(env, 'gmail_plan_changes', query, cap, deadline);
    if (listed.failure && listed.stubs.length === 0) return listed.failure;
    stubs = listed.stubs; estimate = listed.estimate; exhausted = listed.exhausted; stoppedBecause = listed.stoppedBecause;
  }
  if (stubs.length === 0) return succeeded('gmail_plan_empty', { query, planId: null, message: 'No messages match, so there is nothing to change.', nothingChanged: true });
  const read = await readMetadata(env, 'gmail_plan_changes', stubs, ctx, deadline);
  if (read.messages.length === 0) return { status: 'failed', exitCode: null, output: 'could not read any of the matching messages; no plan was made', resultCategory: 'gmail_plan_failed' };
  if (read.stoppedBecause !== 'complete') stoppedBecause = read.stoppedBecause;

  const createLabels = [...create];
  const addLabelIds = [...add];
  const removeLabelIds = [...remove];
  // Only messages the change would actually alter belong in the plan.
  const planned = read.messages.filter((m) => addLabelIds.some((id) => !m.priorLabelIds.includes(id)) || removeLabelIds.some((id) => m.priorLabelIds.includes(id)) || createLabels.length > 0);
  if (planned.length === 0) {
    return succeeded('gmail_plan_empty', { query, planId: null, message: `All ${read.messages.length} matching messages already have this state, so there is nothing to change.`, nothingChanged: true });
  }
  const summary = describeOperation({ addLabelIds, removeLabelIds, createLabels, category: categoryRaw, archive, addNames, removeNames });
  const operation: PlanOperation = { addLabelIds, removeLabelIds, createLabels, summary };
  const failed = stubs.length - read.messages.length;
  const statement = coverageStatement({ examined: read.messages.length, failed, estimate, exhausted, stoppedBecause, query: query ?? '', cap });
  const createdAt = new Date(now()).toISOString();
  const plan: GmailChangePlan = {
    planId: `${PLAN_ID_PREFIX}${crypto.randomUUID()}`,
    accountEmail: env.accountEmail,
    status: 'planned',
    digest: digestOf(env.accountEmail, operation, planned),
    query: query ?? `(${explicitIds.length} message ids)`,
    coverage: { listed: stubs.length, estimatedTotal: estimate, exhausted: exhausted && failed === 0, statement },
    operation,
    messages: planned.map(({ inInbox: _i, unsubscribe: _u, ...m }) => m),
    createdAt,
    expiresAt: new Date(now() + PLAN_TTL_MS).toISOString(),
  };
  env.store.save(plan);
  return succeeded('gmail_plan_succeeded', {
    planId: plan.planId,
    planDigest: plan.digest,
    status: 'planned',
    change: summary,
    willChange: plan.messages.length,
    alreadyInThatState: read.messages.length - planned.length,
    coverage: { ...plan.coverage },
    bySender: topCounts(plan.messages.map((m) => parseSender(m.from).address), 10),
    byClass: topCounts(plan.messages.map((m) => m.class), 7),
    sample: plan.messages.slice(0, 12).map((m) => ({ id: m.id, from: m.from, subject: m.subject, date: m.date, currentLabels: m.priorLabelIds })),
    reversible: 'Yes: the labels every message carries now are saved, and gmail_undo_plan restores them.',
    expiresAt: plan.expiresAt,
    nothingChanged: true,
    next: 'Show the user this preview. To apply it, call gmail_apply_plan with planId and planDigest; the user then approves the exact change.',
  });
}

function topCounts(values: string[], limit: number): Array<{ value: string; count: number }> {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit).map(([value, count]) => ({ value, count }));
}

// ───────────────────────────── approval card (prepare) ─────────────────────────────

export type PrepareOutcome = { ok: true; arguments: Record<string, unknown>; presentation: Record<string, unknown> } | { ok: false; reason: string };

const MODIFY_SCOPE_HELP = 'Inbox organization needs one extra Google permission (gmail.modify). Open Connections → Google → "Allow inbox organization", approve it in the browser, then try again. Nothing was changed.';

function loadLivePlan(env: OrganizeEnv, planId: string, allowed: PlanStatus[]): { ok: true; plan: GmailChangePlan } | { ok: false; reason: string } {
  const plan = env.store.get(planId);
  if (!plan) return { ok: false, reason: `no change plan "${planId}" exists; make a new preview with gmail_plan_changes` };
  if (plan.accountEmail.toLowerCase() !== env.accountEmail.toLowerCase()) return { ok: false, reason: 'that plan was made for a different Google account' };
  if (!allowed.includes(plan.status)) return { ok: false, reason: `that plan is already "${plan.status}" and cannot be used this way` };
  if (plan.status === 'planned' && Date.parse(plan.expiresAt) < (env.nowMs ?? Date.now)()) return { ok: false, reason: 'that preview expired; make a new one with gmail_plan_changes' };
  return { ok: true, plan };
}

export function prepareOrganizeAction(toolName: 'gmail_apply_plan' | 'gmail_undo_plan', rawArgs: Record<string, unknown>, env: OrganizeEnv): PrepareOutcome {
  const args = unwrapArgs(rawArgs);
  const planId = trimmedNonEmptyString(args.planId);
  if (!planId) return { ok: false, reason: `${toolName}: "planId" is required (from gmail_plan_changes)` };
  if (!env.hasModifyScope()) return { ok: false, reason: MODIFY_SCOPE_HELP };
  const apply = toolName === 'gmail_apply_plan';
  const loaded = loadLivePlan(env, planId, apply ? ['planned'] : ['applied', 'applied_unverified']);
  if (!loaded.ok) return { ok: false, reason: loaded.reason };
  const { plan } = loaded;
  if (apply) {
    const digest = trimmedNonEmptyString(args.planDigest);
    if (digest && digest !== plan.digest) return { ok: false, reason: 'the plan changed since it was previewed; make a new preview' };
  }
  const lines = apply
    ? [
      `Organize your Gmail (${plan.accountEmail}):`,
      `• ${plan.operation.summary}`,
      `• ${plan.messages.length} message${plan.messages.length === 1 ? '' : 's'} from ${new Set(plan.messages.map((m) => parseSender(m.from).address)).size} sender(s), found with: ${plan.query}`,
      `• ${plan.coverage.statement}`,
      ...plan.messages.slice(0, 8).map((m) => `    - ${parseSender(m.from).name} — ${m.subject || '(no subject)'}`),
      ...(plan.messages.length > 8 ? [`    … and ${plan.messages.length - 8} more`] : []),
      'Nothing is deleted. The labels each message has now are saved, so this can be undone afterwards.',
    ]
    : [
      `Undo a Gmail change (${plan.accountEmail}):`,
      `• Restore ${plan.messages.length} message${plan.messages.length === 1 ? '' : 's'} to the labels they had before: ${plan.operation.summary}`,
      'Messages that were deleted or moved out of reach in the meantime are reported, not guessed.',
    ];
  return {
    ok: true,
    arguments: apply ? { planId, planDigest: plan.digest } : { planId },
    presentation: { cardText: lines.join('\n'), action: toolName, planId, messageCount: plan.messages.length },
  };
}

// ───────────────────────────── apply / undo / verify ─────────────────────────────

function expectedAfterApply(m: PlannedMessage, op: { add: string[]; remove: string[] }): string[] {
  const set = new Set(m.priorLabelIds);
  for (const id of op.add) set.add(id);
  for (const id of op.remove) set.delete(id);
  return [...set].sort();
}

async function verifyMessages(env: OrganizeEnv, tool: string, messages: PlannedMessage[], expected: (m: PlannedMessage) => string[], touched: Set<string>): Promise<PlanVerification> {
  let done = 0;
  const outcomes = await mapWithConcurrency(messages, READ_CONCURRENCY, async (m) => {
    const outcome = await callGws(env.deps, ['gmail', 'users', 'messages', 'get', '--params', JSON.stringify({ userId: 'me', id: m.id, format: 'minimal' })], `${tool}_verify_failed`);
    done += 1;
    if (done % 25 === 0) env.onProgress?.({ tool, phase: 'verifying', done, total: messages.length });
    return { m, outcome };
  });
  const verification: PlanVerification = { checked: 0, matched: 0, mismatched: [], missing: [], failedLookups: 0 };
  for (const { m, outcome } of outcomes) {
    if (!outcome.ok) {
      if (/\b404\b|notFound|not found/i.test(outcome.result.output)) verification.missing.push(m.id);
      else verification.failedLookups += 1;
      continue;
    }
    verification.checked += 1;
    const actual = ((outcome.data as { labelIds?: string[] } | null)?.labelIds ?? []).filter((l) => touched.has(l)).sort();
    const want = expected(m).filter((l) => touched.has(l)).sort();
    if (actual.length === want.length && actual.every((l, i) => l === want[i])) verification.matched += 1;
    else verification.mismatched.push({ id: m.id, expected: want, actual });
  }
  return verification;
}

async function batchModify(env: OrganizeEnv, tool: string, ids: string[], add: string[], remove: string[]): Promise<{ ok: true } | { ok: false; reason: string; modified: number }> {
  let modified = 0;
  for (let i = 0; i < ids.length; i += BATCH_MODIFY_CHUNK) {
    const chunk = ids.slice(i, i + BATCH_MODIFY_CHUNK);
    const body: Record<string, unknown> = { ids: chunk };
    if (add.length) body.addLabelIds = add;
    if (remove.length) body.removeLabelIds = remove;
    const outcome = await callGws(env.deps, ['gmail', 'users', 'messages', 'batchModify', '--params', JSON.stringify({ userId: 'me' }), '--json', JSON.stringify(body)], `${tool}_modify_failed`, { allowEmptyOutput: true });
    if (!outcome.ok) return { ok: false, reason: outcome.result.output, modified };
    modified += chunk.length;
    env.onProgress?.({ tool, phase: 'modifying', done: modified, total: ids.length });
  }
  return { ok: true };
}

async function ensureLabels(env: OrganizeEnv, names: string[]): Promise<{ ok: true; created: Record<string, string> } | { ok: false; reason: string; created: Record<string, string> }> {
  const created: Record<string, string> = {};
  for (const name of names) {
    const outcome = await callGws(env.deps, ['gmail', 'users', 'labels', 'create', '--params', JSON.stringify({ userId: 'me' }), '--json', JSON.stringify({ name, labelListVisibility: 'labelShow', messageListVisibility: 'show' })], 'gmail_label_create_failed');
    if (!outcome.ok) {
      // A label that appeared in the meantime is fine: reuse it instead of failing.
      const labels = await loadUserLabels(env, 'gmail_apply_plan');
      const existing = labels.ok ? labels.catalog.byName.get(name.toLowerCase()) : undefined;
      if (existing) { created[name] = existing; continue; }
      return { ok: false, reason: `could not create the label "${name}": ${outcome.result.output}`, created };
    }
    const id = (outcome.data as { id?: string } | null)?.id;
    if (!id) return { ok: false, reason: `Gmail created the label "${name}" but returned no id`, created };
    created[name] = id;
  }
  return { ok: true, created };
}

function verificationSummary(v: PlanVerification, total: number): string {
  const parts = [`${v.matched} of ${total} messages verified in Gmail`];
  if (v.mismatched.length) parts.push(`${v.mismatched.length} do not match`);
  if (v.missing.length) parts.push(`${v.missing.length} no longer exist`);
  if (v.failedLookups) parts.push(`${v.failedLookups} could not be re-read`);
  return parts.join('; ');
}

export async function applyPlan(rawArgs: Record<string, unknown>, env: OrganizeEnv): Promise<ToolExecutionResult> {
  const args = unwrapArgs(rawArgs);
  const planId = trimmedNonEmptyString(args.planId);
  if (!planId) return invalidArgs('gmail_apply_plan: "planId" is required');
  if (!env.hasModifyScope()) return { status: 'failed', exitCode: null, output: `NOT DONE. ${MODIFY_SCOPE_HELP}`, resultCategory: 'gmail_modify_scope_missing' };
  const loaded = loadLivePlan(env, planId, ['planned']);
  if (!loaded.ok) return { status: 'failed', exitCode: null, output: `NOT DONE. ${loaded.reason}`, resultCategory: 'gmail_plan_unusable' };
  const { plan } = loaded;
  const approvedDigest = trimmedNonEmptyString(args.planDigest);
  if (approvedDigest && approvedDigest !== plan.digest) return { status: 'failed', exitCode: null, output: 'NOT DONE. The plan changed after it was approved; nothing was applied.', resultCategory: 'gmail_plan_drift' };

  let addIds = [...plan.operation.addLabelIds];
  const created = plan.operation.createLabels.length ? await ensureLabels(env, plan.operation.createLabels) : { ok: true as const, created: {} as Record<string, string> };
  if (!created.ok) return { status: 'failed', exitCode: null, output: `NOT DONE. ${created.reason}`, resultCategory: 'gmail_label_create_failed' };
  addIds = [...addIds, ...Object.values(created.created)];
  const removeIds = plan.operation.removeLabelIds;
  const touched = new Set([...addIds, ...removeIds]);

  const modified = await batchModify(env, 'gmail_apply_plan', plan.messages.map((m) => m.id), addIds, removeIds);
  if (!modified.ok) {
    env.store.update(planId, { status: 'applied_unverified', appliedAt: new Date((env.nowMs ?? Date.now)()).toISOString(), createdLabelIds: created.created });
    return { status: 'failed', exitCode: null, output: `PARTIALLY DONE: Gmail refused part of the change after ${modified.modified} of ${plan.messages.length} messages: ${modified.reason}. Run gmail_undo_plan to restore the labels, or re-check the messages.`, resultCategory: 'gmail_modify_failed' };
  }
  const verification = await verifyMessages(env, 'gmail_apply_plan', plan.messages, (m) => expectedAfterApply(m, { add: addIds, remove: removeIds }), touched);
  const verified = verification.matched === plan.messages.length;
  env.store.update(planId, {
    status: verified ? 'applied' : 'applied_unverified',
    appliedAt: new Date((env.nowMs ?? Date.now)()).toISOString(),
    createdLabelIds: created.created,
    verification,
  });
  return succeeded(verified ? 'gmail_apply_verified' : 'gmail_apply_unverified', {
    planId,
    verified,
    changed: plan.messages.length,
    verification: verificationSummary(verification, plan.messages.length),
    details: verification,
    change: plan.operation.summary,
    undo: `Call gmail_undo_plan with planId ${planId} to restore the previous labels.`,
    note: verified ? 'Every changed message was re-read from Gmail and matches.' : 'Gmail accepted the change but not every message could be verified; say so plainly.',
  });
}

export async function undoPlan(rawArgs: Record<string, unknown>, env: OrganizeEnv): Promise<ToolExecutionResult> {
  const args = unwrapArgs(rawArgs);
  const planId = trimmedNonEmptyString(args.planId);
  if (!planId) return invalidArgs('gmail_undo_plan: "planId" is required');
  if (!env.hasModifyScope()) return { status: 'failed', exitCode: null, output: `NOT DONE. ${MODIFY_SCOPE_HELP}`, resultCategory: 'gmail_modify_scope_missing' };
  const loaded = loadLivePlan(env, planId, ['applied', 'applied_unverified']);
  if (!loaded.ok) return { status: 'failed', exitCode: null, output: `NOT DONE. ${loaded.reason}`, resultCategory: 'gmail_plan_unusable' };
  const { plan } = loaded;
  const addIds = [...plan.operation.addLabelIds, ...Object.values(plan.createdLabelIds ?? {})];
  const removeIds = plan.operation.removeLabelIds;
  const touched = new Set([...addIds, ...removeIds]);

  // Restore only what the change touched: put back what it removed, take away what it added.
  const groups = new Map<string, { ids: string[]; restore: string[]; drop: string[] }>();
  for (const m of plan.messages) {
    const restore = removeIds.filter((l) => m.priorLabelIds.includes(l)).sort();
    const drop = addIds.filter((l) => !m.priorLabelIds.includes(l)).sort();
    if (!restore.length && !drop.length) continue;
    const key = `${restore.join(',')}|${drop.join(',')}`;
    const group = groups.get(key) ?? { ids: [], restore, drop };
    group.ids.push(m.id);
    groups.set(key, group);
  }
  let restored = 0;
  for (const group of groups.values()) {
    const done = await batchModify(env, 'gmail_undo_plan', group.ids, group.restore, group.drop);
    if (!done.ok) {
      env.store.update(planId, { status: 'undo_unverified', undoneAt: new Date((env.nowMs ?? Date.now)()).toISOString() });
      return { status: 'failed', exitCode: null, output: `PARTIALLY UNDONE: ${restored} of ${plan.messages.length} messages restored before Gmail refused: ${done.reason}`, resultCategory: 'gmail_undo_failed' };
    }
    restored += group.ids.length;
  }
  const verification = await verifyMessages(env, 'gmail_undo_plan', plan.messages, (m) => [...m.priorLabelIds].sort(), touched);
  const verified = verification.matched + verification.missing.length === plan.messages.length && verification.mismatched.length === 0 && verification.failedLookups === 0;
  env.store.update(planId, { status: verified ? 'undone' : 'undo_unverified', undoneAt: new Date((env.nowMs ?? Date.now)()).toISOString(), undoVerification: verification });
  return succeeded(verified ? 'gmail_undo_verified' : 'gmail_undo_unverified', {
    planId,
    verified,
    restored,
    verification: verificationSummary(verification, plan.messages.length),
    details: verification,
    note: verified ? 'Every message was re-read from Gmail and carries its previous labels again.' : 'Some messages could not be verified or no longer exist; say so plainly.',
  });
}

export const ORGANIZE_TOOL_NAMES = new Set(['gmail_analyze_inbox', 'gmail_plan_changes', 'gmail_apply_plan', 'gmail_undo_plan']);
