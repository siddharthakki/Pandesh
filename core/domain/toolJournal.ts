import * as path from 'node:path';
import type { CoreDatabase } from '../db/connection';
import { redactSecrets } from '../security/securityJournal';
import { projectEventArguments } from './eventArguments';

/**
 * Tool execution journal: Core's durable, structured record of what each tool call actually did, keyed by the tool
 * invocation that ran it.
 *
 * Why it exists (P0, Builds 163/164): the next turn's model context was rebuilt from `conversation_messages`, which
 * holds only user and assistant prose. A tool result (a plan id, a reminder id, a file path, a delegated agent's
 * answer) reached a later turn only if the model happened to repeat it in its reply. `tool_invocations.evidence` kept a
 * 500-character excerpt for audit, but nothing read it back into a model's context, nothing linked it to the
 * conversation or the agent that ran it, and nothing extracted the identifiers a follow-up needs.
 *
 * The journal fixes that in the shared architecture, not per tool:
 *   - `recordJournalEntry` runs inside `completeToolInvocation`, so every engine that records a tool invocation feeds
 *     it (Pi, the Core-initiated `coreRunTool` path, the executor, bridged capabilities).
 *   - Identifiers and file paths are extracted deterministically from the arguments, the structured details and the
 *     result text, and stored as typed references with the effect the call had on them (created / modified / undone
 *     / read / target).
 *   - `buildJournalContext` gives the next turn a bounded section: the latest item of each kind with its current
 *     state, the recent actions, and, for references the user makes ("that plan", "undo that"), the record Core
 *     resolved them to — or the candidates when the reference is ambiguous.
 *   - `recallJournal` returns the complete persisted record on demand (the model's `recall_execution` tool), so a
 *     follow-up question about a document that was read three turns ago is answered from what the tool returned, not
 *     from memory of the assistant's prose.
 *
 * Isolation: every read is scoped to one conversation AND one agent (`agentId` NULL = the main assistant). A record
 * from another conversation or another agent is never rendered and never recalled; asking for it by id is answered
 * "not accessible here". Results of private tools (mail, calendar, memory, documents, money) are marked `private` and
 * their content is rendered only for a local model.
 */

export type JournalEffect = 'created' | 'modified' | 'undone' | 'read' | 'other';
export type RefRole = 'created' | 'modified' | 'undone' | 'read' | 'target' | 'listed' | 'delegated';

export interface JournalRef {
  kind: string;
  id: string;
  role: RefRole;
  label?: string;
}

export interface JournalEntry {
  seq: number;
  invocationId: string;
  conversationId: string | null;
  requestId: string | null;
  attemptId: string;
  agentId: string | null;
  toolName: string;
  args: Record<string, unknown>;
  status: string;
  effect: JournalEffect;
  summary: string;
  resultText: string;
  refs: JournalRef[];
  artifactIds: string[];
  sensitivity: 'normal' | 'private';
  startedAt: string;
  endedAt: string;
}

/** Complete result text kept per call. Bounded: this is evidence, not a blob store. */
const MAX_RESULT_CHARS = 32_000;
const MAX_SUMMARY_CHARS = 240;
const MAX_REFS = 24;

/** Core plumbing ids that say nothing about the user's work. */
const PLUMBING_PREFIXES = new Set(['tinv', 'att', 'req', 'conv', 'msg', 'minv', 'evt', 'corr', 'appr', 'ckpt', 'ctx', 'loc', 'ws', 'wscmd', 'cmdq', 'cmdconf', 'notif', 'rappr', 'sauth', 'x']);

/** Id prefix → the noun a user would use for it. Unknown prefixes keep the prefix as the kind. */
const KIND_BY_PREFIX: Record<string, string> = {
  reminder: 'reminder',
  note: 'note',
  orgplan: 'plan',
  gplan: 'plan',
  sched: 'schedule',
  artifact: 'artifact',
  hof: 'delegation',
  commitment: 'commitment',
  wish: 'wish',
  proj: 'project',
  mem: 'memory',
  bgtask: 'task',
  story: 'story',
  sdr: 'draft',
  oblig: 'obligation',
  research: 'research',
};

const ID_PATTERN = /\b([a-z][a-z0-9]{0,15})_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/g;

const PATH_ARG_KEYS = /^(?:path|filePath|file|filename|outputPath|targetPath|destination|output|absolutePath|savedTo|pdfPath|documentPath)$/;

