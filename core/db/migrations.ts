import * as crypto from 'node:crypto';
import type { CoreDatabase } from './connection';

export interface Migration {
  version: number;
  description: string;
  sql: string;
}

// Migration 1: bootstrap tables that the migration runner itself depends on.
const MIGRATION_1_BOOTSTRAP = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  description TEXT NOT NULL,
  appliedAt TEXT NOT NULL,
  checksum TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS core_metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);
`;

// Migration 2: the full M31 domain schema.
const MIGRATION_2_DOMAIN = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  archivedAt TEXT,
  defaultRepositoryId TEXT,
  productContext TEXT,
  policyMetadata TEXT,
  revision INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS project_aliases (
  id TEXT PRIMARY KEY,
  projectId TEXT NOT NULL REFERENCES projects(id),
  alias TEXT NOT NULL UNIQUE,
  createdAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_project_aliases_project ON project_aliases(projectId);

CREATE TABLE IF NOT EXISTS repositories (
  id TEXT PRIMARY KEY,
  projectId TEXT NOT NULL REFERENCES projects(id),
  name TEXT NOT NULL,
  remoteUrl TEXT,
  defaultBranch TEXT,
  kind TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  archivedAt TEXT,
  revision INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_repositories_project ON repositories(projectId);

CREATE TABLE IF NOT EXISTS repository_locations (
  id TEXT PRIMARY KEY,
  repositoryId TEXT NOT NULL REFERENCES repositories(id),
  nodeIdentity TEXT NOT NULL,
  localPath TEXT NOT NULL,
  availability TEXT NOT NULL,
  gitCapable INTEGER NOT NULL DEFAULT 0,
  remoteCapable INTEGER NOT NULL DEFAULT 0,
  lastObservedAt TEXT NOT NULL,
  repositoryRootIdentity TEXT,
  currentBranch TEXT,
  isClean INTEGER,
  capability TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_repository_locations_repo ON repository_locations(repositoryId);

CREATE TABLE IF NOT EXISTS stories (
  id TEXT PRIMARY KEY,
  projectId TEXT NOT NULL REFERENCES projects(id),
  repositoryId TEXT REFERENCES repositories(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  acceptanceCriteria TEXT NOT NULL DEFAULT '[]',
  priority TEXT,
  status TEXT NOT NULL,
  storyType TEXT NOT NULL,
  parentId TEXT REFERENCES stories(id),
  assignee TEXT,
  source TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  archivedAt TEXT,
  revision INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_stories_project ON stories(projectId);
CREATE INDEX IF NOT EXISTS idx_stories_status ON stories(status);
CREATE INDEX IF NOT EXISTS idx_stories_parent ON stories(parentId);

CREATE TABLE IF NOT EXISTS story_dependencies (
  id TEXT PRIMARY KEY,
  storyId TEXT NOT NULL REFERENCES stories(id),
  dependsOnStoryId TEXT NOT NULL REFERENCES stories(id),
  dependencyType TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  UNIQUE(storyId, dependsOnStoryId, dependencyType)
);
CREATE INDEX IF NOT EXISTS idx_story_dependencies_story ON story_dependencies(storyId);

CREATE TABLE IF NOT EXISTS story_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  storyId TEXT NOT NULL REFERENCES stories(id),
  eventType TEXT NOT NULL,
  actor TEXT NOT NULL,
  clientId TEXT,
  idempotencyKey TEXT,
  createdAt TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  resultingRevision INTEGER
);
CREATE INDEX IF NOT EXISTS idx_story_events_story ON story_events(storyId);

CREATE TABLE IF NOT EXISTS story_comments (
  id TEXT PRIMARY KEY,
  storyId TEXT NOT NULL REFERENCES stories(id),
  author TEXT NOT NULL,
  body TEXT NOT NULL,
  createdAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_story_comments_story ON story_comments(storyId);

CREATE TABLE IF NOT EXISTS client_devices (
  id TEXT PRIMARY KEY,
  clientType TEXT NOT NULL,
  clientVersion TEXT NOT NULL,
  firstSeenAt TEXT NOT NULL,
  lastSeenAt TEXT NOT NULL,
  deviceLabel TEXT,
  compatibilityStatus TEXT NOT NULL DEFAULT 'compatible'
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key TEXT NOT NULL,
  clientId TEXT NOT NULL,
  routeId TEXT NOT NULL,
  requestHash TEXT NOT NULL,
  responseStatus INTEGER,
  responseBody TEXT,
  createdAt TEXT NOT NULL,
  PRIMARY KEY (key, clientId, routeId)
);

CREATE TABLE IF NOT EXISTS legacy_migration_sources (
  id TEXT PRIMARY KEY,
  sourcePathCanonical TEXT NOT NULL,
  contentDigest TEXT NOT NULL,
  importedAt TEXT NOT NULL,
  projectId TEXT REFERENCES projects(id),
  recordsMigrated INTEGER NOT NULL DEFAULT 0,
  recordsSkipped INTEGER NOT NULL DEFAULT 0,
  recordsFailed INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  UNIQUE(sourcePathCanonical, contentDigest)
);
`;

// Migration 3: M32 durable agent-runtime schema (conversations, immutable request
// envelopes, execution attempts, model/tool invocations, approvals, checkpoints).
// Additive only â€” does not touch any M31 table, index, or the story_events sequence.
const MIGRATION_3_RUNTIME = `
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  mode TEXT NOT NULL,
  projectId TEXT REFERENCES projects(id),
  repositoryId TEXT REFERENCES repositories(id),
  title TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  archivedAt TEXT,
  revision INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_conversations_project ON conversations(projectId);

CREATE TABLE IF NOT EXISTS conversation_messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  conversationId TEXT NOT NULL REFERENCES conversations(id),
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  modelInvocationId TEXT,
  createdAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conversation_messages_conversation ON conversation_messages(conversationId);

-- Immutable request envelope: one row per user submission, never updated after insert.
CREATE TABLE IF NOT EXISTS requests (
  id TEXT PRIMARY KEY,
  createdAt TEXT NOT NULL,
  clientId TEXT NOT NULL,
  currentMessage TEXT NOT NULL,
  requestedMode TEXT NOT NULL,
  resolvedMode TEXT NOT NULL,
  routeReason TEXT NOT NULL,
  conversationId TEXT REFERENCES conversations(id),
  storyId TEXT REFERENCES stories(id),
  projectId TEXT REFERENCES projects(id),
  repositoryId TEXT REFERENCES repositories(id),
  repositoryLocationId TEXT REFERENCES repository_locations(id),
  requestedProvider TEXT,
  requestedModel TEXT,
  toolPermissionPolicy TEXT NOT NULL DEFAULT '{}',
  contextPolicy TEXT NOT NULL DEFAULT '{}',
  correlationId TEXT NOT NULL,
  idempotencyKey TEXT
);
CREATE INDEX IF NOT EXISTS idx_requests_conversation ON requests(conversationId);
CREATE INDEX IF NOT EXISTS idx_requests_story ON requests(storyId);

CREATE TABLE IF NOT EXISTS attempts (
  id TEXT PRIMARY KEY,
  requestId TEXT NOT NULL REFERENCES requests(id),
  predecessorAttemptId TEXT REFERENCES attempts(id),
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  startedAt TEXT,
  completedAt TEXT,
  cancelledAt TEXT,
  cancelRequestedAt TEXT,
  failureReason TEXT,
  claimOwner TEXT,
  claimExpiresAt TEXT,
  revision INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_attempts_request ON attempts(requestId);
CREATE INDEX IF NOT EXISTS idx_attempts_status ON attempts(status);
CREATE INDEX IF NOT EXISTS idx_attempts_predecessor ON attempts(predecessorAttemptId);

-- Append-only runtime event stream, parallel to (never merged with) story_events.
-- Covers conversation/request/attempt/model-invocation/tool-invocation/approval activity.
CREATE TABLE IF NOT EXISTS runtime_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  domain TEXT NOT NULL,
  entityId TEXT NOT NULL,
  eventType TEXT NOT NULL,
  actor TEXT NOT NULL,
  clientId TEXT,
  idempotencyKey TEXT,
  createdAt TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  resultingRevision INTEGER
);
CREATE INDEX IF NOT EXISTS idx_runtime_events_entity ON runtime_events(domain, entityId);

CREATE TABLE IF NOT EXISTS model_invocations (
  id TEXT PRIMARY KEY,
  attemptId TEXT NOT NULL REFERENCES attempts(id),
  requestedProvider TEXT,
  requestedModel TEXT,
  policyProvider TEXT,
  policyModel TEXT,
  actualProvider TEXT,
  actualModel TEXT,
  fallbackUsed INTEGER NOT NULL DEFAULT 0,
  fallbackReason TEXT,
  status TEXT NOT NULL,
  startedAt TEXT NOT NULL,
  endedAt TEXT,
  latencyMs INTEGER,
  usageMetadata TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_model_invocations_attempt ON model_invocations(attemptId);

CREATE TABLE IF NOT EXISTS tool_invocations (
  id TEXT PRIMARY KEY,
  attemptId TEXT NOT NULL REFERENCES attempts(id),
  toolName TEXT NOT NULL,
  argsSummary TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL,
  startedAt TEXT NOT NULL,
  endedAt TEXT,
  exitCode INTEGER,
  evidence TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_tool_invocations_attempt ON tool_invocations(attemptId);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  attemptId TEXT NOT NULL REFERENCES attempts(id),
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  requestedAt TEXT NOT NULL,
  resolvedAt TEXT,
  resolution TEXT,
  summary TEXT NOT NULL DEFAULT '{}',
  claimOwner TEXT,
  claimExpiresAt TEXT,
  revision INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_approvals_attempt ON approvals(attemptId);
CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status);

CREATE TABLE IF NOT EXISTS checkpoints (
  id TEXT PRIMARY KEY,
  attemptId TEXT NOT NULL REFERENCES attempts(id),
  kind TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_checkpoints_attempt ON checkpoints(attemptId);
`;

