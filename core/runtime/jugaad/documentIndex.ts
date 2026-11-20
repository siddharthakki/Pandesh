/**
 * The household's local document index: one SQLite file per household with an FTS5 table, so searching one household can
 * only ever touch that household's file. Nothing leaves the PC: no embeddings service, no cloud search.
 */
import { openDatabase, type CoreDatabase } from '../../db/connection';
import { householdDirs } from './households';

export interface IndexedDocument {
  id: string; sha256: string; name: string; mime: string; typeLabel: string; bytes: number; storedName: string;
  source: 'phone' | 'host'; addedAt: string; textChars: number; textSource: 'text-layer' | 'ocr' | 'plain' | 'none';
  fields: Record<string, unknown>;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY, sha256 TEXT NOT NULL UNIQUE, name TEXT NOT NULL, mime TEXT NOT NULL, typeLabel TEXT NOT NULL, bytes INTEGER NOT NULL,
  storedName TEXT NOT NULL, source TEXT NOT NULL, addedAt TEXT NOT NULL, textChars INTEGER NOT NULL, textSource TEXT NOT NULL, fieldsJson TEXT NOT NULL, textBody TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS processing_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, documentId TEXT NOT NULL, startedAt TEXT NOT NULL, trigger TEXT NOT NULL, byWho TEXT NOT NULL,
  pipelineVersion TEXT NOT NULL, status TEXT NOT NULL, typeLabel TEXT NOT NULL, textSource TEXT NOT NULL, textChars INTEGER NOT NULL,
  fieldsJson TEXT NOT NULL, stepsJson TEXT NOT NULL, changesJson TEXT NOT NULL, note TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_doc ON processing_runs(documentId, id);
CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(name, body, merchant, tokenize = 'unicode61 remove_diacritics 2');
`;

const opened = new Map<string, CoreDatabase>();

/** The household's index (opened once per Core run). */
export function openHouseholdIndex(dataDir: string, householdId: string): CoreDatabase {
  const dirs = householdDirs(dataDir, householdId);
  let db = opened.get(dirs.index);
  if (!db) { db = openDatabase(dirs.index); db.exec(SCHEMA); opened.set(dirs.index, db); }
  return db;
}

/** Test hook and shutdown: closes every open index handle. */
export function closeHouseholdIndexes(): void { for (const db of opened.values()) { try { db.close(); } catch { /* closed */ } } opened.clear(); }

const rowToDoc = (r: Record<string, unknown>): IndexedDocument => ({
  id: String(r.id), sha256: String(r.sha256), name: String(r.name), mime: String(r.mime), typeLabel: String(r.typeLabel), bytes: Number(r.bytes), storedName: String(r.storedName),
  source: r.source === 'host' ? 'host' : 'phone', addedAt: String(r.addedAt), textChars: Number(r.textChars), textSource: r.textSource as IndexedDocument['textSource'],
  fields: JSON.parse(String(r.fieldsJson)),
});

export function findBySha(db: CoreDatabase, sha256: string): IndexedDocument | null {
  const r = db.get<Record<string, unknown>>('SELECT * FROM documents WHERE sha256 = ?', [sha256]);
  return r ? rowToDoc(r) : null;
}

export function getDocument(db: CoreDatabase, id: string): IndexedDocument | null {
  const r = db.get<Record<string, unknown>>('SELECT * FROM documents WHERE id = ?', [id]);
  return r ? rowToDoc(r) : null;
}

/** Adds a document once per content hash; the same bytes again return the existing record (`created: false`). */
export function addDocument(db: CoreDatabase, doc: Omit<IndexedDocument, 'id' | 'addedAt'> & { id: string; text: string }): { doc: IndexedDocument; created: boolean } {
  const existing = findBySha(db, doc.sha256);
  if (existing) return { doc: existing, created: false };
  const at = new Date().toISOString();
  const body = doc.text.slice(0, 400_000);
  db.transaction(() => {
    const ins = db.run(
      'INSERT INTO documents (id, sha256, name, mime, typeLabel, bytes, storedName, source, addedAt, textChars, textSource, fieldsJson, textBody) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [doc.id, doc.sha256, doc.name, doc.mime, doc.typeLabel, doc.bytes, doc.storedName, doc.source, at, body.length, doc.textSource, JSON.stringify(doc.fields), body],
    );
    db.run('INSERT INTO documents_fts (rowid, name, body, merchant) VALUES (?, ?, ?, ?)', [Number(ins.lastInsertRowid), doc.name, body, String(doc.fields.merchant ?? '')]);
  });
  return { doc: getDocument(db, doc.id)!, created: true };
}

/** FTS5 query from free text: every word becomes a quoted prefix term, so user text can never be FTS syntax. */
export function ftsQuery(text: string): string | null {
  const words = (String(text ?? '').normalize('NFKC').match(/[\p{L}\p{N}][\p{L}\p{N}.'-]*/gu) ?? []).slice(0, 12);
  return words.length ? words.map(w => `"${w.replace(/"/g, '')}"*`).join(' ') : null;
}

export interface SearchHit { id: string; name: string; typeLabel: string; addedAt: string; snippet: string; fields: Record<string, unknown> }