/** Private tools: results that must never be rendered to a non-local model. Content stays in the local DB. */
const PRIVATE_TOOLS = /^(?:gmail_|calendar_|memory_|household_|document_read|document_ocr|read_file|read_file_outside_workspace|revenue_|record_wish_money|get_briefing_data|github_read_issue)/;

/** What a call did, from its name. Deterministic and tool-agnostic; unknown tools are 'other'. */
export function classifyEffect(toolName: string): JournalEffect {
  const t = toolName.toLowerCase();
  if (/undo|revert|restore/.test(t)) return 'undone';
  if (/^(?:update_|edit_|apply_|dismiss_|cancel_|delete_|memory_correct|memory_forget|routine_control|system_(?:stop|start|kill|set)_|port_stop|port_cleanup|scout_(?:pause|remove)|dev_story_(?:approve|reassign|retry)|household_obligation_update|advance_wish|update_wish)|_apply(?:_plan)?$|_update(?:_event)?$|_delete(?:_event)?$/.test(t)) return 'modified';
  if (/^(?:create_|write_file|schedule_task|routine_create|propose_|export_|image_generate|video_generate|comfyui_generate|media_create|media_download|build_wish|scout_add|delegate_to|dev_stories_plan|dev_stories_dispatch|declare_execution_plan|memory_remember|send_to_phone|revenue_record|wish_create|wish_order|wish_record|record_wish|wish_prepare|port_allocate|gmail_create_|gmail_plan_changes|calendar_(?:create|draft)_|pc_organize_scan|household_scan|print_test_page|jugaad_send|ollama_pull|connect_network_drive)/.test(t)) return 'created';
  if (/^(?:read|list|get|search|find|recall|inspect|document_|browser_read|governed_research|web_research|software_updates|listening_ports|system_(?:list|hardware)|pc_capability|pc_organize_plan|execution_plan_status|wish_status|routine_list|dev_stories_status|scout_list|resolve_time|calculate|memory_(?:recall|export|impact)|household_obligations|github_read|calendar_list|calendar_check|gmail_(?:search|read|analyze|task_status))/.test(t)) return 'read';
  return 'other';
}

function clip(text: string, max: number): string {
  const s = text.replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function safeJson(value: unknown): string {
  try { return JSON.stringify(value ?? {}); } catch { return '{}'; }
}

function labelFrom(args: Record<string, unknown>, resultText: string): string | undefined {
  for (const key of ['title', 'name', 'subject', 'label', 'objective']) {
    const v = args[key];
    if (typeof v === 'string' && v.trim()) return clip(v, 80);
  }
  const quoted = resultText.match(/"([^"\n]{2,80})"/);
  return quoted ? quoted[1] : undefined;
}

function collectIds(value: unknown, into: Set<string>): void {
  const text = typeof value === 'string' ? value : safeJson(value);
  for (const m of text.matchAll(ID_PATTERN)) {
    if (!PLUMBING_PREFIXES.has(m[1])) into.add(m[0]);
  }
}

function collectPaths(value: unknown, into: Set<string>, depth = 0): void {
  if (!value || typeof value !== 'object' || depth > 3) return;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'string' && PATH_ARG_KEYS.test(k) && v.trim() && v.length < 1024 && /[\\/.]/.test(v)) into.add(v.trim());
    else if (v && typeof v === 'object') collectPaths(v, into, depth + 1);
  }
}

export function kindOfId(id: string): string {
  const prefix = id.slice(0, id.indexOf('_'));
  return KIND_BY_PREFIX[prefix] ?? prefix;
}

