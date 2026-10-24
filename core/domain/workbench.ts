import type { CoreDatabase } from '../db/connection';
import type {
  AttachmentRecord,
  AttemptStatus,
  CitationRecord,
  ConversationBranchRecord,
  ConversationExport,
  ConversationMessageRecord,
  ConversationMode,
  ConversationRailEntry,
  ConversationRailState,
  ConversationRecord,
  ConversationSearchResult,
  ResponseAlternativeRecord,
} from '../shared/wireTypes';
import { CoreError } from './errors';
import { newId, nowIso } from './ids';
import { getConversation, listConversations, listMessages, type ListConversationsFilter } from './conversations';
import { listAttachmentsByMessageForConversation } from './attachments';
import { listCitationsForMessage, listResearchSources } from './research';
import { recordRuntimeEvent } from './runtimeEvents';

const MAX_SEARCH_QUERY_CHARS = 200;
const MAX_SEARCH_RESULTS = 50;
const MAX_SEARCH_CONVERSATIONS = 500;

function asBranch(row: Record<string, unknown>): ConversationBranchRecord {
  return { conversationId: String(row.conversationId), parentConversationId: String(row.parentConversationId), branchPointMessageId: String(row.branchPointMessageId), createdAt: String(row.createdAt) };
}

function asAlternative(row: Record<string, unknown>): ResponseAlternativeRecord {
  return {
    id: String(row.id), conversationId: String(row.conversationId), userMessageId: String(row.userMessageId),
    assistantMessageId: String(row.assistantMessageId), ordinal: Number(row.ordinal), active: Boolean(row.active), createdAt: String(row.createdAt),
  };
}

export function getConversationBranch(db: CoreDatabase, conversationId: string): ConversationBranchRecord | null {
  const row = db.get<Record<string, unknown>>('SELECT * FROM conversation_branches WHERE conversationId = ?', [conversationId]);
  return row ? asBranch(row) : null;
}

export function listResponseAlternatives(db: CoreDatabase, conversationId: string, userMessageId?: string): ResponseAlternativeRecord[] {
  const rows = userMessageId
    ? db.all<Record<string, unknown>>('SELECT * FROM response_alternatives WHERE conversationId = ? AND userMessageId = ? ORDER BY ordinal', [conversationId, userMessageId])
    : db.all<Record<string, unknown>>('SELECT * FROM response_alternatives WHERE conversationId = ? ORDER BY userMessageId, ordinal', [conversationId]);
  return rows.map(asAlternative);
}

/** Creates a branch without copying history or attachment bytes.  The message
 * projection resolves inherited messages through this immutable ancestry row. */
export function branchConversation(db: CoreDatabase, input: { parentConversationId: string; branchPointMessageId: string; title?: string | null; actor: string; clientId?: string | null }): ConversationRecord {
  return db.transaction(() => {
    const parent = getConversation(db, input.parentConversationId);
    const point = listMessages(db, parent.id).find(message => message.id === input.branchPointMessageId);
    if (!point) throw new CoreError('not_found', 'branch point message is not available in the selected conversation');
    const id = newId('conv'); const now = nowIso();
    const title = input.title?.trim() || (parent.title ? `${parent.title} (branch)` : 'Conversation branch');
    db.run(
      `INSERT INTO conversations (id, mode, projectId, repositoryId, title, createdAt, updatedAt, archivedAt, revision)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 1)`,
      [id, parent.mode, parent.projectId, parent.repositoryId, title.slice(0, 240), now, now],
    );
    db.run('INSERT INTO conversation_branches (conversationId, parentConversationId, branchPointMessageId, createdAt) VALUES (?, ?, ?, ?)', [id, parent.id, point.id, now]);
    recordRuntimeEvent(db, { domain: 'conversation', entityId: id, eventType: 'conversation_branched', actor: input.actor, clientId: input.clientId, metadata: { parentConversationId: parent.id, branchPointMessageId: point.id }, resultingRevision: 1 });
    return getConversation(db, id);
  });
}

/** Registers a durable assistant alternative after its immutable message was
 * appended.  Regenerations never replace the original answer. */