// Migration 4: fencing generation on attempts (M32 correction, audit F1/F3/F4).
// A fenced executor lease issues a generation token; every state mutation on a
// fenced attempt must present the current token, so a superseded (stale)
// executor is rejected. Additive forward migration â€” migration 3 is NOT mutated
// in place (per the M32 additive-migration rule). `ALTER TABLE ... ADD COLUMN`
// is idempotent-by-migration-ledger: it runs exactly once because version 4 is
// recorded in schema_migrations after it succeeds.
const MIGRATION_4_FENCE = `
ALTER TABLE attempts ADD COLUMN fenceToken TEXT;
ALTER TABLE attempts ADD COLUMN fenceGeneration INTEGER NOT NULL DEFAULT 0;
`;

// Migration 5: one immutable, hash-verified execution context per attempt and
// the minimum durable approval envelope bound to that frozen context.
const MIGRATION_5_ATTEMPT_CONTEXT_APPROVAL_ENVELOPE = `
CREATE TABLE IF NOT EXISTS attempt_contexts (
  id TEXT PRIMARY KEY,
  contextIdentity TEXT NOT NULL,
  requestId TEXT NOT NULL REFERENCES requests(id),
  attemptId TEXT NOT NULL UNIQUE REFERENCES attempts(id),
  resolvedMode TEXT NOT NULL,
  workspaceRoot TEXT,
  repositoryId TEXT,
  repositoryLocationId TEXT,
  taskInput TEXT NOT NULL,
  selectedProvider TEXT NOT NULL,
  selectedModel TEXT NOT NULL,
  permittedCapabilities TEXT NOT NULL,
  approvalPolicy TEXT NOT NULL,
  schemaVersion INTEGER NOT NULL,
  createdAt TEXT NOT NULL,
  contextHash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attempt_contexts_identity ON attempt_contexts(contextIdentity);
CREATE TRIGGER IF NOT EXISTS attempt_contexts_no_update
BEFORE UPDATE ON attempt_contexts BEGIN
  SELECT RAISE(ABORT, 'attempt_context_immutable');
END;
CREATE TRIGGER IF NOT EXISTS attempt_contexts_no_delete
BEFORE DELETE ON attempt_contexts BEGIN
  SELECT RAISE(ABORT, 'attempt_context_immutable');
END;

ALTER TABLE approvals ADD COLUMN envelopeVersion INTEGER NOT NULL DEFAULT 0;
ALTER TABLE approvals ADD COLUMN expectedAttemptRevision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE approvals ADD COLUMN expectedAttemptStatus TEXT NOT NULL DEFAULT '';
ALTER TABLE approvals ADD COLUMN requestedActionDigest TEXT NOT NULL DEFAULT '';
ALTER TABLE approvals ADD COLUMN frozenContextHash TEXT NOT NULL DEFAULT '';
UPDATE approvals
SET status = 'expired', resolvedAt = COALESCE(resolvedAt, requestedAt), revision = revision + 1
WHERE envelopeVersion = 0 AND status = 'pending';
`;

// Migration 6: immutable M34 execution-quality inputs. Existing attempt rows
// remain hash-compatible because null optional fields are omitted from their
// original canonical material; new attempts freeze the explainable selection
// snapshot and optional retry guidance in their own context row.
const MIGRATION_6_EXECUTION_QUALITY_CONTEXT = `
ALTER TABLE attempt_contexts ADD COLUMN modelSelection TEXT;
ALTER TABLE attempt_contexts ADD COLUMN retryGuidance TEXT;
`;

// Migration 7: M36 durable attachment vertical slice. Additive only â€” does not
// touch any M32/M34 table or column in place. Attachment bytes never live in
// this table (see `storageRelativePath`, a Core-data-dir-relative path only);
// the actual file lives under the Core-owned attachments directory outside the
// repository. `message_attachments.attachmentId` is UNIQUE so one attachment
// can never be linked to more than one message.
const MIGRATION_7_ATTACHMENTS = `
CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  conversationId TEXT NOT NULL REFERENCES conversations(id),
  originalName TEXT NOT NULL,
  declaredMimeType TEXT NOT NULL,
  detectedMimeType TEXT,
  kind TEXT NOT NULL,
  byteSize INTEGER NOT NULL,
  sha256 TEXT,
  storageRelativePath TEXT,
  status TEXT NOT NULL,
  errorCode TEXT,
  errorMessageRedacted TEXT,
  createdAt TEXT NOT NULL,
  readyAt TEXT,
  deletedAt TEXT,
  revision INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_attachments_conversation ON attachments(conversationId);
CREATE INDEX IF NOT EXISTS idx_attachments_status ON attachments(status);

CREATE TABLE IF NOT EXISTS message_attachments (
  messageId TEXT NOT NULL REFERENCES conversation_messages(id),
  attachmentId TEXT NOT NULL UNIQUE REFERENCES attachments(id),
  ordinal INTEGER NOT NULL,
  PRIMARY KEY (messageId, attachmentId)
);
CREATE INDEX IF NOT EXISTS idx_message_attachments_message ON message_attachments(messageId);

ALTER TABLE attempt_contexts ADD COLUMN attachments TEXT;
`;

// Migration 8: M36 pass 2 â€” document extraction and audio transcription
// evidence. Purely additive columns on the existing `attachments` table
// (nullable, defaulted) so no pass-1 row or code path is disturbed;
// `localProcessingCapability` defaults to 'not_applicable' for every
// pre-existing text/image row (correct, since neither kind ever needed
// local processing).
const MIGRATION_8_DOCUMENT_AUDIO_PROCESSING = `
ALTER TABLE attachments ADD COLUMN extraction TEXT;
ALTER TABLE attachments ADD COLUMN transcription TEXT;
ALTER TABLE attachments ADD COLUMN localProcessingCapability TEXT NOT NULL DEFAULT 'not_applicable';
`;

