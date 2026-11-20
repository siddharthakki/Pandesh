/**
 * Shared document and receipt processing for JUGAAD. One deterministic pipeline, run as a Panda bridge service so it has a task
 * id, state, cancel, deadline and receipt like everything else:
 *
 *   hash -> detect type (signature table + optional Magika) -> text (PDF text layer, else OCR; images OCR; plain text read)
 *        -> receipt/invoice fields (rule parser) -> household index (FTS5) -> phone record (`document_ref`, household-scoped).
 *
 * Local only: Poppler/Tesseract/Magika run on this PC through the approved modules; no model and no cloud step exists here. If a
 * step cannot run (no Tesseract, an unreadable file) the result says which step failed; there is no fallback to a cloud service.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CoreDatabase } from '../../db/connection';
import { extractPdfTextLayer, hasPdfMagic, ocrFile, resolveOcrTools, type OcrTools } from '../documentOcr';
import { detectFileType, mergeDetections } from '../kandev/bridgeCoreServices';
import { runMagika } from '../kandev/magikaEngine';
import { upsertCompanionRecord } from '../../domain/companionSync';
import { parseReceiptText, type ReceiptFields } from './receiptParser';
import { addDocument, findBySha, openHouseholdIndex, type IndexedDocument } from './documentIndex';
import { householdDirs } from './households';
import { newId } from '../../domain/ids';

export const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;
const TEXT_EXT = new Set(['.txt', '.md', '.csv', '.json', '.xml', '.html', '.htm', '.log', '.eml']);
const IMAGE_MIME = /^image\/(png|jpeg|tiff|bmp|webp|gif)/;

export interface IntakeStep { step: string; engine: string; ok: boolean; ms: number; note?: string }

export interface IntakeResult {
  document: IndexedDocument; created: boolean; steps: IntakeStep[];
  /** 'independent' only when the text came from a text layer or plain text; OCR can misread, so it is worker-only. */
  verification: 'independent' | 'worker-only';
  receipt: ReceiptFields | null;
}

export interface IntakeOptions {
  signal?: AbortSignal; ocrTools?: OcrTools; magikaExe?: string | null; source?: 'phone' | 'host'; displayName?: string;
}

function sha256File(file: string): string {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try { const buf = Buffer.alloc(1 << 20); let n: number; while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n)); } finally { fs.closeSync(fd); }
  return h.digest('hex');
}

const clean = (name: string) => path.basename(name).replace(/[^\w.\- äöüÄÖÜß()]/g, '_').slice(0, 120) || 'document';

