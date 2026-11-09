import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CoreDatabase } from '../db/connection';
import { openCoreDatabase } from '../db/openCore';
import { appendMessage, createConversation } from '../domain/conversations';
import { getMemoryFact, rememberMemory } from '../domain/memory';
import { grantDocumentReading, revokeDocumentReading } from '../domain/documentReadGrants';
import { brainGraph, brainItem, brainTimeline, correctBrainFact, ensureBrainIndex, forgetBrainFact, searchBrain, toFtsQuery } from '../domain/secondBrain';
import { assignAgentRun, checkMemoryArguments, deriveScope, BUILTIN_AGENTS } from '../domain/agents';

let dir: string;
let vault: string;
let db: CoreDatabase;

function remember(subject: string, predicate: string, value: string, extra: Record<string, unknown> = {}) {
  const conv = createConversation(db, { mode: 'baat_kar', actor: 'test', title: `About ${subject}` });
  const msg = appendMessage(db, conv.id, { role: 'user', content: `${subject} ${predicate} ${value}`, actor: 'test', clientId: null });
  return rememberMemory(db, { memoryType: 'user', scopeType: 'user', scopeId: 'me', subject, predicate, value, sensitivity: 'internal', sourceConversationId: conv.id, sourceMessageId: msg.id, actor: 'test', clientId: null, ...extra } as Parameters<typeof rememberMemory>[1]).memory;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'second-brain-'));
  vault = path.join(dir, 'vault');
  fs.mkdirSync(vault);
  db = openCoreDatabase(path.join(dir, 'core.db')).db;
});
afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

describe('index and search', () => {
  it('finds facts, notes and granted documents with snippets, and never restricted facts', () => {
    remember('dentist', 'is at', 'Praxis am Markt, Thursday 09:30');
    remember('bank pin', 'is', '4711', { sensitivity: 'restricted' });
    db.run("INSERT INTO everyday_notes (id, title, body, createdAt, updatedAt) VALUES ('n1', 'Kitchen', 'Buy dentist-approved toothbrushes', '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z')");
    fs.writeFileSync(path.join(vault, 'health.md'), '# Health\nThe dentist appointment moved. See [[insurance]].');
    fs.writeFileSync(path.join(vault, 'insurance.md'), '# Insurance\nPolicy number lives in the drawer.');
    grantDocumentReading(db, vault, 'test');

    const r = searchBrain(db, { q: 'dentist' });
    const types = r.hits.map((h) => h.type).sort();
    expect(types).toEqual(['document', 'fact', 'note']);
    expect(r.hits.find((h) => h.type === 'fact')!.snippet).toContain('«');
    expect(searchBrain(db, { q: '4711' }).hits).toHaveLength(0);
    expect(searchBrain(db, { q: 'bank pin' }).hits).toHaveLength(0);
    expect(searchBrain(db, { q: 'dentist', types: ['note'] }).hits.map((h) => h.type)).toEqual(['note']);
  });

  it('rebuilds only when a source changed, and a revoked folder leaves the index', () => {
    fs.writeFileSync(path.join(vault, 'a.md'), 'alpha beta');
    const grant = grantDocumentReading(db, vault, 'test');
    expect(ensureBrainIndex(db).rebuilt).toBe(true);
    expect(ensureBrainIndex(db).rebuilt).toBe(false);
    expect(searchBrain(db, { q: 'alpha' }).hits).toHaveLength(1);
    revokeDocumentReading(db, grant.id, 'test');
    expect(searchBrain(db, { q: 'alpha' }).hits).toHaveLength(0);
  });

  it('turns any user text into a safe full-text query', () => {
    expect(toFtsQuery('dentist "OR" NEAR(x) *')).toBe('"dentist"* AND "or"* AND "near"*');
    expect(toFtsQuery('" ) ( -')).toBeNull();
    expect(() => searchBrain(db, { q: 'a" OR 1=1 --' })).not.toThrow();
  });
});