const MIGRATION_9_GOVERNED_RESEARCH = `
CREATE TABLE IF NOT EXISTS research_sessions (
 id TEXT PRIMARY KEY, conversationId TEXT NOT NULL REFERENCES conversations(id), originatingUserMessageId TEXT NOT NULL REFERENCES conversation_messages(id), approvalId TEXT NOT NULL UNIQUE, normalizedQuery TEXT NOT NULL, provider TEXT NOT NULL, state TEXT NOT NULL, createdAt TEXT NOT NULL, startedAt TEXT, completedAt TEXT, failureClassification TEXT
);
CREATE INDEX IF NOT EXISTS idx_research_sessions_conversation ON research_sessions(conversationId);
CREATE TABLE IF NOT EXISTS research_approvals (
 id TEXT PRIMARY KEY, researchId TEXT NOT NULL UNIQUE REFERENCES research_sessions(id), status TEXT NOT NULL, requestedAt TEXT NOT NULL, resolvedAt TEXT, requestedActionDigest TEXT NOT NULL, summary TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS research_sources (
 id TEXT PRIMARY KEY, researchId TEXT NOT NULL REFERENCES research_sessions(id), resultRank INTEGER NOT NULL, normalizedUrl TEXT NOT NULL, finalUrl TEXT, title TEXT, provider TEXT NOT NULL, retrievedAt TEXT, httpStatus INTEGER, contentType TEXT, extractedTextHash TEXT, rawResponseHash TEXT, extractedText TEXT, status TEXT NOT NULL, failure TEXT, provenanceVersion INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_research_sources_research ON research_sources(researchId, resultRank);
CREATE TABLE IF NOT EXISTS citations (
 id TEXT PRIMARY KEY, assistantMessageId TEXT NOT NULL REFERENCES conversation_messages(id), sourceId TEXT NOT NULL REFERENCES research_sources(id), visibleLabel TEXT NOT NULL, evidenceReference TEXT, validationStatus TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_citations_message ON citations(assistantMessageId);
`;

// Migration 10: M36 workbench completion.  Branch ancestry and answer
// alternatives are additive projections; conversation messages and their
// attachment/citation evidence remain append-only and Core-owned.
const MIGRATION_10_WORKBENCH = `
CREATE TABLE IF NOT EXISTS conversation_branches (
 conversationId TEXT PRIMARY KEY REFERENCES conversations(id),
 parentConversationId TEXT NOT NULL REFERENCES conversations(id),
 branchPointMessageId TEXT NOT NULL REFERENCES conversation_messages(id),
 createdAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conversation_branches_parent ON conversation_branches(parentConversationId);
CREATE TABLE IF NOT EXISTS response_alternatives (
 id TEXT PRIMARY KEY,
 conversationId TEXT NOT NULL REFERENCES conversations(id),
 userMessageId TEXT NOT NULL REFERENCES conversation_messages(id),
 assistantMessageId TEXT NOT NULL UNIQUE REFERENCES conversation_messages(id),
 ordinal INTEGER NOT NULL,
 active INTEGER NOT NULL DEFAULT 0,
 createdAt TEXT NOT NULL,
 UNIQUE(conversationId, userMessageId, ordinal)
);
CREATE INDEX IF NOT EXISTS idx_response_alternatives_user ON response_alternatives(conversationId, userMessageId);
CREATE TABLE IF NOT EXISTS regeneration_requests (
 attemptId TEXT PRIMARY KEY REFERENCES attempts(id),
 conversationId TEXT NOT NULL REFERENCES conversations(id),
 originalAssistantMessageId TEXT NOT NULL REFERENCES conversation_messages(id),
 userMessageId TEXT NOT NULL REFERENCES conversation_messages(id),
 createdAt TEXT NOT NULL
);
`;

// Migration 11: M37 makes the engineering-company projection Core-owned. The
// canonical board stays in `stories`; these records only hold lifecycle facts
// that cannot fit in a story row (sprint membership, assignment, CI lineage).
const MIGRATION_11_ENGINEERING_ORGANIZATION = `
CREATE TABLE IF NOT EXISTS engineering_product_requests (
 id TEXT PRIMARY KEY, projectId TEXT NOT NULL REFERENCES projects(id), repositoryId TEXT REFERENCES repositories(id),
 title TEXT NOT NULL, goal TEXT NOT NULL, acceptanceCriteria TEXT NOT NULL, definitionOfReady TEXT NOT NULL,
 definitionOfDone TEXT NOT NULL, dependencies TEXT NOT NULL, estimatedPoints INTEGER NOT NULL, status TEXT NOT NULL,
 storyId TEXT UNIQUE REFERENCES stories(id), approvedAt TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_engineering_product_requests_project ON engineering_product_requests(projectId, status);
CREATE TABLE IF NOT EXISTS engineering_sprints (
 id TEXT PRIMARY KEY, projectId TEXT NOT NULL REFERENCES projects(id), repositoryId TEXT REFERENCES repositories(id),
 name TEXT NOT NULL, goal TEXT NOT NULL, state TEXT NOT NULL, capacityPoints INTEGER NOT NULL, wipLimit INTEGER NOT NULL,
 createdAt TEXT NOT NULL, startedAt TEXT, completedAt TEXT, review TEXT, retrospective TEXT
);
CREATE TABLE IF NOT EXISTS engineering_sprint_items (
 sprintId TEXT NOT NULL REFERENCES engineering_sprints(id), storyId TEXT NOT NULL UNIQUE REFERENCES stories(id), ordinal INTEGER NOT NULL,
 estimatedPoints INTEGER NOT NULL, state TEXT NOT NULL, PRIMARY KEY(sprintId, storyId)
);
CREATE INDEX IF NOT EXISTS idx_engineering_sprint_items_active ON engineering_sprint_items(sprintId, state, ordinal);
CREATE TABLE IF NOT EXISTS engineering_assignments (
 id TEXT PRIMARY KEY, sprintId TEXT NOT NULL REFERENCES engineering_sprints(id), storyId TEXT NOT NULL REFERENCES stories(id),
 attemptId TEXT UNIQUE REFERENCES attempts(id), workerId TEXT NOT NULL, leaseToken TEXT NOT NULL UNIQUE, leaseExpiresAt TEXT NOT NULL,
 state TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, UNIQUE(sprintId, storyId, state)
);
CREATE INDEX IF NOT EXISTS idx_engineering_assignments_story ON engineering_assignments(storyId, state);
CREATE TABLE IF NOT EXISTS engineering_ci_evidence (
 id TEXT PRIMARY KEY, storyId TEXT NOT NULL REFERENCES stories(id), sourceAttemptId TEXT REFERENCES attempts(id),
 repairStoryId TEXT REFERENCES stories(id), repairAttemptId TEXT REFERENCES attempts(id), pullRequestUrl TEXT NOT NULL, headSha TEXT NOT NULL,
 runId TEXT NOT NULL UNIQUE, conclusion TEXT NOT NULL, failureFingerprint TEXT, diagnosis TEXT, regressionTests TEXT NOT NULL DEFAULT '[]',
 replacementRunId TEXT, replacementHeadSha TEXT, reviewedAt TEXT, mergedAt TEXT, mergedBy TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_engineering_ci_story ON engineering_ci_evidence(storyId, createdAt);
`;

// Migration 12: M38 Core Saath Kar execution checkpoint. Not a second workflow
// engine or evidence authority â€” approvals/tool_invocations/attempts remain
// authoritative; this table only lets `RuntimeExecutor.runAgentLoop` resume the
// exact in-flight model-tool-calling turn (assistant tool-call framing, ordered
// tool results already fed to the model, and the pending/remaining tool calls)
// across an Extension Host or Core restart while suspended on a governed
// capability approval. One row per attempt; deleted once the attempt is terminal.
const MIGRATION_12_LOOP_CONTINUATION = `
CREATE TABLE IF NOT EXISTS attempt_loop_continuations (
  attemptId TEXT PRIMARY KEY REFERENCES attempts(id),
  schemaVersion INTEGER NOT NULL,
  state TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  turnIndex INTEGER NOT NULL,
  baseMessageSeq INTEGER NOT NULL,
  continuationJson TEXT NOT NULL,
  pendingApprovalId TEXT,
  requestedActionDigest TEXT,
  frozenContextHash TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  checksum TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attempt_loop_continuations_state ON attempt_loop_continuations(state);
`;

