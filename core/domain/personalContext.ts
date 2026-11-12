/**
 * Personal context: one evidence-grounded picture of the user, assembled from what Core already records.
 *
 * Nothing here is a new store. It reads:
 *   memory_facts + memory_evidence + memory_contradictions   (who the user is, preferences, goals, decisions)
 *   projects.productContext.tasks (personalTasks.ts)          (tasks, deadlines, priorities, blockers, completions)
 *   commitments, everyday_reminders, household_obligations   (promises, reminders, bills and contracts)
 *   tool_execution_journal + approvals                        (what Pandesh actually did, failed, or is waiting on)
 *
 * and produces two things:
 *   - `buildPersonalContextSection`: a compact, relevance-gated block for the main assistant's turn (local model only),
 *     so the user does not have to re-explain themselves, and the model is told where every fact came from;
 *   - `personalOverview`: the deterministic answer to "what matters now / what is due / what did you finish / what am I
 *     neglecting / what changed / which decisions were reversed", every line with its record id.
 *
 * Rules (from the Personal Context mission):
 *   - Every fact carries its source class: user-stated, user-confirmed, observed by a Pandesh tool, imported from a
 *     document or email (unconfirmed), or inference. An inference is never shown as a confirmed fact.
 *   - Priority comes only from what the user declared (task priority, stated goals) and from deadlines and blockers,
 *     never from how often a topic appears in conversation.
 *   - Expired, superseded and contradicted facts are labelled, never silently used.
 *   - A specialist agent and any non-local model receive none of this.
 */
import type { CoreDatabase } from '../db/connection';
import { listMemoryContradictions, listMemoryEvidence } from './memory';
import { allTasks, formatTask, type TaskView } from './personalTasks';
import type { MemoryFactRecord } from '../shared/wireTypes';

export type FactSourceClass = 'user_stated' | 'user_confirmed' | 'observed' | 'imported' | 'inferred';

export const SOURCE_LABEL: Record<FactSourceClass, string> = {
  user_stated: 'you told me',
  user_confirmed: 'you confirmed',
  observed: 'seen by a Pandesh tool',
  imported: 'from a document/email, not confirmed by you',
  inferred: 'inference, not confirmed',
};

const IMPORT_TOOLS = /^(?:document_|read_file|gmail_|calendar_|household_|ocr|brain|search_second_brain)/;

interface FactRow {
  id: string; subject: string; predicate: string; displayValue: string; scopeType: string; scopeId: string; sensitivity: string;
  state: string; createdAt: string; updatedAt: string; expiresAt: string | null; consentApprovalId: string | null; memoryType: string;
}

/** Where a remembered fact came from, decided from its evidence rows (never from the model's say-so). */
export function factSourceClass(db: CoreDatabase, fact: Pick<FactRow, 'id' | 'predicate' | 'consentApprovalId' | 'memoryType'>): FactSourceClass {
  if (/\b(?:inferred|inference|hypothes[ie]s|guess|probably)\b/i.test(fact.predicate)) return 'inferred';
  let evidence: Array<{ sourceType: string; sourceInvocationId: string | null }> = [];
  try { evidence = listMemoryEvidence(db, fact.id); } catch { evidence = []; }
  if (!evidence.length) return 'inferred';
  for (const e of evidence) {
    if (e.sourceType === 'tool_invocation' && e.sourceInvocationId) {
      const tool = db.get<{ toolName: string }>('SELECT toolName FROM tool_invocations WHERE id = ?', [e.sourceInvocationId])?.toolName ?? '';
      if (IMPORT_TOOLS.test(tool)) return 'imported';
    }
  }
  if (evidence.some((e) => e.sourceType === 'capability_approval') || fact.consentApprovalId) return 'user_confirmed';
  if (evidence.some((e) => e.sourceType === 'conversation_message')) return 'user_stated';
  return 'observed';
}