/** Deterministic reference extraction from what the call was given and what it returned. */
export function extractRefs(input: { toolName: string; args: Record<string, unknown>; resultText: string; details?: unknown; effect: JournalEffect; status: string }): JournalRef[] {
  const refs: JournalRef[] = [];
  const seen = new Set<string>();
  const push = (r: JournalRef) => {
    const key = `${r.kind}:${r.id}`;
    if (seen.has(key) || refs.length >= MAX_REFS) return;
    seen.add(key);
    refs.push(r);
  };
  const succeeded = input.status === 'succeeded';
  const label = labelFrom(input.args, input.resultText);

  const argIds = new Set<string>();
  collectIds(input.args, argIds);
  for (const id of argIds) push({ kind: kindOfId(id), id, role: 'target' });

  const resultIds = new Set<string>();
  collectIds(input.resultText, resultIds);
  if (input.details !== undefined) collectIds(input.details, resultIds);
  const isDelegation = /^delegate_to/.test(input.toolName);
  const roleForResult: RefRole = isDelegation ? 'delegated'
    : !succeeded ? 'listed'
      : input.effect === 'created' ? 'created'
        : input.effect === 'modified' ? 'modified'
          : input.effect === 'undone' ? 'undone'
            : input.effect === 'read' ? 'listed' : 'listed';
  // A create call names one new thing; any further ids in its result are what it mentions.
  let primaryAssigned = false;
  for (const id of resultIds) {
    if (argIds.has(id)) continue;
    const role: RefRole = roleForResult === 'created' && primaryAssigned ? 'listed' : roleForResult;
    if (role === 'created') primaryAssigned = true;
    push({ kind: kindOfId(id), id, role, ...(role === 'created' && label ? { label } : {}) });
  }

  const paths = new Set<string>();
  collectPaths(input.args, paths);
  if (input.details && typeof input.details === 'object') collectPaths(input.details, paths);
  const fileRole: RefRole = !succeeded ? 'target'
    : input.effect === 'read' ? 'read'
      : input.effect === 'created' ? 'created'
        : input.effect === 'modified' ? 'modified'
          : input.effect === 'undone' ? 'undone' : 'target';
  for (const p of paths) {
    const kind = /\.(?:md|txt|pdf|docx?|rtf|odt|csv|xlsx?|pptx?|json|html?)$/i.test(p) ? 'document' : 'file';
    push({ kind, id: p, role: fileRole, label: path.basename(p) });
  }
  return refs;
}

function rowToEntry(row: Record<string, unknown>): JournalEntry {
  const parse = <T>(s: unknown, fallback: T): T => { try { return JSON.parse(String(s ?? '')) as T; } catch { return fallback; } };
  return {
    seq: Number(row.seq),
    invocationId: String(row.invocationId),
    conversationId: (row.conversationId as string) ?? null,
    requestId: (row.requestId as string) ?? null,
    attemptId: String(row.attemptId),
    agentId: (row.agentId as string) ?? null,
    toolName: String(row.toolName),
    args: parse(row.argsJson, {}),
    status: String(row.status),
    effect: row.effect as JournalEffect,
    summary: String(row.summary ?? ''),
    resultText: String(row.resultText ?? ''),
    refs: parse(row.refsJson, []),
    artifactIds: parse(row.artifactIdsJson, []),
    sensitivity: row.sensitivity === 'private' ? 'private' : 'normal',
    startedAt: String(row.startedAt),
    endedAt: String(row.endedAt),
  };
}

interface AttemptScope { requestId: string | null; conversationId: string | null; agentId: string | null }

function scopeOfAttempt(db: CoreDatabase, attemptId: string): AttemptScope {
  const row = db.get<{ requestId: string; conversationId: string | null }>(
    'SELECT a.requestId AS requestId, r.conversationId AS conversationId FROM attempts a LEFT JOIN requests r ON r.id = a.requestId WHERE a.id = ?',
    [attemptId],
  );
  if (!row) return { requestId: null, conversationId: null, agentId: null };
  let agentId: string | null = null;
  try {
    agentId = db.get<{ agentId: string }>('SELECT agentId FROM agent_runs WHERE requestId = ?', [row.requestId])?.agentId ?? null;
  } catch { /* agent_runs absent in a very old schema */ }
  return { requestId: row.requestId, conversationId: row.conversationId ?? null, agentId };
}

/** The agent an attempt runs as (NULL = the main assistant): the journal scope a turn may read. */
export function journalAgentForAttempt(db: CoreDatabase, attemptId: string): string | null {
  return scopeOfAttempt(db, attemptId).agentId;
}

export interface RecordJournalInput {
  invocationId: string;
  attemptId: string;
  toolName: string;
  args: Record<string, unknown>;
  status: string;
  resultText: string;
  details?: unknown;
  startedAt: string;
  endedAt: string;
}

/**
 * Writes the journal row for one completed tool invocation. Never throws: the journal is derived evidence and must
 * not fail the tool call it describes (the authoritative row is `tool_invocations`).
 */