// Migration 13: M39 Core-owned memory and knowledge intelligence. Purely
// additive â€” five new tables, no change to any existing table, column, index,
// or constraint. Core's SQLite database remains the sole durable authority
// for memory: there is deliberately no second store, no embedding/vector
// table, and no external graph engine (see docs/m39-memory-knowledge-intelligence.md
// Â§4 and Â§18). Consent, evidence, and idempotency all reuse the pre-existing
// `approvals`/`tool_invocations` rows created by the M38 governed capability
// dispatch path (core/domain/capabilityDispatch.ts) rather than introducing a
// parallel approval authority.
const MIGRATION_13_MEMORY_KNOWLEDGE = `
-- One durable memory fact. Content (subject/predicate/value) is immutable
-- after insert; only lifecycle metadata (state/validTo/forgottenAt/revision)
-- and the tombstone scrub ever change. writeIdentity is the Core-computed
-- idempotency identity: a repeated approved dispatch of the exact same
-- proposed memory can never create a second row (UNIQUE).
CREATE TABLE IF NOT EXISTS memory_facts (
  id TEXT PRIMARY KEY,
  memoryType TEXT NOT NULL,
  scopeType TEXT NOT NULL,
  scopeId TEXT NOT NULL,
  subject TEXT NOT NULL,
  predicate TEXT NOT NULL,
  normalizedValue TEXT NOT NULL,
  displayValue TEXT NOT NULL,
  structuredValue TEXT NOT NULL,
  sensitivity TEXT NOT NULL,
  state TEXT NOT NULL,
  validFrom TEXT NOT NULL,
  validTo TEXT,
  expiresAt TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  forgottenAt TEXT,
  consentApprovalId TEXT,
  toolInvocationId TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  writeIdentity TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_memory_facts_scope ON memory_facts(scopeType, scopeId, subject, predicate, state);
CREATE INDEX IF NOT EXISTS idx_memory_facts_state ON memory_facts(state, createdAt);

-- Every fact must have at least one evidence link. The hash is ALWAYS
-- computed inside Core from the resolved durable source (a conversation
-- message today) â€” a caller-supplied hash is never stored or trusted.
CREATE TABLE IF NOT EXISTS memory_evidence (
  id TEXT PRIMARY KEY,
  memoryId TEXT NOT NULL REFERENCES memory_facts(id),
  sourceType TEXT NOT NULL,
  sourceConversationId TEXT,
  sourceMessageId TEXT,
  sourceAttemptId TEXT,
  sourceInvocationId TEXT,
  sourceContentSha256 TEXT NOT NULL,
  provenanceVersion INTEGER NOT NULL DEFAULT 1,
  createdAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_evidence_memory ON memory_evidence(memoryId, createdAt);

-- Typed knowledge-graph entity. Uniqueness is (entityType, canonicalKey) so
-- the same repository file / GitHub issue / product record is reused rather
-- than duplicated across memories.
CREATE TABLE IF NOT EXISTS knowledge_entities (
  id TEXT PRIMARY KEY,
  entityType TEXT NOT NULL,
  canonicalKey TEXT NOT NULL,
  label TEXT NOT NULL,
  scopeType TEXT,
  scopeId TEXT,
  state TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  UNIQUE(entityType, canonicalKey)
);

-- Temporal typed relationship. Generalizes core/domain/dependencies.ts's
-- cycle-safe directed-graph approach to typed entities; traversal is bounded
-- and cycle-safe in core/domain/memory.ts, not delegated to a graph engine.
CREATE TABLE IF NOT EXISTS knowledge_relationships (
  id TEXT PRIMARY KEY,
  fromEntityId TEXT NOT NULL REFERENCES knowledge_entities(id),
  relationshipType TEXT NOT NULL,
  toEntityId TEXT NOT NULL REFERENCES knowledge_entities(id),
  validFrom TEXT NOT NULL,
  validTo TEXT,
  state TEXT NOT NULL,
  memoryId TEXT REFERENCES memory_facts(id),
  evidenceId TEXT REFERENCES memory_evidence(id),
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  UNIQUE(fromEntityId, relationshipType, toEntityId, memoryId)
);
CREATE INDEX IF NOT EXISTS idx_knowledge_relationships_from ON knowledge_relationships(fromEntityId, state);
CREATE INDEX IF NOT EXISTS idx_knowledge_relationships_memory ON knowledge_relationships(memoryId);

-- Deterministic contradiction: same active scope + subject + predicate with a
-- materially different normalized value. Both facts are always preserved;
-- resolution only ever updates authority/validity metadata.
CREATE TABLE IF NOT EXISTS memory_contradictions (
  id TEXT PRIMARY KEY,
  earlierMemoryId TEXT NOT NULL REFERENCES memory_facts(id),
  laterMemoryId TEXT NOT NULL REFERENCES memory_facts(id),
  state TEXT NOT NULL,
  resolutionPolicy TEXT,
  authoritativeMemoryId TEXT REFERENCES memory_facts(id),
  resolutionApprovalId TEXT,
  resolutionInvocationId TEXT,
  detectedAt TEXT NOT NULL,
  resolvedAt TEXT,
  UNIQUE(earlierMemoryId, laterMemoryId)
);
CREATE INDEX IF NOT EXISTS idx_memory_contradictions_state ON memory_contradictions(state, detectedAt);
`;

// M35 corrective delivery: one Core-owned, workspace-scoped conversation
// ledger across Baat Kar, Saath Kar, and Karke Dikha. The existing normalized
// conversation/request/attempt/approval tables remain the evidence sources;
// these tables add the durable workspace index/current pointer and one stable
// ordered projection identity per submitted turn.
const MIGRATION_14_WORKSPACE_CONVERSATION_LEDGER = `
CREATE TABLE IF NOT EXISTS workspace_conversations (
  workspaceIdentity TEXT NOT NULL,
  localConversationId TEXT NOT NULL,
  conversationId TEXT NOT NULL REFERENCES conversations(id),
  title TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  archivedAt TEXT,
  schemaVersion INTEGER NOT NULL DEFAULT 1,
  migrationMetadata TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (workspaceIdentity, localConversationId),
  UNIQUE (workspaceIdentity, conversationId)
);
CREATE INDEX IF NOT EXISTS idx_workspace_conversations_updated
  ON workspace_conversations(workspaceIdentity, updatedAt DESC);

CREATE TABLE IF NOT EXISTS workspace_conversation_pointers (
  workspaceIdentity TEXT PRIMARY KEY,
  localConversationId TEXT NOT NULL,
  schemaVersion INTEGER NOT NULL DEFAULT 1,
  migrationMetadata TEXT NOT NULL DEFAULT '{}',
  updatedAt TEXT NOT NULL,
  FOREIGN KEY (workspaceIdentity, localConversationId)
    REFERENCES workspace_conversations(workspaceIdentity, localConversationId)
);

CREATE TABLE IF NOT EXISTS conversation_turns (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  conversationId TEXT NOT NULL REFERENCES conversations(id),
  requestId TEXT NOT NULL UNIQUE REFERENCES requests(id),
  attemptId TEXT NOT NULL UNIQUE REFERENCES attempts(id),
  userMessageId TEXT REFERENCES conversation_messages(id),
  mode TEXT NOT NULL,
  taskId TEXT,
  outcome TEXT NOT NULL,
  projectionId TEXT NOT NULL UNIQUE,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  terminalAt TEXT,
  schemaVersion INTEGER NOT NULL DEFAULT 1,
  migrationMetadata TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_conversation_turns_order
  ON conversation_turns(conversationId, seq);

ALTER TABLE tool_invocations ADD COLUMN approvalId TEXT REFERENCES approvals(id);
UPDATE tool_invocations
   SET approvalId = (
     SELECT a.id
       FROM approvals a
      WHERE a.attemptId = tool_invocations.attemptId
        AND a.kind = 'mutation'
        AND a.status = 'approved'
        AND json_extract(a.summary, '$.toolName') = tool_invocations.toolName
        AND json(json_extract(a.summary, '$.arguments')) = json(tool_invocations.argsSummary)
        AND a.requestedAt <= tool_invocations.startedAt
      ORDER BY a.requestedAt DESC
      LIMIT 1
   )
 WHERE approvalId IS NULL;
CREATE INDEX IF NOT EXISTS idx_tool_invocations_approval
  ON tool_invocations(approvalId);
`;