export function registerResponseAlternative(db: CoreDatabase, input: { conversationId: string; userMessageId: string; assistantMessageId: string; activate?: boolean }): ResponseAlternativeRecord {
  return db.transaction(() => {
    const user = db.get('SELECT id FROM conversation_messages WHERE id = ?', [input.userMessageId]);
    const assistant = db.get('SELECT id FROM conversation_messages WHERE id = ?', [input.assistantMessageId]);
    if (!user || !assistant) throw new CoreError('not_found', 'response alternative messages no longer exist');
    const existing = db.get<Record<string, unknown>>('SELECT * FROM response_alternatives WHERE assistantMessageId = ?', [input.assistantMessageId]);
    if (existing) return asAlternative(existing);
    const ordinal = Number(db.get<{ ordinal: number | null }>('SELECT MAX(ordinal) AS ordinal FROM response_alternatives WHERE conversationId = ? AND userMessageId = ?', [input.conversationId, input.userMessageId])?.ordinal ?? -1) + 1;
    const shouldActivate = input.activate !== false;
    if (shouldActivate) db.run('UPDATE response_alternatives SET active = 0 WHERE conversationId = ? AND userMessageId = ?', [input.conversationId, input.userMessageId]);
    const id = newId('alt'); const createdAt = nowIso();
    db.run('INSERT INTO response_alternatives (id, conversationId, userMessageId, assistantMessageId, ordinal, active, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)', [id, input.conversationId, input.userMessageId, input.assistantMessageId, ordinal, shouldActivate ? 1 : 0, createdAt]);
    return asAlternative(db.get<Record<string, unknown>>('SELECT * FROM response_alternatives WHERE id = ?', [id])!);
  });
}

export function setActiveResponseAlternative(db: CoreDatabase, input: { conversationId: string; alternativeId: string; actor: string; clientId?: string | null }): ResponseAlternativeRecord {
  return db.transaction(() => {
    const selected = db.get<Record<string, unknown>>('SELECT * FROM response_alternatives WHERE id = ? AND conversationId = ?', [input.alternativeId, input.conversationId]);
    if (!selected) throw new CoreError('not_found', 'response alternative was not found in this conversation');
    db.run('UPDATE response_alternatives SET active = 0 WHERE conversationId = ? AND userMessageId = ?', [input.conversationId, selected.userMessageId]);
    db.run('UPDATE response_alternatives SET active = 1 WHERE id = ?', [input.alternativeId]);
    recordRuntimeEvent(db, { domain: 'conversation', entityId: input.conversationId, eventType: 'response_alternative_selected', actor: input.actor, clientId: input.clientId, metadata: { alternativeId: input.alternativeId, userMessageId: selected.userMessageId }, resultingRevision: null });
    return asAlternative(db.get<Record<string, unknown>>('SELECT * FROM response_alternatives WHERE id = ?', [input.alternativeId])!);
  });
}

function cleanSnippet(value: string, query: string): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  const index = compact.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
  if (index < 0) return compact.slice(0, 180);
  return `${index > 50 ? '…' : ''}${compact.slice(Math.max(0, index - 50), index + query.length + 100)}${index + query.length + 100 < compact.length ? '…' : ''}`;
}

