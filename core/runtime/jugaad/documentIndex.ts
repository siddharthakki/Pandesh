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