// Repository-aware Baat Kar: immutable, bounded supplemental inference
// context. Existing rows remain hash-compatible because a null optional field
// is omitted from the canonical attempt-context material.
const MIGRATION_15_BAAT_REPOSITORY_CONTEXT = `
ALTER TABLE attempt_contexts ADD COLUMN repositoryContext TEXT;
`;

/**
 * Proposal-time presentation for an approval (today: the bounded unified diff
 * of a Saath Kar `write_file` proposal). Deliberately a separate column from
 * `summary`: `summary` is the authority the requested-action digest binds,
 * while this is the immutable rendering the human was shown. Storing it here
 * is what lets a restored card show the SAME diff instead of recomputing one
 * against whatever bytes are on disk when it happens to render.
 */
const MIGRATION_16_APPROVAL_PRESENTATION = `
ALTER TABLE approvals ADD COLUMN presentation TEXT;
`;

/**
 * Durable Conversational Continuity V1 â€” one bounded derived working state
 * per conversation.
 *
 * Deliberately a single row per conversation rather than an append log: this
 * is a DERIVED summary, not evidence. `conversation_messages` stays the only
 * durable transcript, and every field here is reproducible from the turns the
 * panel already submits. The row is cascade-deleted with its conversation so
 * archiving/deleting a conversation cannot leave orphaned narrative behind.
 *
 * `workspaceIdentity` is stored (not joined through workspace_conversations)
 * so a read can fail closed on a mismatch without a join that a corrupt
 * pointer could satisfy â€” that is the workspace/profile isolation guarantee
 * (milestone Step 6/G).
 */
const MIGRATION_17_CONVERSATION_WORKING_STATE = `
CREATE TABLE conversation_working_state (
  conversationId TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  workspaceIdentity TEXT NOT NULL,
  objectiveId TEXT NOT NULL,
  currentObjective TEXT NOT NULL,
  latestUserIntent TEXT NOT NULL,
  latestExecutionPolicy TEXT,
  relevantFiles TEXT NOT NULL DEFAULT '[]',
  relevantSymbols TEXT NOT NULL DEFAULT '[]',
  userConstraints TEXT NOT NULL DEFAULT '[]',
  latestFindingsSummary TEXT,
  pendingAction TEXT,
  latestTaskId TEXT,
  latestProposalId TEXT,
  latestValidationSummary TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  version INTEGER NOT NULL
);
CREATE INDEX idx_conversation_working_state_workspace
  ON conversation_working_state(workspaceIdentity);
`;

const MIGRATION_18_MISSION_AUTHORIZATION = `
CREATE TABLE mission_authorizations (
  id TEXT PRIMARY KEY,
  attemptId TEXT NOT NULL,
  digest TEXT NOT NULL,
  envelopeJson TEXT NOT NULL,
  status TEXT NOT NULL,
  authorizedAt TEXT,
  authorizedBy TEXT,
  createdAt TEXT NOT NULL
);
CREATE INDEX idx_mission_authorizations_attempt ON mission_authorizations(attemptId);

CREATE TABLE mission_authorized_actions (
  id TEXT PRIMARY KEY,
  authorizationId TEXT NOT NULL REFERENCES mission_authorizations(id),
  attemptId TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  normalizedPath TEXT,
  envelopeDigest TEXT NOT NULL,
  contentDigest TEXT,
  contentBytes INTEGER,
  policyDecision TEXT NOT NULL,
  policyReason TEXT NOT NULL,
  evidenceJson TEXT NOT NULL DEFAULT '{}',
  createdAt TEXT NOT NULL
);
CREATE INDEX idx_mission_authorized_actions_auth ON mission_authorized_actions(authorizationId);
CREATE INDEX idx_mission_authorized_actions_attempt ON mission_authorized_actions(attemptId);
`;

/**
 * Durable ownership for a capability anchor attempt.
 *
 * A mission dispatches its approved mutation through a lightweight anchor
 * attempt (`core/domain/capabilityDispatch.ts`). Nothing recorded which
 * mission owned that anchor, so a finished mission left its mutation attempt
 * `running` forever and no consumer could join the two. `parentAttemptId` is
 * written once at creation and is the only signal that lets Core settle an
 * anchor it owns while leaving shared anchors â€” the Forge/task anchors other
 * callers reuse across turns â€” untouched.
 *
 * Additive per the M32 rule: `ALTER TABLE ... ADD COLUMN` on existing
 * installs, and existing rows stay NULL, which reads as "not mission-owned".
 */
const MIGRATION_19_CAPABILITY_ATTEMPT_OWNERSHIP = `
ALTER TABLE attempts ADD COLUMN parentAttemptId TEXT REFERENCES attempts(id);
CREATE INDEX IF NOT EXISTS idx_attempts_parent ON attempts(parentAttemptId);
`;

const MIGRATION_20_OPENROUTER_ATTEMPT_BUDGET = `
CREATE TABLE IF NOT EXISTS openrouter_attempt_budget (
  attemptId TEXT PRIMARY KEY REFERENCES attempts(id),
  spendCapUsd REAL NOT NULL,
  spentUsd REAL NOT NULL DEFAULT 0,
  reservedUsd REAL NOT NULL DEFAULT 0,
  hasUnresolved INTEGER NOT NULL DEFAULT 0,
  updatedAt TEXT NOT NULL
);
`;

// Everyday Tools (Jarvis Notes / Reminders). Additive Core SQLite authority
// for Desktop-facing personal tools. Desktop only schedules notifications
// while Jarvis is running; closed-app alerts are not claimed by this schema.
const MIGRATION_21_EVERYDAY_TOOLS = `
CREATE TABLE IF NOT EXISTS everyday_notes (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  deletedAt TEXT
);
CREATE INDEX IF NOT EXISTS idx_everyday_notes_updated ON everyday_notes(updatedAt DESC);
CREATE INDEX IF NOT EXISTS idx_everyday_notes_active ON everyday_notes(deletedAt, updatedAt DESC);

CREATE TABLE IF NOT EXISTS everyday_reminders (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  dueAt TEXT NOT NULL,
  timezone TEXT NOT NULL,
  status TEXT NOT NULL,
  notifiedAt TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  completedAt TEXT,
  cancelledAt TEXT
);
CREATE INDEX IF NOT EXISTS idx_everyday_reminders_due ON everyday_reminders(status, dueAt);
CREATE INDEX IF NOT EXISTS idx_everyday_reminders_open ON everyday_reminders(status, notifiedAt, dueAt);
`;

const MIGRATION_22_COMMAND_QUEUE = `
CREATE TABLE IF NOT EXISTS command_queue_items (
  id TEXT PRIMARY KEY,
  ordinal INTEGER NOT NULL,
  status TEXT NOT NULL,
  source TEXT NOT NULL,
  title TEXT NOT NULL,
  instruction TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  confirmationToken TEXT,
  confirmationExpiresAt TEXT,
  dependsOnId TEXT REFERENCES command_queue_items(id),
  attemptId TEXT,
  requestId TEXT,
  outcome TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  startedAt TEXT,
  finishedAt TEXT,
  postponedUntil TEXT,
  lastError TEXT
);
CREATE INDEX IF NOT EXISTS idx_command_queue_status_ordinal ON command_queue_items(status, ordinal);
`;