const GOAL_PREDICATE = /\b(?:goal|goals|priority|priorities|focus|objective|aim|target)\b/i;
const IDENTITY_PREDICATE = /\b(?:name|home|lives?|live in|city|location|language|prefer\w*|preference|works?|job|role|occupation|profession|business|family|partner|wife|husband|child|kids?|birthday|timezone|diet|allerg\w*)\b/i;
const HIGH_IMPORTANCE = /\b(?:top|highest|most important|number one|#1|critical|urgent|main|high)\b/i;

export interface PersonalFact {
  id: string; subject: string; predicate: string; value: string; scope: string; since: string;
  source: FactSourceClass; sensitivity: string; conflict: string | null; expired: boolean; stale: boolean;
}

function toFact(db: CoreDatabase, r: FactRow, now: Date): PersonalFact {
  let conflict: string | null = null;
  try {
    const open = listMemoryContradictions(db, r.id).filter((c) => c.state === 'unresolved');
    if (open.length) {
      const otherId = open[0].earlierMemoryId === r.id ? open[0].laterMemoryId : open[0].earlierMemoryId;
      const other = db.get<{ displayValue: string }>('SELECT displayValue FROM memory_facts WHERE id = ?', [otherId]);
      conflict = other ? `conflicts with "${other.displayValue}" (${otherId})` : 'has an unresolved contradiction';
    }
  } catch { /* contradiction lookup is best effort */ }
  return {
    id: r.id, subject: r.subject, predicate: r.predicate, value: r.displayValue, scope: `${r.scopeType}:${r.scopeId}`, since: r.createdAt,
    source: factSourceClass(db, r), sensitivity: r.sensitivity, conflict,
    expired: Boolean(r.expiresAt && new Date(r.expiresAt) <= now),
    // A fact not touched for 180 days may no longer be current; it is shown with that warning, not dropped.
    stale: now.getTime() - new Date(r.updatedAt).getTime() > 180 * 86_400_000,
  };
}

/** Active, non-forgotten, non-restricted user/global facts. Project/task/repository facts stay with their scope. */
export function userFacts(db: CoreDatabase, now = new Date()): PersonalFact[] {
  const rows = db.all<FactRow>(
    `SELECT id, subject, predicate, displayValue, scopeType, scopeId, sensitivity, state, createdAt, updatedAt, expiresAt, consentApprovalId, memoryType
       FROM memory_facts WHERE state = 'active' AND forgottenAt IS NULL AND sensitivity != 'restricted' AND scopeType IN ('user', 'global')
      ORDER BY createdAt DESC LIMIT 300`);
  return rows.map((r) => toFact(db, r, now)).filter((f) => !f.expired);
}

export interface DatedItem {
  kind: 'task' | 'commitment' | 'reminder' | 'obligation';
  ref: string; title: string; dueAt: string; detail: string; source: FactSourceClass;
  priority?: string | null; goal?: string | null;
}

export interface JournalItem { invocationId: string; toolName: string; status: string; effect: string; summary: string; at: string; conversationId: string | null }

export interface PersonalState {
  now: string;
  windowDays: number;
  facts: PersonalFact[];
  goals: PersonalFact[];
  formerGoals: Array<{ id: string; value: string; until: string }>;
  tasks: TaskView[];
  dated: DatedItem[];
  completedTasks: TaskView[];
  blockedTasks: TaskView[];
  staleTasks: TaskView[];
  pandeshCompleted: JournalItem[];
  pandeshFailed: JournalItem[];
  pendingApprovals: Array<{ id: string; kind: string; requestedAt: string; summary: string }>;
  reversedDecisions: Array<{ oldId: string; oldValue: string; newId: string | null; newValue: string | null; subject: string; at: string }>;
  openContradictions: Array<{ id: string; earlier: string; later: string; subject: string }>;
  coverage: string[];
}

const safeAll = <T>(db: CoreDatabase, sql: string, params: unknown[] = []): T[] => { try { return db.all<T>(sql, params); } catch { return []; } };

/** Everything the overview and the turn section draw on, read in one pass. Read-only. */
export function collectPersonalState(db: CoreDatabase, opts: { now?: Date; windowDays?: number; horizonDays?: number } = {}): PersonalState {
  const now = opts.now ?? new Date();
  const windowDays = opts.windowDays ?? 7;
  const horizonDays = opts.horizonDays ?? 14;
  const since = new Date(now.getTime() - windowDays * 86_400_000).toISOString();
  const horizon = new Date(now.getTime() + horizonDays * 86_400_000).toISOString();
  const facts = userFacts(db, now);
  const goals = facts.filter((f) => GOAL_PREDICATE.test(f.predicate) || GOAL_PREDICATE.test(f.subject));
  const formerGoals = safeAll<{ id: string; displayValue: string; updatedAt: string; predicate: string; subject: string }>(db,
    "SELECT id, displayValue, updatedAt, predicate, subject FROM memory_facts WHERE state IN ('historical', 'expired') AND forgottenAt IS NULL AND sensitivity != 'restricted' AND scopeType IN ('user', 'global') ORDER BY updatedAt DESC LIMIT 100")
    .filter((r) => GOAL_PREDICATE.test(r.predicate) || GOAL_PREDICATE.test(r.subject)).slice(0, 8)
    .map((r) => ({ id: r.id, value: r.displayValue, until: r.updatedAt }));

  const tasks = allTasks(db);
  const open = tasks.filter((t) => t.status !== 'done' && t.status !== 'cancelled');
  const dated: DatedItem[] = [];
  for (const t of open) if (t.dueAt && t.dueAt <= horizon) dated.push({ kind: 'task', ref: t.ref, title: t.title, dueAt: t.dueAt, detail: `${t.projectName}${t.status === 'blocked' ? ', blocked' : ''}`, source: 'user_stated', priority: t.priority ?? null, goal: t.goal ?? null });
  for (const c of safeAll<{ id: string; title: string; dueAt: string; channel: string; condition: string }>(db, "SELECT id, title, dueAt, channel, condition FROM commitments WHERE status = 'open' AND dueAt IS NOT NULL AND dueAt <= ?", [horizon])) {
    dated.push({ kind: 'commitment', ref: c.id, title: c.title, dueAt: c.dueAt, detail: `promise${c.condition !== 'none' ? ` (${c.condition})` : ''}`, source: 'user_stated' });
  }
  for (const r of safeAll<{ id: string; title: string; dueAt: string }>(db, "SELECT id, title, dueAt FROM everyday_reminders WHERE status IN ('scheduled', 'notified') AND dueAt <= ?", [horizon])) {
    dated.push({ kind: 'reminder', ref: r.id, title: r.title, dueAt: r.dueAt, detail: 'reminder', source: 'user_stated' });
  }
  for (const o of safeAll<{ id: string; title: string; nextDate: string; status: string; amountCents: number | null; currency: string | null; counterparty: string }>(db,
    "SELECT id, title, nextDate, status, amountCents, currency, counterparty FROM household_obligations WHERE status IN ('proposed', 'confirmed') AND nextDate IS NOT NULL AND nextDate <= ?", [horizon.slice(0, 10)])) {
    dated.push({ kind: 'obligation', ref: o.id, title: o.title, dueAt: o.nextDate.length === 10 ? `${o.nextDate}T23:59:00.000Z` : o.nextDate, detail: `${o.counterparty}${o.amountCents != null ? `, ${(o.amountCents / 100).toFixed(2)} ${o.currency ?? ''}`.trimEnd() : ''}`, source: o.status === 'confirmed' ? 'user_confirmed' : 'imported' });
  }
  dated.sort((a, b) => a.dueAt.localeCompare(b.dueAt));

  const completedTasks = tasks.filter((t) => t.status === 'done' && t.completedAt && t.completedAt >= since);
  const blockedTasks = open.filter((t) => t.status === 'blocked' || Boolean(t.blockedBy));
  const staleTasks = open.filter((t) => t.status === 'in_progress' && t.updatedAt && now.getTime() - new Date(t.updatedAt).getTime() > 14 * 86_400_000);

  // What Pandesh itself did. Only the main assistant's records (agentId NULL/chief); specialists keep their own.
  const journal = safeAll<{ invocationId: string; toolName: string; status: string; effect: string; summary: string; endedAt: string; conversationId: string | null }>(db,
    `SELECT invocationId, toolName, status, effect, summary, endedAt, conversationId FROM tool_execution_journal
      WHERE endedAt >= ? AND (agentId IS NULL OR agentId = 'chief') ORDER BY seq DESC LIMIT 400`, [since]);
  const consequential = (e: { effect: string }) => e.effect === 'created' || e.effect === 'modified' || e.effect === 'undone';
  const toItem = (e: typeof journal[number]): JournalItem => ({ invocationId: e.invocationId, toolName: e.toolName, status: e.status, effect: e.effect, summary: e.summary, at: e.endedAt, conversationId: e.conversationId });
  const pandeshCompleted = journal.filter((e) => consequential(e) && e.status === 'succeeded').map(toItem);
  const pandeshFailed = journal.filter((e) => consequential(e) && (e.status === 'failed' || e.status === 'denied')).map(toItem);
  const pendingApprovals = safeAll<{ id: string; kind: string; requestedAt: string; summary: string }>(db,
    "SELECT id, kind, requestedAt, summary FROM approvals WHERE status = 'pending' ORDER BY requestedAt DESC LIMIT 20")
    .map((a) => ({ ...a, summary: summarizeApproval(a.summary) }));

  const reversedDecisions = safeAll<{ id: string; displayValue: string; subject: string; predicate: string; scopeType: string; scopeId: string; updatedAt: string }>(db,
    "SELECT id, displayValue, subject, predicate, scopeType, scopeId, updatedAt FROM memory_facts WHERE state = 'historical' AND forgottenAt IS NULL AND sensitivity != 'restricted' AND updatedAt >= ? ORDER BY updatedAt DESC LIMIT 30", [new Date(now.getTime() - Math.max(windowDays, 30) * 86_400_000).toISOString()])
    .map((h) => {
      const current = db.get<{ id: string; displayValue: string }>("SELECT id, displayValue FROM memory_facts WHERE scopeType = ? AND scopeId = ? AND subject = ? AND predicate = ? AND state = 'active' ORDER BY createdAt DESC LIMIT 1", [h.scopeType, h.scopeId, h.subject, h.predicate]);
      return { oldId: h.id, oldValue: h.displayValue, newId: current?.id ?? null, newValue: current?.displayValue ?? null, subject: `${h.subject} ${h.predicate}`.trim(), at: h.updatedAt };
    });
  const openContradictions = safeAll<{ id: string; e: string; l: string; subject: string }>(db,
    `SELECT c.id AS id, a.displayValue AS e, b.displayValue AS l, a.subject AS subject FROM memory_contradictions c
       JOIN memory_facts a ON a.id = c.earlierMemoryId JOIN memory_facts b ON b.id = c.laterMemoryId
      WHERE c.state = 'unresolved' AND a.sensitivity != 'restricted' AND b.sensitivity != 'restricted' LIMIT 10`)
    .map((r) => ({ id: r.id, earlier: r.e, later: r.l, subject: r.subject }));

  return {
    now: now.toISOString(), windowDays, facts, goals, formerGoals, tasks, dated, completedTasks, blockedTasks, staleTasks,
    pandeshCompleted, pandeshFailed, pendingApprovals, reversedDecisions, openContradictions,
    coverage: ['remembered facts', 'Projects tasks', 'commitments', 'reminders', 'household obligations', "Pandesh's own tool journal", 'pending approvals'],
  };
}

function summarizeApproval(raw: string): string {
  try {
    const s = JSON.parse(raw) as Record<string, unknown>;
    return String(s.title ?? s.summary ?? s.toolName ?? s.action ?? s.kind ?? '').slice(0, 120) || 'approval';
  } catch { return String(raw ?? '').slice(0, 120); }
}

// ---------------------------------------------------------------------------------------------------------------------
// Prioritisation: declared importance + deadlines + blockers. Deterministic, explainable.
// ---------------------------------------------------------------------------------------------------------------------

export interface RankedItem { item: DatedItem | { kind: 'task'; ref: string; title: string; dueAt: string | null; detail: string; source: FactSourceClass; priority?: string | null; goal?: string | null }; score: number; reasons: string[] }

export function rankPriorities(state: PersonalState): RankedItem[] {
  const now = new Date(state.now).getTime();
  const goalText = state.goals.map((g) => `${g.subject} ${g.value}`.toLowerCase());
  const highGoals = state.goals.filter((g) => HIGH_IMPORTANCE.test(`${g.predicate} ${g.value}`)).map((g) => `${g.subject} ${g.value}`.toLowerCase());
  const matchesGoal = (title: string, goal?: string | null) => {
    const words = `${goal ?? ''} ${title}`.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 3);
    const hit = (list: string[]) => list.some((g) => words.some((w) => g.includes(w)));
    return { any: Boolean(goal) || hit(goalText), high: hit(highGoals) };
  };
  const seen = new Set<string>();
  const candidates: RankedItem['item'][] = [...state.dated];
  for (const t of state.tasks) if (t.status !== 'done' && t.status !== 'cancelled' && !state.dated.some((d) => d.ref === t.ref) && (t.priority === 'high' || t.goal)) {
    candidates.push({ kind: 'task', ref: t.ref, title: t.title, dueAt: t.dueAt ?? null, detail: t.projectName, source: 'user_stated', priority: t.priority ?? null, goal: t.goal ?? null });
  }
  const out: RankedItem[] = [];
  for (const item of candidates) {
    if (seen.has(item.ref)) continue;
    seen.add(item.ref);
    const blocked = state.blockedTasks.some((b) => b.ref === item.ref);
    if (blocked) continue;
    const reasons: string[] = [];
    let score = 0;
    if (item.dueAt) {
      const days = (new Date(item.dueAt).getTime() - now) / 86_400_000;
      if (days < 0) { score += 4; reasons.push(`overdue since ${item.dueAt.slice(0, 10)}`); }
      else if (days <= 1) { score += 3; reasons.push('due within a day'); }
      else if (days <= 3) { score += 2; reasons.push(`due ${item.dueAt.slice(0, 10)}`); }
      else if (days <= 7) { score += 1; reasons.push(`due ${item.dueAt.slice(0, 10)}`); }
    }
    if (item.priority === 'high') { score += 3; reasons.push('you marked it high priority'); }
    else if (item.priority === 'low') { score -= 1; reasons.push('you marked it low priority'); }
    const g = matchesGoal(item.title, item.goal);
    if (g.high) { score += 2; reasons.push('serves a goal you called top priority'); }
    else if (g.any) { score += 1; reasons.push('serves one of your stated goals'); }
    if (item.kind === 'commitment') { score += 1.5; reasons.push('a promise to someone'); }
    if (item.kind === 'obligation' && item.source === 'imported') reasons.push('found in a document/email, not confirmed by you');
    out.push({ item, score, reasons });
  }
  return out.sort((a, b) => b.score - a.score || (a.item.dueAt ?? '9999').localeCompare(b.item.dueAt ?? '9999'));
}

