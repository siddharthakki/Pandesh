import * as crypto from 'node:crypto';
import type { CoreDatabase } from '../db/connection';
import type { CitationRecord, ResearchApprovalRecord, ResearchSessionRecord, ResearchSourceRecord, ResearchState } from '../shared/wireTypes';
import { CoreError } from './errors';
import { appendMessage } from './conversations';
import { newId, nowIso } from './ids';
import { recordRuntimeEvent } from './runtimeEvents';

const MAX_QUERY_CHARS = 1_000;
const MAX_EVIDENCE_CHARS = 24_000;

function digest(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}
function asSession(row: Record<string, unknown>): ResearchSessionRecord {
  return { id: String(row.id), conversationId: String(row.conversationId), originatingUserMessageId: String(row.originatingUserMessageId), approvalId: String(row.approvalId), normalizedQuery: String(row.normalizedQuery), provider: String(row.provider), state: row.state as ResearchState, createdAt: String(row.createdAt), startedAt: row.startedAt as string ?? null, completedAt: row.completedAt as string ?? null, failureClassification: row.failureClassification as string ?? null };
}
function asApproval(row: Record<string, unknown>): ResearchApprovalRecord {
  return { id: String(row.id), researchId: String(row.researchId), status: row.status as ResearchApprovalRecord['status'], requestedAt: String(row.requestedAt), resolvedAt: row.resolvedAt as string ?? null, requestedActionDigest: String(row.requestedActionDigest), summary: JSON.parse(String(row.summary)), revision: Number(row.revision) };
}
function asSource(row: Record<string, unknown>): ResearchSourceRecord {
  return { id: String(row.id), researchId: String(row.researchId), resultRank: Number(row.resultRank), normalizedUrl: String(row.normalizedUrl), finalUrl: row.finalUrl as string ?? null, title: row.title as string ?? null, provider: String(row.provider), retrievedAt: row.retrievedAt as string ?? null, httpStatus: row.httpStatus as number ?? null, contentType: row.contentType as string ?? null, extractedTextHash: row.extractedTextHash as string ?? null, rawResponseHash: row.rawResponseHash as string ?? null, extractedText: row.extractedText as string ?? null, status: row.status as ResearchSourceRecord['status'], failure: row.failure as string ?? null, provenanceVersion: Number(row.provenanceVersion) };
}
export function getResearchSession(db: CoreDatabase, id: string): ResearchSessionRecord {
  const row = db.get<Record<string, unknown>>('SELECT * FROM research_sessions WHERE id = ?', [id]);
  if (!row) throw new CoreError('not_found', `research '${id}' not found`);
  return asSession(row);
}
export function getResearchApproval(db: CoreDatabase, id: string): ResearchApprovalRecord {
  const row = db.get<Record<string, unknown>>('SELECT * FROM research_approvals WHERE id = ?', [id]);
  if (!row) throw new CoreError('not_found', `research approval '${id}' not found`);
  return asApproval(row);
}
export function createResearchSession(db: CoreDatabase, input: { conversationId: string; query: string; provider: string; actor: string; clientId?: string | null }): { session: ResearchSessionRecord; approval: ResearchApprovalRecord } {
  const normalizedQuery = input.query.replace(/\s+/g, ' ').trim();
  if (!normalizedQuery || normalizedQuery.length > MAX_QUERY_CHARS) throw new CoreError('invalid_request', 'research query must be between 1 and 1000 characters');
  if (!input.provider) throw new CoreError('invalid_request', 'research provider is not configured');
  return db.transaction(() => {
    const user = appendMessage(db, input.conversationId, { role: 'user', content: input.query, actor: input.actor, clientId: input.clientId });
    const id = newId('research'); const approvalId = newId('rappr'); const now = nowIso();
    const summary = { provider: input.provider, queryPreview: normalizedQuery.slice(0, 180), maxSources: 3 };
    db.run('INSERT INTO research_sessions (id, conversationId, originatingUserMessageId, approvalId, normalizedQuery, provider, state, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [id, input.conversationId, user.id, approvalId, normalizedQuery, input.provider, 'awaiting_approval', now]);
    db.run('INSERT INTO research_approvals (id, researchId, status, requestedAt, requestedActionDigest, summary, revision) VALUES (?, ?, ?, ?, ?, ?, 1)', [approvalId, id, 'pending', now, digest(summary), JSON.stringify(summary)]);
    recordRuntimeEvent(db, { domain: 'research', entityId: id, eventType: 'research_approval_requested', actor: input.actor, clientId: input.clientId, metadata: { approvalId, provider: input.provider }, resultingRevision: 1 });
    return { session: getResearchSession(db, id), approval: getResearchApproval(db, approvalId) };
  });
}
export function resolveResearchApproval(db: CoreDatabase, sessionId: string, input: { approvalId: string; requestedActionDigest: string; resolution: 'approved' | 'rejected'; actor: string; clientId?: string | null }): ResearchSessionRecord {
  return db.transaction(() => {
    const session = getResearchSession(db, sessionId);
    if (session.state !== 'awaiting_approval' || session.approvalId !== input.approvalId) throw new CoreError('invalid_transition', 'research approval is no longer actionable');
    const approval = getResearchApproval(db, input.approvalId);
    if (approval.status !== 'pending' || approval.requestedActionDigest !== input.requestedActionDigest) throw new CoreError('revision_mismatch', 'research approval envelope does not match');
    const now = nowIso();
    db.run('UPDATE research_approvals SET status = ?, resolvedAt = ?, revision = revision + 1 WHERE id = ?', [input.resolution === 'approved' ? 'approved' : 'rejected', now, approval.id]);
    const state = input.resolution === 'approved' ? 'running' : 'denied';
    db.run('UPDATE research_sessions SET state = ?, startedAt = ?, completedAt = ? WHERE id = ?', [state, input.resolution === 'approved' ? now : null, input.resolution === 'rejected' ? now : null, sessionId]);
    if (input.resolution === 'rejected') {
      appendMessage(db, session.conversationId, { role: 'assistant', content: 'Research was not started because network access was not approved.', actor: 'core:research', clientId: input.clientId });
    }
    recordRuntimeEvent(db, { domain: 'research', entityId: sessionId, eventType: input.resolution === 'approved' ? 'research_approved' : 'research_denied', actor: input.actor, clientId: input.clientId, metadata: {}, resultingRevision: 2 });
    return getResearchSession(db, sessionId);
  });
}
export function completeResearch(db: CoreDatabase, id: string, state: Extract<ResearchState, 'completed' | 'insufficient_evidence' | 'failed' | 'unavailable'>, failureClassification: string | null, actor = 'core:research'): ResearchSessionRecord {
  const current = getResearchSession(db, id);
  if (current.state !== 'running') return current;
  const now = nowIso();
  db.run('UPDATE research_sessions SET state = ?, completedAt = ?, failureClassification = ? WHERE id = ?', [state, now, failureClassification, id]);
  recordRuntimeEvent(db, { domain: 'research', entityId: id, eventType: `research_${state}`, actor, metadata: { failureClassification }, resultingRevision: null });
  return getResearchSession(db, id);
}
export function recordResearchSource(db: CoreDatabase, input: Omit<ResearchSourceRecord, 'id' | 'provenanceVersion'>): ResearchSourceRecord {
  if (input.extractedText && input.extractedText.length > MAX_EVIDENCE_CHARS) throw new CoreError('invalid_request', 'research evidence exceeds bound');
  const id = newId('source');
  db.run('INSERT INTO research_sources (id, researchId, resultRank, normalizedUrl, finalUrl, title, provider, retrievedAt, httpStatus, contentType, extractedTextHash, rawResponseHash, extractedText, status, failure, provenanceVersion) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)', [id, input.researchId, input.resultRank, input.normalizedUrl, input.finalUrl, input.title, input.provider, input.retrievedAt, input.httpStatus, input.contentType, input.extractedTextHash, input.rawResponseHash, input.extractedText, input.status, input.failure]);
  return asSource(db.get<Record<string, unknown>>('SELECT * FROM research_sources WHERE id = ?', [id])!);
}
export function listResearchSources(db: CoreDatabase, researchId: string): ResearchSourceRecord[] { return db.all<Record<string, unknown>>('SELECT * FROM research_sources WHERE researchId = ? ORDER BY resultRank, id', [researchId]).map(asSource); }
export function recordCitations(db: CoreDatabase, assistantMessageId: string, citations: Array<{ sourceId: string; label: string; evidenceReference?: string | null }>): CitationRecord[] {
  return citations.map((citation) => { const id = newId('cite'); db.run('INSERT INTO citations (id, assistantMessageId, sourceId, visibleLabel, evidenceReference, validationStatus) VALUES (?, ?, ?, ?, ?, ?)', [id, assistantMessageId, citation.sourceId, citation.label, citation.evidenceReference ?? null, 'valid']); return { id, assistantMessageId, sourceId: citation.sourceId, visibleLabel: citation.label, evidenceReference: citation.evidenceReference ?? null, validationStatus: 'valid' }; });
}
export function listResearchForConversation(db: CoreDatabase, conversationId: string): ResearchSessionRecord[] { return db.all<Record<string, unknown>>('SELECT * FROM research_sessions WHERE conversationId = ? ORDER BY createdAt', [conversationId]).map(asSession); }
export function listCitationsForMessage(db: CoreDatabase, messageId: string): CitationRecord[] { return db.all<Record<string, unknown>>('SELECT * FROM citations WHERE assistantMessageId = ? ORDER BY id', [messageId]).map((r) => ({ id: String(r.id), assistantMessageId: String(r.assistantMessageId), sourceId: String(r.sourceId), visibleLabel: String(r.visibleLabel), evidenceReference: r.evidenceReference as string ?? null, validationStatus: r.validationStatus as CitationRecord['validationStatus'] })); }