// Jarvis Connector Foundation: durable read/draft/execute permission grants
// per connector (Gmail/Google Calendar/WhatsApp/Printer). Absence of a row
// means not granted â€” fail closed by construction, never inferred from a
// default-true column.
const MIGRATION_23_CONNECTOR_PERMISSIONS = `
CREATE TABLE IF NOT EXISTS connector_permissions (
  connectorId TEXT NOT NULL,
  tier TEXT NOT NULL,
  granted INTEGER NOT NULL DEFAULT 0,
  updatedAt TEXT NOT NULL,
  updatedBy TEXT,
  PRIMARY KEY (connectorId, tier)
);
`;

// Draft-bound Gmail send safety: the canonical digest and display content
// recorded when a draft is created, bridging the separate `gmail_create_draft`
// (draft tier) and `gmail_send_draft` (execute tier) approvals for the same
// Gmail draft ID. `gmail_send_draft`'s approval is built from this row (the
// "approved digest"); the executor re-reads the live draft from Gmail
// immediately before sending and refuses if its freshly computed digest no
// longer matches. Never a general evidence/log table â€” scoped purpose-built
// storage for this one bridge, one row per live draft.
const MIGRATION_24_GMAIL_DRAFT_BINDINGS = `
CREATE TABLE IF NOT EXISTS gmail_draft_bindings (
  draftId TEXT PRIMARY KEY,
  accountEmail TEXT NOT NULL,
  threadId TEXT,
  digest TEXT NOT NULL,
  toJson TEXT NOT NULL,
  ccJson TEXT NOT NULL,
  bccJson TEXT NOT NULL,
  subject TEXT NOT NULL,
  bodyText TEXT NOT NULL,
  bodyHtml TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);
`;

// Jarvis Conversations rail Checkpoint 1: pin support. Additive per the M32
// rule â€” nullable column, no backfill needed (NULL = not pinned).
const MIGRATION_25_CONVERSATION_PIN = `
ALTER TABLE conversations ADD COLUMN pinnedAt TEXT;
CREATE INDEX IF NOT EXISTS idx_conversations_pinned ON conversations(pinnedAt);
`;

// Shared artifact subsystem: durable references to verified output files.
// Bytes remain in their producer-owned location; Core records the digest and
// re-checks availability before projecting an artifact as ready.
const MIGRATION_26_ARTIFACTS = `
CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  conversationId TEXT REFERENCES conversations(id),
  requestId TEXT,
  attemptId TEXT,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  mimeType TEXT NOT NULL,
  absolutePath TEXT NOT NULL,
  byteSize INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  source TEXT NOT NULL,
  metadataJson TEXT NOT NULL DEFAULT '{}',
  createdAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_artifacts_created ON artifacts(createdAt DESC);
CREATE INDEX IF NOT EXISTS idx_artifacts_conversation ON artifacts(conversationId, createdAt DESC);
`;

/**
 * Conversation/objective arbitration correction: a durable flag that survives
 * a restart between the user confirming "New Task" (in response to an
 * objective-boundary ambiguity prompt, or an explicit New Task action) and
 * them actually typing the new objective. While set, the NEXT substantive
 * message bypasses continuation-vs-new classification entirely and becomes
 * the objective directly, so the confirmation reply itself can never be
 * misread as the objective and the ambiguity prompt can never re-fire for it.
 */
const MIGRATION_27_PENDING_NEW_OBJECTIVE = `
ALTER TABLE conversation_working_state ADD COLUMN pendingNewObjective INTEGER NOT NULL DEFAULT 0;
`;

/**
 * Conversation/objective arbitration correction, part 2: a durable flag that
 * records whether KKD just asked a control question expecting a bare
 * acknowledgement reply ("Continue?", "Should I treat it as a new task?").
 * `classifyControlAcknowledgement` matches a small closed vocabulary ("yes",
 * "continue", "retry", "new task") that can also occur as ordinary chat
 * content; without this flag, that vocabulary could silently force objective
 * routing outside the control-question exchange it is meant for.
 */
const MIGRATION_28_AWAITING_OBJECTIVE_CLARIFICATION = `
ALTER TABLE conversation_working_state ADD COLUMN awaitingObjectiveClarification INTEGER NOT NULL DEFAULT 0;
`;

/**
 * M45: the approval summary is bounded presentation plus a digest binding.
 * When a bulk argument (file content, edit find/replace) is projected out of
 * the summary, the canonical full redacted arguments are stored here, bound by
 * the summary's `argumentsDigest`. Policy, mission authorization and execution
 * read this column, never the projected summary text.
 */
const MIGRATION_29_APPROVAL_ACTION_ARGUMENTS = `
ALTER TABLE approvals ADD COLUMN actionArgumentsJson TEXT;
`;

// Migration 30: M54 local autonomy security kernel state
const MIGRATION_31_SCHEDULED_TASKS = `
CREATE TABLE IF NOT EXISTS scheduled_tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  instruction TEXT NOT NULL,
  dailyTime TEXT NOT NULL,
  repeat TEXT NOT NULL DEFAULT 'daily',
  timezone TEXT NOT NULL,
  conversationId TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  nextRunAt TEXT NOT NULL,
  lastRunAt TEXT,
  lastAttemptId TEXT,
  model TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_due ON scheduled_tasks(enabled, nextRunAt);
`;
/**
 * M56: the Personal Assistant's one proactive routine.
 *
 * `scheduled_tasks` gains a `routine` column: a row with a routine name is
 * executed by Core itself (deterministically, without a model call) instead of
 * being submitted as an agent attempt. `routine_deliveries` is the ledger that
 * makes a routine fire exactly once per occurrence — the primary key is the
 * (routine, occurrence) pair, so a second delivery for the same occurrence is
 * refused by the database itself rather than by a convention.
 */
const MIGRATION_32_ASSISTANT_ROUTINES = `
ALTER TABLE scheduled_tasks ADD COLUMN routine TEXT;
CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_routine ON scheduled_tasks(routine, enabled);

CREATE TABLE IF NOT EXISTS routine_deliveries (
  routineId TEXT NOT NULL,
  occurrenceKey TEXT NOT NULL,
  claimedAt TEXT NOT NULL,
  deliveredAt TEXT,
  conversationId TEXT,
  messageId TEXT,
  PRIMARY KEY (routineId, occurrenceKey)
);
`;

/**
 * M33 — durable commitments (the "I said I would" record).
 *
 * A commitment is a promise the user made, with a condition that says whether
 * it still stands: "reply to Priya if she does not answer by Friday". Until
 * now the only trace of such a promise was inside a chat transcript or a
 * reminder note, so it could not be checked, surfaced, or resolved. This
 * table makes the promise a first-class durable fact:
 *
 * - `status` is the truth of the promise, not the intention.
 * - `condition` names the check that decides it ('no_reply' is the only
 *   condition the built-in checker understands today; any other value is a
 *   human-owned condition the assistant reports but never auto-resolves).
 * - `relatedId` points at the thing the promise is about (a Gmail thread id),
 *   so the checker can look it up instead of guessing.
 * - `conversationId`/`attemptId` preserve provenance: where the promise was
 *   made and which task created it.
 */
const MIGRATION_33_COMMITMENTS = `
CREATE TABLE IF NOT EXISTS commitments (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  detail TEXT,
  channel TEXT NOT NULL DEFAULT 'none',
  subject TEXT,
  relatedId TEXT,
  condition TEXT NOT NULL DEFAULT 'none',
  dueAt TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  conversationId TEXT,
  attemptId TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  resolvedAt TEXT,
  resolutionNote TEXT
);
CREATE INDEX IF NOT EXISTS idx_commitments_status_due ON commitments(status, dueAt);
CREATE INDEX IF NOT EXISTS idx_commitments_conversation ON commitments(conversationId);
`;