/** Runs the pipeline on one file that already sits inside the household's inbox. Throws only for a precondition failure; step failures are reported in `steps`. */
export async function ingestDocument(db: CoreDatabase, dataDir: string, householdId: string, filePath: string, opts: IntakeOptions = {}): Promise<IntakeResult> {
  const dirs = householdDirs(dataDir, householdId);
  const real = fs.realpathSync(filePath);
  const inbox = fs.realpathSync(dirs.inbox);
  const rel = path.relative(inbox, real);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('the document is not in this household\'s inbox');
  const st = fs.statSync(real);
  if (!st.isFile()) throw new Error('not a file');
  if (st.size === 0) throw new Error('the document is empty');
  if (st.size > MAX_DOCUMENT_BYTES) throw new Error(`the document is larger than ${MAX_DOCUMENT_BYTES / 1024 / 1024} MB`);
  const abort = () => { if (opts.signal?.aborted) throw new Error('cancelled'); };
  const steps: IntakeStep[] = [];
  const timed = async <T>(step: string, engine: string, fn: () => Promise<T> | T): Promise<T | null> => {
    const t0 = Date.now(); abort();
    try { const v = await fn(); steps.push({ step, engine, ok: true, ms: Date.now() - t0 }); return v; }
    catch (err) { if (opts.signal?.aborted) throw err; steps.push({ step, engine, ok: false, ms: Date.now() - t0, note: (err instanceof Error ? err.message : String(err)).slice(0, 160) }); return null; }
  };

  const sha = (await timed('hash', 'sha256', () => sha256File(real)))!;
  const existing = findBySha(openHouseholdIndex(dataDir, householdId), sha);
  if (existing) return { document: existing, created: false, steps: [...steps, { step: 'dedupe', engine: 'sha256', ok: true, ms: 0, note: 'already in this household\'s index' }], verification: 'independent', receipt: null };

  const head = Buffer.alloc(Math.min(4096, st.size));
  const fd = fs.openSync(real, 'r'); try { fs.readSync(fd, head, 0, head.length, 0); } finally { fs.closeSync(fd); }
  const sig = detectFileType(head, real);
  const magika = await timed('detect', 'magika', () => runMagika(real, { exe: opts.magikaExe, signal: opts.signal }));
  const type = mergeDetections(sig, magika ?? null, st.size, real, head);
  steps.push({ step: 'detect', engine: type.engine, ok: true, ms: 0, note: `${type.label} (${type.basis})` });

  const tools = opts.ocrTools ?? resolveOcrTools();
  let text = ''; let textSource: IndexedDocument['textSource'] = 'none';
  const isPdf = type.mime === 'application/pdf' || hasPdfMagic(real);
  if (isPdf) {
    const layer = await timed('text', 'poppler-pdftotext', () => extractPdfTextLayer(real, tools, { signal: opts.signal }));
    if (layer && layer.text.replace(/\s/g, '').length > 20) { text = layer.text; textSource = 'text-layer'; }
    else {
      const ocr = await timed('text', 'tesseract', () => ocrFile(real, { tools, maxPages: 10, signal: opts.signal }));
      if (ocr) { text = ocr.sections.map(s => s.text).join('\n\n'); textSource = text.trim() ? 'ocr' : 'none'; }
    }
  } else if (IMAGE_MIME.test(type.mime)) {
    const ocr = await timed('text', 'tesseract', () => ocrFile(real, { tools, signal: opts.signal }));
    if (ocr) { text = ocr.sections.map(s => s.text).join('\n\n'); textSource = text.trim() ? 'ocr' : 'none'; }
  } else if (type.mime.startsWith('text/') || type.mime === 'application/json' || type.mime === 'application/xml' || TEXT_EXT.has(path.extname(real).toLowerCase())) {
    // Fields are parsed from the whole text (a total sits at the END of a long statement); only the search index is capped.
    const raw = await timed('text', 'utf8', () => fs.readFileSync(real, 'utf8').slice(0, 2_000_000));
    if (raw) { text = raw; textSource = 'plain'; }
  } else {
    steps.push({ step: 'text', engine: 'none', ok: false, ms: 0, note: `no text extractor for ${type.label}; the file is stored and indexed by name only` });
  }

  text = text.replace(/\r\n?/g, '\n'); // Poppler and Tesseract emit CRLF on Windows; keep stored text and snippets clean
  const receipt = text.trim() ? parseReceiptText(text) : null;
  if (receipt) steps.push({ step: 'fields', engine: 'rule-parser', ok: receipt.matchedBy.length > 0, ms: 0, note: receipt.matchedBy.join(', ') || 'no field matched' });

  const displayName = clean(opts.displayName ?? path.basename(real));
  const fields: Record<string, unknown> = receipt ? { ...receipt } : {};
  const id = newId('doc');
  const { doc, created } = addDocument(openHouseholdIndex(dataDir, householdId), {
    id, sha256: sha, name: displayName, mime: type.mime, typeLabel: type.label, bytes: st.size, storedName: path.basename(real), source: opts.source ?? 'phone', textChars: text.length, textSource, fields, text,
  });
  steps.push({ step: 'index', engine: 'sqlite-fts5', ok: true, ms: 0 });

  // The phone sees a small reference, never the document: household-scoped record id so other households' phones cannot pull it.
  upsertCompanionRecord(db, {
    recordId: `${householdId}:${doc.id}`, kind: 'document_ref',
    payload: { documentId: doc.id, name: doc.name, type: doc.typeLabel, bytes: doc.bytes, addedAt: doc.addedAt, textSource: doc.textSource, ...(receipt && receipt.matchedBy.length ? { merchant: receipt.merchant ?? null, date: receipt.date ?? null, totalCents: receipt.totalCents ?? null, currency: receipt.currency ?? null, kind: receipt.kind } : {}) },
  });
  return { document: doc, created, steps, verification: textSource === 'ocr' ? 'worker-only' : 'independent', receipt };
}
