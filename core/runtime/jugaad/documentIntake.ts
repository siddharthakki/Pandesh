/**
 * Shared document and receipt processing for JUGAAD. One deterministic pipeline, run as a Panda bridge service so it has a task id,
 * state, cancel, deadline and receipt like everything else:
 *
 *   hash -> detect type (signature table + optional Magika) -> text (PDF text layer, else OCR; images OCR; plain text read)
 *        -> receipt/invoice fields (rule parser) -> household index (FTS5) -> phone record (`document_ref`, household-scoped).
 *
 * The same pipeline is what the owner can re-run later (`reprocessDocument`) when OCR or the parsers improve. The ORIGINAL file is never
 * touched: it stays in the household inbox under the hash it was accepted with, every run is recorded in the document's processing
 * history, and a re-run only replaces the current result, never the original or the earlier runs.
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
import { addDocument, addRun, findBySha, getDocument, openHouseholdIndex, replaceDocumentProcessing, type IndexedDocument } from './documentIndex';
import { householdDirs } from './households';
import { newId } from '../../domain/ids';

export const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;
/** Bump when the text extraction or the field parser changes in a way that can change results: older documents then show as "outdated". */
export const PIPELINE_VERSION = 'jugaad-intake-3';
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

interface Analysis {
  sha: string; bytes: number; typeLabel: string; mime: string; text: string; textSource: IndexedDocument['textSource'];
  receipt: ReceiptFields | null; steps: IntakeStep[];
}

/** Hash, detect, extract text, parse fields. Pure with respect to the index: it reads the file and nothing else. */
async function analyzeFile(real: string, opts: IntakeOptions, steps: IntakeStep[] = []): Promise<Analysis> {
  const st = fs.statSync(real);
  if (!st.isFile()) throw new Error('not a file');
  if (st.size === 0) throw new Error('the document is empty');
  if (st.size > MAX_DOCUMENT_BYTES) throw new Error(`the document is larger than ${MAX_DOCUMENT_BYTES / 1024 / 1024} MB`);
  const abort = () => { if (opts.signal?.aborted) throw new Error('cancelled'); };
  const timed = async <T>(step: string, engine: string, fn: () => Promise<T> | T): Promise<T | null> => {
    const t0 = Date.now(); abort();
    try { const v = await fn(); steps.push({ step, engine, ok: true, ms: Date.now() - t0 }); return v; }
    catch (err) { if (opts.signal?.aborted) throw err; steps.push({ step, engine, ok: false, ms: Date.now() - t0, note: (err instanceof Error ? err.message : String(err)).slice(0, 160) }); return null; }
  };

  const sha = (await timed('hash', 'sha256', () => sha256File(real)))!;
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
  return { sha, bytes: st.size, typeLabel: type.label, mime: type.mime, text, textSource, receipt, steps };
}

/** The phone's small reference to a document (never the document itself); household-scoped record id. */
function publishDocumentRef(db: CoreDatabase, householdId: string, doc: IndexedDocument, receipt: ReceiptFields | null): void {
  upsertCompanionRecord(db, {
    recordId: `${householdId}:${doc.id}`, kind: 'document_ref',
    payload: { documentId: doc.id, name: doc.name, type: doc.typeLabel, bytes: doc.bytes, addedAt: doc.addedAt, textSource: doc.textSource, ...(receipt && receipt.matchedBy.length ? { merchant: receipt.merchant ?? null, date: receipt.date ?? null, totalCents: receipt.totalCents ?? null, currency: receipt.currency ?? null, kind: receipt.kind } : {}) },
  });
}

/** Runs the pipeline on one file that already sits inside the household's inbox. Throws only for a precondition failure; step failures are reported in `steps`. */
export async function ingestDocument(db: CoreDatabase, dataDir: string, householdId: string, filePath: string, opts: IntakeOptions = {}): Promise<IntakeResult> {
  const dirs = householdDirs(dataDir, householdId);
  const real = fs.realpathSync(filePath);
  const inbox = fs.realpathSync(dirs.inbox);
  const rel = path.relative(inbox, real);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('the document is not in this household\'s inbox');
  const index = openHouseholdIndex(dataDir, householdId);
  const steps: IntakeStep[] = [];
  const a = await analyzeFile(real, opts, steps);
  const existing = findBySha(index, a.sha);
  if (existing) return { document: existing, created: false, steps: [...steps, { step: 'dedupe', engine: 'sha256', ok: true, ms: 0, note: 'already in this household\'s index' }], verification: 'independent', receipt: null };

  const displayName = clean(opts.displayName ?? path.basename(real));
  const fields: Record<string, unknown> = a.receipt ? { ...a.receipt } : {};
  const { doc, created } = addDocument(index, {
    id: newId('doc'), sha256: a.sha, name: displayName, mime: a.mime, typeLabel: a.typeLabel, bytes: a.bytes, storedName: path.basename(real), source: opts.source ?? 'phone', textChars: a.text.length, textSource: a.textSource, fields, text: a.text,
  });
  steps.push({ step: 'index', engine: 'sqlite-fts5', ok: true, ms: 0 });
  if (created) addRun(index, { documentId: doc.id, trigger: 'intake', by: `jugaad:${opts.source ?? 'phone'}`, pipelineVersion: PIPELINE_VERSION, status: 'applied', typeLabel: doc.typeLabel, textSource: doc.textSource, textChars: doc.textChars, fields, steps, changes: [], note: null });
  publishDocumentRef(db, householdId, doc, a.receipt);
  return { document: doc, created, steps, verification: a.textSource === 'ocr' ? 'worker-only' : 'independent', receipt: a.receipt };
}

