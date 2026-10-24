/**
 * M36 pass 2 — local document text extraction with page/section provenance.
 * Runs entirely locally (no network, no cloud call): PDF via `pdfjs-dist`'s
 * legacy Node build (text layer only, no rendering/canvas dependency), DOCX
 * via `mammoth` (pure JS, no native dependency). Bounded by the same
 * `MAX_ATTACHMENT_BYTES` cap already enforced at upload time — extraction
 * reads the already-stored, already-size-checked file.
 */
import * as fs from 'node:fs/promises';
import type { DocumentExtractionResult, DocumentExtractionSection } from '../shared/wireTypes';

/**
 * pdfjs-dist's Node ("legacy") build creates a module-level
 * `new DOMMatrix()` (a `SCALE_MATRIX` constant) as an unconditional
 * top-level side effect of importing the module — this happens even for
 * pure text extraction that never touches the canvas-rendering code paths
 * that class is really for. Bare Node has no `DOMMatrix` global; pdfjs's own
 * fallback tries to source one from the optional `canvas` npm package
 * (which we deliberately do not depend on, to avoid a native binary), so
 * without this stub the plain `import()` below throws
 * `ReferenceError: DOMMatrix is not defined` before any of our code runs —
 * text-only extraction never actually exercises real matrix math through
 * this stub, so a bare-minimum, always-identity-behaving shape is
 * sufficient (never used for rendering, only to satisfy the load-time
 * side effect and any incidental construction along the text-content path).
 */
/** A real (not no-op) minimal 2D affine-matrix implementation of the subset
 * of the DOMMatrix interface pdfjs-dist actually calls. This matters even
 * for pure text-content extraction (no rendering): pdfjs tracks each
 * glyph run's cumulative transform via exactly these operations to compute
 * text-item positions/widths, so a no-op stub silently corrupts that
 * tracking — observed directly: a no-op version truncated extracted text
 * partway through the first line for any string long enough to need more
 * than one internal transform update, with no error or warning at all. */
class DOMMatrixStub {
  a = 1; b = 0; c = 0; d = 1; e = 0; f = 0;
  constructor(init?: number[]) {
    if (Array.isArray(init) && init.length === 6) {
      [this.a, this.b, this.c, this.d, this.e, this.f] = init;
    }
  }
  multiplySelf(other: DOMMatrixStub): this {
    const { a: a1, b: b1, c: c1, d: d1, e: e1, f: f1 } = this;
    const { a: a2, b: b2, c: c2, d: d2, e: e2, f: f2 } = other;
    this.a = a1 * a2 + c1 * b2;
    this.b = b1 * a2 + d1 * b2;
    this.c = a1 * c2 + c1 * d2;
    this.d = b1 * c2 + d1 * d2;
    this.e = a1 * e2 + c1 * f2 + e1;
    this.f = b1 * e2 + d1 * f2 + f1;
    return this;
  }
  preMultiplySelf(other: DOMMatrixStub): this {
    const combined = new DOMMatrixStub([other.a, other.b, other.c, other.d, other.e, other.f]).multiplySelf(this);
    ({ a: this.a, b: this.b, c: this.c, d: this.d, e: this.e, f: this.f } = combined);
    return this;
  }
  multiply(other: DOMMatrixStub): DOMMatrixStub {
    return new DOMMatrixStub([this.a, this.b, this.c, this.d, this.e, this.f]).multiplySelf(other);
  }
  translate(tx: number, ty = 0): DOMMatrixStub {
    return this.multiply(new DOMMatrixStub([1, 0, 0, 1, tx, ty]));
  }
  scale(sx: number, sy = sx): DOMMatrixStub {
    return this.multiply(new DOMMatrixStub([sx, 0, 0, sy, 0, 0]));
  }
  invertSelf(): this {
    const det = this.a * this.d - this.b * this.c;
    if (!det) {
      this.a = this.b = this.c = this.d = this.e = this.f = NaN;
      return this;
    }
    const { a, b, c, d, e, f } = this;
    this.a = d / det;
    this.b = -b / det;
    this.c = -c / det;
    this.d = a / det;
    this.e = (c * f - d * e) / det;
    this.f = (b * e - a * f) / det;
    return this;
  }
}

function ensureNodeDomMatrixStub(): void {
  const g = globalThis as { DOMMatrix?: unknown; Path2D?: unknown };
  if (typeof g.DOMMatrix === 'undefined') {
    g.DOMMatrix = DOMMatrixStub;
  }
  if (typeof g.Path2D === 'undefined') {
    class Path2DStub {
      addPath() { /* no-op: never rendered — only exists so the module-level side effect doesn't throw. */ }
    }
    g.Path2D = Path2DStub;
  }
}

