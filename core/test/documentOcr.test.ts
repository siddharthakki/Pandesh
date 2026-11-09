/**
 * Local OCR and the governed document tools.
 *
 * The unit part needs no external tool: it proves the refusals, the argument
 * handling and the honest error paths. The live part runs only when Tesseract
 * and Poppler are actually installed, and then it proves the thing that
 * matters: a SCANNED invoice — a PDF with no text layer at all — yields its
 * invoice number and total through OCR, locally.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildScannedInvoice } from '../../scripts/lib/scannedInvoiceFixture.mjs';
import { OcrError, ocrFile, resolveOcrTools } from '../runtime/documentOcr';
import { createDocumentToolsAdapter, readDocument, resolveDownloadBinary } from '../runtime/documentToolsCapability';

const tools = resolveOcrTools();
const liveOcr = Boolean(tools.tesseract && tools.pdftoppm);

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe('document tools — refusals and argument handling', () => {
  it('refuses a missing path and a directory instead of guessing', async () => {
    const adapter = createDocumentToolsAdapter({ tools });
    const missing = await adapter.run({ name: 'document_read', arguments: { path: path.join(os.tmpdir(), 'pandesh-does-not-exist-xyz.pdf') } }, {});
    expect(missing.status).toBe('failed');
    expect(missing.resultCategory).toBe('document_not_found');

    const directory = tempDir('pandesh-doc-dir-');
    const notAFile = await adapter.run({ name: 'document_ocr', arguments: { path: directory } }, {});
    expect(notAFile.status).toBe('failed');
    expect(notAFile.resultCategory).toBe('document_not_a_file');
  });

  it('refuses a media URL that is not http(s)', async () => {
    const adapter = createDocumentToolsAdapter({ tools });
    const result = await adapter.run({ name: 'media_download', arguments: { url: 'file:///C:/Windows/System32/calc.exe' } }, {});
    expect(result.status).toBe('failed');
    expect(result.resultCategory).toBe('media_url_refused');
  });

  it('never reads a credential file or symlink into a protected file into the conversation', async () => {
    const dir = tempDir('pandesh-credential-doc-');
    const file = path.join(dir, 'credentials.pdf');
    fs.writeFileSync(file, Buffer.from('%PDF-1.4 not really a pdf'));
    const secretFile = path.join(dir, 'secret.env');
    fs.writeFileSync(secretFile, 'KEY=supersecret');
    const link = path.join(dir, 'innocent-looking.pdf');
    try {
      fs.symlinkSync(secretFile, link);
    } catch {
      // In case symlink creation requires admin privilege on Windows, test with file directly
    }

    const adapter = createDocumentToolsAdapter({ tools });
    for (const targetPath of [file, fs.existsSync(link) ? link : null].filter(Boolean) as string[]) {
      for (const name of ['document_read', 'document_ocr']) {
        const result = await adapter.run({ name, arguments: { path: targetPath } }, {});
        expect(result.status).toBe('failed');
        expect(result.resultCategory).toBe('document_credential_file_refused');
        expect(result.output).not.toContain('%PDF');
        expect(result.output).not.toContain('supersecret');
      }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('refuses to read files from protected system or git folders', async () => {
    const dir = tempDir('pandesh-protected-doc-');
    const gitDir = path.join(dir, '.git');
    fs.mkdirSync(gitDir, { recursive: true });
    const gitConfig = path.join(gitDir, 'config');
    fs.writeFileSync(gitConfig, '[core]\nrepositoryformatversion = 0\n');

    const adapter = createDocumentToolsAdapter({ tools });
    for (const name of ['document_read', 'document_ocr']) {
      const result = await adapter.run({ name, arguments: { path: gitConfig } }, {});
      expect(result.status).toBe('failed');
      expect(result.resultCategory).toBe('document_credential_file_refused');
      expect(result.output).not.toContain('repositoryformatversion');
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('refuses to write a download outside Pandesh\'s downloads folder, including traversal and symlinks', async () => {
    const downloadsDir = tempDir('pandesh-downloads-');
    const outside = tempDir('pandesh-downloads-outside-');
    const adapter = createDocumentToolsAdapter({ tools, downloadsDir, ytdlp: 'C:/does-not-exist/yt-dlp.exe' });

    // Absolute path outside
    const result1 = await adapter.run({ name: 'media_download', arguments: { url: 'https://example.com/clip.mp4', directory: outside } }, {});
    expect(result1.status).toBe('failed');
    expect(result1.resultCategory).toBe('media_download_outside_downloads');

    // Traversal outside
    const result2 = await adapter.run({ name: 'media_download', arguments: { url: 'https://example.com/clip.mp4', directory: '../escaping' } }, {});
    expect(result2.status).toBe('failed');
    expect(result2.resultCategory).toBe('media_download_outside_downloads');

    fs.rmSync(downloadsDir, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('refuses private, loopback, link-local, credentials and non-public media URLs (SSRF protection)', async () => {
    const downloadsDir = tempDir('pandesh-ssrf-downloads-');
    const adapter = createDocumentToolsAdapter({ tools, downloadsDir, ytdlp: 'C:/does-not-exist/yt-dlp.exe' });

    const forbiddenUrls = [
      'http://127.0.0.1/video.mp4',
      'http://localhost/video.mp4',
      'http://169.254.169.254/latest/meta-data',
      'http://10.0.0.1/internal.mp4',
      'http://192.168.1.1/router.mp4',
      'http://172.16.0.1/intranet.mp4',
      'http://internal-host/video.mp4',
      'https://user:password@example.com/video.mp4',
    ];

    for (const url of forbiddenUrls) {
      const result = await adapter.run({ name: 'media_download', arguments: { url } }, {});
      expect(result.status).toBe('failed');
      expect(result.resultCategory).toBe('media_url_refused');
    }

    fs.rmSync(downloadsDir, { recursive: true, force: true });
  });

  it('reports an honest health state when no document tool is installed', () => {
    const none = { tesseract: null, pdftoppm: null, pdftotext: null, pdfinfo: null };
    expect(createDocumentToolsAdapter({ tools: none, browserBin: null }).health().state).toBe('unavailable');
    // PDF export (D5) only needs the browser, so without OCR tools the adapter is degraded, not unavailable.
    expect(createDocumentToolsAdapter({ tools: none, browserBin: 'C:/msedge.exe' }).health().state).toBe('degraded');
    const partial = createDocumentToolsAdapter({ tools: { tesseract: null, pdftoppm: null, pdftotext: 'C:/pdftotext.exe', pdfinfo: null } });
    expect(partial.health().state).toBe('degraded');
    const full = createDocumentToolsAdapter({ tools: { tesseract: 'C:/tesseract.exe', pdftoppm: 'C:/pdftoppm.exe', pdftotext: 'C:/pdftotext.exe', pdfinfo: 'C:/pdfinfo.exe' } });
    expect(full.health().state).toBe('available');
  });

  it('classifies every tool as consequential and names it honestly', () => {
    const adapter = createDocumentToolsAdapter({ tools });
    const names = adapter.definitions().map((definition) => definition.name);
    expect(names).toEqual(['document_read', 'document_ocr', 'media_download', 'export_document_pdf']);
    for (const name of names) expect(adapter.classify(name)).toBe('consequential');
  });

  it('says plainly when a file cannot be OCRd because Tesseract is missing', async () => {
    const file = path.join(tempDir('pandesh-ocr-none-'), 'page.png');
    fs.writeFileSync(file, Buffer.from('not really a png'));
    await expect(ocrFile(file, { tools: { tesseract: null, pdftoppm: null, pdftotext: null, pdfinfo: null } }))
      .rejects.toBeInstanceOf(OcrError);
  });

  it('does not need yt-dlp to be installed to describe the download tool honestly', () => {
    expect(typeof resolveDownloadBinary()).toBe('string');
  });
});

describe.skipIf(!liveOcr)('document tools — a real scan read locally', () => {
  it('reads the invoice number and the total out of a PDF with no text layer', async () => {
    const dir = tempDir('pandesh-scan-fixture-');
    const fixture = buildScannedInvoice({
      dir,
      invoiceNumber: 'INV-2026-00417',
      total: '1284.50',
      vendor: 'Garden Services GmbH',
      pdftoppm: tools.pdftoppm!,
    });

    // Ground truth: the scan has NO text layer, so the text layer alone can
    // never produce the answer.
    const textLayerOnly = await readDocument(fixture.pdfPath, { tools: { ...tools, tesseract: null } });
    expect(textLayerOnly.sections.every((section) => section.text.trim() === '')).toBe(true);

    const read = await readDocument(fixture.pdfPath, { tools });
    const all = read.sections.map((section) => section.text).join('\n');
    expect(read.engine).toContain('tesseract');
    expect(all).toMatch(/INV-2026-00417/i);
    expect(all).toMatch(/1284[.,]50/);
    expect(read.sections.some((section) => section.page === 1)).toBe(true);

    fs.rmSync(dir, { recursive: true, force: true });
  }, 120_000);
});