// ---------------------------------------------------------------------------------------------------------------------
// Overview (the personal_overview tool)
// ---------------------------------------------------------------------------------------------------------------------

export type OverviewFocus = 'all' | 'priorities' | 'due' | 'completed' | 'unfinished' | 'changes' | 'decisions' | 'about_me';

const d = (iso: string | null | undefined) => (iso ? iso.slice(0, 16).replace('T', ' ') : 'no date');

function datedLine(i: DatedItem, now: number): string {
  const late = new Date(i.dueAt).getTime() < now ? ' (OVERDUE)' : '';
  return `${i.kind} "${i.title}" — due ${i.dueAt.slice(0, 10)}${late}; ${i.detail}${i.source === 'imported' ? '; from a document/email, not confirmed by you' : ''} [${i.ref}]`;
}

export function personalOverview(db: CoreDatabase, opts: { focus?: OverviewFocus; days?: number; now?: Date } = {}): string {
  const focus = opts.focus ?? 'all';
  const state = collectPersonalState(db, { now: opts.now, windowDays: opts.days ?? 7 });
  const now = new Date(state.now).getTime();
  const want = (f: OverviewFocus) => focus === 'all' || focus === f;
  const out: string[] = [`PERSONAL OVERVIEW from Core records as of ${d(state.now)} (window: last ${state.windowDays} days, next 14 days). Every line ends with its record id. Sources read: ${state.coverage.join(', ')}. Calendar and email are not included here; use their own tools for those.`];

  if (want('about_me')) {
    out.push('\nABOUT YOU (remembered facts):');
    if (!state.facts.length) out.push('- nothing is remembered about you yet');
    for (const f of state.facts.slice(0, 25)) out.push(`- ${f.subject}${f.predicate && f.predicate !== f.subject ? ` (${f.predicate})` : ''}: ${f.value} — ${SOURCE_LABEL[f.source]}, since ${f.since.slice(0, 10)}${f.stale ? ', not updated for 6+ months: may be outdated' : ''}${f.conflict ? `; ${f.conflict}` : ''} [${f.id}]`);
  }
  if (want('priorities') || want('all')) {
    out.push('\nGOALS YOU STATED (current):');
    if (!state.goals.length) out.push('- none recorded. Priorities below come only from deadlines and task priorities you set.');
    for (const g of state.goals) out.push(`- ${g.subject}: ${g.value} — ${SOURCE_LABEL[g.source]} ${g.since.slice(0, 10)} [${g.id}]`);
    if (state.formerGoals.length) out.push(`Earlier goals no longer current: ${state.formerGoals.map((g) => `"${g.value}" (until ${g.until.slice(0, 10)}) [${g.id}]`).join('; ')}`);
    const ranked = rankPriorities(state).slice(0, 7);
    out.push('\nWHAT MATTERS NOW (ranked by: deadline, the priority you set, your stated goals, promises; blocked items excluded):');
    if (!ranked.length) out.push('- nothing has a deadline, a high priority or a goal link in the next 14 days');
    ranked.forEach((r, i) => out.push(`${i + 1}. ${r.item.kind} "${r.item.title}"${r.item.dueAt ? ` (due ${r.item.dueAt.slice(0, 10)})` : ''} — ${r.reasons.join(', ') || 'no deadline or declared priority'} [${r.item.ref}]`));
  }
  if (want('due')) {
    out.push('\nDUE / OVERDUE (next 14 days):');
    if (!state.dated.length) out.push('- nothing with a date');
    for (const i of state.dated) out.push(`- ${datedLine(i, now)}`);
    const sameDay = new Map<string, DatedItem[]>();
    for (const i of state.dated) { const k = i.dueAt.slice(0, 10); sameDay.set(k, [...(sameDay.get(k) ?? []), i]); }
    const clashes = [...sameDay.entries()].filter(([, v]) => v.length >= 2);
    if (clashes.length) out.push(`CONFLICTS (several deadlines on one day): ${clashes.map(([day, v]) => `${day}: ${v.map((i) => `"${i.title}" [${i.ref}]`).join(' + ')}`).join('; ')}`);
  }
  if (want('unfinished')) {
    out.push('\nUNFINISHED:');
    if (state.blockedTasks.length) out.push(`Blocked: ${state.blockedTasks.map((t) => formatTask(t)).join('; ')}`);
    if (state.staleTasks.length) out.push(`In progress but untouched for 14+ days (possibly neglected): ${state.staleTasks.map((t) => formatTask(t)).join('; ')}`);
    const openPromises = safeAll<{ id: string; title: string; dueAt: string | null; createdAt: string }>(db, "SELECT id, title, dueAt, createdAt FROM commitments WHERE status = 'open' ORDER BY COALESCE(dueAt, createdAt) LIMIT 20");
    if (openPromises.length) out.push(`Open promises: ${openPromises.map((c) => `"${c.title}"${c.dueAt ? ` due ${c.dueAt.slice(0, 10)}` : ''} [${c.id}]`).join('; ')}`);
    if (state.pandeshFailed.length) out.push(`Actions Pandesh attempted that FAILED (not done): ${state.pandeshFailed.slice(0, 10).map((e) => `${e.toolName} at ${d(e.at)}: ${e.summary} [${e.invocationId}]`).join('; ')}`);
    if (state.pendingApprovals.length) out.push(`Waiting for your approval: ${state.pendingApprovals.map((a) => `${a.kind} "${a.summary}" since ${d(a.requestedAt)} [${a.id}]`).join('; ')}`);
    if (!state.blockedTasks.length && !state.staleTasks.length && !openPromises.length && !state.pandeshFailed.length && !state.pendingApprovals.length) out.push('- nothing recorded as blocked, stalled, promised, failed or waiting');
  }
  if (want('completed')) {
    out.push(`\nCOMPLETED in the last ${state.windowDays} days:`);
    if (state.completedTasks.length) out.push(`Your tasks marked done: ${state.completedTasks.map((t) => `"${t.title}" (${d(t.completedAt)}) [${t.ref}]`).join('; ')}`);
    if (state.pandeshCompleted.length) out.push(`What Pandesh actually did (verified tool records): ${state.pandeshCompleted.slice(0, 15).map((e) => `${e.toolName}: ${e.summary} (${d(e.at)}) [${e.invocationId}]`).join('; ')}`);
    if (!state.completedTasks.length && !state.pandeshCompleted.length) out.push('- nothing recorded as completed');
    // "What did you finish?" must not hide what was attempted and did not happen.
    if (focus === 'completed' && state.pandeshFailed.length) out.push(`Attempted but FAILED (not done): ${state.pandeshFailed.slice(0, 10).map((e) => `${e.toolName} at ${d(e.at)}: ${e.summary} [${e.invocationId}]`).join('; ')}`);
    if (focus === 'completed' && state.pendingApprovals.length) out.push(`Not done yet, waiting for your approval: ${state.pendingApprovals.map((a) => `${a.kind} "${a.summary}" [${a.id}]`).join('; ')}`);
  }
  if (want('changes') || want('decisions')) {
    out.push('\nDECISIONS AND FACTS THAT CHANGED:');
    if (state.reversedDecisions.length) for (const r of state.reversedDecisions.slice(0, 10)) out.push(`- ${r.subject}: was "${r.oldValue}" [${r.oldId}], ${r.newValue ? `now "${r.newValue}" [${r.newId}]` : 'no longer current'} (changed ${r.at.slice(0, 10)})`);
    else out.push('- no remembered decision or fact was corrected or superseded recently');
    if (state.openContradictions.length) out.push(`UNRESOLVED CONTRADICTIONS (ask the user which is right): ${state.openContradictions.map((c) => `${c.subject}: "${c.earlier}" vs "${c.later}" [${c.id}]`).join('; ')}`);
  }
  out.push('\nAnything not listed here is not recorded in Core: say so instead of guessing.');
  return out.join('\n');
}

