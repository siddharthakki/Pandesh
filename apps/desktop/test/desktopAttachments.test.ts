import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AttachmentStaging, AttachmentStagingError, classifyAttachment, safeAttachmentName } from '../src/host/desktopAttachments';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
const PDF = Buffer.from('%PDF-1.7\n1 0 obj\n');
const TEXT = Buffer.from('hello world\nsecond line\n', 'utf8');

let dir: string;
let staging: AttachmentStaging;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'panda-staging-'));
  staging = new AttachmentStaging(path.join(dir, 'staging'));
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('attachment classification', () => {
  it('decides by bytes, so a renamed file is judged by what it really is', () => {
    expect(classifyAttachment('photo.png', PNG)).toEqual({ kind: 'image', mimeType: 'image/png' });
    expect(classifyAttachment('totally-a-doc.txt', PNG).kind).toBe('image');
    expect(classifyAttachment('report.pdf', PDF)).toEqual({ kind: 'document', mimeType: 'application/pdf' });
    expect(classifyAttachment('notes.md', TEXT)).toEqual({ kind: 'text', mimeType: 'text/plain' });
    expect(classifyAttachment('clip.wav', Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE')])).kind).toBe('audio');
  });

  it('refuses unsupported and mislabelled files in plain words, without trusting the extension', () => {
    expect(() => classifyAttachment('setup.exe', Buffer.from('MZ'))).toThrow(/can't read/);
    expect(() => classifyAttachment('sheet.xlsx', Buffer.from('PK\x03\x04'))).toThrow(AttachmentStagingError);
    expect(() => classifyAttachment('fake.pdf', TEXT)).toThrow(/doesn't look like a real PDF/);
    expect(() => classifyAttachment('mystery.dat', Buffer.from([0, 1, 2, 3, 0, 255]))).toThrow(/isn't a file type/);
  });

  it('sanitizes display names (no directories or control characters)', () => {
    expect(safeAttachmentName('C:\\Users\\me\\secret\\plan.txt')).toBe('plan.txt');
    expect(safeAttachmentName('../../etc/passwd')).toBe('passwd');
    expect(safeAttachmentName('a\u0000b<c>.txt')).toBe('a_b_c_.txt');
    expect(safeAttachmentName('')).toBe('attachment');
  });
});

describe('attachment staging', () => {
  it('stages bytes and files, exposing only name/size/kind (never a path)', () => {
    const view = staging.stageBytes('shot.png', PNG);
    expect(view).toMatchObject({ name: 'shot.png', kind: 'image', byteSize: PNG.length });
    expect(JSON.stringify(view)).not.toContain(dir);
    const src = path.join(dir, 'doc.txt');
    fs.writeFileSync(src, TEXT);
    expect(staging.stageFile(src)).toMatchObject({ name: 'doc.txt', kind: 'text' });
    expect(staging.list()).toHaveLength(2);
    expect(JSON.stringify(staging.list())).not.toContain('filePath');
  });

  it('enforces the per-message count and per-file size limits', () => {
    for (let i = 0; i < 5; i += 1) staging.stageBytes(`n${i}.txt`, TEXT);
    expect(() => staging.stageBytes('sixth.txt', TEXT)).toThrow(/up to 5 files/);
    const bigStaging = new AttachmentStaging(path.join(dir, 'big'));
    expect(() => bigStaging.stageBytes('huge.txt', Buffer.alloc(10 * 1024 * 1024 + 1, 97))).toThrow(/limit is 10 MB/);
    expect(() => bigStaging.stageBytes('empty.txt', Buffer.alloc(0))).toThrow(/is empty/);
  });

  it('remove deletes the staged bytes; take hands over everything; restore puts it back after a failed send; release deletes after success', () => {
    const a = staging.stageBytes('a.txt', TEXT);
    const b = staging.stageBytes('b.png', PNG);
    staging.remove(a.id);
    expect(staging.list().map((v) => v.name)).toEqual(['b.png']);
    const taken = staging.take();
    expect(taken).toHaveLength(1);
    expect(staging.list()).toEqual([]);
    expect(fs.existsSync(taken[0].filePath)).toBe(true);
    staging.restore(taken); // the upload failed: nothing lost
    expect(staging.list().map((v) => v.id)).toEqual([b.id]);
    const again = staging.take();
    staging.release(again); // the upload worked: bytes live in Core now
    expect(fs.existsSync(again[0].filePath)).toBe(false);
  });

  it('never reuses files left over from a previous crashed session', () => {
    staging.stageBytes('left.txt', TEXT);
    const fresh = new AttachmentStaging(path.join(dir, 'staging'));
    expect(fresh.list()).toEqual([]);
    expect(fs.readdirSync(path.join(dir, 'staging'))).toEqual([]);
  });
});
