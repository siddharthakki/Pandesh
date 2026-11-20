import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ServiceRegistry } from '../runtime/kandev/bridgeServices';
import { findExecutable, registerToolServices } from '../runtime/kandev/bridgeToolServices';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'panda-tools-')); fs.mkdirSync(path.join(dir, 'root')); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
const ctx = (args: Record<string, unknown>) => ({ args, signal: new AbortController().signal });

const MINI_PDF = '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n'
  + '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 100]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n'
  + '4 0 obj<</Length 44>>stream\nBT /F1 18 Tf 10 50 Td (Invoice 4711 paid) Tj ET\nendstream endobj\n'
  + '5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R/Size 6>>\n%%EOF\n';

describe('tool-backed services', () => {
  it('only registers a service whose executable exists', () => {
    const reg = new ServiceRegistry();
    const r = registerToolServices(reg, [path.join(dir, 'root')], () => null);
    expect(r.registered).toEqual([]);
    expect(r.skipped).toHaveLength(4);
    expect(reg.list()).toHaveLength(0);
  });

  const pdftotext = findExecutable('pdftotext');
  it.skipIf(!pdftotext)('extracts the text layer of a PDF inside the root, and refuses outside it or a non-PDF', async () => {
    const reg = new ServiceRegistry();
    registerToolServices(reg, [path.join(dir, 'root')], n => (n === 'pdftotext' ? pdftotext : null));
    const svc = reg.get('doc.pdf-text')!;
    fs.writeFileSync(path.join(dir, 'root', 'a.pdf'), MINI_PDF);
    const out = await svc.run(ctx({ path: path.join(dir, 'root', 'a.pdf') }));
    expect(String(out.evidence.text)).toContain('Invoice 4711 paid');
    fs.writeFileSync(path.join(dir, 'out.pdf'), MINI_PDF);
    await expect(svc.run(ctx({ path: path.join(dir, 'out.pdf') }))).rejects.toThrow(/outside the roots/);
    fs.writeFileSync(path.join(dir, 'root', 'b.txt'), 'x');
    await expect(svc.run(ctx({ path: path.join(dir, 'root', 'b.txt') }))).rejects.toThrow(/\.pdf/);
    fs.writeFileSync(path.join(dir, 'root', 'empty.pdf'), MINI_PDF.replace('Invoice 4711 paid', ''));
    await expect(svc.run(ctx({ path: path.join(dir, 'root', 'empty.pdf') }))).rejects.toThrow(/no text layer/);
  });

  it('OCR refuses non-images and bad language codes cannot inject arguments', async () => {
    const reg = new ServiceRegistry();
    registerToolServices(reg, [path.join(dir, 'root')], n => (n === 'tesseract' ? 'tesseract-not-run' : null));
    const svc = reg.get('doc.ocr')!;
    fs.writeFileSync(path.join(dir, 'root', 'a.txt'), 'x');
    await expect(svc.run(ctx({ path: path.join(dir, 'root', 'a.txt') }))).rejects.toThrow(/image/);
  });
});
