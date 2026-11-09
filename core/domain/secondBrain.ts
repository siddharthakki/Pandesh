/**
 * Phase 2d — Second Brain (docs/architecture/pandesh-ui-v2/second_brain_design.md).
 *
 * Built on the existing memory tables. Adds only a source registry for
 * user-granted folders, a derived chunk cache and one FTS5 index; all three are
 * rebuildable and hold no truth of their own.
 *
 * Rules kept from the design:
 * - Edges must earn their place: the graph shows only Core relationships (each
 *   tied to a memory and its evidence), explicit [[wikilinks]]/markdown links
 *   between indexed documents, and fact → conversation provenance. No
 *   co-mention or similarity edges.
 * - `restricted` facts are never indexed or shown; agent runs see only their
 *   memory scopes (enforced at dispatch, 2b).
 * - Folders are read only when the user granted them (document_read_grants);
 *   only .md/.txt, bounded size and count. Nothing is crawled.
 * - No embeddings (gate in §3.3 not met).
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CoreDatabase } from '../db/connection';
import { CoreError } from './errors';
import { newId, nowIso } from './ids';
import { analyzeMemoryImpact, forgetMemory, getMemoryFact, listMemoryContradictions, listMemoryEvidence, listMemoryRelationships, rememberMemory, resolveMemoryContradiction } from './memory';
import { appendMessage, createConversation } from './conversations';

export type BrainItemType = 'fact' | 'note' | 'commitment' | 'artifact' | 'entity' | 'document';
const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

const MAX_FILES = 2000;
const MAX_FILE_BYTES = 512 * 1024;

// ---------- index ----------

function signature(db: CoreDatabase): string {
  const parts = [
    db.get<{ n: number; m: string | null }>("SELECT COUNT(*) AS n, MAX(updatedAt) AS m FROM memory_facts"),
    db.get<{ n: number; m: string | null }>('SELECT COUNT(*) AS n, MAX(updatedAt) AS m FROM everyday_notes'),
    db.get<{ n: number; m: string | null }>('SELECT COUNT(*) AS n, MAX(updatedAt) AS m FROM commitments'),
    db.get<{ n: number; m: string | null }>('SELECT COUNT(*) AS n, MAX(createdAt) AS m FROM artifacts'),
    db.get<{ n: number; m: string | null }>('SELECT COUNT(*) AS n, MAX(updatedAt) AS m FROM knowledge_entities'),
    db.get<{ n: number; m: string | null }>('SELECT COUNT(*) AS n, MAX(lastIndexedAt) AS m FROM knowledge_sources'),
    db.get<{ n: number; m: string | null }>('SELECT COUNT(*) AS n, MAX(COALESCE(revokedAt, grantedAt)) AS m FROM document_read_grants'),
  ];
  return parts.map((p) => `${p?.n ?? 0}:${p?.m ?? ''}`).join('|');
}

function chunkText(text: string): Array<{ heading: string | null; text: string; start: number; end: number }> {
  const out: Array<{ heading: string | null; text: string; start: number; end: number }> = [];
  const lines = text.split(/\r?\n/);
  let heading: string | null = null; let buf: string[] = []; let start = 0; let pos = 0;
  const flush = (end: number) => { const t = buf.join('\n').trim(); if (t) out.push({ heading, text: t.slice(0, 4000), start, end }); buf = []; start = end; };
  for (const line of lines) {
    const h = line.match(/^#{1,4}\s+(.+)/);
    if (h) { flush(pos); heading = h[1].trim(); }
    buf.push(line);
    pos += line.length + 1;
    if (buf.join('\n').length > 1600) flush(pos);
  }
  flush(pos);
  return out;
}

const LINK_RE = /\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]|\]\(([^)\s]+\.(?:md|txt))\)/gi;

/** Indexes .md/.txt files in folders the user granted for document reading. Content stays where it is. */
function syncGrantedFolders(db: CoreDatabase): { files: number; skipped: number } {
  const grants = db.all<{ id: string; folder: string }>('SELECT id, folder FROM document_read_grants WHERE revokedAt IS NULL');
  const live = new Set<string>();
  let files = 0; let skipped = 0;
  for (const g of grants) {
    const stack = [g.folder];
    while (stack.length && files < MAX_FILES) {
      const dir = stack.pop()!;
      let entries: fs.Dirent[] = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        if (e.name.startsWith('.') || e.name === 'node_modules') continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { stack.push(full); continue; }
        if (!/\.(md|markdown|txt)$/i.test(e.name)) continue;
        let st: fs.Stats; try { st = fs.statSync(full); } catch { continue; }
        if (st.size > MAX_FILE_BYTES) { skipped++; continue; }
        files++;
        live.add(full);
        const text = fs.readFileSync(full, 'utf8');
        const hash = sha(text);
        const existing = db.get<{ id: string; contentSha256: string | null }>("SELECT id, contentSha256 FROM knowledge_sources WHERE kind = 'document' AND locator = ?", [full]);
        if (existing?.contentSha256 === hash) continue;
        const id = existing?.id ?? newId('ksrc');
        db.transaction(() => {
          if (existing) db.run('DELETE FROM knowledge_chunks WHERE sourceId = ?', [id]);
          else db.run("INSERT INTO knowledge_sources (id, kind, locator, grantId, scopeType, sensitivity, state) VALUES (?, 'document', ?, ?, 'user', 'internal', 'active')", [id, full, g.id]);
          chunkText(text).forEach((c, i) => db.run('INSERT INTO knowledge_chunks (id, sourceId, ordinal, heading, text, charStart, charEnd, contentSha256) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [newId('kch'), id, i, c.heading, c.text, c.start, c.end, sha(c.text)]));
          db.run("UPDATE knowledge_sources SET contentSha256 = ?, lastIndexedAt = ?, state = 'active' WHERE id = ?", [hash, nowIso(), id]);
        });
      }
    }
  }
  // Files that disappeared or whose grant was revoked leave the index.
  for (const s of db.all<{ id: string; locator: string }>("SELECT id, locator FROM knowledge_sources WHERE kind = 'document' AND state = 'active'")) {
    if (!live.has(s.locator)) db.transaction(() => { db.run('DELETE FROM knowledge_chunks WHERE sourceId = ?', [s.id]); db.run('DELETE FROM knowledge_links WHERE fromSourceId = ? OR toSourceId = ?', [s.id, s.id]); db.run("UPDATE knowledge_sources SET state = 'gone', lastIndexedAt = ? WHERE id = ?", [nowIso(), s.id]); });
  }
  // Structural links between indexed documents: [[wikilinks]] and markdown links by file name.
  const docs = db.all<{ id: string; locator: string }>("SELECT id, locator FROM knowledge_sources WHERE kind = 'document' AND state = 'active'");
  const byName = new Map(docs.map((d) => [path.basename(d.locator).replace(/\.(md|markdown|txt)$/i, '').toLowerCase(), d.id]));
  db.run('DELETE FROM knowledge_links');
  for (const d of docs) {
    const text = db.all<{ text: string }>('SELECT text FROM knowledge_chunks WHERE sourceId = ? ORDER BY ordinal', [d.id]).map((c) => c.text).join('\n');
    for (const m of text.matchAll(LINK_RE)) {
      const target = (m[1] ?? path.basename(m[2] ?? '').replace(/\.(md|txt)$/i, '')).trim().toLowerCase();
      const to = byName.get(target);
      if (to && to !== d.id) db.run("INSERT OR IGNORE INTO knowledge_links (id, fromSourceId, toSourceId, linkType, evidence) VALUES (?, ?, ?, 'links_to', ?)", [newId('klk'), d.id, to, m[0].slice(0, 200)]);
    }
  }
  return { files, skipped };
}

/** Rebuilds the full-text index when any source changed. Cheap no-op otherwise. */
export function ensureBrainIndex(db: CoreDatabase, force = false): { rebuilt: boolean; items: number; builtAt: string } {
  syncGrantedFolders(db);
  const sig = signature(db);
  const state = db.get<{ signature: string; builtAt: string; items: number }>('SELECT signature, builtAt, items FROM brain_index_state WHERE id = 1');
  if (!force && state?.signature === sig) return { rebuilt: false, items: state.items, builtAt: state.builtAt };
  let items = 0;
  db.transaction(() => {
    db.run('DELETE FROM brain_fts');
    const ins = (title: string, body: string, type: BrainItemType, id: string, scope: string, sensitivity: string, date: string | null) => {
      db.run('INSERT INTO brain_fts (title, body, itemType, itemId, scopeType, sensitivity, itemDate) VALUES (?, ?, ?, ?, ?, ?, ?)', [title, body, type, id, scope, sensitivity, date]);
      items++;
    };
    for (const f of db.all<{ id: string; subject: string; predicate: string; displayValue: string; scopeType: string; sensitivity: string; createdAt: string }>(
      "SELECT id, subject, predicate, displayValue, scopeType, sensitivity, createdAt FROM memory_facts WHERE state = 'active' AND forgottenAt IS NULL AND sensitivity != 'restricted'")) {
      ins(`${f.subject} — ${f.predicate}`, f.displayValue, 'fact', f.id, f.scopeType, f.sensitivity, f.createdAt);
    }
    for (const n of db.all<{ id: string; title: string | null; body: string; updatedAt: string }>('SELECT id, title, body, updatedAt FROM everyday_notes WHERE deletedAt IS NULL')) ins(n.title || n.body.slice(0, 60), n.body, 'note', n.id, 'user', 'internal', n.updatedAt);
    for (const c of db.all<{ id: string; title: string; detail: string | null; status: string; dueAt: string | null; createdAt: string }>('SELECT id, title, detail, status, dueAt, createdAt FROM commitments')) ins(c.title, `${c.detail ?? ''} (${c.status}${c.dueAt ? `, due ${c.dueAt}` : ''})`, 'commitment', c.id, 'user', 'internal', c.dueAt ?? c.createdAt);
    for (const a of db.all<{ id: string; title: string | null; kind: string; absolutePath: string | null; createdAt: string }>('SELECT id, title, kind, absolutePath, createdAt FROM artifacts')) ins(a.title || path.basename(a.absolutePath ?? a.id), `${a.kind} ${a.absolutePath ?? ''}`, 'artifact', a.id, 'task', 'internal', a.createdAt);
    for (const e of db.all<{ id: string; label: string; entityType: string; scopeType: string | null; createdAt: string }>("SELECT id, label, entityType, scopeType, createdAt FROM knowledge_entities WHERE state = 'active' AND entityType NOT IN ('decision', 'user')")) ins(e.label, e.entityType, 'entity', e.id, e.scopeType ?? 'global', 'internal', e.createdAt);
    for (const c of db.all<{ id: string; heading: string | null; text: string; locator: string; lastIndexedAt: string | null }>(
      "SELECT k.id AS id, k.heading AS heading, k.text AS text, s.locator AS locator, s.lastIndexedAt AS lastIndexedAt FROM knowledge_chunks k JOIN knowledge_sources s ON s.id = k.sourceId WHERE s.state = 'active' AND s.sensitivity != 'restricted'")) {
      ins(`${path.basename(c.locator)}${c.heading ? ` › ${c.heading}` : ''}`, c.text, 'document', c.id, 'user', 'internal', c.lastIndexedAt);
    }
    const builtAt = nowIso();
    db.run('INSERT INTO brain_index_state (id, signature, builtAt, items) VALUES (1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET signature = excluded.signature, builtAt = excluded.builtAt, items = excluded.items', [sig, builtAt, items]);
  });
  return { rebuilt: true, items, builtAt: nowIso() };
}

// ---------- search ----------

export interface BrainHit { id: string; type: BrainItemType; title: string; snippet: string; scope: string; date: string | null; score: number }

/** User text → a safe FTS5 query: each word a quoted prefix term, all required. */
export function toFtsQuery(q: string): string | null {
  const words = q.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'._-]*/gu) ?? [];
  const terms = words.filter((w) => w.length > 1).slice(0, 12).map((w) => `"${w.replace(/"/g, '')}"*`);
  return terms.length ? terms.join(' AND ') : null;
}

export function searchBrain(db: CoreDatabase, input: { q: string; types?: BrainItemType[]; scopes?: string[]; limit?: number }): { hits: BrainHit[]; total: number } {
  ensureBrainIndex(db);
  const match = toFtsQuery(input.q);
  if (!match) return { hits: [], total: 0 };
  const where: string[] = ['brain_fts MATCH ?'];
  const params: unknown[] = [match];
  if (input.types?.length) { where.push(`itemType IN (${input.types.map(() => '?').join(',')})`); params.push(...input.types); }
  if (input.scopes?.length) { where.push(`scopeType IN (${input.scopes.map(() => '?').join(',')})`); params.push(...input.scopes); }
  const rows = db.all<{ title: string; snip: string; itemType: BrainItemType; itemId: string; scopeType: string; itemDate: string | null; score: number }>(
    `SELECT title, snippet(brain_fts, -1, '«', '»', '…', 14) AS snip, itemType, itemId, scopeType, itemDate, bm25(brain_fts, 4.0, 1.0) AS score
       FROM brain_fts WHERE ${where.join(' AND ')} ORDER BY score LIMIT ?`, [...params, Math.min(input.limit ?? 40, 200)]);
  return { hits: rows.map((r) => ({ id: r.itemId, type: r.itemType, title: r.title, snippet: r.snip, scope: r.scopeType, date: r.itemDate, score: Math.round(-r.score * 100) / 100 })), total: rows.length };
}

// ---------- item inspector ----------

export function brainItem(db: CoreDatabase, type: BrainItemType, id: string): Record<string, unknown> {
  switch (type) {
    case 'fact': {
      const fact = getMemoryFact(db, id);
      if (fact.sensitivity === 'restricted') throw new CoreError('forbidden', 'this memory is restricted and is not shown');
      const history = db.all('SELECT id, displayValue, state, revision, createdAt, forgottenAt FROM memory_facts WHERE scopeType = ? AND scopeId = ? AND subject = ? AND predicate = ? ORDER BY createdAt DESC', [fact.scopeType, fact.scopeId, fact.subject, fact.predicate]);
      const evidence = listMemoryEvidence(db, id).map((e) => ({ ...e, conversationTitle: e.sourceConversationId ? db.get<{ title: string | null }>('SELECT title FROM conversations WHERE id = ?', [e.sourceConversationId])?.title ?? null : null }));
      return { type, fact, evidence, relationships: listMemoryRelationships(db, id), contradictions: listMemoryContradictions(db, id), history };
    }
    case 'note': {
      const note = db.get('SELECT id, title, body, createdAt, updatedAt FROM everyday_notes WHERE id = ? AND deletedAt IS NULL', [id]);
      if (!note) throw new CoreError('not_found', 'note not found');
      return { type, note };
    }
    case 'commitment': {
      const c = db.get('SELECT * FROM commitments WHERE id = ?', [id]);
      if (!c) throw new CoreError('not_found', 'commitment not found');
      return { type, commitment: c };
    }
    case 'artifact': {
      const a = db.get('SELECT id, conversationId, attemptId, kind, title, mimeType, absolutePath, byteSize, source, createdAt FROM artifacts WHERE id = ?', [id]);
      if (!a) throw new CoreError('not_found', 'artifact not found');
      return { type, artifact: a };
    }
    case 'entity': {
      const e = db.get('SELECT * FROM knowledge_entities WHERE id = ?', [id]);
      if (!e) throw new CoreError('not_found', 'entity not found');
      const relationships = db.all("SELECT r.*, f.label AS fromLabel, t.label AS toLabel FROM knowledge_relationships r JOIN knowledge_entities f ON f.id = r.fromEntityId JOIN knowledge_entities t ON t.id = r.toEntityId WHERE (r.fromEntityId = ? OR r.toEntityId = ?) AND r.state = 'active'", [id, id]);
      return { type, entity: e, relationships };
    }
    case 'document': {
      const c = db.get<{ sourceId: string } & Record<string, unknown>>('SELECT k.*, s.locator AS locator, s.lastIndexedAt AS lastIndexedAt FROM knowledge_chunks k JOIN knowledge_sources s ON s.id = k.sourceId WHERE k.id = ?', [id]);
      if (!c) throw new CoreError('not_found', 'document section not found');
      const links = db.all('SELECT l.linkType, l.evidence, s.locator AS target FROM knowledge_links l JOIN knowledge_sources s ON s.id = l.toSourceId WHERE l.fromSourceId = ?', [c.sourceId]);
      const backlinks = db.all('SELECT l.linkType, l.evidence, s.locator AS source FROM knowledge_links l JOIN knowledge_sources s ON s.id = l.fromSourceId WHERE l.toSourceId = ?', [c.sourceId]);
      return { type, chunk: c, links, backlinks };
    }
    default: throw new CoreError('invalid_request', `unknown item type ${type}`);
  }
}

// ---------- timeline ----------

export function brainTimeline(db: CoreDatabase, input: { from?: string; to?: string; types?: BrainItemType[]; limit?: number }): Array<{ id: string; type: BrainItemType; title: string; date: string; detail: string }> {
  const from = input.from ?? '0000'; const to = input.to ?? '9999';
  const want = (t: BrainItemType) => !input.types?.length || input.types.includes(t);
  const out: Array<{ id: string; type: BrainItemType; title: string; date: string; detail: string }> = [];
  if (want('fact')) for (const f of db.all<{ id: string; subject: string; predicate: string; displayValue: string; createdAt: string }>("SELECT id, subject, predicate, displayValue, createdAt FROM memory_facts WHERE state = 'active' AND sensitivity != 'restricted' AND createdAt BETWEEN ? AND ?", [from, to])) out.push({ id: f.id, type: 'fact', title: `${f.subject} — ${f.predicate}`, date: f.createdAt, detail: f.displayValue });
  if (want('note')) for (const n of db.all<{ id: string; title: string | null; body: string; createdAt: string }>('SELECT id, title, body, createdAt FROM everyday_notes WHERE deletedAt IS NULL AND createdAt BETWEEN ? AND ?', [from, to])) out.push({ id: n.id, type: 'note', title: n.title || n.body.slice(0, 60), date: n.createdAt, detail: n.body.slice(0, 160) });
  if (want('commitment')) for (const c of db.all<{ id: string; title: string; status: string; createdAt: string }>('SELECT id, title, status, createdAt FROM commitments WHERE createdAt BETWEEN ? AND ?', [from, to])) out.push({ id: c.id, type: 'commitment', title: c.title, date: c.createdAt, detail: c.status });
  if (want('artifact')) for (const a of db.all<{ id: string; title: string | null; kind: string; createdAt: string }>('SELECT id, title, kind, createdAt FROM artifacts WHERE createdAt BETWEEN ? AND ?', [from, to])) out.push({ id: a.id, type: 'artifact', title: a.title || a.kind, date: a.createdAt, detail: a.kind });
  return out.sort((a, b) => b.date.localeCompare(a.date)).slice(0, Math.min(input.limit ?? 200, 500));
}

// ---------- graph (real relationships only) ----------

export interface GraphNode { id: string; type: BrainItemType | 'conversation' | 'cluster'; label: string; count?: number }
export interface GraphEdge { from: string; to: string; type: string; origin: 'relationship' | 'link' | 'provenance'; evidence: string | null }

const LIMIT_NODES = 150;

export function brainGraph(db: CoreDatabase, input: { focusType?: BrainItemType; focusId?: string; hops?: number; limit?: number }): { nodes: GraphNode[]; edges: GraphEdge[]; clusters: GraphNode[]; truncated: boolean } {
  ensureBrainIndex(db);
  const limit = Math.min(input.limit ?? LIMIT_NODES, LIMIT_NODES);
  const nodes = new Map<string, GraphNode>(); const edges: GraphEdge[] = []; const clusterCounts = new Map<string, number>();
  let truncated = false;
  const add = (n: GraphNode) => { if (nodes.has(n.id)) return true; if (nodes.size >= limit) { truncated = true; clusterCounts.set(n.type, (clusterCounts.get(n.type) ?? 0) + 1); return false; } nodes.set(n.id, n); return true; };
  const seenEdges = new Set<string>();
  const edge = (e: GraphEdge) => {
    const key = `${e.from}|${e.type}|${e.to}`;
    if (nodes.has(e.from) && nodes.has(e.to) && !seenEdges.has(key)) { seenEdges.add(key); edges.push(e); }
  };

  const entityNeighbours = (entityId: string) => db.all<{ id: string; fromEntityId: string; toEntityId: string; relationshipType: string; evidenceId: string | null; memoryId: string | null; fromLabel: string; fromType: string; toLabel: string; toType: string }>(
    `SELECT r.id, r.fromEntityId, r.toEntityId, r.relationshipType, r.evidenceId, r.memoryId, f.label AS fromLabel, f.entityType AS fromType, t.label AS toLabel, t.entityType AS toType
       FROM knowledge_relationships r JOIN knowledge_entities f ON f.id = r.fromEntityId JOIN knowledge_entities t ON t.id = r.toEntityId
      WHERE r.state = 'active' AND (r.fromEntityId = ? OR r.toEntityId = ?)`, [entityId, entityId]);

  const expandFact = (factId: string) => {
    const f = db.get<{ id: string; subject: string; predicate: string; displayValue: string; sensitivity: string }>("SELECT id, subject, predicate, displayValue, sensitivity FROM memory_facts WHERE id = ? AND state = 'active'", [factId]);
    if (!f || f.sensitivity === 'restricted') return [];
    add({ id: `fact:${f.id}`, type: 'fact', label: `${f.subject}: ${f.displayValue}`.slice(0, 80) });
    for (const e of listMemoryEvidence(db, f.id)) if (e.sourceConversationId) {
      const title = db.get<{ title: string | null }>('SELECT title FROM conversations WHERE id = ?', [e.sourceConversationId])?.title ?? 'Conversation';
      if (add({ id: `conversation:${e.sourceConversationId}`, type: 'conversation', label: title ?? 'Conversation' })) edge({ from: `fact:${f.id}`, to: `conversation:${e.sourceConversationId}`, type: 'from', origin: 'provenance', evidence: e.id });
    }
    const ents = db.all<{ fromEntityId: string; toEntityId: string }>("SELECT fromEntityId, toEntityId FROM knowledge_relationships WHERE memoryId = ? AND state = 'active'", [f.id]);
    return [...new Set(ents.flatMap((r) => [r.fromEntityId, r.toEntityId]))];
  };
  const expandEntity = (entityId: string, depth: number, maxDepth: number) => {
    for (const r of entityNeighbours(entityId)) {
      add({ id: `entity:${r.fromEntityId}`, type: 'entity', label: `${r.fromLabel}` });
      add({ id: `entity:${r.toEntityId}`, type: 'entity', label: `${r.toLabel}` });
      edge({ from: `entity:${r.fromEntityId}`, to: `entity:${r.toEntityId}`, type: r.relationshipType, origin: 'relationship', evidence: r.evidenceId });
      if (r.memoryId) { const before = nodes.size; expandFact(r.memoryId); if (nodes.has(`fact:${r.memoryId}`) && nodes.size >= before) edge({ from: `fact:${r.memoryId}`, to: `entity:${r.fromEntityId}`, type: 'states', origin: 'relationship', evidence: r.evidenceId }); }
      if (depth < maxDepth) { const other = r.fromEntityId === entityId ? r.toEntityId : r.fromEntityId; expandEntity(other, depth + 1, maxDepth); }
    }
  };
  const expandDoc = (sourceId: string, depth: number, maxDepth: number) => {
    const s = db.get<{ locator: string }>("SELECT locator FROM knowledge_sources WHERE id = ? AND state = 'active'", [sourceId]);
    if (!s) return;
    add({ id: `doc:${sourceId}`, type: 'document', label: path.basename(s.locator) });
    for (const l of db.all<{ fromSourceId: string; toSourceId: string; evidence: string }>('SELECT fromSourceId, toSourceId, evidence FROM knowledge_links WHERE fromSourceId = ? OR toSourceId = ?', [sourceId, sourceId])) {
      const other = l.fromSourceId === sourceId ? l.toSourceId : l.fromSourceId;
      const os = db.get<{ locator: string }>('SELECT locator FROM knowledge_sources WHERE id = ?', [other]);
      if (os && add({ id: `doc:${other}`, type: 'document', label: path.basename(os.locator) })) edge({ from: `doc:${l.fromSourceId}`, to: `doc:${l.toSourceId}`, type: 'links_to', origin: 'link', evidence: l.evidence });
      if (depth < maxDepth) expandDoc(other, depth + 1, maxDepth);
    }
  };

  const hops = Math.min(Math.max(input.hops ?? 1, 1), 2);
  if (input.focusId && input.focusType) {
    if (input.focusType === 'fact') for (const ent of expandFact(input.focusId)) expandEntity(ent, 1, hops);
    else if (input.focusType === 'entity') expandEntity(input.focusId, 1, hops);
    else if (input.focusType === 'document') { const src = db.get<{ sourceId: string }>('SELECT sourceId FROM knowledge_chunks WHERE id = ?', [input.focusId])?.sourceId; if (src) expandDoc(src, 1, hops); }
    else throw new CoreError('invalid_request', `a ${input.focusType} has no graph neighbourhood`);
  } else {
    // Overview: the most connected entities and linked documents, never the whole graph.
    for (const e of db.all<{ id: string }>("SELECT e.id AS id FROM knowledge_entities e JOIN knowledge_relationships r ON (r.fromEntityId = e.id OR r.toEntityId = e.id) AND r.state = 'active' WHERE e.state = 'active' GROUP BY e.id ORDER BY COUNT(*) DESC LIMIT 25")) expandEntity(e.id, 1, 1);
    for (const d of db.all<{ id: string }>('SELECT fromSourceId AS id FROM knowledge_links GROUP BY fromSourceId ORDER BY COUNT(*) DESC LIMIT 25')) expandDoc(d.id, 1, 1);
  }
  const clusters = [...clusterCounts.entries()].map(([t, n]) => ({ id: `cluster:${t}`, type: 'cluster' as const, label: `${n} more ${t}${n === 1 ? '' : 's'}`, count: n }));
  return { nodes: [...nodes.values()], edges, clusters, truncated };
}

// ---------- correction and forgetting ----------

export function forgetImpact(db: CoreDatabase, memoryId: string) {
  const fact = getMemoryFact(db, memoryId);
  return { fact, impact: analyzeMemoryImpact(db, { memoryId, maxDepth: 2 }) };
}

export function forgetBrainFact(db: CoreDatabase, memoryId: string, actor: string, clientId: string | null) {
  const r = forgetMemory(db, { memoryId, actor, clientId });
  ensureBrainIndex(db, true);
  return r;
}

/**
 * The user corrects a fact. The correction is recorded as the user's own
 * message in a "Second Brain corrections" conversation (so the new fact has
 * real provenance), remembered with the same subject/predicate/scope, and the
 * old fact is forgotten through the existing tombstone path.
 */
export function correctBrainFact(db: CoreDatabase, input: { memoryId: string; value: string; actor: string; clientId: string | null }) {
  const value = input.value.trim();
  if (!value) throw new CoreError('invalid_request', 'the corrected value is empty');
  const old = getMemoryFact(db, input.memoryId);
  if (old.state !== 'active') throw new CoreError('invalid_transition', 'only an active memory can be corrected');
  const convId = db.get<{ id: string }>("SELECT id FROM conversations WHERE title = 'Second Brain corrections' ORDER BY createdAt LIMIT 1")?.id
    ?? createConversation(db, { mode: 'baat_kar', actor: input.actor, title: 'Second Brain corrections' } as Parameters<typeof createConversation>[1]).id;
  const message = appendMessage(db, convId, { role: 'user', content: `Correction: ${old.subject} — ${old.predicate} is "${value}" (was "${old.displayValue}").`, actor: input.actor, clientId: input.clientId });
  const remembered = rememberMemory(db, {
    memoryType: old.memoryType, scopeType: old.scopeType, scopeId: old.scopeId, subject: old.subject, predicate: old.predicate,
    value, sensitivity: old.sensitivity, sourceConversationId: convId, sourceMessageId: message.id, actor: input.actor, clientId: input.clientId,
  } as Parameters<typeof rememberMemory>[1]);
  forgetMemory(db, { memoryId: old.id, actor: input.actor, clientId: input.clientId });
  // The user decided: the conflict Core recorded between old and new is resolved in favour of the correction.
  for (const c of remembered.contradictions ?? []) {
    if (c.state === 'unresolved') resolveMemoryContradiction(db, { contradictionId: c.id, policy: 'prefer_later', actor: input.actor, clientId: input.clientId });
  }
  ensureBrainIndex(db, true);
  return { corrected: remembered.memory, replaced: old.id, evidenceMessageId: message.id };
}