export function searchConversations(db: CoreDatabase, rawQuery: string, rawLimit?: number): ConversationSearchResult[] {
  const query = rawQuery.trim().replace(/\s+/g, ' ');
  if (!query) return [];
  if (query.length > MAX_SEARCH_QUERY_CHARS) throw new CoreError('invalid_request', `search query exceeds ${MAX_SEARCH_QUERY_CHARS} characters`);
  const limit = Math.min(Math.max(rawLimit ?? 20, 1), MAX_SEARCH_RESULTS);
  const needle = query.toLocaleLowerCase();
  const conversations = db.all<Record<string, unknown>>('SELECT * FROM conversations WHERE archivedAt IS NULL ORDER BY updatedAt DESC, id DESC LIMIT ?', [MAX_SEARCH_CONVERSATIONS]);
  const matches: Array<ConversationSearchResult & { score: number }> = [];
  for (const row of conversations) {
    const conversation = getConversation(db, String(row.id));
    const kinds = new Set<ConversationSearchResult['matchedKinds'][number]>();
    let messageId: string | null = null; let snippet = ''; let score = 0;
    if ((conversation.title ?? '').toLocaleLowerCase().includes(needle)) { kinds.add('title'); snippet = cleanSnippet(conversation.title ?? '', query); score = 500; }
    for (const message of listMessages(db, conversation.id, { limit: 2000 })) {
      if (message.content.toLocaleLowerCase().includes(needle) && score < 400) { kinds.add('message'); messageId = message.id; snippet = cleanSnippet(message.content, query); score = 400; }
    }
    const attachments = db.all<Record<string, unknown>>('SELECT extraction, transcription FROM attachments WHERE conversationId = ?', [conversation.id]);
    for (const attachment of attachments) {
      const text = [attachment.extraction, attachment.transcription].filter(Boolean).map(value => String(value)).join(' ');
      if (text.toLocaleLowerCase().includes(needle) && score < 300) { kinds.add(text.includes('segments') ? 'transcript' : 'attachment'); snippet = cleanSnippet(text, query); score = 300; }
    }
    const sources = db.all<Record<string, unknown>>('SELECT title, normalizedUrl FROM research_sources WHERE researchId IN (SELECT id FROM research_sessions WHERE conversationId = ?)', [conversation.id]);
    for (const source of sources) {
      const text = `${source.title ?? ''} ${source.normalizedUrl ?? ''}`;
      if (text.toLocaleLowerCase().includes(needle) && score < 200) { kinds.add('source'); snippet = cleanSnippet(text, query); score = 200; }
    }
    if (score) matches.push({ conversationId: conversation.id, messageId, title: conversation.title, snippet, matchedKinds: [...kinds], updatedAt: conversation.updatedAt, branch: getConversationBranch(db, conversation.id), score });
  }
  return matches.sort((a, b) => b.score - a.score || b.updatedAt.localeCompare(a.updatedAt) || a.conversationId.localeCompare(b.conversationId)).slice(0, limit).map(({ score: _score, ...result }) => result);
}

export function exportConversation(db: CoreDatabase, conversationId: string): ConversationExport {
  const conversation = getConversation(db, conversationId);
  const messages = listMessages(db, conversationId, { limit: 2000 });
  const attachments = listAttachmentsByMessageForConversation(db, conversationId);
  const alternatives = listResponseAlternatives(db, conversationId);
  const research = db.all<Record<string, unknown>>(
    `SELECT * FROM research_sessions WHERE originatingUserMessageId IN (${messages.length ? messages.map(() => '?').join(',') : "''"}) ORDER BY createdAt`,
    messages.map(message => message.id),
  ).map((session) => ({
    session: {
      id: String(session.id), conversationId: String(session.conversationId), originatingUserMessageId: String(session.originatingUserMessageId), approvalId: String(session.approvalId), normalizedQuery: String(session.normalizedQuery), provider: String(session.provider), state: session.state as ConversationExport['research'][number]['session']['state'], createdAt: String(session.createdAt), startedAt: session.startedAt as string ?? null, completedAt: session.completedAt as string ?? null, failureClassification: session.failureClassification as string ?? null,
    },
    sources: listResearchSources(db, String(session.id)),
  }));
  return {
    schemaVersion: 1, exportedAt: nowIso(), conversation, branch: getConversationBranch(db, conversationId), research,
    messages: messages.map(message => ({ attachments: attachments[message.id] ?? [], citations: listCitationsForMessage(db, message.id), alternatives: alternatives.filter(alt => alt.userMessageId === message.id || alt.assistantMessageId === message.id), ...message })),
  };
}