export function searchDocuments(db: CoreDatabase, text: string, limit = 10): SearchHit[] {
  const q = ftsQuery(text);
  if (!q) return [];
  const rows = db.all<Record<string, unknown>>(
    `SELECT d.id, d.name, d.typeLabel, d.addedAt, d.fieldsJson, snippet(documents_fts, 1, '[', ']', ' … ', 14) AS snip
       FROM documents_fts JOIN documents d ON d.rowid = documents_fts.rowid
      WHERE documents_fts MATCH ? ORDER BY rank LIMIT ?`, [q, Math.min(25, Math.max(1, limit))]);
  return rows.map(r => ({ id: String(r.id), name: String(r.name), typeLabel: String(r.typeLabel), addedAt: String(r.addedAt), snippet: String(r.snip ?? ''), fields: JSON.parse(String(r.fieldsJson)) }));
}

export function listDocuments(db: CoreDatabase, limit = 50): IndexedDocument[] {
  return db.all<Record<string, unknown>>('SELECT * FROM documents ORDER BY addedAt DESC LIMIT ?', [Math.min(200, Math.max(1, limit))]).map(rowToDoc);
}

// ---------------------------------------------------------------- processing history

export interface ProcessingRun {
  id: number; documentId: string; at: string; trigger: 'intake' | 'reprocess'; by: string; pipelineVersion: string;
  status: 'applied' | 'unchanged' | 'kept-previous'; typeLabel: string; textSource: string; textChars: number;
  fields: Record<string, unknown>; steps: unknown[]; changes: Array<{ field: string; before: unknown; after: unknown }>; note: string | null;
}

/** Appends one run to the document's history. History is append-only: nothing here updates or deletes a row. */
export function addRun(db: CoreDatabase, r: Omit<ProcessingRun, 'id' | 'at'>): ProcessingRun {
  const at = new Date().toISOString();
  const ins = db.run(
    'INSERT INTO processing_runs (documentId, startedAt, trigger, byWho, pipelineVersion, status, typeLabel, textSource, textChars, fieldsJson, stepsJson, changesJson, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [r.documentId, at, r.trigger, r.by, r.pipelineVersion, r.status, r.typeLabel, r.textSource, r.textChars, JSON.stringify(r.fields), JSON.stringify(r.steps), JSON.stringify(r.changes), r.note],
  );
  return { ...r, id: Number(ins.lastInsertRowid), at };
}

export function listRuns(db: CoreDatabase, documentId: string): ProcessingRun[] {
  return db.all<Record<string, unknown>>('SELECT * FROM processing_runs WHERE documentId = ? ORDER BY id ASC', [documentId]).map(x => ({
    id: Number(x.id), documentId: String(x.documentId), at: String(x.startedAt), trigger: x.trigger as ProcessingRun['trigger'], by: String(x.byWho), pipelineVersion: String(x.pipelineVersion),
    status: x.status as ProcessingRun['status'], typeLabel: String(x.typeLabel), textSource: String(x.textSource), textChars: Number(x.textChars),
    fields: JSON.parse(String(x.fieldsJson)), steps: JSON.parse(String(x.stepsJson)), changes: JSON.parse(String(x.changesJson)), note: (x.note as string) ?? null,
  }));
}

/** Replaces the document's CURRENT result (text, fields, search entry). The original file and the earlier runs are not touched. */
export function replaceDocumentProcessing(db: CoreDatabase, id: string, p: { typeLabel: string; mime: string; textSource: IndexedDocument['textSource']; textChars: number; fields: Record<string, unknown>; text: string }): void {
  const body = p.text.slice(0, 400_000);
  db.transaction(() => {
    const row = db.get<{ rowid: number; name: string }>('SELECT rowid AS rowid, name FROM documents WHERE id = ?', [id]);
    if (!row) throw new Error('document not found');
    db.run('UPDATE documents SET typeLabel = ?, mime = ?, textSource = ?, textChars = ?, fieldsJson = ?, textBody = ? WHERE id = ?', [p.typeLabel, p.mime, p.textSource, p.textChars, JSON.stringify(p.fields), body, id]);
    db.run('DELETE FROM documents_fts WHERE rowid = ?', [Number(row.rowid)]);
    db.run('INSERT INTO documents_fts (rowid, name, body, merchant) VALUES (?, ?, ?, ?)', [Number(row.rowid), row.name, body, String(p.fields.merchant ?? '')]);
  });
}

/** Documents whose newest run was made by an older pipeline (or that have no run at all): candidates for an owner-authorised reprocess. */
export function listOutdated(db: CoreDatabase, currentVersion: string, limit = 200): Array<{ id: string; name: string; pipelineVersion: string | null }> {
  return db.all<{ id: string; name: string; pv: string | null }>(
    `SELECT d.id AS id, d.name AS name, (SELECT r.pipelineVersion FROM processing_runs r WHERE r.documentId = d.id ORDER BY r.id DESC LIMIT 1) AS pv FROM documents d ORDER BY d.addedAt ASC`,
  ).filter(x => x.pv !== currentVersion).slice(0, limit).map(x => ({ id: x.id, name: x.name, pipelineVersion: x.pv }));
}
