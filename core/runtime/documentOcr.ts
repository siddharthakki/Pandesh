/**
 * Local OCR and PDF text extraction.
 *
 * Everything here runs on this PC: Poppler's `pdftoppm` renders a PDF page
 * to an image, Tesseract reads the image, Poppler's `pdftotext` reads the
 * text layer of a text PDF. Nothing is uploaded, nothing is sent to a cloud
 * model, and no document byte ever leaves the machine.
 *
 * The two engines answer different questions and the difference is honest:
 *   - `pdftotext` reads the TEXT LAYER of a PDF (fast, exact, and empty for a
 *     scan),
 *   - OCR reads the PICTURE of a page (slow, approximate, and the only way to
 *     read a scan).
 * A caller that needs both gets both, each labelled with the tool that
 * produced it.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createSanitizedChildEnvironment } from '../security/childEnvironment';
import { resolveExecutable } from './capabilityInventory';

export interface OcrTools {
  tesseract: string | null;
  pdftoppm: string | null;
  pdftotext: string | null;
  pdfinfo: string | null;
}

/** Known install locations for the tools Pandesh drives. */
const TESSERACT_KNOWN = [
  'C:\\Program Files\\Tesseract-OCR\\tesseract.exe',
  'C:\\Program Files (x86)\\Tesseract-OCR\\tesseract.exe',
];

/** Locates the OCR/PDF binaries once per process. */
export function resolveOcrTools(env: NodeJS.ProcessEnv = process.env): OcrTools {
  return {
    tesseract: resolveExecutable(['tesseract'], env, TESSERACT_KNOWN),
    pdftoppm: resolveExecutable(['pdftoppm'], env),
    pdftotext: resolveExecutable(['pdftotext'], env),
    pdfinfo: resolveExecutable(['pdfinfo'], env),
  };
}

export interface OcrSection {
  /** 1-based page number; null for a standalone image. */
  page: number | null;
  text: string;
  /** Which engine produced this section. */
  engine: 'ocr' | 'text-layer';
}

export interface OcrResult {
  engine: string;
  pageCount: number | null;
  sections: OcrSection[];
  /** The tools that actually ran. */
  tools: string[];
  /** Honest notes: which pages failed, what was skipped and why. */
  notes: string[];
  truncated: boolean;
}

export interface OcrOptions {
  /** 1-based first page. */
  firstPage?: number;
  /** 1-based last page (inclusive). */
  lastPage?: number;
  /** Tesseract language, e.g. "eng" or "deu+eng". */
  language?: string;
  /** Render resolution for the page image. */
  dpi?: number;
  /** Hard cap on pages read in one call. */
  maxPages?: number;
  /** Hard cap on the text returned. */
  maxChars?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Test seam: the binaries to use. */
  tools?: OcrTools;
}

const DEFAULT_MAX_PAGES = 40;
const DEFAULT_MAX_CHARS = 400_000;
const DEFAULT_TIMEOUT_MS = 120_000;

export class OcrError extends Error {
  constructor(message: string, readonly reason: 'not_installed' | 'failed' | 'cancelled' | 'timeout' | 'invalid_arguments') {
    super(message);
    this.name = 'OcrError';
  }
}

interface RunResult { code: number | null; stdout: string; stderr: string }

/**
 * Runs one local binary with a sanitized environment, a bounded timeout and
 * a real process-tree kill on cancellation. Nothing is ever run through a
 * shell, so no argument can be reinterpreted.
 */