export function recordJournalEntry(db: CoreDatabase, input: RecordJournalInput): void {
  try {
    const scope = scopeOfAttempt(db, input.attemptId);
    const effect = classifyEffect(input.toolName);
    const sanitizedArgs = projectEventArguments(redactSecrets(input.args ?? {}) as Record<string, unknown>);
    const resultText = String(redactSecrets(input.resultText ?? '') ?? '').slice(0, MAX_RESULT_CHARS);
    const refs = extractRefs({ toolName: input.toolName, args: input.args ?? {}, resultText: input.resultText ?? '', details: input.details, effect, status: input.status });
    // Delegation: the child's own created/modified records travel up as references (ids only, never its content).
    const childAttemptId = (input.details as { childAttemptId?: unknown } | undefined)?.childAttemptId;
    if (typeof childAttemptId === 'string') {
      for (const child of listEntriesForAttempt(db, childAttemptId)) {
        if (child.status !== 'succeeded') continue;
        for (const r of child.refs) {
          if ((r.role === 'created' || r.role === 'modified' || r.role === 'undone') && refs.length < MAX_REFS && !refs.some((x) => x.id === r.id)) {
            refs.push({ ...r, role: 'delegated' });
          }
        }
      }
    }
    let artifactIds: string[] = [];
    try {
      artifactIds = db.all<{ id: string }>('SELECT id FROM artifacts WHERE attemptId = ? AND createdAt >= ? AND createdAt <= ? ORDER BY createdAt ASC', [input.attemptId, input.startedAt, input.endedAt]).map((r) => r.id);
    } catch { /* artifacts table absent */ }
    for (const id of artifactIds) if (!refs.some((r) => r.id === id) && refs.length < MAX_REFS) refs.push({ kind: 'artifact', id, role: input.status === 'succeeded' ? 'created' : 'listed' });
    const firstLine = resultText.split('\n').find((l) => l.trim()) ?? '';
    db.run(
      `INSERT OR REPLACE INTO tool_execution_journal
        (invocationId, conversationId, requestId, attemptId, agentId, toolName, argsJson, status, effect, summary, resultText, refsJson, artifactIdsJson, sensitivity, startedAt, endedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.invocationId, scope.conversationId, scope.requestId, input.attemptId, scope.agentId, input.toolName,
        safeJson(sanitizedArgs), input.status, effect, clip(firstLine, MAX_SUMMARY_CHARS), resultText, safeJson(refs), safeJson(artifactIds),
        PRIVATE_TOOLS.test(input.toolName) ? 'private' : 'normal', input.startedAt, input.endedAt,
      ],
    );
  } catch (err) {
    console.warn('[toolJournal] could not record entry:', err instanceof Error ? err.message : String(err));
  }
}

export function listEntriesForAttempt(db: CoreDatabase, attemptId: string): JournalEntry[] {
  try {
    return db.all<Record<string, unknown>>('SELECT * FROM tool_execution_journal WHERE attemptId = ? ORDER BY seq ASC', [attemptId]).map(rowToEntry);
  } catch { return []; }
}

/**
 * Upgrade path: tool invocations recorded before the journal existed (Builds ≤ 164) are journaled from their stored
 * evidence (a 500-character excerpt) the first time their conversation is read, so a conversation started on an older
 * build keeps the ids its tools returned.
 */
export function backfillConversationJournal(db: CoreDatabase, conversationId: string): number {
  try {
    const rows = db.all<Record<string, unknown>>(
      `SELECT ti.* FROM tool_invocations ti
         JOIN attempts a ON a.id = ti.attemptId
         JOIN requests r ON r.id = a.requestId
        WHERE r.conversationId = ? AND ti.status != 'pending'
          AND NOT EXISTS (SELECT 1 FROM tool_execution_journal j WHERE j.invocationId = ti.id)
        ORDER BY ti.startedAt ASC LIMIT 500`,
      [conversationId],
    );
    for (const row of rows) {
      let args: Record<string, unknown> = {};
      let evidence: Record<string, unknown> = {};
      try { args = JSON.parse(String(row.argsSummary ?? '{}')); } catch { /* keep empty */ }
      try { evidence = JSON.parse(String(row.evidence ?? '{}')); } catch { /* keep empty */ }
      recordJournalEntry(db, {
        invocationId: String(row.id), attemptId: String(row.attemptId), toolName: String(row.toolName), args,
        status: String(row.status), resultText: String(evidence.output ?? ''), startedAt: String(row.startedAt), endedAt: String(row.endedAt ?? row.startedAt),
      });
    }
    return rows.length;
  } catch { return 0; }
}

export interface JournalScope {
  conversationId: string;
  /** NULL = the main assistant. A specialist only ever sees its own records. */
  agentId: string | null;
}

export function listConversationEntries(db: CoreDatabase, scope: JournalScope, options: { excludeAttemptId?: string; limit?: number } = {}): JournalEntry[] {
  try {
    const rows = db.all<Record<string, unknown>>(
      `SELECT * FROM tool_execution_journal
        WHERE conversationId = ? AND ${scope.agentId === null ? 'agentId IS NULL' : 'agentId = ?'} ${options.excludeAttemptId ? 'AND attemptId != ?' : ''}
        ORDER BY seq DESC LIMIT ?`,
      [scope.conversationId, ...(scope.agentId === null ? [] : [scope.agentId]), ...(options.excludeAttemptId ? [options.excludeAttemptId] : []), options.limit ?? 400],
    );
    return rows.map(rowToEntry).reverse();
  } catch { return []; }
}

// ---------------------------------------------------------------------------------------------------------------
// Active task state: the latest item of each kind and what has happened to it since. Derived deterministically from
// the journal on every read, so it can never drift from what actually ran.
// ---------------------------------------------------------------------------------------------------------------

export interface ActiveItem {
  kind: string;
  id: string;
  label?: string;
  /** created / modified / undone / read / delegated: the latest thing that happened to it. */
  state: RefRole;
  bySeq: number;
  byTool: string;
  /** The turn (attempt) that last touched it: two items touched in one turn are equally "that one". */
  byAttempt: string;
  invocationId: string;
  at: string;
  createdIn: { invocationId: string; toolName: string } | null;
}

export function activeItems(entries: JournalEntry[]): ActiveItem[] {
  const items = new Map<string, ActiveItem>();
  for (const e of entries) {
    if (e.status !== 'succeeded') continue;
    for (const r of e.refs) {
      if (r.role === 'listed') continue;
      const key = `${r.kind}:${r.id}`;
      const prev = items.get(key);
      const state: RefRole = r.role === 'target' ? (e.effect === 'read' || e.effect === 'other' ? 'read' : e.effect as RefRole) : r.role;
      items.set(key, {
        kind: r.kind, id: r.id, label: r.label ?? prev?.label, state, bySeq: e.seq, byTool: e.toolName, byAttempt: e.attemptId, invocationId: e.invocationId, at: e.endedAt,
        createdIn: prev?.createdIn ?? (r.role === 'created' || r.role === 'delegated' ? { invocationId: e.invocationId, toolName: e.toolName } : null),
      });
    }
  }
  return [...items.values()].sort((a, b) => a.bySeq - b.bySeq);
}

// ---------------------------------------------------------------------------------------------------------------
// Reference resolution: "that plan", "the file you created", "undo that", "continue the previous task".
// ---------------------------------------------------------------------------------------------------------------

const KIND_WORDS: Array<{ kind: string[]; words: RegExp }> = [
  { kind: ['plan'], words: /\b(?:plan|plans)\b/i },
  { kind: ['reminder'], words: /\breminders?\b/i },
  { kind: ['note'], words: /\bnotes?\b/i },
  { kind: ['schedule'], words: /\b(?:schedules?|scheduled task|routine)\b/i },
  { kind: ['document', 'file', 'artifact'], words: /\b(?:file|files|document|doc|pdf|report|spreadsheet)\b/i },
  { kind: ['artifact'], words: /\b(?:image|picture|video|artifact)\b/i },
  { kind: ['draft'], words: /\bdrafts?\b/i },
  { kind: ['delegation'], words: /\b(?:agent|specialist|delegat\w*)\b/i },
  { kind: ['commitment'], words: /\bcommitments?\b/i },
  { kind: ['project'], words: /\bprojects?\b/i },
];

/** A pointer at something earlier, as opposed to a fresh request that merely names a kind. */
const REFERENCE_CUE = /\b(?:that|this|it|those|these|the same|the last|the previous|the latest|the one|earlier|before|you (?:just )?(?:created|made|wrote|saved|set|scheduled|read|opened|found|generated|did|returned|proposed)|from (?:before|earlier))\b/i;
const UNDO_CUE = /\b(?:undo|revert|roll ?back|reverse|take (?:that|it) back)\b/i;
const CONTINUE_CUE = /\b(?:continue|carry on|resume|pick up|keep going)\b.*\b(?:task|work|that|it|where|previous|last)\b|\bcontinue\b\s*$/i;
const ACTION_CUE = /\b(?:undo|revert|apply|update|change|edit|rename|delete|remove|cancel|dismiss|move|send|run|execute|approve|finish|complete|pause|resume|stop)\b/i;

const STOP_WORDS = new Set(['the', 'that', 'this', 'plan', 'note', 'file', 'reminder', 'document', 'please', 'for', 'and', 'with', 'from', 'into', 'about', 'one', 'you', 'created', 'made', 'update', 'change', 'apply', 'undo']);

function tokens(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9äöüß]{3,}/g) ?? []).filter((t) => !STOP_WORDS.has(t));
}

export type ReferenceResolution =
  | { status: 'none' }
  | { status: 'resolved'; cue: string; item: ActiveItem; reason: string }
  | { status: 'ambiguous'; cue: string; candidates: ActiveItem[]; action: boolean }
  | { status: 'inaccessible'; ids: string[] };

/**
 * Resolves what the user's message points at against the verified journal of THIS conversation and agent. Never
 * guesses: when two items fit equally well the result is 'ambiguous' with both candidates.
 */
export function resolveReference(message: string, entries: JournalEntry[], foreignIds: string[] = []): ReferenceResolution {
  if (foreignIds.length) return { status: 'inaccessible', ids: foreignIds };
  const items = activeItems(entries);
  if (!items.length) return { status: 'none' };
  const text = message.trim();
  const isUndo = UNDO_CUE.test(text);
  const isContinue = CONTINUE_CUE.test(text);
  const kindHit = KIND_WORDS.find((k) => k.words.test(text));
  if (!isUndo && !isContinue && !(kindHit && REFERENCE_CUE.test(text))) return { status: 'none' };
  const action = isUndo || ACTION_CUE.test(text);

  let pool: ActiveItem[];
  let cue: string;
  if (kindHit) {
    pool = items.filter((i) => kindHit.kind.includes(i.kind));
    cue = kindHit.kind[0];
    if (isUndo) pool = pool.filter((i) => i.state !== 'undone' && i.state !== 'read');
  } else if (isUndo) {
    // "Undo that": the most recent change Core recorded that has not been undone already.
    pool = items.filter((i) => i.state === 'created' || i.state === 'modified' || i.state === 'delegated');
    cue = 'undo';
  } else {
    pool = items.filter((i) => i.state !== 'read');
    cue = 'continue';
  }
  if (!pool.length) return { status: 'none' };

  // A distinguishing word in the message ("the Downloads plan", "the 2026 budget note") narrows the pool first.
  const words = new Set(tokens(text));
  const scored = pool.map((i) => ({ i, score: tokens(`${i.label ?? ''} ${path.basename(i.id)}`).filter((t) => words.has(t)).length }));
  const best = Math.max(...scored.map((s) => s.score));
  if (best > 0) {
    const top = scored.filter((s) => s.score === best).map((s) => s.i);
    if (top.length === 1) return { status: 'resolved', cue, item: top[0], reason: 'named in the message' };
    pool = top;
  }
  // Otherwise the most recent item wins only when it is the only one its turn touched; two items made or changed in
  // the same turn ("set two reminders", then "dismiss that reminder") are a genuine ambiguity.
  const latestSeq = Math.max(...pool.map((i) => i.bySeq));
  const latestAttempt = pool.find((i) => i.bySeq === latestSeq)!.byAttempt;
  const latest = pool.filter((i) => i.byAttempt === latestAttempt);
  if (latest.length === 1) {
    // The newest record wins over older ones of the same kind, unless the older ones carry the same label (two
    // similarly named items): then Core asks.
    const sameLabel = latest[0].label ? pool.filter((i) => i !== latest[0] && i.label && i.label.toLowerCase() === latest[0].label!.toLowerCase()) : [];
    if (sameLabel.length) return { status: 'ambiguous', cue, candidates: [latest[0], ...sameLabel].slice(0, 6), action };
    return { status: 'resolved', cue, item: latest[0], reason: 'the most recent one recorded' };
  }
  return { status: 'ambiguous', cue, candidates: latest.slice(0, 6), action };
}

/** Ids the user typed that exist in Core's journal but outside this conversation/agent: they must not be used. */
export function foreignIdsInMessage(db: CoreDatabase, message: string, scope: JournalScope): string[] {
  const ids = new Set<string>();
  collectIds(message, ids);
  const foreign: string[] = [];
  for (const id of ids) {
    try {
      const like = `%${id}%`;
      const mine = db.get(`SELECT 1 FROM tool_execution_journal WHERE conversationId = ? AND ${scope.agentId === null ? 'agentId IS NULL' : 'agentId = ?'} AND (refsJson LIKE ? OR artifactIdsJson LIKE ?) LIMIT 1`, [scope.conversationId, ...(scope.agentId === null ? [] : [scope.agentId]), like, like]);
      if (mine) continue;
      const elsewhere = db.get('SELECT 1 FROM tool_execution_journal WHERE refsJson LIKE ? OR artifactIdsJson LIKE ? LIMIT 1', [like, like])
        ?? (id.startsWith('artifact_') ? db.get('SELECT 1 FROM artifacts WHERE id = ? AND (conversationId IS NULL OR conversationId != ?)', [id, scope.conversationId]) : null);
      if (elsewhere) foreign.push(id);
    } catch { /* treat as unknown */ }
  }
  return foreign;
}

function describeItem(i: ActiveItem): string {
  return `${i.kind} ${i.id}${i.label ? ` "${i.label}"` : ''} (${i.state} by ${i.byTool} at ${i.at.slice(0, 16).replace('T', ' ')}Z; record ${i.invocationId})`;
}

export function clarificationQuestion(res: Extract<ReferenceResolution, { status: 'ambiguous' }>): string {
  const lines = res.candidates.map((c, n) => `${n + 1}. ${c.label ? `"${c.label}" — ` : ''}${c.kind} \`${c.id}\` (${c.state} by ${c.byTool}, ${c.at.slice(0, 16).replace('T', ' ')} UTC)`);
  return `I have more than one ${res.cue === 'undo' || res.cue === 'continue' ? 'recent action' : res.cue} that this could mean, so I have not changed anything yet. Which one do you mean?\n\n${lines.join('\n')}`;
}

// ---------------------------------------------------------------------------------------------------------------
// Context for the next model turn: bounded, deterministic, with references to the complete records.
// ---------------------------------------------------------------------------------------------------------------

export interface JournalContextOptions {
  message: string;
  excludeAttemptId?: string;
  /** False when the turn's model is not local: private results are then referenced by id only. */
  localModel: boolean;
  maxChars?: number;
}

export interface JournalContext {
  section: string;
  resolution: ReferenceResolution;
  entries: number;
}

export function buildJournalContext(db: CoreDatabase, scope: JournalScope, options: JournalContextOptions): JournalContext {
  backfillConversationJournal(db, scope.conversationId);
  const entries = listConversationEntries(db, scope, { excludeAttemptId: options.excludeAttemptId });
  const resolution = resolveReference(options.message, entries, foreignIdsInMessage(db, options.message, scope));
  if (!entries.length && resolution.status !== 'inaccessible') return { section: '', resolution, entries: 0 };
  const maxChars = options.maxChars ?? 4_500;
  const show = (e: JournalEntry) => e.sensitivity === 'private' && !options.localModel ? '[private result: content withheld from a non-local model]' : e.summary;

  const lines: string[] = [];
  lines.push('EXECUTION JOURNAL (Core\'s verified record of what Pandesh actually did in this conversation. It is authoritative over earlier replies, which may have left ids out. Use these exact ids and paths; never invent one. To see a complete earlier result — a document\'s text, a full list, an agent\'s whole answer — call recall_execution with the record id or the item id.)');

  if (resolution.status === 'resolved') {
    lines.push(`RESOLVED REFERENCE: in the latest message, "${resolution.cue}" means ${describeItem(resolution.item)} — ${resolution.reason}.`);
  } else if (resolution.status === 'ambiguous') {
    lines.push(`AMBIGUOUS REFERENCE: the latest message could mean any of: ${resolution.candidates.map(describeItem).join('; ')}. Ask the user which one before changing anything.`);
  } else if (resolution.status === 'inaccessible') {
    lines.push(`NOT ACCESSIBLE: ${resolution.ids.join(', ')} belong${resolution.ids.length === 1 ? 's' : ''} to another conversation or agent. Do not use, open, change or describe ${resolution.ids.length === 1 ? 'it' : 'them'}; tell the user it is not available in this conversation.`);
  }

  const items = activeItems(entries).filter((i) => i.state !== 'read' || /^(?:document|file)$/.test(i.kind));
  const latestByKind = new Map<string, ActiveItem>();
  for (const i of items) latestByKind.set(i.kind, i);
  if (latestByKind.size) {
    lines.push('CURRENT ITEMS (latest of each kind, with what last happened to it):');
    for (const i of [...latestByKind.values()].sort((a, b) => b.bySeq - a.bySeq).slice(0, 10)) lines.push(`- ${describeItem(i)}`);
  }

  const recent = entries.slice(-14);
  if (recent.length) {
    lines.push(`RECENT ACTIONS (oldest first; ${entries.length} recorded in this conversation):`);
    for (const e of recent) {
      const refs = e.refs.filter((r) => r.role !== 'listed').slice(0, 4).map((r) => `${r.role} ${r.kind} ${r.id}`).join(', ');
      lines.push(`- [${e.invocationId}] ${e.endedAt.slice(11, 16)}Z ${e.toolName} → ${e.status.toUpperCase()}${refs ? ` | ${refs}` : ''} | ${clip(show(e), 160)}`);
    }
  }

  // The resolved item's own record, in full enough to act on (bounded).
  if (resolution.status === 'resolved') {
    const source = entries.find((e) => e.invocationId === resolution.item.invocationId);
    const creator = resolution.item.createdIn ? entries.find((e) => e.invocationId === resolution.item.createdIn!.invocationId) : undefined;
    for (const e of [creator, source].filter((x, n, a): x is JournalEntry => Boolean(x) && a.indexOf(x) === n)) {
      const body = e.sensitivity === 'private' && !options.localModel ? '[private result withheld]' : clip(e.resultText, 1_800);
      lines.push(`RECORD ${e.invocationId} (${e.toolName}, ${e.status}): ${body}`);
    }
  }

  let section = lines.join('\n');
  if (section.length > maxChars) section = `${section.slice(0, maxChars - 40)}\n[journal section truncated]`;
  return { section, resolution, entries: entries.length };
}

/** The `recall_execution` tool: complete persisted records, only from this conversation and agent. */
export function recallJournal(db: CoreDatabase, scope: JournalScope, query: string, options: { localModel: boolean; maxChars?: number }): { ok: boolean; text: string } {
  const q = String(query ?? '').trim();
  if (!q) return { ok: false, text: 'Give a record id (tinv_…), an item id, or a file path.' };
  backfillConversationJournal(db, scope.conversationId);
  const entries = listConversationEntries(db, scope);
  const matches = entries.filter((e) => e.invocationId === q || e.refs.some((r) => r.id === q || (r.kind === 'document' || r.kind === 'file') && path.basename(r.id).toLowerCase() === q.toLowerCase()) || e.artifactIds.includes(q));
  if (!matches.length) {
    const elsewhere = (() => { try { return db.get('SELECT 1 FROM tool_execution_journal WHERE invocationId = ? OR refsJson LIKE ? LIMIT 1', [q, `%${q}%`]); } catch { return null; } })();
    return { ok: false, text: elsewhere ? `NOT ACCESSIBLE: ${q} belongs to another conversation or agent. It cannot be used here.` : `No record of ${q} in this conversation.` };
  }
  const max = options.maxChars ?? 12_000;
  const out = matches.slice(-4).map((e) => {
    const body = e.sensitivity === 'private' && !options.localModel ? '[private result withheld from a non-local model]' : e.resultText;
    return `RECORD ${e.invocationId}: ${e.toolName} ${e.status} at ${e.endedAt}\nargs: ${safeJson(e.args).slice(0, 600)}\nrefs: ${e.refs.map((r) => `${r.role} ${r.kind} ${r.id}`).join(', ') || 'none'}\nresult:\n${body}`;
  }).join('\n\n');
  return { ok: true, text: out.length > max ? `${out.slice(0, max)}\n[…truncated]` : out };
}
