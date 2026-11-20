import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DEFAULT_MAGIKA_EXE, parseMagikaJson, resolveMagikaExe, runMagika } from '../runtime/kandev/magikaEngine';
import { detectFileType, detectTypeService, mergeDetections } from '../runtime/kandev/bridgeCoreServices';

const ok = (o: Record<string, unknown>, score = 0.99) => JSON.stringify([{ path: 'x', result: { status: 'ok', value: { output: o, score } } }]);
const PNG = { label: 'png', description: 'PNG image', mime_type: 'image/png', group: 'image', is_text: false };
const DOCX = { label: 'docx', description: 'Microsoft Word 2007+ document', mime_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', group: 'document', is_text: false };
const TS = { label: 'typescript', description: 'TypeScript source', mime_type: 'application/typescript', group: 'code', is_text: true };
const mg = (o: Record<string, unknown>, score = 0.99) => parseMagikaJson(ok(o, score))!;

describe('magika output parsing', () => {
  it('parses a good result and rejects malformed, errored or empty output', () => {
    expect(mg(PNG)).toMatchObject({ label: 'png', mime: 'image/png', group: 'image', isText: false, score: 0.99 });
    expect(parseMagikaJson('not json')).toBeNull();
    expect(parseMagikaJson('[]')).toBeNull();
    expect(parseMagikaJson(JSON.stringify([{ result: { status: 'error' } }]))).toBeNull();
    expect(parseMagikaJson(JSON.stringify([{ result: { status: 'ok', value: { output: { label: 5 } } } }]))).toBeNull();
  });
});

describe('hybrid policy', () => {
  const sigOf = (bytes: Buffer, name: string) => detectFileType(bytes, name);
  const zip = Buffer.from([0x50, 0x4b, 3, 4, 0, 0, 0, 0]);
  it('without Magika the signature verdict stands and is labelled as such', () => {
    const t = mergeDetections(sigOf(zip, 'a.zip'), null, 5000, 'a.zip');
    expect(t).toMatchObject({ engine: 'signature-table', basis: 'signature', engines: { magika: null, agree: null } });
  });
  it('a hard signature wins over a disagreeing Magika, and the disagreement is reported', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const t = mergeDetections(sigOf(png, 'a.png'), mg(TS), 5000, 'a.png');
    expect(t.engine).toBe('signature-table');
    expect(t.label).toBe('PNG image');
    expect(t.engines.agree).toBe(false);
  });
  it('Magika refines a ZIP container into DOCX when confident', () => {
    const t = mergeDetections(sigOf(zip, 'x.zip'), mg(DOCX), 5000, 'x.zip');
    expect(t).toMatchObject({ engine: 'magika', basis: 'magika', nameMatches: false });
    expect(t.label).toMatch(/Word/);
    expect(mergeDetections(sigOf(zip, 'x.docx'), mg(DOCX), 5000, 'x.docx').nameMatches).toBe(true);
  });
  it('Magika classifies unsigned text when confident and long enough; short files keep the heuristic', () => {
    const text = Buffer.from('export const a = 1;\n'.repeat(50));
    const t = mergeDetections(sigOf(text, 'a.txt'), mg(TS), text.length, 'a.txt');
    expect(t).toMatchObject({ engine: 'magika', mime: 'application/typescript' });
    expect(mergeDetections(sigOf(Buffer.from('hello'), 'a.txt'), mg(TS), 5, 'a.txt').engine).toBe('signature-table');
    expect(mergeDetections(sigOf(text, 'a.txt'), mg(TS, 0.5), text.length, 'a.txt').engine).toBe('signature-table');
  });
});

describe('degenerate content', () => {
  it('an all-zero file is never relabelled by Magika (it answered "iso" at 1.00 in measurement)', () => {
    const zeros = Buffer.alloc(2048);
    const t = mergeDetections(detectFileType(zeros, 'z.bin'), mg({ label: 'iso', description: 'ISO 9660 CD-ROM filesystem data', mime_type: 'application/x-iso9660-image', group: 'archive', is_text: false }, 1), 2048, 'z.bin', zeros);
    expect(t).toMatchObject({ engine: 'signature-table', label: 'Unknown binary', engines: { magika: null } });
  });
});

describe('failure fallback', () => {
  it('runMagika returns null (never throws) when the executable is missing, off, or not runnable', async () => {
    expect(await runMagika('x', { exe: null })).toBeNull();
    expect(await runMagika('x', { exe: path.join(os.tmpdir(), 'no-such-magika.exe') })).toBeNull();
    expect(resolveMagikaExe({ KARKEDIKHA_MAGIKA_EXE: 'off' } as NodeJS.ProcessEnv)).toBeNull();
    expect(resolveMagikaExe({ KARKEDIKHA_MAGIKA_EXE: path.join(os.tmpdir(), 'nope.exe') } as NodeJS.ProcessEnv)).toBeNull();
  });
});

describe('doc.detect-type service', () => {
  let dir: string;
  beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'magika-svc-')); });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
  const run = (file: string, magikaExe: string | null) => {
    const svc = detectTypeService([dir], { magikaExe });
    return svc.run({ args: { path: file }, signal: new AbortController().signal } as never);
  };

  it('works with the signature table alone and reports the engine', async () => {
    const f = path.join(dir, 'pic.jpg'); fs.writeFileSync(f, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]));
    const out = await run(f, null);
    expect(out.evidence).toMatchObject({ kind: 'file-type', label: 'PNG image', nameMatches: false, engine: 'signature-table' });
  });
  it('an empty file is handled without invoking Magika', async () => {
    const f = path.join(dir, 'empty.bin'); fs.writeFileSync(f, '');
    expect((await run(f, 'C:\\does\\not\\matter.exe')).evidence).toMatchObject({ bytes: 0, engine: 'signature-table' });
  });
  it('a broken Magika executable falls back to the signature verdict', async () => {
    const f = path.join(dir, 'a.txt'); fs.writeFileSync(f, 'plain words '.repeat(40));
    const out = await run(f, path.join(dir, 'missing-magika.exe'));
    expect(out.evidence).toMatchObject({ label: 'Plain text', engine: 'signature-table' });
  });

  const live = fs.existsSync(DEFAULT_MAGIKA_EXE);
  it.skipIf(!live)('with the real Magika installed, refines a source file and still identifies a PDF by signature', async () => {
    const ts = path.join(dir, 'note.txt'); fs.writeFileSync(ts, fs.readFileSync(path.join(__dirname, '..', 'domain', 'pandaBridge.ts')).subarray(0, 6000));
    const out = await run(ts, DEFAULT_MAGIKA_EXE);
    expect(out.evidence).toMatchObject({ engine: 'magika' });
    const pdf = path.join(dir, 'scan.jpg'); fs.writeFileSync(pdf, Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from('1 0 obj\n<<>>\nendobj\n'.repeat(30))]));
    expect((await run(pdf, DEFAULT_MAGIKA_EXE)).evidence).toMatchObject({ label: 'PDF document', nameMatches: false });
  }, 60_000);
});