export function runLocalTool(
  file: string,
  args: string[],
  options: { timeoutMs?: number; signal?: AbortSignal; cwd?: string; maxBuffer?: number } = {},
): Promise<RunResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBuffer = options.maxBuffer ?? 32 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(file, args, {
        cwd: options.cwd,
        env: createSanitizedChildEnvironment(),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      reject(new OcrError(`could not start ${path.basename(file)}: ${error instanceof Error ? error.message : String(error)}`, 'failed'));
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result: RunResult | Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      if (result instanceof Error) reject(result);
      else resolve(result);
    };
    const kill = () => {
      try { child.kill(); } catch { /* already gone */ }
      try {
        // The tree primitive: a tool that spawned helpers must not leave them.
        spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
      } catch { /* best effort */ }
    };
    const onAbort = () => { kill(); finish(new OcrError('the OCR run was cancelled', 'cancelled')); };
    const timer = setTimeout(() => { kill(); finish(new OcrError(`the OCR run exceeded ${Math.round(timeoutMs / 1000)}s and was stopped`, 'timeout')); }, timeoutMs);
    timer.unref?.();
    options.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < maxBuffer) stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < maxBuffer) stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => finish(new OcrError(`could not start ${path.basename(file)}: ${error.message}`, 'failed')));
    child.on('close', (code) => finish({ code, stdout, stderr }));
  });
}

/** The PDF's page count, read by Poppler itself (never guessed). */
export async function pdfPageCount(pdfPath: string, tools: OcrTools, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<number | null> {
  if (!tools.pdfinfo) return null;
  const result = await runLocalTool(tools.pdfinfo, [pdfPath], { timeoutMs: options.timeoutMs ?? 20_000, signal: options.signal });
  if (result.code !== 0) return null;
  const match = /Pages:\s*(\d+)/i.exec(result.stdout);
  return match ? Number(match[1]) : null;
}

/** Reads the TEXT LAYER of a PDF with Poppler. Empty for a scan — honestly empty. */
export async function extractPdfTextLayer(
  pdfPath: string,
  tools: OcrTools,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<{ text: string; pages: number | null }> {
  if (!tools.pdftotext) return { text: '', pages: null };
  const result = await runLocalTool(tools.pdftotext, ['-layout', '-enc', 'UTF-8', pdfPath, '-'], {
    timeoutMs: options.timeoutMs ?? 60_000,
    signal: options.signal,
  });
  if (result.code !== 0) return { text: '', pages: null };
  return { text: result.stdout, pages: null };
}

/** Reads one page image with Tesseract. */
export async function ocrImageFile(
  imagePath: string,
  tools: OcrTools,
  options: { language?: string; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<string> {
  if (!tools.tesseract) throw new OcrError('Tesseract OCR is not installed on this PC', 'not_installed');
  const args = [imagePath, 'stdout'];
  if (options.language) args.push('-l', options.language);
  const result = await runLocalTool(tools.tesseract, args, {
    timeoutMs: options.timeoutMs ?? 90_000,
    signal: options.signal,
  });
  if (result.code !== 0) {
    throw new OcrError(`Tesseract could not read the page (exit ${result.code ?? 'none'}): ${result.stderr.trim().split(/\r?\n/).slice(-2).join(' ')}`.slice(0, 300), 'failed');
  }
  return result.stdout;
}

/** True when the file really starts with the PDF magic bytes. */
export function hasPdfMagic(filePath: string): boolean {
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, 'r');
    const header = Buffer.alloc(4);
    const read = fs.readSync(fd, header, 0, 4, 0);
    return read === 4 && header.toString('latin1') === '%PDF';
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* already closed */ }
    }
  }
}

/**
 * OCRs a PDF or an image file.
 *
 * A PDF is rendered page by page with Poppler and each page is read with
 * Tesseract, so the result carries the page it came from. An image is read
 * directly.
 */