// ---------------------------------------------------------------------------------------------------------------------
// The per-turn section
// ---------------------------------------------------------------------------------------------------------------------

const PLANNING_WORDS = /\b(?:priorit\w*|focus|today|tomorrow|this week|next week|deadline\w*|due|overdue|neglect\w*|plan\w*|schedule|what should i|what next|work on|busy|agenda|todo|to-do|tasks?|goals?|promis\w*|commit\w*|unfinished|finish\w*|complete\w*|done|ready|progress|changed|decid\w*|decision\w*|reversed?|recommend\w*|remind\w*|bills?|pay\w*)\b/i;
const PERSONAL_WORDS = /\b(?:i|i'm|i've|my|me|mine|myself|we|our|us)\b/i;
const STOP = new Set(['what', 'which', 'when', 'where', 'who', 'how', 'the', 'and', 'for', 'with', 'that', 'this', 'have', 'from', 'your', 'you', 'are', 'was', 'were', 'about', 'should', 'would', 'could', 'please', 'tell', 'show', 'give', 'make', 'need', 'want', 'know', 'there', 'their', 'them', 'they', 'does', 'did', 'done', 'into', 'some', 'any']);

export interface PersonalContextOptions {
  message: string;
  agentId?: string | null;
  localModel: boolean;
  now?: Date;
  maxChars?: number;
}

