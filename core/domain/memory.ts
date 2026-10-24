/**
 * M39 — Core-owned memory and knowledge intelligence.
 *
 * Core's SQLite store is the sole durable authority for every memory fact,
 * evidence link, knowledge entity, relationship, and contradiction (see
 * docs/m39-memory-knowledge-intelligence.md §4). This module deliberately
 * introduces NO new runtime, approval system, or evidence store:
 *
 *   chat/model tool call
 *     -> core/runtime/memoryCapability.ts (the governed capability adapter)
 *       -> core/domain/capabilityDispatch.ts (existing 'mutation' approval,
 *          existing approval restoration, existing tool_invocations evidence)
 *         -> this module, inside one Core SQLite transaction.
 *
 * Consequential operations (remember / forget / contradiction resolution)
 * therefore reuse the *existing* M38 capability mutation approval as the
 * explicit user-consent step. Read-only operations (recall / impact / export)
 * execute without one. `src/memory/*` and `FrontierCoreServices.openKnowledgeLedger()`
 * (file-backed, disconnected) are NOT the M39 authority and are not wired in.
 */
import * as crypto from 'node:crypto';
import type { CoreDatabase } from '../db/connection';
import { CoreError } from './errors';
import { newId, nowIso } from './ids';
import { recordRuntimeEvent } from './runtimeEvents';
import {
  MEMORY_EXPORT_SCHEMA_VERSION,
  MEMORY_PROVENANCE_VERSION,
  type KnowledgeEntityRecord,
  type KnowledgeEntityType,
  type KnowledgeRelationshipRecord,
  type KnowledgeRelationshipType,
  type MemoryContradictionRecord,
  type MemoryEvidenceRecord,
  type MemoryFactRecord,
  type MemoryImpactEntry,
  type MemoryRecallEntry,
  type MemoryResolutionPolicy,
  type MemoryScopeType,
  type MemorySensitivity,
  type MemoryType,
} from '../shared/wireTypes';

export const MEMORY_TYPES: readonly MemoryType[] = ['user', 'project', 'task', 'episodic', 'semantic', 'procedural'];
export const MEMORY_SCOPE_TYPES: readonly MemoryScopeType[] = ['user', 'project', 'task', 'repository', 'global'];
export const MEMORY_SENSITIVITIES: readonly MemorySensitivity[] = ['public', 'internal', 'confidential', 'restricted'];
export const KNOWLEDGE_ENTITY_TYPES: readonly KnowledgeEntityType[] = [
  'user', 'project', 'task', 'decision', 'repository_file', 'github_issue', 'product_record',
];
export const KNOWLEDGE_RELATIONSHIP_TYPES: readonly KnowledgeRelationshipType[] = [
  'affects', 'depends_on', 'supersedes', 'implemented_by', 'contradicts', 'scoped_to',
];
export const MEMORY_RESOLUTION_POLICIES: readonly MemoryResolutionPolicy[] = [
  'prefer_earlier', 'prefer_later', 'keep_both', 'scope_split',
];

export const MAX_SUBJECT_CHARS = 200;
export const MAX_PREDICATE_CHARS = 120;
export const MAX_VALUE_CHARS = 2_000;
export const MAX_AFFECTED_ENTITIES = 12;
export const MAX_IMPACT_DEPTH = 4;
export const MAX_IMPACT_NODES = 200;
export const MAX_RECALL_RESULTS = 50;

// ---------------------------------------------------------------------------
// Redaction — memory-specific, applied BEFORE any M39 row is written and
// before any argument is copied into governed tool-invocation evidence.
// Generalizes core/runtime/githubCapability.ts's `redact` rather than
// duplicating it as a display-time filter over an unredacted store.
// ---------------------------------------------------------------------------

interface RedactionRule { readonly id: string; readonly pattern: RegExp; readonly replacement: string }