export function renderConversationMarkdown(value: ConversationExport): string {
  const lines = [`# ${value.conversation.title ?? 'Conversation'}`, '', `Exported: ${value.exportedAt}`, `Conversation: ${value.conversation.id}`];
  if (value.branch) lines.push(`Branch: from ${value.branch.parentConversationId} at ${value.branch.branchPointMessageId}`);
  for (const message of value.messages) {
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    lines.push('', `## ${message.role === 'user' ? 'User' : 'Assistant'} — ${message.createdAt}`, '', message.content);
    for (const attachment of message.attachments) lines.push('', `Attachment: ${attachment.originalName} (${attachment.sha256 ?? 'hash unavailable'})`);
    for (const citation of message.citations) lines.push(`Citation [${citation.visibleLabel}]: ${citation.sourceId}`);
    const alternatives = message.alternatives.filter(alt => alt.assistantMessageId === message.id);
    if (alternatives.length) lines.push(`Alternative ${alternatives[0].ordinal + 1}${alternatives[0].active ? ' (active)' : ''}`);
  }
  if (value.research.length) lines.push('', '## Research sources');
  for (const item of value.research) for (const source of item.sources) lines.push(`- ${source.title ?? 'Untitled'} — ${source.finalUrl ?? source.normalizedUrl} (${source.status})`);
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// Jarvis Conversations rail (Checkpoint 1) — a derived, read-only projection.
// State is computed fresh from the latest attempt for the conversation, never
// stored, so the rail can never drift from Core's authoritative execution
// records. `conversation_turns.outcome` (see conversationLedger.ts) is
// deliberately NOT reused here: its `statusToOutcome` mapping silently folds
// the real `waiting_for_approval` attempt status into 'active', which would
// make an approval-pending conversation indistinguishable from a working one.
// ---------------------------------------------------------------------------

function latestAttemptStatusForConversation(db: CoreDatabase, conversationId: string): AttemptStatus | null {
  const row = db.get<{ status: string }>(
    `SELECT a.status
       FROM attempts a
       JOIN requests r ON r.id = a.requestId
      WHERE r.conversationId = ?
      ORDER BY a.updatedAt DESC
      LIMIT 1`,
    [conversationId],
  );
  return (row?.status as AttemptStatus) ?? null;
}

function deriveConversationRailState(status: AttemptStatus | null): ConversationRailState {
  if (status === 'waiting_for_approval') return 'needs_approval';
  if (status === 'completed') return 'completed';
  // A conversation the person stopped is not a failure: it says so.
  if (status === 'cancelled') return 'stopped';
  if (status === 'failed') return 'failed';
  // null (no turns yet), created/queued/running/validating/paused/blocked/
  // cancelling/recovery_required all read as a usable, in-progress conversation.
  return 'active';
}

/** Governed capability actions (image/video generation, etc.) park their approval on an anchor
 * attempt that carries no conversationId, so the latest-attempt lookup above cannot see it. A still-
 * actionable approval there is exactly what the user needs to find from the conversation rail. */
function hasPendingCapabilityApproval(db: CoreDatabase, conversationId: string): boolean {
  const row = db.get<{ n: number }>(
    `SELECT 1 AS n
       FROM approvals ap
       JOIN attempts a ON a.id = ap.attemptId
       JOIN requests r ON r.id = a.requestId
      WHERE ap.status = 'pending' AND a.status = 'waiting_for_approval'
        AND r.currentMessage = ?
      LIMIT 1`,
    [`M38 governed capability dispatch anchor for ${conversationId}`],
  );
  return Boolean(row);
}

/** Bounded by `listConversations`'s own MAX_PAGE_SIZE (200) — one extra
 * messages+attempt lookup per row is acceptable at rail scale. Not a pattern
 * to reuse for anything unbounded. */
export function listConversationRail(
  db: CoreDatabase,
  filter: ListConversationsFilter & { mode?: ConversationMode } = {},
): ConversationRailEntry[] {
  return listConversations(db, filter).map((conversation): ConversationRailEntry => {
    const messages = listMessages(db, conversation.id, { limit: 2000 });
    const last = [...messages].reverse().find(message => message.role === 'user' || message.role === 'assistant') ?? null;
    const repository = conversation.repositoryId
      ? db.get<{ name: string }>('SELECT name FROM repositories WHERE id = ?', [conversation.repositoryId])
      : null;
    return {
      ...conversation,
      preview: last ? cleanSnippet(last.content, '') : null,
      state: hasPendingCapabilityApproval(db, conversation.id) ? 'needs_approval' : deriveConversationRailState(latestAttemptStatusForConversation(db, conversation.id)),
      repositoryName: repository?.name ?? null,
    };
  });
}