export interface PersonalContextResult { section: string; facts: number; dated: number; withheld: boolean; chars: number }

/**
 * The block the main assistant gets with a user message. Empty for specialists. For a non-local model only a one-line
 * notice (no personal content). Relevance-gated: facts are chosen by overlap with the message (plus a few stable
 * identity facts when the message is personal), and the deadline/goal lines appear only for planning-type messages.
 */
export function buildPersonalContextSection(db: CoreDatabase, opts: PersonalContextOptions): PersonalContextResult {
  const empty = { section: '', facts: 0, dated: 0, withheld: false, chars: 0 };
  if (opts.agentId && opts.agentId !== 'chief') return empty;
  const msg = String(opts.message ?? '');
  const planning = PLANNING_WORDS.test(msg);
  const personal = PERSONAL_WORDS.test(msg) || planning;
  if (!personal) return empty;
  let state: PersonalState;
  try { state = collectPersonalState(db, { now: opts.now }); } catch { return empty; }
  const hasAnything = state.facts.length || state.dated.length || state.goals.length || state.pandeshFailed.length || state.pendingApprovals.length;
  if (!hasAnything) return empty;
  if (!opts.localModel) {
    const section = "PERSONAL RECORDS: Core holds remembered facts, goals and deadlines for this user, but they are withheld from this model because it does not run on this PC. Do not guess personal details; say they are available with a local model.";
    return { section, facts: 0, dated: 0, withheld: true, chars: section.length };
  }
  const max = opts.maxChars ?? 1800;
  const words = msg.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2 && !STOP.has(w));
  const relevance = (f: PersonalFact) => words.filter((w) => `${f.subject} ${f.predicate} ${f.value}`.toLowerCase().includes(w)).length;
  const scored = state.facts.map((f) => ({ f, r: relevance(f) })).filter((x) => x.r > 0).sort((a, b) => b.r - a.r).map((x) => x.f);
  const identity = state.facts.filter((f) => IDENTITY_PREDICATE.test(`${f.subject} ${f.predicate}`) && !scored.includes(f)).slice(0, 4);
  const goalFacts = planning ? state.goals.filter((g) => !scored.includes(g) && !identity.includes(g)) : [];
  const chosen = [...scored.slice(0, 8), ...identity, ...goalFacts.slice(0, 5)];
  const lines: string[] = [];
  const factLine = (f: PersonalFact) => `- ${f.subject}${f.predicate && !/^(?:preference_or_fact|fact|value)$/.test(f.predicate) ? ` (${f.predicate})` : ''}: ${f.value} [${SOURCE_LABEL[f.source]}, ${f.since.slice(0, 10)}${f.stale ? ', may be outdated' : ''}${f.conflict ? `, ${f.conflict}` : ''}; ${f.id}]`;
  for (const f of chosen) lines.push(factLine(f));
  let datedCount = 0;
  if (planning) {
    const now = new Date(state.now).getTime();
    const ranked = rankPriorities(state).slice(0, 5);
    if (ranked.length) {
      lines.push('Ranked by deadline, your declared priority and goals (call personal_overview for the full, evidence-linked list):');
      ranked.forEach((r, i) => lines.push(`  ${i + 1}. ${r.item.kind} "${r.item.title}"${r.item.dueAt ? ` due ${r.item.dueAt.slice(0, 10)}${new Date(r.item.dueAt).getTime() < now ? ' OVERDUE' : ''}` : ''} — ${r.reasons.join(', ')} [${r.item.ref}]`));
      datedCount = ranked.length;
    }
    if (state.blockedTasks.length) lines.push(`Blocked (cannot move until the blocker clears): ${state.blockedTasks.slice(0, 4).map((t) => `"${t.title}" by ${t.blockedBy ?? 'unknown'} [${t.ref}]`).join('; ')}`);
    // Live check (gemma4:12b): "What am I neglecting?" was answered with upcoming deadlines only, because stalled work
    // was not in front of the model. Neglect = in progress but untouched for 14+ days, plus open promises past due.
    if (state.staleTasks.length) lines.push(`Possibly neglected (in progress, untouched for 14+ days): ${state.staleTasks.slice(0, 4).map((t) => `"${t.title}" (last change ${String(t.updatedAt ?? '').slice(0, 10)}) [${t.ref}]`).join('; ')}`);
    if (state.pandeshFailed.length) lines.push(`Pandesh actions that failed recently (NOT done): ${state.pandeshFailed.slice(0, 3).map((e) => `${e.toolName}: ${e.summary} [${e.invocationId}]`).join('; ')}`);
    if (state.pendingApprovals.length) lines.push(`Waiting for the user's approval: ${state.pendingApprovals.length}`);
  }
  if (state.openContradictions.length && chosen.some((f) => f.conflict)) lines.push('Some facts above conflict: ask the user which is right before relying on them.');
  if (!lines.length) return empty;
  const header = 'WHAT PANDESH KNOWS ABOUT THE USER (Core records; each line shows where it came from and its id). Use these instead of asking again. Anything personal that is not here or in a tool result is unknown: say so, never guess. Only items marked "you told me"/"you confirmed" are confirmed; "inference" and "from a document" are not.';
  let section = `${header}\n${lines.join('\n')}`;
  if (section.length > max) section = `${section.slice(0, max - 40)}\n… (more: call personal_overview)`;
  return { section, facts: chosen.length, dated: datedCount, withheld: false, chars: section.length };
}

export type { MemoryFactRecord };
