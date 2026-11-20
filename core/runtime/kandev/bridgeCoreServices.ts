/**
 * Deterministic services for routine operations, registered with the Panda bridge's service registry. They run as ordinary
 * bridge tasks (task id, status, cancel, deadline, receipt) inside the roots they were registered with. None of them imports
 * child_process: PDF/OCR work goes through the already-allowlisted `core/runtime/documentOcr.ts`.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BridgeService, ServiceContext, ServiceOutput } from './bridgeServices';
import { resolveInsideRoots } from './bridgeServices';
import { extractPdfTextLayer, hasPdfMagic, ocrFile, pdfPageCount, resolveOcrTools } from '../documentOcr';
import { searchBrain } from '../../domain/secondBrain';
import { searchConversations } from '../../domain/workbench';
import { DEFAULT_OLLAMA_URL } from '../modelBackend';

const MAX_LIST = 200;

function abortIf(signal: AbortSignal) { if (signal.aborted) throw new Error('cancelled'); }

/** Exact directory listing and counts, hidden entries counted separately (never silently dropped). */
export function fsListService(roots: string[]): BridgeService {
  return {
    id: 'fs.list', label: 'Directory listing and counts (read-only)', readOnly: true, taskClasses: ['filesystem.list'], roots,
    async run({ args, signal }): Promise<ServiceOutput> {
      const p = resolveInsideRoots(args.path, roots);
      const st = fs.statSync(p);
      if (!st.isDirectory()) throw new Error('args.path is not a directory');
      const entries = fs.readdirSync(p, { withFileTypes: true });
      abortIf(signal);
      const hidden = (n: string) => n.startsWith('.');
      const files = entries.filter(e => e.isFile()), dirs = entries.filter(e => e.isDirectory());
      const counts = {
        files: files.filter(e => !hidden(e.name)).length, folders: dirs.filter(e => !hidden(e.name)).length,
        hiddenFiles: files.filter(e => hidden(e.name)).length, hiddenFolders: dirs.filter(e => hidden(e.name)).length,
        other: entries.length - files.length - dirs.length, total: entries.length,
      };
      const shown = entries.slice().sort((a, b) => a.name.localeCompare(b.name)).slice(0, MAX_LIST);
      return {
        summary: `${counts.files + counts.hiddenFiles} file(s) and ${counts.folders + counts.hiddenFolders} folder(s), ${counts.hiddenFiles + counts.hiddenFolders} of them hidden`,
        evidence: {
          kind: 'directory-listing', counts, truncated: entries.length > MAX_LIST,
          entries: shown.map(e => ({ name: e.name, type: e.isDirectory() ? 'folder' : e.isFile() ? 'file' : 'other', hidden: hidden(e.name) })),
        },
      };
    },
  };
}