const REDACTION_RULES: readonly RedactionRule[] = [
  { id: 'pem_private_key', pattern: /-{5}BEGIN[\s\S]*?-{5}END[^-]*-{5}/g, replacement: '[redacted-key-block]' },
  { id: 'github_token', pattern: /gh[pousr]_[A-Za-z0-9]{20,}/g, replacement: '[redacted-token]' },
  { id: 'github_fine_grained_token', pattern: /github_pat_[A-Za-z0-9_]{20,}/g, replacement: '[redacted-token]' },
  { id: 'authorization_header', pattern: /(authorization\s*[:=]\s*)(bearer\s+)?\S+/gi, replacement: '$1[redacted]' },
  { id: 'bearer_token', pattern: /\bbearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi, replacement: 'bearer [redacted]' },
  { id: 'url_credentials', pattern: /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, replacement: '$1[redacted]@' },
  { id: 'api_key_assignment', pattern: /((?:api[_-]?key|secret|access[_-]?token|client[_-]?secret|password)\s*[:=]\s*)["']?[A-Za-z0-9._~+/-]{12,}=*["']?/gi, replacement: '$1[redacted]' },
  { id: 'aws_access_key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, replacement: '[redacted-token]' },
  { id: 'slack_token', pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g, replacement: '[redacted-token]' },
];

export interface RedactionOutcome { text: string; redacted: boolean; rules: string[] }

/** Applies every memory redaction rule and reports which ones fired. */
export function redactMemoryText(input: string): RedactionOutcome {
  let text = input;
  const rules: string[] = [];
  for (const rule of REDACTION_RULES) {
    const before = text;
    text = text.replace(rule.pattern, rule.replacement);
    if (text !== before) rules.push(rule.id);
  }
  return { text, redacted: rules.length > 0, rules };
}

/** Deep, bounded redaction of a tool-call argument object. Used both by the
 * adapter (before persisting anything) and by the governed dispatch path
 * (before the approval summary / `tool_invocations.argsSummary` are written),
 * so a raw secret never reaches M39 evidence at all. */
export function redactMemoryArguments(args: Record<string, unknown>): Record<string, unknown> {
  const walk = (value: unknown, depth: number): unknown => {
    if (depth > 6) return '[redacted-depth]';
    if (typeof value === 'string') return redactMemoryText(value).text;
    if (Array.isArray(value)) return value.slice(0, 32).map((entry) => walk(entry, depth + 1));
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(value as Record<string, unknown>)) out[key] = walk(entry, depth + 1);
      return out;
    }
    return value;
  };
  return walk(args, 0) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Normalization and identity
// ---------------------------------------------------------------------------

/** Canonical, deterministic normalization used for subject/predicate/value.
 * Contradiction detection compares normalized values only — never model
 * judgement. */
export function normalizeMemoryText(value: string): string {
  return String(value ?? '').normalize('NFKC').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

function asFact(row: Record<string, unknown>): MemoryFactRecord {
  return {
    id: String(row.id),
    memoryType: row.memoryType as MemoryType,
    scopeType: row.scopeType as MemoryScopeType,
    scopeId: String(row.scopeId),
    subject: String(row.subject),
    predicate: String(row.predicate),
    normalizedValue: String(row.normalizedValue),
    displayValue: String(row.displayValue),
    structuredValue: row.structuredValue ? JSON.parse(String(row.structuredValue)) as Record<string, unknown> : null,
    sensitivity: row.sensitivity as MemorySensitivity,
    state: row.state as MemoryFactRecord['state'],
    validFrom: String(row.validFrom),
    validTo: (row.validTo as string | null) ?? null,
    expiresAt: (row.expiresAt as string | null) ?? null,
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
    forgottenAt: (row.forgottenAt as string | null) ?? null,
    consentApprovalId: (row.consentApprovalId as string | null) ?? null,
    toolInvocationId: (row.toolInvocationId as string | null) ?? null,
    revision: Number(row.revision),
    writeIdentity: String(row.writeIdentity),
  };
}

function asEvidence(row: Record<string, unknown>): MemoryEvidenceRecord {
  return {
    id: String(row.id),
    memoryId: String(row.memoryId),
    sourceType: row.sourceType as MemoryEvidenceRecord['sourceType'],
    sourceConversationId: (row.sourceConversationId as string | null) ?? null,
    sourceMessageId: (row.sourceMessageId as string | null) ?? null,
    sourceAttemptId: (row.sourceAttemptId as string | null) ?? null,
    sourceInvocationId: (row.sourceInvocationId as string | null) ?? null,
    sourceContentSha256: String(row.sourceContentSha256),
    provenanceVersion: Number(row.provenanceVersion),
    createdAt: String(row.createdAt),
  };
}

function asEntity(row: Record<string, unknown>): KnowledgeEntityRecord {
  return {
    id: String(row.id),
    entityType: row.entityType as KnowledgeEntityType,
    canonicalKey: String(row.canonicalKey),
    label: String(row.label),
    scopeType: (row.scopeType as string | null) ?? null,
    scopeId: (row.scopeId as string | null) ?? null,
    state: row.state as KnowledgeEntityRecord['state'],
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
  };
}

function asRelationship(row: Record<string, unknown>): KnowledgeRelationshipRecord {
  return {
    id: String(row.id),
    fromEntityId: String(row.fromEntityId),
    relationshipType: row.relationshipType as KnowledgeRelationshipType,
    toEntityId: String(row.toEntityId),
    validFrom: String(row.validFrom),
    validTo: (row.validTo as string | null) ?? null,
    state: row.state as KnowledgeRelationshipRecord['state'],
    memoryId: (row.memoryId as string | null) ?? null,
    evidenceId: (row.evidenceId as string | null) ?? null,
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
  };
}

function asContradiction(row: Record<string, unknown>): MemoryContradictionRecord {
  return {
    id: String(row.id),
    earlierMemoryId: String(row.earlierMemoryId),
    laterMemoryId: String(row.laterMemoryId),
    state: row.state as MemoryContradictionRecord['state'],
    resolutionPolicy: (row.resolutionPolicy as MemoryResolutionPolicy | null) ?? null,
    authoritativeMemoryId: (row.authoritativeMemoryId as string | null) ?? null,
    resolutionApprovalId: (row.resolutionApprovalId as string | null) ?? null,
    resolutionInvocationId: (row.resolutionInvocationId as string | null) ?? null,
    detectedAt: String(row.detectedAt),
    resolvedAt: (row.resolvedAt as string | null) ?? null,
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export function getMemoryFact(db: CoreDatabase, id: string): MemoryFactRecord {
  const row = db.get<Record<string, unknown>>('SELECT * FROM memory_facts WHERE id = ?', [id]);
  if (!row) throw new CoreError('not_found', `memory '${id}' not found`);
  return asFact(row);
}

export function listMemoryEvidence(db: CoreDatabase, memoryId: string): MemoryEvidenceRecord[] {
  return db.all<Record<string, unknown>>('SELECT * FROM memory_evidence WHERE memoryId = ? ORDER BY createdAt, id', [memoryId]).map(asEvidence);
}

export function listMemoryContradictions(db: CoreDatabase, memoryId: string): MemoryContradictionRecord[] {
  return db.all<Record<string, unknown>>(
    'SELECT * FROM memory_contradictions WHERE earlierMemoryId = ? OR laterMemoryId = ? ORDER BY detectedAt, id',
    [memoryId, memoryId],
  ).map(asContradiction);
}

export function listMemoryRelationships(db: CoreDatabase, memoryId: string): KnowledgeRelationshipRecord[] {
  return db.all<Record<string, unknown>>('SELECT * FROM knowledge_relationships WHERE memoryId = ? ORDER BY createdAt, id', [memoryId]).map(asRelationship);
}

export function getKnowledgeEntity(db: CoreDatabase, id: string): KnowledgeEntityRecord {
  const row = db.get<Record<string, unknown>>('SELECT * FROM knowledge_entities WHERE id = ?', [id]);
  if (!row) throw new CoreError('not_found', `knowledge entity '${id}' not found`);
  return asEntity(row);
}

function findEntity(db: CoreDatabase, entityType: KnowledgeEntityType, canonicalKey: string): KnowledgeEntityRecord | undefined {
  const row = db.get<Record<string, unknown>>('SELECT * FROM knowledge_entities WHERE entityType = ? AND canonicalKey = ?', [entityType, canonicalKey]);
  return row ? asEntity(row) : undefined;
}

// ---------------------------------------------------------------------------
// Entity validation / resolution
// ---------------------------------------------------------------------------

/** Repository files are stored as normalized repository-relative POSIX paths.
 * Absolute paths and traversal are rejected outright — a memory must never
 * become a pointer at arbitrary filesystem content. */
export function normalizeRepositoryFilePath(raw: string): string {
  const value = String(raw ?? '').trim().replace(/\\/g, '/');
  if (!value) throw new CoreError('invalid_request', 'repository_file canonical key must not be empty');
  if (/^[a-zA-Z]:\//.test(value) || value.startsWith('/') || value.startsWith('//')) {
    throw new CoreError('invalid_request', `repository_file path must be repository-relative, not absolute: '${raw}'`);
  }
  const segments = value.split('/').filter((segment) => segment.length > 0 && segment !== '.');
  if (segments.some((segment) => segment === '..')) {
    throw new CoreError('invalid_request', `repository_file path must not traverse outside the repository: '${raw}'`);
  }
  if (segments.length === 0) throw new CoreError('invalid_request', 'repository_file canonical key must name a file');
  return segments.join('/');
}

const GITHUB_ISSUE_KEY = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+#[1-9][0-9]{0,9}$/;

/** Canonical `owner/repository#number`. The graph stores the approved
 * reference only — M39 never performs a network write to GitHub. */
export function normalizeGithubIssueKey(raw: string): string {
  const value = String(raw ?? '').trim();
  if (!GITHUB_ISSUE_KEY.test(value)) {
    throw new CoreError('invalid_request', `github_issue canonical key must be 'owner/repository#number', got '${raw}'`);
  }
  return value;
}

/** A product record must resolve to a record Core already owns (project,
 * approved product request, or story) rather than becoming an unverifiable
 * opaque reference. */
export function resolveProductRecordKey(db: CoreDatabase, raw: string): { canonicalKey: string; label: string } {
  const value = String(raw ?? '').trim();
  if (!value) throw new CoreError('invalid_request', 'product_record canonical key must not be empty');
  const project = db.get<{ id: string; name: string }>('SELECT id, name FROM projects WHERE id = ? OR lower(name) = lower(?)', [value, value]);
  if (project) return { canonicalKey: project.id, label: project.name };
  const request = db.get<{ id: string; title: string }>('SELECT id, title FROM engineering_product_requests WHERE id = ?', [value]);
  if (request) return { canonicalKey: request.id, label: request.title };
  const story = db.get<{ id: string; title: string }>('SELECT id, title FROM stories WHERE id = ?', [value]);
  if (story) return { canonicalKey: story.id, label: story.title };
  throw new CoreError('invalid_request', `product_record '${raw}' does not resolve to a Core project, product request, or story`);
}

function upsertEntity(
  db: CoreDatabase,
  input: { entityType: KnowledgeEntityType; canonicalKey: string; label: string; scopeType?: string | null; scopeId?: string | null },
): KnowledgeEntityRecord {
  const existing = findEntity(db, input.entityType, input.canonicalKey);
  const now = nowIso();
  if (existing) {
    db.run('UPDATE knowledge_entities SET label = ?, updatedAt = ? WHERE id = ?', [input.label, now, existing.id]);
    return getKnowledgeEntity(db, existing.id);
  }
  const id = newId('kent');
  db.run(
    'INSERT INTO knowledge_entities (id, entityType, canonicalKey, label, scopeType, scopeId, state, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [id, input.entityType, input.canonicalKey, input.label, input.scopeType ?? null, input.scopeId ?? null, 'active', now, now],
  );
  return getKnowledgeEntity(db, id);
}

function upsertRelationship(
  db: CoreDatabase,
  input: {
    fromEntityId: string;
    relationshipType: KnowledgeRelationshipType;
    toEntityId: string;
    memoryId: string | null;
    evidenceId: string | null;
  },
): KnowledgeRelationshipRecord {
  const existing = db.get<Record<string, unknown>>(
    'SELECT * FROM knowledge_relationships WHERE fromEntityId = ? AND relationshipType = ? AND toEntityId = ? AND memoryId IS ?',
    [input.fromEntityId, input.relationshipType, input.toEntityId, input.memoryId],
  );
  if (existing) return asRelationship(existing);
  const now = nowIso();
  const id = newId('krel');
  db.run(
    'INSERT INTO knowledge_relationships (id, fromEntityId, relationshipType, toEntityId, validFrom, validTo, state, memoryId, evidenceId, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)',
    [id, input.fromEntityId, input.relationshipType, input.toEntityId, now, 'active', input.memoryId, input.evidenceId, now, now],
  );
  return asRelationship(db.get<Record<string, unknown>>('SELECT * FROM knowledge_relationships WHERE id = ?', [id])!);
}

// ---------------------------------------------------------------------------
// Remember
// ---------------------------------------------------------------------------

export interface AffectedEntityInput {
  type: KnowledgeEntityType;
  canonicalKey: string;
  label?: string;
  relationship?: KnowledgeRelationshipType;
}

export interface RememberMemoryInput {
  memoryType: MemoryType;
  scopeType: MemoryScopeType;
  scopeId: string;
  subject: string;
  predicate: string;
  value: string;
  sensitivity: MemorySensitivity;
  sourceConversationId: string;
  sourceMessageId: string;
  expiresAt?: string | null;
  affectedEntities?: AffectedEntityInput[];
  consentApprovalId?: string | null;
  toolInvocationId?: string | null;
  attemptId?: string | null;
  actor: string;
  clientId?: string | null;
}

export interface RememberMemoryResult {
  memory: MemoryFactRecord;
  evidence: MemoryEvidenceRecord[];
  entities: KnowledgeEntityRecord[];
  relationships: KnowledgeRelationshipRecord[];
  contradictions: MemoryContradictionRecord[];
  /** True when an identical approved write already existed — the second
   * dispatch created nothing. */
  deduplicated: boolean;
  redaction: { applied: boolean; rules: string[] };
}

function requireEnum<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  const candidate = String(value ?? '');
  if (!(allowed as readonly string[]).includes(candidate)) {
    throw new CoreError('invalid_request', `${field} must be one of ${allowed.join(', ')}, got '${candidate}'`);
  }
  return candidate as T;
}

function boundedString(value: unknown, max: number, field: string): string {
  const candidate = String(value ?? '').trim();
  if (!candidate) throw new CoreError('invalid_request', `${field} must not be empty`);
  if (candidate.length > max) throw new CoreError('invalid_request', `${field} must be at most ${max} characters`);
  return candidate;
}

/** Resolves the durable source and computes its content hash INSIDE Core. A
 * caller-supplied hash is never accepted (§6). */
function resolveEvidenceSource(
  db: CoreDatabase,
  conversationId: string,
  messageId: string,
): { conversationId: string; messageId: string; sha256: string } {
  const row = db.get<{ id: string; conversationId: string; role: string; content: string; createdAt: string }>(
    'SELECT id, conversationId, role, content, createdAt FROM conversation_messages WHERE id = ?',
    [messageId],
  );
  if (!row) throw new CoreError('invalid_request', `memory evidence source message '${messageId}' does not exist in Core`);
  if (row.conversationId !== conversationId) {
    throw new CoreError('invalid_request', `memory evidence source message '${messageId}' does not belong to conversation '${conversationId}'`);
  }
  return {
    conversationId: row.conversationId,
    messageId: row.id,
    sha256: sha256(`${MEMORY_PROVENANCE_VERSION}\n${row.id}\n${row.role}\n${row.content}`),
  };
}

/**
 * The stable write identity of a memory: its CONTENT, not the turn it was
 * said in. Restating the same decision in a later turn — a retry, a
 * redispatch, or the same action re-approved after a restart — must never
 * create a second durable fact, so the source message is deliberately NOT
 * part of this identity. A UNIQUE index on `memory_facts.writeIdentity`
 * enforces it at the database level, not merely in this function.
 */
function memoryWriteIdentity(parts: {
  memoryType: string; scopeType: string; scopeId: string; subject: string; predicate: string; normalizedValue: string;
}): string {
  return sha256(canonicalJson(parts));
}

/** Loads a memory plus its full graph/evidence projection. */
function projectMemory(db: CoreDatabase, memoryId: string, redaction: { applied: boolean; rules: string[] }, deduplicated: boolean): RememberMemoryResult {
  const relationships = listMemoryRelationships(db, memoryId);
  const entityIds = new Set<string>();
  for (const relationship of relationships) { entityIds.add(relationship.fromEntityId); entityIds.add(relationship.toEntityId); }
  return {
    memory: getMemoryFact(db, memoryId),
    evidence: listMemoryEvidence(db, memoryId),
    entities: [...entityIds].sort().map((id) => getKnowledgeEntity(db, id)),
    relationships,
    contradictions: listMemoryContradictions(db, memoryId),
    deduplicated,
    redaction,
  };
}

/**
 * One atomic transaction: validate the source, derive the evidence hash from
 * Core's own durable record, normalize, redact, validate/insert typed
 * entities, insert exactly one memory row, link evidence, insert
 * relationships, detect deterministic contradictions, and return everything.
 */
export function rememberMemory(db: CoreDatabase, input: RememberMemoryInput): RememberMemoryResult {
  const memoryType = requireEnum(input.memoryType, MEMORY_TYPES, 'memoryType');
  const scopeType = requireEnum(input.scopeType, MEMORY_SCOPE_TYPES, 'scopeType');
  const sensitivity = requireEnum(input.sensitivity, MEMORY_SENSITIVITIES, 'sensitivity');
  const scopeId = boundedString(input.scopeId, 200, 'scopeId');
  const subjectRaw = boundedString(input.subject, MAX_SUBJECT_CHARS, 'subject');
  const predicateRaw = boundedString(input.predicate, MAX_PREDICATE_CHARS, 'predicate');
  const valueRaw = boundedString(input.value, MAX_VALUE_CHARS, 'value');
  const affected = (input.affectedEntities ?? []).slice(0, MAX_AFFECTED_ENTITIES + 1);
  if (affected.length > MAX_AFFECTED_ENTITIES) {
    throw new CoreError('invalid_request', `at most ${MAX_AFFECTED_ENTITIES} affected entities may be supplied`);
  }
  if (input.expiresAt && Number.isNaN(Date.parse(input.expiresAt))) {
    throw new CoreError('invalid_request', 'expiresAt must be an ISO-8601 timestamp');
  }

  // Redaction happens before ANY M39 write. Restricted content that still
  // contains a secret after redaction cannot safely retain meaning, so it
  // fails closed with zero writes rather than storing a mangled fact.
  const subjectRedaction = redactMemoryText(subjectRaw);
  const predicateRedaction = redactMemoryText(predicateRaw);
  const valueRedaction = redactMemoryText(valueRaw);
  const redaction = {
    applied: subjectRedaction.redacted || predicateRedaction.redacted || valueRedaction.redacted,
    rules: [...new Set([...subjectRedaction.rules, ...predicateRedaction.rules, ...valueRedaction.rules])].sort(),
  };
  if (sensitivity === 'restricted' && redaction.applied) {
    throw new CoreError('invalid_request',
      `restricted memory content contains credential-shaped data (${redaction.rules.join(', ')}) that cannot be safely retained; no memory was written`);
  }

  const subject = normalizeMemoryText(subjectRedaction.text);
  const predicate = normalizeMemoryText(predicateRedaction.text);
  const normalizedValue = normalizeMemoryText(valueRedaction.text);
  if (!subject || !predicate || !normalizedValue) {
    throw new CoreError('invalid_request', 'subject, predicate, and value must each normalize to at least one token');
  }

  return db.transaction(() => {
    const source = resolveEvidenceSource(db, String(input.sourceConversationId ?? ''), String(input.sourceMessageId ?? ''));
    const writeIdentity = memoryWriteIdentity({ memoryType, scopeType, scopeId, subject, predicate, normalizedValue });

    // Database uniqueness + this lookup make a repeated approved dispatch a
    // no-op rather than a duplicate row — across a retry, a redispatch, and a
    // Core or Extension Host restart alike. A forgotten memory releases its
    // content identity (see `forgetMemory`), so re-remembering something that
    // was deliberately forgotten is still possible and creates a new record.
    const duplicate = db.get<Record<string, unknown>>('SELECT * FROM memory_facts WHERE writeIdentity = ?', [writeIdentity]);
    if (duplicate) {
      // A restatement is additional provenance for the SAME fact, never a
      // second fact. Link it once per distinct durable source.
      const memoryId = String(duplicate.id);
      const alreadyLinked = db.get<{ id: string }>(
        'SELECT id FROM memory_evidence WHERE memoryId = ? AND sourceMessageId = ?',
        [memoryId, source.messageId],
      );
      if (!alreadyLinked) {
        db.run(
          `INSERT INTO memory_evidence (id, memoryId, sourceType, sourceConversationId, sourceMessageId, sourceAttemptId, sourceInvocationId,
            sourceContentSha256, provenanceVersion, createdAt) VALUES (?, ?, 'conversation_message', ?, ?, ?, ?, ?, ?, ?)`,
          [newId('mevi'), memoryId, source.conversationId, source.messageId, input.attemptId ?? null, input.toolInvocationId ?? null,
            source.sha256, MEMORY_PROVENANCE_VERSION, nowIso()],
        );
      }
      return projectMemory(db, memoryId, redaction, true);
    }

    const now = nowIso();
    const memoryId = newId('mem');
    const structuredValue = {
      value: valueRedaction.text,
      normalizedValue,
      redacted: valueRedaction.redacted,
      redactionRules: valueRedaction.rules,
    };
    db.run(
      `INSERT INTO memory_facts (id, memoryType, scopeType, scopeId, subject, predicate, normalizedValue, displayValue, structuredValue,
        sensitivity, state, validFrom, validTo, expiresAt, createdAt, updatedAt, forgottenAt, consentApprovalId, toolInvocationId, revision, writeIdentity)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, NULL, ?, ?, ?, NULL, ?, ?, 1, ?)`,
      [
        memoryId, memoryType, scopeType, scopeId, subject, predicate, normalizedValue, valueRedaction.text,
        JSON.stringify(structuredValue), sensitivity, now, input.expiresAt ?? null, now, now,
        input.consentApprovalId ?? null, input.toolInvocationId ?? null, writeIdentity,
      ],
    );

    const evidenceId = newId('mevi');
    db.run(
      `INSERT INTO memory_evidence (id, memoryId, sourceType, sourceConversationId, sourceMessageId, sourceAttemptId, sourceInvocationId,
        sourceContentSha256, provenanceVersion, createdAt) VALUES (?, ?, 'conversation_message', ?, ?, ?, ?, ?, ?, ?)`,
      [evidenceId, memoryId, source.conversationId, source.messageId, input.attemptId ?? null, input.toolInvocationId ?? null,
        source.sha256, MEMORY_PROVENANCE_VERSION, now],
    );

    // The decision entity for this memory, plus its scope, plus every
    // validated affected entity. Entity keys are canonical so the same file /
    // issue / product record is reused across memories rather than duplicated.
    const decision = upsertEntity(db, {
      entityType: 'decision',
      canonicalKey: memoryId,
      label: valueRedaction.text.slice(0, 200),
      scopeType,
      scopeId,
    });
    const scopeEntityType: KnowledgeEntityType = scopeType === 'project' ? 'project' : scopeType === 'task' ? 'task' : scopeType === 'user' ? 'user' : 'product_record';
    if (scopeType === 'project' || scopeType === 'task' || scopeType === 'user') {
      const scopeEntity = upsertEntity(db, { entityType: scopeEntityType, canonicalKey: scopeId, label: scopeId, scopeType, scopeId });
      upsertRelationship(db, { fromEntityId: decision.id, relationshipType: 'scoped_to', toEntityId: scopeEntity.id, memoryId, evidenceId });
    }

    for (const entry of affected) {
      const entityType = requireEnum(entry.type, KNOWLEDGE_ENTITY_TYPES, 'affectedEntities[].type');
      const relationshipType = entry.relationship
        ? requireEnum(entry.relationship, KNOWLEDGE_RELATIONSHIP_TYPES, 'affectedEntities[].relationship')
        : 'affects';
      const rawKey = boundedString(entry.canonicalKey, 300, 'affectedEntities[].canonicalKey');
      let canonicalKey = rawKey;
      let label = entry.label ? boundedString(entry.label, 200, 'affectedEntities[].label') : rawKey;
      if (entityType === 'repository_file') {
        canonicalKey = normalizeRepositoryFilePath(rawKey);
        label = entry.label ? redactMemoryText(label).text : canonicalKey;
      } else if (entityType === 'github_issue') {
        canonicalKey = normalizeGithubIssueKey(rawKey);
        label = entry.label ? redactMemoryText(label).text : canonicalKey;
      } else if (entityType === 'product_record') {
        const resolved = resolveProductRecordKey(db, rawKey);
        canonicalKey = resolved.canonicalKey;
        label = entry.label ? redactMemoryText(label).text : resolved.label;
      } else {
        label = redactMemoryText(label).text;
      }
      const entity = upsertEntity(db, { entityType, canonicalKey, label, scopeType, scopeId });
      upsertRelationship(db, { fromEntityId: decision.id, relationshipType, toEntityId: entity.id, memoryId, evidenceId });
    }

    // Deterministic contradiction detection: same active scope + normalized
    // subject + normalized predicate, materially different normalized value.
    // Both facts are preserved; nothing is overwritten.
    const conflicting = db.all<Record<string, unknown>>(
      `SELECT * FROM memory_facts WHERE scopeType = ? AND scopeId = ? AND subject = ? AND predicate = ?
         AND normalizedValue <> ? AND state = 'active' AND id <> ? ORDER BY createdAt, id`,
      [scopeType, scopeId, subject, predicate, normalizedValue, memoryId],
    ).map(asFact);
    for (const earlier of conflicting) {
      const contradictionId = newId('mcon');
      db.run(
        `INSERT INTO memory_contradictions (id, earlierMemoryId, laterMemoryId, state, resolutionPolicy, authoritativeMemoryId,
          resolutionApprovalId, resolutionInvocationId, detectedAt, resolvedAt)
         VALUES (?, ?, ?, 'unresolved', NULL, NULL, NULL, NULL, ?, NULL)`,
        [contradictionId, earlier.id, memoryId, now],
      );
      const earlierDecision = findEntity(db, 'decision', earlier.id);
      if (earlierDecision) {
        upsertRelationship(db, { fromEntityId: decision.id, relationshipType: 'contradicts', toEntityId: earlierDecision.id, memoryId, evidenceId });
      }
    }

    recordRuntimeEvent(db, {
      domain: 'memory',
      entityId: memoryId,
      eventType: 'memory_remembered',
      actor: input.actor,
      clientId: input.clientId,
      metadata: {
        scopeType, scopeId, memoryType, sensitivity,
        contradictionCount: conflicting.length,
        redactionApplied: redaction.applied,
        consentApprovalId: input.consentApprovalId ?? null,
      },
      resultingRevision: 1,
    });

    return projectMemory(db, memoryId, redaction, false);
  });
}

// ---------------------------------------------------------------------------
// Recall
// ---------------------------------------------------------------------------

export interface RecallMemoriesInput {
  scopeType?: MemoryScopeType;
  scopeId?: string;
  subject?: string;
  predicate?: string;
  includeHistorical?: boolean;
  limit?: number;
}

/** True when a fact's own expiry has passed. Expiry is decided at read time —
 * a read never performs a hidden write. */
function isExpired(fact: MemoryFactRecord, atIso: string): boolean {
  return Boolean(fact.expiresAt) && fact.expiresAt! <= atIso;
}

/**
 * Deterministic retrieval. Defaults to active, non-expired, non-forgotten
 * memories. Contradictions are surfaced, never hidden, and every returned
 * entry carries its evidence — a fact with no resolvable evidence is never
 * returned as a durable fact.
 */
export function recallMemories(db: CoreDatabase, input: RecallMemoriesInput = {}): { entries: MemoryRecallEntry[]; recalledAt: string } {
  const recalledAt = nowIso();
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (input.scopeType) { clauses.push('scopeType = ?'); params.push(requireEnum(input.scopeType, MEMORY_SCOPE_TYPES, 'scopeType')); }
  if (input.scopeId) { clauses.push('scopeId = ?'); params.push(String(input.scopeId)); }
  if (input.subject) { clauses.push('subject = ?'); params.push(normalizeMemoryText(input.subject)); }
  if (input.predicate) { clauses.push('predicate = ?'); params.push(normalizeMemoryText(input.predicate)); }
  if (!input.includeHistorical) clauses.push("state IN ('active')");
  else clauses.push("state IN ('active', 'historical', 'expired')");
  const limit = Math.min(Math.max(Number(input.limit ?? MAX_RECALL_RESULTS), 1), MAX_RECALL_RESULTS);

  const rows = db.all<Record<string, unknown>>(
    `SELECT * FROM memory_facts ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY createdAt, id LIMIT ?`,
    [...params, limit],
  ).map(asFact);

  const entries: MemoryRecallEntry[] = [];
  for (const fact of rows) {
    // A forgotten fact is never active, regardless of any other filter.
    if (fact.state === 'forgotten') continue;
    const evidence = listMemoryEvidence(db, fact.id);
    const contradictions = listMemoryContradictions(db, fact.id);
    const expired = isExpired(fact, recalledAt);
    if (expired && !input.includeHistorical) continue;

    let kind: MemoryRecallEntry['kind'];
    if (evidence.length === 0) kind = 'inference';
    else if (expired) kind = 'expired_fact';
    else if (fact.state === 'historical') kind = 'historical_fact';
    else if (contradictions.some((entry) => entry.state === 'unresolved')) kind = 'unresolved_contradiction';
    else kind = 'durable_fact';

    entries.push({ kind, memory: fact, evidence, contradictions });
  }
  return { entries, recalledAt };
}

// ---------------------------------------------------------------------------
// Contradiction resolution
// ---------------------------------------------------------------------------

export interface ResolveMemoryContradictionInput {
  contradictionId: string;
  policy: MemoryResolutionPolicy;
  approvalId?: string | null;
  toolInvocationId?: string | null;
  actor: string;
  clientId?: string | null;
}

export interface ResolveMemoryContradictionResult {
  contradiction: MemoryContradictionRecord;
  earlier: MemoryFactRecord;
  later: MemoryFactRecord;
  authoritativeMemoryId: string | null;
  alreadyResolved: boolean;
}

/**
 * Explicit-policy resolution. Both original records are preserved and no
 * episodic history is rewritten — only authority/validity metadata changes.
 * Idempotent and restart-safe: re-resolving an already-resolved contradiction
 * with the same policy returns the existing terminal state.
 */
export function resolveMemoryContradiction(db: CoreDatabase, input: ResolveMemoryContradictionInput): ResolveMemoryContradictionResult {
  const policy = requireEnum(input.policy, MEMORY_RESOLUTION_POLICIES, 'policy');
  return db.transaction(() => {
    const row = db.get<Record<string, unknown>>('SELECT * FROM memory_contradictions WHERE id = ?', [input.contradictionId]);
    if (!row) throw new CoreError('not_found', `memory contradiction '${input.contradictionId}' not found`);
    const contradiction = asContradiction(row);
    if (contradiction.state === 'resolved') {
      if (contradiction.resolutionPolicy !== policy) {
        throw new CoreError('conflict', `memory contradiction '${contradiction.id}' was already resolved with policy '${contradiction.resolutionPolicy}'`);
      }
      return {
        contradiction,
        earlier: getMemoryFact(db, contradiction.earlierMemoryId),
        later: getMemoryFact(db, contradiction.laterMemoryId),
        authoritativeMemoryId: contradiction.authoritativeMemoryId,
        alreadyResolved: true,
      };
    }

    const now = nowIso();
    const earlier = getMemoryFact(db, contradiction.earlierMemoryId);
    const later = getMemoryFact(db, contradiction.laterMemoryId);
    let authoritative: string | null = null;
    const demote = (fact: MemoryFactRecord): void => {
      if (fact.state !== 'active') return;
      db.run('UPDATE memory_facts SET state = ?, validTo = ?, updatedAt = ?, revision = revision + 1 WHERE id = ?',
        ['historical', now, now, fact.id]);
    };

    if (policy === 'prefer_later') { authoritative = later.id; demote(earlier); }
    else if (policy === 'prefer_earlier') { authoritative = earlier.id; demote(later); }
    else if (policy === 'keep_both') { authoritative = null; }
    else {
      // scope_split: both remain authoritative within their own scope. Nothing
      // is demoted; the policy itself is the durable record of that decision.
      authoritative = null;
    }

    if (policy === 'prefer_later' || policy === 'prefer_earlier') {
      const winner = policy === 'prefer_later' ? later : earlier;
      const loser = policy === 'prefer_later' ? earlier : later;
      const winnerEntity = findEntity(db, 'decision', winner.id);
      const loserEntity = findEntity(db, 'decision', loser.id);
      if (winnerEntity && loserEntity) {
        upsertRelationship(db, {
          fromEntityId: winnerEntity.id, relationshipType: 'supersedes', toEntityId: loserEntity.id,
          memoryId: winner.id, evidenceId: listMemoryEvidence(db, winner.id)[0]?.id ?? null,
        });
      }
      // Relationships sourced from the demoted memory become historical, so
      // impact analysis stops reporting them as current.
      db.run("UPDATE knowledge_relationships SET state = 'historical', validTo = ?, updatedAt = ? WHERE memoryId = ? AND state = 'active' AND relationshipType <> 'supersedes'",
        [now, now, loser.id]);
    }

    db.run(
      `UPDATE memory_contradictions SET state = 'resolved', resolutionPolicy = ?, authoritativeMemoryId = ?,
        resolutionApprovalId = ?, resolutionInvocationId = ?, resolvedAt = ? WHERE id = ?`,
      [policy, authoritative, input.approvalId ?? null, input.toolInvocationId ?? null, now, contradiction.id],
    );

    recordRuntimeEvent(db, {
      domain: 'memory',
      entityId: contradiction.id,
      eventType: 'memory_contradiction_resolved',
      actor: input.actor,
      clientId: input.clientId,
      metadata: { policy, authoritativeMemoryId: authoritative, approvalId: input.approvalId ?? null },
      resultingRevision: null,
    });

    return {
      contradiction: asContradiction(db.get<Record<string, unknown>>('SELECT * FROM memory_contradictions WHERE id = ?', [contradiction.id])!),
      earlier: getMemoryFact(db, earlier.id),
      later: getMemoryFact(db, later.id),
      authoritativeMemoryId: authoritative,
      alreadyResolved: false,
    };
  });
}

// ---------------------------------------------------------------------------
// Forget (tombstone)
// ---------------------------------------------------------------------------

export interface ForgetMemoryInput {
  memoryId: string;
  approvalId?: string | null;
  toolInvocationId?: string | null;
  actor: string;
  clientId?: string | null;
}

export interface ForgetMemoryResult {
  memory: MemoryFactRecord;
  deactivatedRelationships: number;
  alreadyForgotten: boolean;
}

/**
 * M39's declared retention policy is tombstoning. The stored display and
 * structured values are scrubbed, the row is marked forgotten, and only the
 * minimum audit metadata needed to prove the governed deletion is retained.
 * Relationships sourced only from this memory are deactivated. Evidence rows
 * are retained (they prove which source authorized the original write) but
 * carry no memory content themselves.
 */
export function forgetMemory(db: CoreDatabase, input: ForgetMemoryInput): ForgetMemoryResult {
  return db.transaction(() => {
    const fact = getMemoryFact(db, input.memoryId);
    if (fact.state === 'forgotten') {
      return { memory: fact, deactivatedRelationships: 0, alreadyForgotten: true };
    }
    const now = nowIso();
    const tombstone = {
      tombstone: true,
      forgottenAt: now,
      originalSensitivity: fact.sensitivity,
      approvalId: input.approvalId ?? null,
    };
    // Releasing the content write identity is part of the retention policy:
    // a deliberately forgotten memory must not permanently block the user
    // from choosing to remember that fact again later. The tombstone keeps a
    // derived, still-unique identity so the governed deletion stays auditable.
    db.run(
      `UPDATE memory_facts SET state = 'forgotten', forgottenAt = ?, validTo = ?, updatedAt = ?,
        displayValue = '[forgotten]', structuredValue = ?, normalizedValue = '[forgotten]',
        writeIdentity = ?, revision = revision + 1 WHERE id = ?`,
      [now, now, now, JSON.stringify(tombstone), `${fact.writeIdentity}:forgotten:${fact.id}`, fact.id],
    );
    const deactivated = db.run(
      "UPDATE knowledge_relationships SET state = 'historical', validTo = ?, updatedAt = ? WHERE memoryId = ? AND state = 'active'",
      [now, now, fact.id],
    );
    const decisionEntity = findEntity(db, 'decision', fact.id);
    if (decisionEntity) {
      db.run("UPDATE knowledge_entities SET state = 'retired', label = '[forgotten]', updatedAt = ? WHERE id = ?", [now, decisionEntity.id]);
    }
    recordRuntimeEvent(db, {
      domain: 'memory',
      entityId: fact.id,
      eventType: 'memory_forgotten',
      actor: input.actor,
      clientId: input.clientId,
      metadata: { approvalId: input.approvalId ?? null, scopeType: fact.scopeType, scopeId: fact.scopeId },
      resultingRevision: fact.revision + 1,
    });
    return {
      memory: getMemoryFact(db, fact.id),
      deactivatedRelationships: Number(deactivated.changes ?? 0),
      alreadyForgotten: false,
    };
  });
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export interface ExportMemoryInput {
  memoryId?: string;
  scopeType?: MemoryScopeType;
  scopeId?: string;
}

/** Stable, deterministically-ordered auditable JSON: lifecycle, scope, type,
 * evidence links and hashes, contradiction history, entities, relationships,
 * redaction/tombstone state, and the provenance/schema version. */
export function exportMemory(db: CoreDatabase, input: ExportMemoryInput = {}): Record<string, unknown> {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (input.memoryId) { clauses.push('id = ?'); params.push(String(input.memoryId)); }
  if (input.scopeType) { clauses.push('scopeType = ?'); params.push(requireEnum(input.scopeType, MEMORY_SCOPE_TYPES, 'scopeType')); }
  if (input.scopeId) { clauses.push('scopeId = ?'); params.push(String(input.scopeId)); }
  const facts = db.all<Record<string, unknown>>(
    `SELECT * FROM memory_facts ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY createdAt, id`,
    params,
  ).map(asFact);

  const memories = facts.map((fact) => {
    const relationships = listMemoryRelationships(db, fact.id);
    const entityIds = [...new Set(relationships.flatMap((r) => [r.fromEntityId, r.toEntityId]))].sort();
    return {
      id: fact.id,
      memoryType: fact.memoryType,
      scopeType: fact.scopeType,
      scopeId: fact.scopeId,
      subject: fact.subject,
      predicate: fact.predicate,
      displayValue: fact.displayValue,
      structuredValue: fact.structuredValue,
      sensitivity: fact.sensitivity,
      state: fact.state,
      tombstoned: fact.state === 'forgotten',
      redacted: Boolean((fact.structuredValue as { redacted?: boolean } | null)?.redacted),
      validFrom: fact.validFrom,
      validTo: fact.validTo,
      expiresAt: fact.expiresAt,
      createdAt: fact.createdAt,
      updatedAt: fact.updatedAt,
      forgottenAt: fact.forgottenAt,
      consentApprovalId: fact.consentApprovalId,
      toolInvocationId: fact.toolInvocationId,
      revision: fact.revision,
      evidence: listMemoryEvidence(db, fact.id).map((entry) => ({
        id: entry.id,
        sourceType: entry.sourceType,
        sourceConversationId: entry.sourceConversationId,
        sourceMessageId: entry.sourceMessageId,
        sourceAttemptId: entry.sourceAttemptId,
        sourceInvocationId: entry.sourceInvocationId,
        sourceContentSha256: entry.sourceContentSha256,
        provenanceVersion: entry.provenanceVersion,
        createdAt: entry.createdAt,
      })),
      contradictions: listMemoryContradictions(db, fact.id).map((entry) => ({ ...entry })),
      entities: entityIds.map((id) => ({ ...getKnowledgeEntity(db, id) })),
      relationships: relationships.map((entry) => ({ ...entry })),
    };
  });

  return {
    schemaVersion: MEMORY_EXPORT_SCHEMA_VERSION,
    provenanceVersion: MEMORY_PROVENANCE_VERSION,
    filter: {
      memoryId: input.memoryId ?? null,
      scopeType: input.scopeType ?? null,
      scopeId: input.scopeId ?? null,
    },
    memoryCount: memories.length,
    memories,
  };
}

// ---------------------------------------------------------------------------
// Impact analysis (bounded, cycle-safe traversal)
// ---------------------------------------------------------------------------

export interface AnalyzeMemoryImpactInput {
  memoryId?: string;
  entityId?: string;
  maxDepth?: number;
}

export interface AnalyzeMemoryImpactResult {
  originEntityId: string;
  maxDepth: number;
  truncated: boolean;
  entries: MemoryImpactEntry[];
  byEntityType: Record<string, MemoryImpactEntry[]>;
}

/**
 * Breadth-first walk of ACTIVE typed relationships from a memory's decision
 * entity (or an explicit entity), bounded in depth and node count and
 * cycle-safe by construction — the same discipline
 * `core/domain/dependencies.ts` already uses for story dependencies, not a
 * graph engine. Every returned entry carries the relationship path and the
 * evidence supporting every hop; an edge without supporting evidence is never
 * traversed.
 */
export function analyzeMemoryImpact(db: CoreDatabase, input: AnalyzeMemoryImpactInput): AnalyzeMemoryImpactResult {
  const maxDepth = Math.min(Math.max(Number(input.maxDepth ?? MAX_IMPACT_DEPTH), 1), MAX_IMPACT_DEPTH);
  let originEntityId = input.entityId ? String(input.entityId) : '';
  if (!originEntityId) {
    if (!input.memoryId) throw new CoreError('invalid_request', 'memoryId or entityId is required for impact analysis');
    const fact = getMemoryFact(db, String(input.memoryId));
    const decision = findEntity(db, 'decision', fact.id);
    if (!decision) throw new CoreError('not_found', `memory '${fact.id}' has no decision entity to analyze`);
    originEntityId = decision.id;
  }
  getKnowledgeEntity(db, originEntityId); // fail closed on an unknown origin

  const visited = new Set<string>([originEntityId]);
  const entries: MemoryImpactEntry[] = [];
  let truncated = false;
  let frontier: Array<{ entityId: string; path: MemoryImpactEntry['path']; evidenceIds: string[] }> = [
    { entityId: originEntityId, path: [], evidenceIds: [] },
  ];

  for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
    const next: typeof frontier = [];
    for (const node of frontier) {
      const edges = db.all<Record<string, unknown>>(
        "SELECT * FROM knowledge_relationships WHERE fromEntityId = ? AND state = 'active' ORDER BY relationshipType, toEntityId, id",
        [node.entityId],
      ).map(asRelationship);
      for (const edge of edges) {
        // Every hop must be evidence-backed; an edge with no evidence is not
        // a fact and is never surfaced as impact.
        if (!edge.evidenceId) continue;
        if (visited.has(edge.toEntityId)) continue; // cycle-safe: never revisit
        if (visited.size >= MAX_IMPACT_NODES) { truncated = true; break; }
        visited.add(edge.toEntityId);
        const path = [...node.path, {
          fromEntityId: edge.fromEntityId,
          relationshipType: edge.relationshipType,
          toEntityId: edge.toEntityId,
          relationshipId: edge.id,
        }];
        const evidenceIds = [...node.evidenceIds, edge.evidenceId];
        const entity = getKnowledgeEntity(db, edge.toEntityId);
        if (entity.state === 'active') entries.push({ entity, depth, path, evidenceIds });
        next.push({ entityId: edge.toEntityId, path, evidenceIds });
      }
      if (truncated) break;
    }
    if (truncated) break;
    frontier = next;
  }

  entries.sort((a, b) => (a.depth - b.depth)
    || a.entity.entityType.localeCompare(b.entity.entityType)
    || a.entity.canonicalKey.localeCompare(b.entity.canonicalKey));
  const byEntityType: Record<string, MemoryImpactEntry[]> = {};
  for (const entry of entries) {
    (byEntityType[entry.entity.entityType] ??= []).push(entry);
  }
  return { originEntityId, maxDepth, truncated, entries, byEntityType };
}