describe('graph shows only real relationships', () => {
  it('links documents only through explicit links, never co-mentions', () => {
    fs.writeFileSync(path.join(vault, 'a.md'), 'Vienna trip notes. Links: [[b]]');
    fs.writeFileSync(path.join(vault, 'b.md'), 'Vienna hotels');
    fs.writeFileSync(path.join(vault, 'c.md'), 'Vienna museums (no link)');
    grantDocumentReading(db, vault, 'test');
    ensureBrainIndex(db);
    const g = brainGraph(db, {});
    const labels = g.nodes.map((n) => n.label).sort();
    expect(labels).toEqual(['a.md', 'b.md']);
    expect(g.edges).toEqual([expect.objectContaining({ type: 'links_to', origin: 'link' })]);
  });

  it('shows Core relationships with their evidence and the fact’s source conversation', () => {
    const fact = remember('kitchen app', 'depends on', 'barcode import', { affectedEntities: [{ type: 'project', canonicalKey: 'kitchen-inventory', label: 'kitchen-inventory', relationship: 'affects' }] });
    const g = brainGraph(db, { focusType: 'fact', focusId: fact.id });
    expect(g.nodes.some((n) => n.type === 'fact')).toBe(true);
    expect(g.nodes.some((n) => n.type === 'conversation' && n.label === 'About kitchen app')).toBe(true);
    expect(g.edges.some((e) => e.origin === 'provenance' && e.evidence)).toBe(true);
    expect(g.edges.every((e) => e.origin !== 'link' || e.type === 'links_to')).toBe(true);
  });

  it('caps the graph at 150 nodes and reports the rest as clusters', () => {
    for (let i = 0; i < 170; i++) fs.writeFileSync(path.join(vault, `n${i}.md`), `note ${i} [[hub]]`);
    fs.writeFileSync(path.join(vault, 'hub.md'), 'hub');
    grantDocumentReading(db, vault, 'test');
    ensureBrainIndex(db);
    const hubChunk = db.get<{ id: string }>("SELECT k.id AS id FROM knowledge_chunks k JOIN knowledge_sources s ON s.id = k.sourceId WHERE s.locator LIKE '%hub.md'")!;
    const g = brainGraph(db, { focusType: 'document', focusId: hubChunk.id });
    expect(g.nodes.length).toBe(150);
    expect(g.truncated).toBe(true);
    expect(g.clusters[0].count).toBeGreaterThan(0);
  });
});

describe('correct and forget keep provenance', () => {
  it('a correction is a new fact backed by the user’s own message; the old one is forgotten and leaves search', () => {
    const fact = remember('dentist', 'is on', 'Thursday');
    const r = correctBrainFact(db, { memoryId: fact.id, value: 'Friday', actor: 'user', clientId: null });
    expect(getMemoryFact(db, fact.id).state).toBe('forgotten');
    const item = brainItem(db, 'fact', r.corrected.id) as { evidence: Array<{ sourceMessageId: string; conversationTitle: string }>; history: unknown[] };
    expect(item.evidence[0]).toMatchObject({ sourceMessageId: r.evidenceMessageId, conversationTitle: 'Second Brain corrections' });
    expect(searchBrain(db, { q: 'thursday' }).hits).toHaveLength(0);
    expect((item as unknown as { contradictions: Array<{ state: string }> }).contradictions.every((c) => c.state === 'resolved')).toBe(true);
    expect(searchBrain(db, { q: 'friday' }).hits[0].id).toBe(r.corrected.id);
  });

  it('forget removes the fact from search and timeline', () => {
    const fact = remember('old address', 'was', 'Hauptstraße 1');
    expect(brainTimeline(db, {}).some((t) => t.id === fact.id)).toBe(true);
    forgetBrainFact(db, fact.id, 'user', null);
    expect(searchBrain(db, { q: 'hauptstraße' }).hits).toHaveLength(0);
    expect(brainTimeline(db, {}).some((t) => t.id === fact.id)).toBe(false);
  });

  it('restricted facts cannot be opened in the inspector', () => {
    const secret = remember('bank pin', 'is', '4711', { sensitivity: 'restricted' });
    expect(() => brainItem(db, 'fact', secret.id)).toThrow(/restricted/);
  });
});

describe('agent memory scopes at dispatch', () => {
  it('reads only readable scope types and writes only writable ones', () => {
    const def = (id: string) => BUILTIN_AGENTS.find((a) => a.id === id)!;
    const research = deriveScope(def('research'), dir);
    expect(checkMemoryArguments(db, research, 'memory_recall', { scopeType: 'user' }).allowed).toBe(false);
    expect(checkMemoryArguments(db, research, 'memory_recall', {}).allowed).toBe(false);
    expect(checkMemoryArguments(db, research, 'memory_recall', { scopeType: 'global' }).allowed).toBe(true);
    const coding = deriveScope(def('coding'), dir);
    expect(checkMemoryArguments(db, coding, 'memory_remember', { scopeType: 'user' }).allowed).toBe(false);
    const userFact = remember('me', 'likes', 'tea');
    expect(checkMemoryArguments(db, coding, 'memory_forget', { memoryId: userFact.id }).allowed).toBe(false);
    const personal = deriveScope(def('personal'), dir);
    expect(checkMemoryArguments(db, personal, 'memory_forget', { memoryId: userFact.id }).allowed).toBe(true);
    // A child of Research cannot read user memory even if Personal could.
    const personalUnderResearch = deriveScope(def('personal'), dir, research);
    expect(checkMemoryArguments(db, personalUnderResearch, 'memory_recall', { scopeType: 'user' }).allowed).toBe(false);
    void assignAgentRun;
  });
});