/**
 * M34 — the outcome record of a task.
 *
 * A task is more than a prompt. While it runs, the assistant must keep the
 * user's objective, the conditions that would make it successful, the
 * capabilities it chose, the blocker it hit and the next action in one
 * place, so the work survives an interruption, a restart and a change of
 * surface.
 *
 * The record is deliberately one row per attempt, and it is written by the
 * assistant itself (`update_task_outcome`) rather than inferred afterwards.
 * Its `status` is the truth of the task:
 *   - `in_progress` — still being worked on,
 *   - `satisfied`   — the success conditions are met, with evidence,
 *   - `partial`     — some of it is done, and the rest is named,
 *   - `blocked`     — something outside the assistant's reach stops it, and
 *                    the blocker is written down.
 *
 * `evidence` is a JSON array of `{ kind, reference }` entries — never prose.
 * A task with no evidence cannot be `satisfied`.
 */
const MIGRATION_34_TASK_OUTCOMES = `
CREATE TABLE IF NOT EXISTS task_outcomes (
  attemptId TEXT PRIMARY KEY,
  conversationId TEXT,
  requestId TEXT,
  objective TEXT NOT NULL,
  successCriteria TEXT NOT NULL DEFAULT '[]',
  capabilities TEXT NOT NULL DEFAULT '[]',
  evidence TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'in_progress',
  blocker TEXT,
  nextAction TEXT,
  summary TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_task_outcomes_conversation ON task_outcomes(conversationId);
CREATE INDEX IF NOT EXISTS idx_task_outcomes_status ON task_outcomes(status);
`;

const MIGRATION_30_SECURITY_EXECUTION_GRANTS = `
CREATE TABLE IF NOT EXISTS execution_grants (
  id TEXT PRIMARY KEY,
  requestId TEXT NOT NULL,
  actionId TEXT NOT NULL,
  attemptId TEXT NOT NULL,
  executor TEXT NOT NULL DEFAULT 'core:security_kernel',
  capability TEXT NOT NULL,
  workspaceRoot TEXT NOT NULL,
  targetResource TEXT,
  command TEXT,
  argumentsHash TEXT,
  filesystemScopeHash TEXT,
  networkScopeHash TEXT,
  riskClass TEXT NOT NULL,
  issuedAt TEXT NOT NULL,
  expiresAt TEXT NOT NULL,
  nonce TEXT NOT NULL,
  grantDigest TEXT NOT NULL,
  singleUse INTEGER NOT NULL DEFAULT 1,
  consumedAt TEXT,
  revokedAt TEXT,
  epoch TEXT NOT NULL DEFAULT 'epoch_initial'
);
CREATE INDEX IF NOT EXISTS idx_execution_grants_consumed ON execution_grants(consumedAt);
CREATE INDEX IF NOT EXISTS idx_execution_grants_revoked ON execution_grants(revokedAt);
CREATE INDEX IF NOT EXISTS idx_execution_grants_attempt ON execution_grants(attemptId);
CREATE INDEX IF NOT EXISTS idx_execution_grants_epoch ON execution_grants(epoch);

CREATE TABLE IF NOT EXISTS security_events (
  id TEXT PRIMARY KEY,
  eventType TEXT NOT NULL,
  requestId TEXT,
  actionId TEXT,
  attemptId TEXT,
  objectiveId TEXT,
  executor TEXT NOT NULL,
  capability TEXT,
  targetResource TEXT,
  riskLevel TEXT,
  payload TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  epoch TEXT NOT NULL DEFAULT 'epoch_initial'
);
CREATE INDEX IF NOT EXISTS idx_security_events_type ON security_events(eventType);
CREATE INDEX IF NOT EXISTS idx_security_events_attempt ON security_events(attemptId);
CREATE INDEX IF NOT EXISTS idx_security_events_created ON security_events(createdAt);
CREATE INDEX IF NOT EXISTS idx_security_events_epoch ON security_events(epoch);

CREATE TABLE IF NOT EXISTS security_safe_mode (
  id TEXT PRIMARY KEY,
  active INTEGER NOT NULL DEFAULT 0,
  reason TEXT,
  activatedAt TEXT,
  activatedBy TEXT,
  deactivatedAt TEXT,
  deactivatedBy TEXT,
  epoch TEXT NOT NULL DEFAULT 'epoch_initial',
  updatedAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_security_safe_mode_active ON security_safe_mode(active);
`;

// Gmail inbox organization: the durable journal of a bulk change. A plan is a preview first (the exact message
// ids with the labels each carried BEFORE any change), then an approved, verified application, and it keeps the
// prior state so the change can be undone. Only message metadata the user's own mailbox already shows (sender,
// subject, labels) is stored - never a body or a snippet.
const MIGRATION_35_GMAIL_CHANGE_PLANS = `
CREATE TABLE IF NOT EXISTS gmail_change_plans (
  planId TEXT PRIMARY KEY,
  accountEmail TEXT NOT NULL,
  status TEXT NOT NULL,
  digest TEXT NOT NULL,
  planJson TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  expiresAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gmail_change_plans_account ON gmail_change_plans(accountEmail, createdAt);
`;

const MIGRATION_36_BACKGROUND_TASKS = `
CREATE TABLE IF NOT EXISTS background_tasks (
  id TEXT PRIMARY KEY,
  attemptId TEXT NOT NULL UNIQUE REFERENCES attempts(id),
  conversationId TEXT NOT NULL REFERENCES conversations(id),
  taskType TEXT NOT NULL,
  objective TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  completionCriteria TEXT NOT NULL DEFAULT '[]',
  checkpoints TEXT NOT NULL DEFAULT '[]',
  payload TEXT NOT NULL DEFAULT '{}',
  resultSummary TEXT,
  resultData TEXT,
  error TEXT,
  notificationSent INTEGER NOT NULL DEFAULT 0,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  completedAt TEXT
);
CREATE INDEX IF NOT EXISTS idx_background_tasks_status ON background_tasks(status);
CREATE INDEX IF NOT EXISTS idx_background_tasks_conversation ON background_tasks(conversationId);
`;

const MIGRATION_37_PANDA_BRIDGE = `
CREATE TABLE IF NOT EXISTS bridge_pairing_codes (
  codeHash TEXT PRIMARY KEY,
  createdAt TEXT NOT NULL,
  expiresAt TEXT NOT NULL,
  consumedAt TEXT
);
CREATE TABLE IF NOT EXISTS bridge_pairings (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  extensionId TEXT,
  tokenHash TEXT NOT NULL UNIQUE,
  createdAt TEXT NOT NULL,
  lastSeenAt TEXT,
  revokedAt TEXT,
  revokedReason TEXT
);
CREATE TABLE IF NOT EXISTS bridge_tasks (
  id TEXT PRIMARY KEY,
  pairingId TEXT NOT NULL REFERENCES bridge_pairings(id),
  clientRequestId TEXT NOT NULL,
  instruction TEXT NOT NULL,
  instructionSha256 TEXT NOT NULL,
  sourceRef TEXT NOT NULL DEFAULT '{}',
  contextText TEXT,
  contextConfirmed INTEGER NOT NULL DEFAULT 0,
  sensitivity TEXT NOT NULL DEFAULT 'normal',
  sensitivityReasons TEXT NOT NULL DEFAULT '[]',
  conversationId TEXT REFERENCES conversations(id),
  projectId TEXT,
  storyId TEXT,
  attemptId TEXT,
  executor TEXT,
  model TEXT,
  routing TEXT,
  externalConsent TEXT,
  workspacePath TEXT,
  status TEXT NOT NULL,
  statusDetail TEXT,
  control TEXT NOT NULL DEFAULT 'none',
  result TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  completedAt TEXT,
  UNIQUE (pairingId, clientRequestId)
);
CREATE INDEX IF NOT EXISTS idx_bridge_tasks_status ON bridge_tasks(status);
CREATE INDEX IF NOT EXISTS idx_bridge_tasks_story ON bridge_tasks(storyId);
CREATE TABLE IF NOT EXISTS bridge_task_checkpoints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  taskId TEXT NOT NULL REFERENCES bridge_tasks(id),
  status TEXT NOT NULL,
  detail TEXT,
  snapshot TEXT,
  createdAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bridge_checkpoints_task ON bridge_task_checkpoints(taskId, id);
`;

