import { describe, expect, it } from 'vitest';
import { INPUT_LIMITS, INPUT_SUPPORT, buildInput, checkInput, classifyInput, extensionOf, inputRequirements, pickerFilters } from '../platform/artifacts/artifactInput';

describe('ArtifactInput', () => {
  it('classifies code, text, structured data, images, documents and audio from one table', () => {
    expect(classifyInput('foo.py')).toMatchObject({ type: 'code', language: 'python', kind: 'text' });
    expect(classifyInput('App.TSX')).toMatchObject({ type: 'code', language: 'typescript' });
    expect(classifyInput('notes.md')).toMatchObject({ type: 'markdown', mimeType: 'text/markdown' });
    expect(classifyInput('data.csv')).toMatchObject({ type: 'csv' });
    expect(classifyInput('app.log')).toMatchObject({ type: 'log' });
    expect(classifyInput('shot.PNG')).toMatchObject({ type: 'image', mimeType: 'image/png', kind: 'image' });
    expect(classifyInput('shot.webp')!.mimeType).toBe('image/webp');
    expect(classifyInput('spec.pdf')).toMatchObject({ type: 'pdf', kind: 'document' });
    expect(classifyInput('memo.docx')).toMatchObject({ type: 'document' });
    expect(classifyInput('clip.flac')).toMatchObject({ kind: 'audio' });
    expect(classifyInput('movie.mp4')).toBeUndefined();
    expect(classifyInput('Makefile')).toBeUndefined();
    expect(extensionOf('a.b.C')).toBe('.c');
    // Every listed format maps to a Core kind that actually exists.
    for (const entry of Object.values(INPUT_SUPPORT)) expect(['text', 'image', 'document', 'audio']).toContain(entry.kind);
  });

  it('admission checks give messages a person can act on', () => {
    expect(checkInput('movie.mp4', 100)).toMatchObject({ ok: false, message: expect.stringMatching(/"\.mp4" files are not supported yet\. Supported:/) });
    expect(checkInput('Makefile', 100)).toMatchObject({ ok: false, message: expect.stringMatching(/without an extension/) });
    expect(checkInput('a.py', 0)).toMatchObject({ ok: false, message: 'a.py is empty.' });
    expect(checkInput('big.txt', INPUT_LIMITS.maxBytes + 1)).toMatchObject({ ok: false, message: expect.stringMatching(/limit is 10 MB/) });
    expect(checkInput('drop.png', INPUT_LIMITS.maxDroppedBytes + 1, { dropped: true })).toMatchObject({ ok: false, message: expect.stringMatching(/limit is 5 MB for dropped files \(use the attach button/) });
    expect(checkInput('a.py', 10, { countInMessage: INPUT_LIMITS.maxFilesPerMessage })).toMatchObject({ ok: false, message: expect.stringMatching(/At most 8 files/) });
    expect(checkInput('a.py', 10)).toMatchObject({ ok: true });
  });

  it('builds inputs without overclaiming: extracted text only when supplied; vision follows the content type', () => {
    const now = () => new Date('2026-10-06T00:00:00Z');
    const py = buildInput({ id: '1', name: 'foo.py', size: 20, support: classifyInput('foo.py')!, origin: { kind: 'file', ref: 'C:/x/foo.py' }, reference: 'C:/x/foo.py', writable: true, now });
    expect(py).toMatchObject({ type: 'code', language: 'python', requiresVision: false, permissions: { read: true, write: true }, provenance: { source: 'file', capturedAt: '2026-10-06T00:00:00.000Z' } });
    expect(py.extractedText).toBeUndefined();
    expect(py.binary).toBeUndefined();
    const shot = buildInput({ id: '2', name: 'err.png', size: 5, support: classifyInput('err.png')!, origin: { kind: 'screenshot' }, base64: 'AAAA', hash: 'h', now });
    expect(shot).toMatchObject({ requiresVision: true, binary: { encoding: 'base64', data: 'AAAA' }, hash: 'h', permissions: { write: false } });
  });

  it('a single image makes the whole turn require vision; documents and audio need extraction', () => {
    expect(inputRequirements([])).toEqual({ requiresVision: false, needsExtraction: false, count: 0 });
    expect(inputRequirements([{ type: 'code', requiresVision: false }, { type: 'image', requiresVision: true }])).toMatchObject({ requiresVision: true, needsExtraction: false });
    expect(inputRequirements([{ type: 'pdf', requiresVision: false }])).toMatchObject({ requiresVision: false, needsExtraction: true });
  });

  it('builds picker filters from the same table', () => {
    const filters = pickerFilters();
    expect(filters.Images).toEqual(expect.arrayContaining(['png', 'jpg', 'webp']));
    expect(filters['Text & Code']).toEqual(expect.arrayContaining(['py', 'ts', 'md', 'csv', 'log']));
    expect(filters.Documents).toEqual(['pdf', 'docx']);
    expect(filters['All Files']).toEqual(['*']);
  });
});
