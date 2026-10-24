import { describe, it, expect } from 'vitest';
import { detectContent, contentMatchesDeclaredKind } from '../attachments/mime';

describe('attachment content sniffing (M36)', () => {
  it('detects PNG from magic bytes regardless of declared type', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    const detected = detectContent(png);
    expect(detected).toEqual({ kind: 'image', mimeType: 'image/png' });
  });

  it('detects JPEG from magic bytes', () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
    expect(detectContent(jpeg)).toEqual({ kind: 'image', mimeType: 'image/jpeg' });
  });

  it('detects GIF87a and GIF89a', () => {
    expect(detectContent(Buffer.from('GIF87a...', 'ascii'))).toEqual({ kind: 'image', mimeType: 'image/gif' });
    expect(detectContent(Buffer.from('GIF89a...', 'ascii'))).toEqual({ kind: 'image', mimeType: 'image/gif' });
  });

  it('detects WebP from the RIFF/WEBP container markers', () => {
    const webp = Buffer.concat([Buffer.from('RIFF', 'ascii'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBP', 'ascii')]);
    expect(detectContent(webp)).toEqual({ kind: 'image', mimeType: 'image/webp' });
  });

  it('detects plain UTF-8 text', () => {
    const text = Buffer.from('Hello, world!\nThis is a plain text attachment.\n', 'utf8');
    expect(detectContent(text)).toEqual({ kind: 'text', mimeType: 'text/plain' });
  });

  it('rejects binary content that is neither a known image nor text-like', () => {
    const garbage = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x00, 0x10, 0x20, 0x00, 0x00]);
    expect(detectContent(garbage)).toBeNull();
  });

  it('rejects a NUL-containing buffer as text even if otherwise printable', () => {
    const withNul = Buffer.from('hello\x00world');
    expect(detectContent(withNul)).toBeNull();
  });

  it('flags a declared/detected kind mismatch (e.g. a PNG declared as text)', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const detected = detectContent(png)!;
    expect(contentMatchesDeclaredKind(detected, 'text')).toBe(false);
    expect(contentMatchesDeclaredKind(detected, 'image')).toBe(true);
  });

  it('detects PDF from the %PDF- magic', () => {
    const pdf = Buffer.from('%PDF-1.4\n%rest of file', 'ascii');
    expect(detectContent(pdf)).toEqual({ kind: 'document', mimeType: 'application/pdf' });
  });

  it('detects DOCX from the ZIP magic only when hinted by a .docx extension', () => {
    const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
    expect(detectContent(zip, '.docx')).toEqual({
      kind: 'document',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
    expect(detectContent(zip, 'docx')).toEqual({
      kind: 'document',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
  });

  it('never classifies a bare ZIP magic as a document without a .docx hint (avoids masquerading as an unsupported OOXML kind)', () => {
    const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
    expect(detectContent(zip)).toBeNull();
    expect(detectContent(zip, '.xlsx')).toBeNull();
  });

  it('detects WAV from the RIFF/WAVE container markers', () => {
    const wav = Buffer.concat([Buffer.from('RIFF', 'ascii'), Buffer.from([0, 0, 0, 0]), Buffer.from('WAVE', 'ascii')]);
    expect(detectContent(wav)).toEqual({ kind: 'audio', mimeType: 'audio/wav' });
  });

  it('detects MP3 from an ID3 tag or a bare frame sync', () => {
    const withId3 = Buffer.from([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 0]);
    expect(detectContent(withId3)).toEqual({ kind: 'audio', mimeType: 'audio/mpeg' });
    const bareFrame = Buffer.from([0xff, 0xfb, 0x90, 0x00]);
    expect(detectContent(bareFrame)).toEqual({ kind: 'audio', mimeType: 'audio/mpeg' });
  });

  it('detects OGG and FLAC container magics', () => {
    expect(detectContent(Buffer.from('OggS....', 'ascii'))).toEqual({ kind: 'audio', mimeType: 'audio/ogg' });
    expect(detectContent(Buffer.from('fLaC....', 'ascii'))).toEqual({ kind: 'audio', mimeType: 'audio/flac' });
  });

  it('flags a document/audio kind mismatch against the declared kind', () => {
    const pdf = detectContent(Buffer.from('%PDF-1.4', 'ascii'))!;
    expect(contentMatchesDeclaredKind(pdf, 'document')).toBe(true);
    expect(contentMatchesDeclaredKind(pdf, 'audio')).toBe(false);
    const wav = detectContent(Buffer.concat([Buffer.from('RIFF', 'ascii'), Buffer.from([0, 0, 0, 0]), Buffer.from('WAVE', 'ascii')]))!;
    expect(contentMatchesDeclaredKind(wav, 'audio')).toBe(true);
    expect(contentMatchesDeclaredKind(wav, 'document')).toBe(false);
  });
});