export const MIGRATIONS: Migration[] = [
  { version: 1, description: 'bootstrap core_metadata and schema_migrations', sql: MIGRATION_1_BOOTSTRAP },
  { version: 2, description: 'M31 domain schema (projects/repositories/stories/events/etc.)', sql: MIGRATION_2_DOMAIN },
  { version: 3, description: 'M32 durable agent-runtime schema (conversations/requests/attempts/invocations/approvals/checkpoints)', sql: MIGRATION_3_RUNTIME },
  { version: 4, description: 'M32 correction: fencing generation on attempts (audit F1/F3/F4)', sql: MIGRATION_4_FENCE },
  { version: 5, description: 'M32 correction: frozen attempt context and Core-validated approval envelope', sql: MIGRATION_5_ATTEMPT_CONTEXT_APPROVAL_ENVELOPE },
  { version: 6, description: 'M34 immutable model-selection and retry-guidance context', sql: MIGRATION_6_EXECUTION_QUALITY_CONTEXT },
  { version: 7, description: 'M36 durable attachment vertical slice (attachments/message_attachments/frozen attachment context)', sql: MIGRATION_7_ATTACHMENTS },
  { version: 8, description: 'M36 pass 2 — document extraction and audio transcription evidence columns', sql: MIGRATION_8_DOCUMENT_AUDIO_PROCESSING },
  { version: 9, description: 'M36 governed SearXNG research, approvals, sources, and citations', sql: MIGRATION_9_GOVERNED_RESEARCH },
  { version: 10, description: 'M36 workbench search/export/branch/regeneration projections', sql: MIGRATION_10_WORKBENCH },
  { version: 11, description: 'M37 Core-owned engineering organization lifecycle and CI-repair evidence', sql: MIGRATION_11_ENGINEERING_ORGANIZATION },
  { version: 12, description: 'M38 Core Saath Kar agent-loop execution checkpoint (attempt_loop_continuations)', sql: MIGRATION_12_LOOP_CONTINUATION },
  { version: 13, description: 'M39 Core memory and knowledge intelligence (memory_facts/memory_evidence/knowledge_entities/knowledge_relationships/memory_contradictions)', sql: MIGRATION_13_MEMORY_KNOWLEDGE },
  { version: 14, description: 'M35 correction: authoritative workspace conversation ledger and approval-bound tool evidence', sql: MIGRATION_14_WORKSPACE_CONVERSATION_LEDGER },
  { version: 15, description: 'Repository-aware Baat Kar frozen supplemental context', sql: MIGRATION_15_BAAT_REPOSITORY_CONTEXT },
  { version: 16, description: 'Immutable proposal-time approval presentation (write_file diff)', sql: MIGRATION_16_APPROVAL_PRESENTATION },
  { version: 17, description: 'Durable Conversational Continuity V1 bounded per-conversation working state', sql: MIGRATION_17_CONVERSATION_WORKING_STATE },
  { version: 18, description: 'Hands-off Mission V1 frozen authorization and auto-authorized action audit', sql: MIGRATION_18_MISSION_AUTHORIZATION },
  { version: 19, description: 'Durable parent linkage for mission-owned capability anchor attempts', sql: MIGRATION_19_CAPABILITY_ATTEMPT_OWNERSHIP },
  { version: 20, description: 'OpenRouter Gate 1 durable attempt spend cap ledger', sql: MIGRATION_20_OPENROUTER_ATTEMPT_BUDGET },
  { version: 21, description: 'Everyday Tools notes and reminders (Core-owned persistence)', sql: MIGRATION_21_EVERYDAY_TOOLS },
  { version: 22, description: 'Durable Command Queue items (Core-owned)', sql: MIGRATION_22_COMMAND_QUEUE },
  { version: 23, description: 'Jarvis Connector Foundation read/draft/execute permission grants', sql: MIGRATION_23_CONNECTOR_PERMISSIONS },
  { version: 24, description: 'Gmail draft-bound send safety: create/send digest binding per draft ID', sql: MIGRATION_24_GMAIL_DRAFT_BINDINGS },
  { version: 25, description: 'Jarvis Conversations rail Checkpoint 1: pin support', sql: MIGRATION_25_CONVERSATION_PIN },
  { version: 26, description: 'Core-owned durable artifact references and provenance', sql: MIGRATION_26_ARTIFACTS },
  { version: 27, description: 'Conversation/objective arbitration: durable pendingNewObjective flag on working state', sql: MIGRATION_27_PENDING_NEW_OBJECTIVE },
  { version: 28, description: 'Conversation/objective arbitration: durable awaitingObjectiveClarification flag on working state', sql: MIGRATION_28_AWAITING_OBJECTIVE_CLARIFICATION },
  { version: 29, description: 'M45 approval action arguments stored apart from the bounded digest-bearing summary', sql: MIGRATION_29_APPROVAL_ACTION_ARGUMENTS },
  { version: 30, description: 'M54 local autonomy security execution grants', sql: MIGRATION_30_SECURITY_EXECUTION_GRANTS },
  { version: 31, description: 'Durable daily scheduled tasks executed by Core', sql: MIGRATION_31_SCHEDULED_TASKS },
  { version: 32, description: 'Pandesh assistant routines: routine-kind scheduled tasks and their once-per-occurrence delivery ledger', sql: MIGRATION_32_ASSISTANT_ROUTINES },
  { version: 33, description: 'Pandesh durable commitments: the promises the user made, their condition and their state', sql: MIGRATION_33_COMMITMENTS },
  { version: 34, description: 'Pandesh task outcomes: the objective, success conditions, evidence, blocker and next action of a task', sql: MIGRATION_34_TASK_OUTCOMES },
  { version: 35, description: 'Gmail inbox organization: durable change plans with the prior label state of every message', sql: MIGRATION_35_GMAIL_CHANGE_PLANS },
  { version: 36, description: 'Pandesh background delegated tasks: durable background worker execution, checkpoints and delivery ledger', sql: MIGRATION_36_BACKGROUND_TASKS },
  { version: 37, description: 'Panda bridge: browser pairings, relayed tasks (source reference, consent, routing) and durable checkpoints', sql: MIGRATION_37_PANDA_BRIDGE },
];


function checksumOf(sql: string): string {
  return crypto.createHash('sha256').update(sql).digest('hex');
}

/**
 * Applies any migrations not yet recorded in `schema_migrations`, each in its
 * own transaction. Migration 1 is special-cased because `schema_migrations`
 * itself doesn't exist until it runs.
 */
export function runMigrations(db: CoreDatabase): { applied: number[] } {
  db.exec(MIGRATION_1_BOOTSTRAP);
  const first = MIGRATIONS[0];
  const firstChecksum = checksumOf(first.sql);
  const firstRow = db.get<{ version: number }>('SELECT version FROM schema_migrations WHERE version = ?', [first.version]);
  const applied: number[] = [];
  if (!firstRow) {
    db.run('INSERT INTO schema_migrations (version, description, appliedAt, checksum) VALUES (?, ?, ?, ?)', [
      first.version,
      first.description,
      new Date().toISOString(),
      firstChecksum,
    ]);
    applied.push(first.version);
  }

  for (const migration of MIGRATIONS.slice(1)) {
    const existing = db.get<{ version: number }>('SELECT version FROM schema_migrations WHERE version = ?', [migration.version]);
    if (existing) continue;
    db.transaction(() => {
      db.exec(migration.sql);
      db.run('INSERT INTO schema_migrations (version, description, appliedAt, checksum) VALUES (?, ?, ?, ?)', [
        migration.version,
        migration.description,
        new Date().toISOString(),
        checksumOf(migration.sql),
      ]);
    });
    applied.push(migration.version);
  }
  return { applied };
}

export function getAppliedMigrations(db: CoreDatabase): Array<{ version: number; description: string; appliedAt: string }> {
  return db.all('SELECT version, description, appliedAt FROM schema_migrations ORDER BY version');
}

