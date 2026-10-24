/**
 * M39 focused domain tests — memory and knowledge intelligence.
 *
 * These exercise Core's real SQLite domain (never a mock): migration
 * additivity, provenance, redaction, contradiction determinism, resolution,
 * expiry, forget/tombstone, export, and bounded cycle-safe graph traversal.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { openDatabase, type CoreDatabase } from '../db/connection';
import { runMigrations, getAppliedMigrations, MIGRATIONS } from '../db/migrations';
import { createConversation, appendMessage } from '../domain/conversations';
import { createProject } from '../domain/projects';
import {
  analyzeMemoryImpact,
  exportMemory,
  forgetMemory,
  normalizeGithubIssueKey,
  normalizeRepositoryFilePath,
  recallMemories,
  redactMemoryArguments,
  redactMemoryText,
  rememberMemory,
  resolveMemoryContradiction,
  listMemoryContradictions,
  getMemoryFact,
} from '../domain/memory';
import { CoreError } from '../domain/errors';

const FIXTURE_TOKEN = 'ghp_M39FIXTUREtokenAAAAAAAAAAAAAAAAAAAA';

let dir: string;
let db: CoreDatabase;
let conversationId: string;
let userMessageId: string;
let projectId: string;

function tableCount(table: string): number {
  return Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)!.n);
}

function memoryTableDump(): string {
  const tables = ['memory_facts', 'memory_evidence', 'knowledge_entities', 'knowledge_relationships', 'memory_contradictions'];
  return tables.map((table) => JSON.stringify(db.all(`SELECT * FROM ${table}`))).join('\n');
}

function remember(overrides: Partial<Parameters<typeof rememberMemory>[1]> = {}) {
  return rememberMemory(db, {
    memoryType: 'semantic',
    scopeType: 'project',
    scopeId: 'Atlas',
    subject: 'authoritative memory store',
    predicate: 'is',
    value: 'SQLite',
    sensitivity: 'internal',
    sourceConversationId: conversationId,
    sourceMessageId: userMessageId,
    actor: 'test:actor',
    ...overrides,
  });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karkedikha-m39-memory-'));
  db = openDatabase(path.join(dir, 'core.db'));
  runMigrations(db);
  const project = createProject(db, { name: 'Atlas', actor: 'test:actor' });
  projectId = project.id;
  const conversation = createConversation(db, { mode: 'saath_kar', actor: 'test:actor' });
  conversationId = conversation.id;
  userMessageId = appendMessage(db, conversationId, {
    role: 'user',
    content: 'For project Atlas, use SQLite as the authoritative memory store.',
    actor: 'test:actor',
  }).id;
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('M39 migration 13', () => {
  it('applies cleanly and is purely additive', () => {
    const applied = getAppliedMigrations(db).map((entry) => entry.version);
    expect(applied).toContain(13);
    expect(MIGRATIONS.filter((migration) => migration.version === 13)).toHaveLength(1);
    // Migration 13 must not alter or drop anything that already existed.
    const sql = MIGRATIONS.find((migration) => migration.version === 13)!.sql;
    expect(sql).not.toMatch(/\bALTER\s+TABLE\b/i);
    expect(sql).not.toMatch(/\bDROP\b/i);
    for (const table of ['memory_facts', 'memory_evidence', 'knowledge_entities', 'knowledge_relationships', 'memory_contradictions']) {
      expect(db.get(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`, [table])).toBeTruthy();
    }
    // Pre-existing tables are still present and untouched.
    for (const table of ['conversations', 'approvals', 'tool_invocations', 'attempt_loop_continuations']) {
      expect(db.get(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`, [table])).toBeTruthy();
    }
    // Re-running migrations is a no-op.
    expect(runMigrations(db).applied).toEqual([]);
  });
});

describe('M39 remember', () => {
  it('creates exactly one fact with evidence, entities, and relationships', () => {
    const result = remember({
      affectedEntities: [
        { type: 'repository_file', canonicalKey: 'src/storage.ts' },
        { type: 'github_issue', canonicalKey: 'fixture/repository#39' },
        { type: 'product_record', canonicalKey: 'Atlas' },
      ],
    });
    expect(result.deduplicated).toBe(false);
    expect(tableCount('memory_facts')).toBe(1);
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0].sourceMessageId).toBe(userMessageId);
    expect(result.memory.state).toBe('active');
    // decision + project scope + 3 affected entities
    const types = result.entities.map((entity) => entity.entityType).sort();
    expect(types).toEqual(['decision', 'github_issue', 'product_record', 'project', 'repository_file']);
    expect(result.relationships).toHaveLength(4);
    expect(result.entities.find((entity) => entity.entityType === 'product_record')!.canonicalKey).toBe(projectId);
  });

  it('computes the evidence hash from the durable source message inside Core', () => {
    const result = remember();
    const row = db.get<{ role: string; content: string; id: string }>(
      'SELECT id, role, content FROM conversation_messages WHERE id = ?', [userMessageId],
    )!;
    const expected = crypto.createHash('sha256').update(`1\n${row.id}\n${row.role}\n${row.content}`, 'utf8').digest('hex');
    expect(result.evidence[0].sourceContentSha256).toBe(expected);
  });

  it('fails closed with zero writes when the evidence source is invalid or mismatched', () => {
    expect(() => remember({ sourceMessageId: 'msg_does_not_exist' })).toThrow(CoreError);
    const otherConversation = createConversation(db, { mode: 'baat_kar', actor: 'test:actor' });
    expect(() => remember({ sourceConversationId: otherConversation.id })).toThrow(/does not belong to conversation/);
    expect(tableCount('memory_facts')).toBe(0);
    expect(tableCount('memory_evidence')).toBe(0);
  });

  it('is idempotent: a repeated approved dispatch creates exactly one row', () => {
    const first = remember();
    const second = remember();
    expect(second.deduplicated).toBe(true);
    expect(second.memory.id).toBe(first.memory.id);
    expect(tableCount('memory_facts')).toBe(1);
    expect(tableCount('memory_evidence')).toBe(1);
  });

  it('redacts credential-shaped content before any M39 persistence', () => {
    const result = remember({
      sensitivity: 'internal',
      subject: 'deployment credential',
      value: `use token ${FIXTURE_TOKEN} for deploys`,
    });
    expect(result.redaction.applied).toBe(true);
    expect(result.memory.displayValue).not.toContain(FIXTURE_TOKEN);
    expect(memoryTableDump()).not.toContain(FIXTURE_TOKEN);
  });

  it('fails closed with zero writes for restricted content that cannot be safely retained', () => {
    expect(() => remember({ sensitivity: 'restricted', value: `secret ${FIXTURE_TOKEN}` }))
      .toThrow(/cannot be safely retained/);
    expect(tableCount('memory_facts')).toBe(0);
    expect(tableCount('memory_evidence')).toBe(0);
    expect(tableCount('knowledge_entities')).toBe(0);
    expect(memoryTableDump()).not.toContain(FIXTURE_TOKEN);
  });

  it('rejects absolute and traversal repository-file paths', () => {
    expect(() => normalizeRepositoryFilePath('C:/secrets/id_rsa')).toThrow(/repository-relative/);
    expect(() => normalizeRepositoryFilePath('/etc/passwd')).toThrow(/repository-relative/);
    expect(() => normalizeRepositoryFilePath('../../outside.ts')).toThrow(/traverse/);
    expect(normalizeRepositoryFilePath('src\\storage.ts')).toBe('src/storage.ts');
    expect(() => normalizeGithubIssueKey('not-an-issue')).toThrow();
    expect(normalizeGithubIssueKey('fixture/repository#39')).toBe('fixture/repository#39');
    expect(() => remember({ affectedEntities: [{ type: 'repository_file', canonicalKey: '../escape.ts' }] })).toThrow();
    expect(tableCount('memory_facts')).toBe(0);
  });

  it('refuses a product record that does not resolve to a Core record', () => {
    expect(() => remember({ affectedEntities: [{ type: 'product_record', canonicalKey: 'not-a-real-product' }] }))
      .toThrow(/does not resolve/);
    expect(tableCount('memory_facts')).toBe(0);
  });
});

describe('M39 contradiction semantics', () => {
  function twoConflictingFacts() {
    const first = remember({ affectedEntities: [{ type: 'repository_file', canonicalKey: 'src/storage.ts' }] });
    const laterMessageId = appendMessage(db, conversationId, {
      role: 'user',
      content: 'For project Atlas, use PostgreSQL as the authoritative memory store.',
      actor: 'test:actor',
    }).id;
    const second = remember({ value: 'PostgreSQL', sourceMessageId: laterMessageId });
    return { first, second };
  }

  it('detects a deterministic contradiction and preserves both facts', () => {
    const { first, second } = twoConflictingFacts();
    expect(tableCount('memory_facts')).toBe(2);
    expect(tableCount('memory_contradictions')).toBe(1);
    const contradiction = listMemoryContradictions(db, second.memory.id)[0];
    expect(contradiction.earlierMemoryId).toBe(first.memory.id);
    expect(contradiction.laterMemoryId).toBe(second.memory.id);
    expect(contradiction.state).toBe('unresolved');
    expect(getMemoryFact(db, first.memory.id).state).toBe('active');
    expect(getMemoryFact(db, first.memory.id).displayValue).toBe('SQLite');
  });

  it('recall returns both sides with evidence while the contradiction is unresolved', () => {
    twoConflictingFacts();
    const { entries } = recallMemories(db, { scopeType: 'project', scopeId: 'Atlas' });
    expect(entries).toHaveLength(2);
    expect(entries.every((entry) => entry.kind === 'unresolved_contradiction')).toBe(true);
    expect(entries.every((entry) => entry.evidence.length === 1)).toBe(true);
    expect(entries.map((entry) => entry.memory.displayValue)).toEqual(['SQLite', 'PostgreSQL']);
  });

  it('prefer_later preserves history and changes only active authority', () => {
    const { first, second } = twoConflictingFacts();
    const contradiction = listMemoryContradictions(db, second.memory.id)[0];
    const resolved = resolveMemoryContradiction(db, {
      contradictionId: contradiction.id,
      policy: 'prefer_later',
      approvalId: 'appr_fixture',
      actor: 'test:actor',
    });
    expect(resolved.authoritativeMemoryId).toBe(second.memory.id);
    expect(getMemoryFact(db, first.memory.id).state).toBe('historical');
    expect(getMemoryFact(db, first.memory.id).displayValue).toBe('SQLite');
    expect(getMemoryFact(db, second.memory.id).state).toBe('active');
    expect(tableCount('memory_facts')).toBe(2);
    const active = recallMemories(db, { scopeType: 'project', scopeId: 'Atlas' });
    expect(active.entries).toHaveLength(1);
    expect(active.entries[0].memory.displayValue).toBe('PostgreSQL');
    // A supersedes relationship records the authority change in the graph.
    const supersedes = db.all<{ relationshipType: string }>("SELECT relationshipType FROM knowledge_relationships WHERE relationshipType = 'supersedes'");
    expect(supersedes).toHaveLength(1);
  });

  it('resolution is idempotent and never applies a conflicting second policy', () => {
    const { second } = twoConflictingFacts();
    const contradiction = listMemoryContradictions(db, second.memory.id)[0];
    resolveMemoryContradiction(db, { contradictionId: contradiction.id, policy: 'prefer_later', actor: 'test:actor' });
    const again = resolveMemoryContradiction(db, { contradictionId: contradiction.id, policy: 'prefer_later', actor: 'test:actor' });
    expect(again.alreadyResolved).toBe(true);
    expect(() => resolveMemoryContradiction(db, { contradictionId: contradiction.id, policy: 'prefer_earlier', actor: 'test:actor' }))
      .toThrow(/already resolved/);
  });
});

describe('M39 expiry, forget, and export', () => {
  it('excludes an expired fact from active recall without deleting it', () => {
    const expired = remember({ expiresAt: new Date(Date.now() - 60_000).toISOString() });
    expect(recallMemories(db, { scopeType: 'project', scopeId: 'Atlas' }).entries).toHaveLength(0);
    const historical = recallMemories(db, { scopeType: 'project', scopeId: 'Atlas', includeHistorical: true });
    expect(historical.entries).toHaveLength(1);
    expect(historical.entries[0].kind).toBe('expired_fact');
    // The read performed no hidden write: the row is untouched.
    expect(getMemoryFact(db, expired.memory.id).state).toBe('active');
    expect(getMemoryFact(db, expired.memory.id).revision).toBe(1);
  });

  it('forget scrubs and tombstones the memory and excludes it from every recall', () => {
    const created = remember({ affectedEntities: [{ type: 'repository_file', canonicalKey: 'src/storage.ts' }] });
    const result = forgetMemory(db, { memoryId: created.memory.id, approvalId: 'appr_forget', actor: 'test:actor' });
    expect(result.memory.state).toBe('forgotten');
    expect(result.memory.displayValue).toBe('[forgotten]');
    expect(result.deactivatedRelationships).toBeGreaterThan(0);
    expect(memoryTableDump()).not.toContain('SQLite');
    expect(recallMemories(db, { scopeType: 'project', scopeId: 'Atlas' }).entries).toHaveLength(0);
    expect(recallMemories(db, { scopeType: 'project', scopeId: 'Atlas', includeHistorical: true }).entries).toHaveLength(0);
    // The governed deletion itself remains auditable.
    expect(tableCount('memory_facts')).toBe(1);
    expect(tableCount('memory_evidence')).toBe(1);
    expect(forgetMemory(db, { memoryId: created.memory.id, actor: 'test:actor' }).alreadyForgotten).toBe(true);
  });

  it('export contains the complete auditable evidence chain and is deterministically ordered', () => {
    const created = remember({
      affectedEntities: [
        { type: 'repository_file', canonicalKey: 'src/storage.ts' },
        { type: 'github_issue', canonicalKey: 'fixture/repository#39' },
      ],
    });
    const exported = exportMemory(db, { memoryId: created.memory.id }) as {
      schemaVersion: number; memoryCount: number; memories: Array<Record<string, unknown>>;
    };
    expect(exported.schemaVersion).toBe(1);
    expect(exported.memoryCount).toBe(1);
    const memory = exported.memories[0];
    expect(memory.id).toBe(created.memory.id);
    expect((memory.evidence as unknown[]).length).toBe(1);
    expect((memory.evidence as Array<{ sourceContentSha256: string }>)[0].sourceContentSha256).toHaveLength(64);
    expect((memory.relationships as unknown[]).length).toBe(3);
    expect(memory.tombstoned).toBe(false);
    // Deterministic: two consecutive exports are byte-identical.
    expect(JSON.stringify(exportMemory(db, { memoryId: created.memory.id })))
      .toBe(JSON.stringify(exportMemory(db, { memoryId: created.memory.id })));
    // Tombstone state is represented explicitly after a forget.
    forgetMemory(db, { memoryId: created.memory.id, actor: 'test:actor' });
    const afterForget = exportMemory(db, { memoryId: created.memory.id }) as { memories: Array<Record<string, unknown>> };
    expect(afterForget.memories[0].tombstoned).toBe(true);
  });
});

describe('M39 bounded knowledge graph', () => {
  it('returns repository file, GitHub issue, and product entities with evidence-backed paths', () => {
    const created = remember({
      affectedEntities: [
        { type: 'repository_file', canonicalKey: 'src/storage.ts' },
        { type: 'github_issue', canonicalKey: 'fixture/repository#39' },
        { type: 'product_record', canonicalKey: 'Atlas' },
      ],
    });
    const impact = analyzeMemoryImpact(db, { memoryId: created.memory.id });
    const keys = impact.entries.map((entry) => `${entry.entity.entityType}:${entry.entity.canonicalKey}`).sort();
    expect(keys).toContain('repository_file:src/storage.ts');
    expect(keys).toContain('github_issue:fixture/repository#39');
    expect(keys).toContain(`product_record:${projectId}`);
    expect(impact.entries.every((entry) => entry.evidenceIds.length === entry.path.length && entry.evidenceIds.length > 0)).toBe(true);
    expect(Object.keys(impact.byEntityType).sort()).toEqual(['github_issue', 'product_record', 'project', 'repository_file']);
  });

  it('is cycle-safe and bounded', () => {
    const created = remember({ affectedEntities: [{ type: 'repository_file', canonicalKey: 'src/storage.ts' }] });
    const decision = db.get<{ id: string }>("SELECT id FROM knowledge_entities WHERE entityType = 'decision'")!;
    const file = db.get<{ id: string }>("SELECT id FROM knowledge_entities WHERE entityType = 'repository_file'")!;
    const evidence = db.get<{ id: string }>('SELECT id FROM memory_evidence LIMIT 1')!;
    // Deliberately introduce a cycle: file -> decision.
    db.run(
      `INSERT INTO knowledge_relationships (id, fromEntityId, relationshipType, toEntityId, validFrom, validTo, state, memoryId, evidenceId, createdAt, updatedAt)
       VALUES ('krel_cycle', ?, 'depends_on', ?, '2020-01-01T00:00:00.000Z', NULL, 'active', ?, ?, '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z')`,
      [file.id, decision.id, created.memory.id, evidence.id],
    );
    const impact = analyzeMemoryImpact(db, { memoryId: created.memory.id });
    expect(impact.entries.filter((entry) => entry.entity.id === decision.id)).toHaveLength(0);
    expect(impact.entries.length).toBeLessThanOrEqual(4);
    expect(impact.maxDepth).toBeLessThanOrEqual(4);
  });

  it('never traverses an edge without supporting evidence', () => {
    const created = remember();
    const decision = db.get<{ id: string }>("SELECT id FROM knowledge_entities WHERE entityType = 'decision'")!;
    db.run(
      `INSERT INTO knowledge_entities (id, entityType, canonicalKey, label, scopeType, scopeId, state, createdAt, updatedAt)
       VALUES ('kent_orphan', 'repository_file', 'src/orphan.ts', 'orphan', NULL, NULL, 'active', '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z')`,
    );
    db.run(
      `INSERT INTO knowledge_relationships (id, fromEntityId, relationshipType, toEntityId, validFrom, validTo, state, memoryId, evidenceId, createdAt, updatedAt)
       VALUES ('krel_noevidence', ?, 'affects', 'kent_orphan', '2020-01-01T00:00:00.000Z', NULL, 'active', ?, NULL, '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z')`,
      [decision.id, created.memory.id],
    );
    const impact = analyzeMemoryImpact(db, { memoryId: created.memory.id });
    expect(impact.entries.map((entry) => entry.entity.canonicalKey)).not.toContain('src/orphan.ts');
  });
});

describe('M39 redaction helpers', () => {
  it('redacts every required credential shape', () => {
    const cases: Array<[string, string]> = [
      ['bearer token', 'Bearer abcdefghijklmnopqrstuvwxyz012345'],
      ['github token', FIXTURE_TOKEN],
      ['api key', 'api_key = ABCDEFGHIJKLMNOP0123'], // gitleaks:allow
      ['pem block', '-----BEGIN RSA PRIVATE KEY-----abc-----END RSA PRIVATE KEY-----'],
      ['authorization header', 'Authorization: Bearer abcdefghijklmnopqrst'],
      ['url credentials', 'https://user:hunter2@example.com/repo.git'],
    ];
    for (const [label, value] of cases) {
      const outcome = redactMemoryText(value);
      expect(outcome.redacted, label).toBe(true);
    }
    expect(redactMemoryText('SQLite is the authoritative store').redacted).toBe(false);
  });

  it('redacts nested tool arguments before they can reach governed evidence', () => {
    const redacted = redactMemoryArguments({
      value: `token ${FIXTURE_TOKEN}`,
      affectedEntities: [{ type: 'repository_file', canonicalKey: 'src/storage.ts', label: FIXTURE_TOKEN }],
    });
    expect(JSON.stringify(redacted)).not.toContain(FIXTURE_TOKEN);
  });
});

describe('M39 write identity (regression)', () => {
  it('a restatement in a later turn deduplicates to the same fact and only adds provenance', () => {
    const first = remember();
    const laterMessageId = appendMessage(db, conversationId, {
      role: 'user',
      content: 'Retry: for project Atlas, use SQLite as the authoritative memory store.',
      actor: 'test:actor',
    }).id;
    const restated = remember({ sourceMessageId: laterMessageId });
    expect(restated.deduplicated).toBe(true);
    expect(restated.memory.id).toBe(first.memory.id);
    expect(tableCount('memory_facts')).toBe(1);
    // The restatement is additional evidence for the same fact, not a second fact.
    expect(restated.evidence).toHaveLength(2);
    expect(restated.evidence.map((entry) => entry.sourceMessageId).sort()).toEqual([userMessageId, laterMessageId].sort());
    // Re-linking the same source a third time adds nothing further.
    expect(remember({ sourceMessageId: laterMessageId }).evidence).toHaveLength(2);
  });

  it('a restated decision never resurrects a fact that resolution made historical', () => {
    const first = remember();
    const laterMessageId = appendMessage(db, conversationId, {
      role: 'user', content: 'For project Atlas, use PostgreSQL as the authoritative memory store.', actor: 'test:actor',
    }).id;
    const second = remember({ value: 'PostgreSQL', sourceMessageId: laterMessageId });
    const contradiction = listMemoryContradictions(db, second.memory.id)[0];
    resolveMemoryContradiction(db, { contradictionId: contradiction.id, policy: 'prefer_later', actor: 'test:actor' });
    expect(getMemoryFact(db, first.memory.id).state).toBe('historical');

    const restated = remember();
    expect(restated.deduplicated).toBe(true);
    expect(restated.memory.id).toBe(first.memory.id);
    expect(getMemoryFact(db, first.memory.id).state).toBe('historical');
    expect(tableCount('memory_facts')).toBe(2);
    expect(recallMemories(db, { scopeType: 'project', scopeId: 'Atlas' }).entries.map((entry) => entry.memory.displayValue))
      .toEqual(['PostgreSQL']);
  });

  it('forgetting a memory releases its content identity so it can be deliberately remembered again', () => {
    const first = remember();
    forgetMemory(db, { memoryId: first.memory.id, actor: 'test:actor' });
    const again = remember();
    expect(again.deduplicated).toBe(false);
    expect(again.memory.id).not.toBe(first.memory.id);
    expect(again.memory.state).toBe('active');
    expect(tableCount('memory_facts')).toBe(2);
    // The tombstone remains auditable and still excluded from recall.
    expect(getMemoryFact(db, first.memory.id).state).toBe('forgotten');
    expect(recallMemories(db, { scopeType: 'project', scopeId: 'Atlas' }).entries).toHaveLength(1);
  });
});
