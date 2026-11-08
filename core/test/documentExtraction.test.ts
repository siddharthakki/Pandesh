import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { extractDocument } from '../attachments/documentExtraction';
import { buildMinimalPdf, buildMinimalDocx } from './fixtures/documentFixtures';

const tempFiles: string[] = [];
function writeTempFile(name: string, bytes: Buffer): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karkedikha-doc-extract-test-'));
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, bytes);
  tempFiles.push(dir);
  return filePath;
}

afterEach(() => {
  while (tempFiles.length > 0) {
    const dir = tempFiles.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('local document extraction (pdfjs-dist / mammoth)', () => {
  it('extracts page-provenanced text from a real single-page PDF', async () => {
    const pdfPath = writeTempFile('fixture.pdf', buildMinimalPdf('Hello World'));
    const result = await extractDocument(pdfPath, 'application/pdf');
    expect(result).not.toBeNull();
    expect(result?.engine).toBe('pdfjs-dist');
    expect(result?.pageCount).toBe(1);
    expect(result?.sections).toHaveLength(1);
    expect(result?.sections[0].page).toBe(1);
    expect(result?.sections[0].sectionOrdinal).toBe(0);
    expect(result?.sections[0].text).toContain('Hello World');
    expect(result?.sections[0].charStart).toBe(0);
    expect(result?.sections[0].charEnd).toBe(result?.sections[0].text.length);
  });

  it('extracts paragraph-provenanced text from a real DOCX', async () => {
    const docxBytes = await buildMinimalDocx(['First paragraph.', 'Second paragraph with more content.']);
    const docxPath = writeTempFile('fixture.docx', docxBytes);
    const result = await extractDocument(
      docxPath,
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    expect(result).not.toBeNull();
    expect(result?.engine).toBe('mammoth');
    expect(result?.pageCount).toBeNull();
    expect(result?.sections).toHaveLength(2);
    expect(result?.sections[0].page).toBeNull();
    expect(result?.sections[0].sectionOrdinal).toBe(0);
    expect(result?.sections[0].text).toBe('First paragraph.');
    expect(result?.sections[1].sectionOrdinal).toBe(1);
    expect(result?.sections[1].text).toBe('Second paragraph with more content.');
    // Provenance offsets are exact and non-overlapping, in source order.
    expect(result?.sections[0].charEnd).toBe(result?.sections[1].charStart);
  });

  it('returns null (never throws, never fabricates content) for an unrecognized document MIME type', async () => {
    const pdfPath = writeTempFile('fixture.bin', Buffer.from('not a real document'));
    const result = await extractDocument(pdfPath, 'application/octet-stream');
    expect(result).toBeNull();
  });
});

// Security floor for the document parsers bundled into Core (core.js runs as
// Electron-as-Node, outside the renderer sandbox). A lockfile change must
// never quietly resolve below a patched release.
describe('bundled document-parser security floor', () => {
  function installedVersion(pkg: string): number[] {
    const manifest = path.join(__dirname, '..', '..', 'node_modules', ...pkg.split('/'), 'package.json');
    const version = JSON.parse(fs.readFileSync(manifest, 'utf8')).version as string;
    return version.split('-')[0].split('.').map(Number);
  }
  function atLeast(actual: number[], floor: number[]): boolean {
    for (let i = 0; i < floor.length; i++) {
      if ((actual[i] ?? 0) !== floor[i]) return (actual[i] ?? 0) > floor[i];
    }
    return true;
  }

  it('pdfjs-dist is at or above 6.2.108 (GHSA-hq66-cqwq-w95j: JS execution from a malicious PDF)', () => {
    expect(atLeast(installedVersion('pdfjs-dist'), [6, 2, 108])).toBe(true);
  });
});