/** Bounded total extracted-text size, independent of the source file's byte
 * size (a pathological PDF could have far more text than its compressed
 * byte size suggests) — protects downstream storage/JSON serialization. */
const MAX_EXTRACTED_TEXT_CHARS = 2_000_000;

function buildSections(pieces: Array<{ page: number | null; text: string }>): { sections: DocumentExtractionSection[]; truncated: boolean } {
  const sections: DocumentExtractionSection[] = [];
  let cursor = 0;
  let truncated = false;
  pieces.forEach((piece, index) => {
    if (cursor >= MAX_EXTRACTED_TEXT_CHARS) {
      truncated = true;
      return;
    }
    const remaining = MAX_EXTRACTED_TEXT_CHARS - cursor;
    const text = piece.text.length > remaining ? piece.text.slice(0, remaining) : piece.text;
    if (text.length < piece.text.length) truncated = true;
    sections.push({
      sectionOrdinal: index,
      page: piece.page,
      text,
      charStart: cursor,
      charEnd: cursor + text.length,
    });
    cursor += text.length;
  });
  return { sections, truncated };
}

async function extractPdf(filePath: string): Promise<DocumentExtractionResult> {
  // Legacy build: works under plain Node without DOM/Worker globals, and has
  // no canvas/native dependency for text-only extraction.
  ensureNodeDomMatrixStub();
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  // pdfjs normally runs parsing on a real Worker thread, loaded from a
  // separate `pdf.worker.mjs` file on disk next to its main module — a path
  // that does not exist once everything is esbuild-bundled into a single
  // out-core/core.js. Importing the worker module directly makes it
  // self-register on `globalThis.pdfjsWorker`, which pdfjs's own "fake
  // worker" fallback (same-thread, no separate file needed) detects and uses
  // instead of trying to load a worker script from disk.
  if (!(globalThis as { pdfjsWorker?: unknown }).pdfjsWorker) {
    await import('pdfjs-dist/legacy/build/pdf.worker.mjs');
  }
  const data = new Uint8Array(await fs.readFile(filePath));
  // pdfjs-dist 6 removed `isEvalSupported`; font parsing no longer uses eval,
  // so the old disable flag has no corresponding option. `useSystemFonts`
  // remains false so extraction cannot pull host fonts.
  // `destroy()` lives on the loading task, not on the resolved document proxy
  // — the proxy only exposes per-page `cleanup()`.
  const loadingTask = pdfjs.getDocument({ data, useSystemFonts: false });
  try {
    const doc = await loadingTask.promise;
    const pieces: Array<{ page: number | null; text: string }> = [];
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
      const page = await doc.getPage(pageNumber);
      try {
        const content = await page.getTextContent();
        const text = content.items.map((item) => ('str' in item ? item.str : '')).join(' ').trim();
        pieces.push({ page: pageNumber, text });
      } finally {
        page.cleanup();
      }
    }
    const { sections } = buildSections(pieces);
    return { engine: 'pdfjs-dist', pageCount: doc.numPages, sections, extractedAt: new Date().toISOString() };
  } finally {
    await loadingTask.destroy();
  }
}

async function extractDocx(filePath: string): Promise<DocumentExtractionResult> {
  const mammoth = await import('mammoth');
  const buffer = await fs.readFile(filePath);
  const result = await mammoth.extractRawText({ buffer });
  // mammoth has no page concept (DOCX pagination is a rendering-time layout
  // fact, not stored in the document); paragraphs are the natural section
  // unit instead, so `page` stays null throughout and `sectionOrdinal` alone
  // gives stable, exact provenance.
  const paragraphs = result.value.split(/\r?\n+/).filter((p) => p.trim().length > 0);
  const pieces = paragraphs.map((text) => ({ page: null, text }));
  const { sections } = buildSections(pieces);
  return { engine: 'mammoth', pageCount: null, sections, extractedAt: new Date().toISOString() };
}

/** `mimeType` must already be the Core-detected (never client-declared) MIME
 * type from `detectContent`, so this only ever dispatches on bytes it has
 * itself verified. Returns `null` (never throws to the caller) for a
 * document MIME type this slice does not yet extract — callers must treat a
 * null result as `unavailable_unsupported_format`, never as empty content. */
export async function extractDocument(filePath: string, mimeType: string): Promise<DocumentExtractionResult | null> {
  if (mimeType === 'application/pdf') return extractPdf(filePath);
  if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return extractDocx(filePath);
  return null;
}