export async function ocrFile(filePath: string, options: OcrOptions = {}): Promise<OcrResult> {
  const tools = options.tools ?? resolveOcrTools();
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const dpi = options.dpi ?? 200;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const notes: string[] = [];
  const used: string[] = [];

  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    throw new OcrError(`"${filePath}" does not exist`, 'invalid_arguments');
  }
  if (!stat.isFile()) throw new OcrError(`"${filePath}" is not a file`, 'invalid_arguments');

  const extension = path.extname(filePath).toLowerCase();
  const isPdf = extension === '.pdf' || hasPdfMagic(filePath);

  if (!isPdf) {
    if (!tools.tesseract) throw new OcrError('Tesseract OCR is not installed on this PC', 'not_installed');
    used.push('tesseract');
    const text = await ocrImageFile(filePath, tools, { language: options.language, timeoutMs, signal: options.signal });
    const trimmed = text.trim();
    const truncated = trimmed.length > maxChars;
    return {
      engine: 'tesseract',
      pageCount: null,
      sections: [{ page: null, text: truncated ? trimmed.slice(0, maxChars) : trimmed, engine: 'ocr' }],
      tools: used,
      notes: trimmed ? notes : ['the page produced no text'],
      truncated,
    };
  }

  if (!tools.tesseract) throw new OcrError('Tesseract OCR is not installed on this PC', 'not_installed');
  if (!tools.pdftoppm) throw new OcrError('Poppler (pdftoppm) is not installed on this PC, so PDF pages cannot be rendered for OCR', 'not_installed');

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pandesh-ocr-'));
  try {
    const totalPages = (await pdfPageCount(filePath, tools, { signal: options.signal })) ?? null;
    const first = Math.max(1, options.firstPage ?? 1);
    const last = Math.min(totalPages ?? Number.MAX_SAFE_INTEGER, options.lastPage ?? Number.MAX_SAFE_INTEGER);
    if (last < first) {
      return { engine: 'tesseract+pdftoppm', pageCount: totalPages, sections: [], tools: [], notes: ['the requested page range is outside the document'], truncated: false };
    }
    const boundedLast = Math.min(last, first + maxPages - 1);
    if (boundedLast < last) notes.push(`only pages ${first}-${boundedLast} were read (${maxPages}-page cap)`);

    const prefix = path.join(work, 'page');
    used.push('pdftoppm', 'tesseract');
    const render = await runLocalTool(tools.pdftoppm, ['-r', String(dpi), '-png', '-f', String(first), '-l', String(boundedLast), filePath, prefix], {
      timeoutMs,
      signal: options.signal,
    });
    if (render.code !== 0) {
      throw new OcrError(`the PDF pages could not be rendered (exit ${render.code ?? 'none'}): ${render.stderr.trim().split(/\r?\n/).slice(-2).join(' ')}`.slice(0, 300), 'failed');
    }
    const rendered = fs.readdirSync(work)
      .filter((name) => name.startsWith('page-') && name.endsWith('.png'))
      .sort((a, b) => Number(a.replace(/\D+/g, '')) - Number(b.replace(/\D+/g, '')));
    if (rendered.length === 0) {
      throw new OcrError('the PDF pages could not be rendered to images', 'failed');
    }

    const sections: OcrSection[] = [];
    let chars = 0;
    let truncated = false;
    for (const name of rendered) {
      const pageNumber = first + Number(name.replace(/\D+/g, '')) - 1;
      try {
        const text = (await ocrImageFile(path.join(work, name), tools, { language: options.language, timeoutMs, signal: options.signal })).trim();
        if (!text) {
          notes.push(`page ${pageNumber} produced no text`);
          sections.push({ page: pageNumber, text: '', engine: 'ocr' });
          continue;
        }
        if (chars + text.length > maxChars) {
          truncated = true;
          sections.push({ page: pageNumber, text: text.slice(0, Math.max(0, maxChars - chars)), engine: 'ocr' });
          chars = maxChars;
          break;
        }
        chars += text.length;
        sections.push({ page: pageNumber, text, engine: 'ocr' });
      } catch (error) {
        if (error instanceof OcrError && error.reason === 'cancelled') throw error;
        notes.push(`page ${pageNumber} failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 200));
      }
    }
    return { engine: 'tesseract+pdftoppm', pageCount: totalPages, sections, tools: used, notes, truncated };
  } finally {
    try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* temp */ }
  }
}