export interface FieldChange { field: string; before: unknown; after: unknown }

export interface ReprocessResult {
  documentId: string; outcome: 'updated' | 'unchanged' | 'kept-previous'; changes: FieldChange[]; steps: IntakeStep[];
  verification: 'independent' | 'worker-only'; runId: number; pipelineVersion: string;
}

const FIELD_KEYS = ['kind', 'merchant', 'date', 'totalCents', 'currency', 'vatCents', 'invoiceNumber'] as const;
function diffFields(before: Record<string, unknown>, after: Record<string, unknown>): FieldChange[] {
  const out: FieldChange[] = [];
  for (const k of FIELD_KEYS) if (JSON.stringify(before[k] ?? null) !== JSON.stringify(after[k] ?? null)) out.push({ field: k, before: before[k] ?? null, after: after[k] ?? null });
  return out;
}

/**
 * Owner-authorised re-run of the pipeline on a document already in the index (the caller is a host-started, tracked task).
 * The original file is read, never written: its SHA-256 must still equal the one it was accepted with, or nothing is changed.
 * The result replaces the document's CURRENT text and fields; every run, including this one, stays in the history with a field-by-field diff.
 * A run that loses the text the previous run had (for example an OCR that failed this time) is recorded but does not replace it.
 */
export async function reprocessDocument(db: CoreDatabase, dataDir: string, householdId: string, documentId: string, ctx: { by: string; reason?: string | null; signal?: AbortSignal; ocrTools?: OcrTools; magikaExe?: string | null }): Promise<ReprocessResult> {
  const dirs = householdDirs(dataDir, householdId);
  const index = openHouseholdIndex(dataDir, householdId);
  const doc = getDocument(index, documentId);
  if (!doc) throw new Error('document not found in this household');
  const original = path.join(dirs.inbox, doc.storedName);
  if (!fs.existsSync(original)) throw new Error('the original file is no longer in the household inbox; nothing was changed');
  if (sha256File(original) !== doc.sha256) throw new Error('the original file no longer matches the hash it was accepted with; nothing was changed');

  const steps: IntakeStep[] = [];
  const a = await analyzeFile(original, { signal: ctx.signal, ocrTools: ctx.ocrTools, magikaExe: ctx.magikaExe }, steps);
  const newFields: Record<string, unknown> = a.receipt ? { ...a.receipt } : {};
  const changes = diffFields(doc.fields, newFields);
  const typeChanged = a.typeLabel !== doc.typeLabel || a.mime !== doc.mime;
  const textChanged = a.text.slice(0, 400_000) !== (getText(index, doc.id) ?? '') || a.textSource !== doc.textSource;
  const lostText = doc.textChars > 0 && a.text.trim().length === 0;
  const verification: 'independent' | 'worker-only' = a.textSource === 'ocr' ? 'worker-only' : 'independent';

  let outcome: ReprocessResult['outcome'];
  if (lostText) outcome = 'kept-previous';
  else if (!changes.length && !typeChanged && !textChanged) outcome = 'unchanged';
  else outcome = 'updated';

  const run = addRun(index, {
    documentId: doc.id, trigger: 'reprocess', by: ctx.by, pipelineVersion: PIPELINE_VERSION,
    status: outcome === 'updated' ? 'applied' : outcome === 'unchanged' ? 'unchanged' : 'kept-previous',
    typeLabel: a.typeLabel, textSource: a.textSource, textChars: a.text.length, fields: newFields, steps, changes,
    note: ctx.reason ? String(ctx.reason).slice(0, 300) : outcome === 'kept-previous' ? 'the new run found no text where the previous run had some; the previous result was kept' : null,
  });
  if (outcome === 'updated') {
    replaceDocumentProcessing(index, doc.id, { typeLabel: a.typeLabel, mime: a.mime, textSource: a.textSource, textChars: Math.min(a.text.length, 400_000), fields: newFields, text: a.text });
    publishDocumentRef(db, householdId, getDocument(index, doc.id)!, a.receipt);
  }
  return { documentId: doc.id, outcome, changes, steps, verification, runId: run.id, pipelineVersion: PIPELINE_VERSION };
}

function getText(index: CoreDatabase, id: string): string | null {
  return index.get<{ textBody: string }>('SELECT textBody FROM documents WHERE id = ?', [id])?.textBody ?? null;
}