/** Types recognised from the first bytes. A signature, not a guess from the name; the name is only compared afterwards. */
const SIGNATURES: Array<{ label: string; mime: string; test: (b: Buffer) => boolean }> = [
  { label: 'PDF document', mime: 'application/pdf', test: b => b.subarray(0, 4).toString('latin1') === '%PDF' },
  { label: 'PNG image', mime: 'image/png', test: b => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { label: 'JPEG image', mime: 'image/jpeg', test: b => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { label: 'GIF image', mime: 'image/gif', test: b => /^GIF8[79]a/.test(b.subarray(0, 6).toString('latin1')) },
  { label: 'WebP image', mime: 'image/webp', test: b => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
  { label: 'WAV audio', mime: 'audio/wav', test: b => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WAVE' },
  { label: 'TIFF image', mime: 'image/tiff', test: b => (b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a && b[3] === 0) || (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0 && b[3] === 0x2a) },
  { label: 'BMP image', mime: 'image/bmp', test: b => b[0] === 0x42 && b[1] === 0x4d },
  { label: 'MP4/QuickTime video', mime: 'video/mp4', test: b => b.subarray(4, 8).toString('latin1') === 'ftyp' },
  { label: 'MP3 audio', mime: 'audio/mpeg', test: b => b.subarray(0, 3).toString('latin1') === 'ID3' || (b[0] === 0xff && (b[1]! & 0xe0) === 0xe0) },
  { label: 'Ogg media', mime: 'application/ogg', test: b => b.subarray(0, 4).toString('latin1') === 'OggS' },
  { label: 'ZIP container (also DOCX/XLSX/PPTX/JAR/APK)', mime: 'application/zip', test: b => b[0] === 0x50 && b[1] === 0x4b && (b[2] === 3 || b[2] === 5) },
  { label: 'GZIP archive', mime: 'application/gzip', test: b => b[0] === 0x1f && b[1] === 0x8b },
  { label: '7-Zip archive', mime: 'application/x-7z-compressed', test: b => b.subarray(0, 6).equals(Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) },
  { label: 'RAR archive', mime: 'application/vnd.rar', test: b => b.subarray(0, 6).toString('latin1') === 'Rar!\x1a\x07' },
  { label: 'Windows executable (PE)', mime: 'application/vnd.microsoft.portable-executable', test: b => b[0] === 0x4d && b[1] === 0x5a },
  { label: 'ELF executable', mime: 'application/x-elf', test: b => b[0] === 0x7f && b.subarray(1, 4).toString('latin1') === 'ELF' },
  { label: 'SQLite database', mime: 'application/vnd.sqlite3', test: b => b.subarray(0, 15).toString('latin1') === 'SQLite format 3' },
  { label: 'RTF document', mime: 'application/rtf', test: b => b.subarray(0, 5).toString('latin1') === '{\\rtf' },
  { label: 'OLE2 Office document (DOC/XLS/PPT/MSI)', mime: 'application/x-ole-storage', test: b => b.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) },
];

const EXTENSION_FAMILY: Record<string, string> = {
  '.docx': 'ZIP', '.xlsx': 'ZIP', '.pptx': 'ZIP', '.zip': 'ZIP', '.jar': 'ZIP', '.apk': 'ZIP', '.pdf': 'PDF', '.png': 'PNG', '.jpg': 'JPEG', '.jpeg': 'JPEG',
  '.gif': 'GIF', '.webp': 'WebP', '.wav': 'WAV', '.mp3': 'MP3', '.mp4': 'MP4', '.mov': 'MP4', '.exe': 'Windows', '.dll': 'Windows', '.gz': 'GZIP', '.7z': '7-Zip', '.rar': 'RAR', '.db': 'SQLite', '.sqlite': 'SQLite',
};

export function detectFileType(head: Buffer, fileName: string): { label: string; mime: string; basis: 'signature' | 'text-heuristic' | 'unknown'; nameMatches: boolean | null } {
  const sig = SIGNATURES.find(s => head.length >= 4 && s.test(head));
  const family = EXTENSION_FAMILY[path.extname(fileName).toLowerCase()] ?? null;
  if (sig) return { label: sig.label, mime: sig.mime, basis: 'signature', nameMatches: family ? sig.label.includes(family) : null };
  // No signature: text if it decodes as UTF-8 without control bytes.
  const sample = head.subarray(0, 4096);
  const binary = sample.some(b => b === 0 || (b < 9) || (b > 13 && b < 32));
  if (sample.length && !binary) {
    const t = sample.toString('utf8').trimStart();
    if (/^<!doctype html|^<html/i.test(t)) return { label: 'HTML document', mime: 'text/html', basis: 'text-heuristic', nameMatches: null };
    if (/^<\?xml/i.test(t)) return { label: 'XML document', mime: 'application/xml', basis: 'text-heuristic', nameMatches: null };
    if (/^[{[]/.test(t)) { try { JSON.parse(sample.length < 4096 ? t : t + ''); return { label: 'JSON document', mime: 'application/json', basis: 'text-heuristic', nameMatches: null }; } catch { /* maybe truncated */ } }
    return { label: 'Plain text', mime: 'text/plain', basis: 'text-heuristic', nameMatches: null };
  }
  return { label: 'Unknown binary', mime: 'application/octet-stream', basis: 'unknown', nameMatches: null };
}

export function detectTypeService(roots: string[]): BridgeService {
  return {
    id: 'doc.detect-type', label: 'File type from content (read-only)', readOnly: true, taskClasses: ['document.detect'], roots,
    async run({ args }): Promise<ServiceOutput> {
      const p = resolveInsideRoots(args.path, roots);
      const st = fs.statSync(p);
      if (!st.isFile()) throw new Error('args.path is not a file');
      const fd = fs.openSync(p, 'r');
      let head: Buffer;
      try { head = Buffer.alloc(Math.min(4096, st.size)); fs.readSync(fd, head, 0, head.length, 0); } finally { fs.closeSync(fd); }
      const t = detectFileType(head, p);
      return { summary: `${t.label} (${t.basis})`, evidence: { kind: 'file-type', ...t, extension: path.extname(p).toLowerCase() || null, bytes: st.size, engine: 'signature-table' } };
    },
  };
}

/** PDF operations through the approved OCR module (Poppler/Tesseract with fixed argv). */
export function pdfServices(roots: string[]): BridgeService[] {
  const pdfPath = (args: Record<string, unknown>) => {
    const p = resolveInsideRoots(args.path, roots);
    if (!/\.pdf$/i.test(p) && !hasPdfMagic(p)) throw new Error('args.path must be a PDF');
    return p;
  };
  return [
    {
      id: 'doc.pdf-text', label: 'PDF text layer (Poppler via the approved OCR module, read-only)', readOnly: true, taskClasses: ['document.extract'], roots,
      async run({ args, signal }) {
        const p = pdfPath(args);
        const { text } = await extractPdfTextLayer(p, resolveOcrTools(), { signal });
        const chars = text.replace(/\s/g, '').length;
        if (chars === 0) throw new Error('no text layer found (a scan?); use the OCR service');
        return { summary: `Extracted ${chars} characters`, evidence: { kind: 'pdf-text', chars, text: text.slice(0, 1500) } };
      },
    },
    {
      id: 'doc.pdf-info', label: 'PDF page count (Poppler, read-only)', readOnly: true, taskClasses: ['pdf.info'], roots,
      async run({ args, signal }) {
        const p = pdfPath(args);
        const pages = await pdfPageCount(p, resolveOcrTools(), { signal });
        if (pages === null) throw new Error('could not read the page count (Poppler pdfinfo missing or the file is not a readable PDF)');
        return { summary: `${pages} page(s)`, evidence: { kind: 'pdf-info', pages, bytes: fs.statSync(p).size } };
      },
    },
    {
      id: 'doc.pdf-ocr', label: 'PDF/image OCR (Tesseract via the approved OCR module, read-only)', readOnly: true, taskClasses: ['ocr.pdf'], roots,
      async run({ args, signal }) {
        const p = resolveInsideRoots(args.path, roots);
        const pages = Number.isInteger(args.pages) ? Math.min(10, Math.max(1, Number(args.pages))) : 3;
        const r = await ocrFile(p, { maxPages: pages, signal });
        const text = r.sections.map(s => s.text).join('\n\n');
        if (!text.trim()) throw new Error('OCR found no text');
        return { summary: `Recognised ${text.length} characters`, evidence: { kind: 'ocr', engine: r.engine, pages: r.pageCount, chars: text.length, text: text.slice(0, 1500) } };
      },
    },
  ];
}

/** Health of the pieces the bridge depends on. Read-only probes with short timeouts. */
export function healthService(): BridgeService {
  return {
    id: 'svc.health', label: 'Service health check (read-only)', readOnly: true, taskClasses: ['service.health'], roots: [],
    async run({ db, host, signal }): Promise<ServiceOutput> {
      const out: Record<string, unknown> = { kind: 'health', checkedAt: new Date().toISOString() };
      try { out.database = db ? (db.get<{ ok: number }>('SELECT 1 AS ok')?.ok === 1 ? 'ok' : 'unexpected') : 'unavailable'; } catch (e) { out.database = `failed: ${(e as Error).message.slice(0, 80)}`; }
      try {
        const base = (process.env.KARKEDIKHA_OLLAMA_URL ?? DEFAULT_OLLAMA_URL).replace(/\/$/, '');
        const r = await fetch(`${base}/api/tags`, { signal: AbortSignal.any([signal, AbortSignal.timeout(4000)]) });
        const j = await r.json().catch(() => null) as { models?: unknown[] } | null;
        out.ollama = { reachable: r.ok, models: Array.isArray(j?.models) ? j!.models.length : null };
      } catch { out.ollama = { reachable: false, models: null }; }
      out.kandev = { running: host ? await host.kandevRunning().catch(() => false) : null };
      const bad = [out.database !== 'ok' ? 'database' : '', (out.ollama as { reachable: boolean }).reachable ? '' : 'ollama'].filter(Boolean);
      return { summary: bad.length ? `Needs attention: ${bad.join(', ')}` : 'Core database and Ollama are healthy', evidence: out };
    },
  };
}

/** Full-text search over Pandesh's own records, through the existing indexes. */
export function searchRecordsService(): BridgeService {
  return {
    id: 'search.records', label: 'Search Pandesh records (read-only)', readOnly: true, taskClasses: ['search.records'], roots: [],
    async run({ args, db }): Promise<ServiceOutput> {
      if (!db) throw new Error('search needs the Core database');
      const query = String(args.query ?? '').trim();
      if (query.length < 2) throw new Error('args.query is required');
      const scope = args.scope === 'conversations' ? 'conversations' : 'brain';
      if (scope === 'conversations') {
        const r = searchConversations(db, query, 8);
        return { summary: `${r.length} conversation(s) match`, evidence: { kind: 'search', scope, query, total: r.length, items: r.slice(0, 8).map(x => ({ id: (x as { id?: string }).id ?? null, title: String((x as { title?: string }).title ?? '').slice(0, 100) })) } };
      }
      const r = searchBrain(db, { q: query, limit: 8 });
      return { summary: `${r.total} item(s) match`, evidence: { kind: 'search', scope, query, total: r.total, items: r.hits.slice(0, 8).map(h => ({ id: h.id, type: h.type, title: h.title.slice(0, 100), date: h.date })) } };
    },
  };
}

/** Runs a registered workflow as child bridge tasks (same lifecycle, receipts and permissions); the parent task mirrors the result. */
export function workflowRunService(): BridgeService {
  return {
    id: 'workflow.run', label: 'Run a registered workflow', readOnly: false, taskClasses: ['workflow.run'], roots: [],
    async run({ args, host, signal }): Promise<ServiceOutput> {
      if (!host) throw new Error('workflow execution needs the bridge runtime');
      const id = String(args.workflow ?? '');
      const input = args.input && typeof args.input === 'object' ? args.input as Record<string, unknown> : {};
      const run = await host.runWorkflow(id, input, signal);
      const summary = `${id}: ${run.status} (${run.steps.map(s => `${s.name}=${s.status}`).join(', ')})`;
      if (run.status !== 'completed') throw new Error(summary);
      return { summary, evidence: { kind: 'workflow-run', workflow: id, status: run.status, steps: run.steps } };
    },
  };
}

export function coreServices(roots: string[]): BridgeService[] {
  return [fsListService(roots), detectTypeService(roots), ...pdfServices(roots), healthService(), searchRecordsService(), workflowRunService()];
}

export type { ServiceContext };
