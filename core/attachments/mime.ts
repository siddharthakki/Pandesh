/**
 * Bounded content sniffing for the M36 first attachment slice. Only the two
 * kinds accepted by this slice are detected: `text` (UTF-8/plain-text-like)
 * and `image` (PNG/JPEG/GIF/WebP). Detection is always from bytes, never from
 * filename/declared MIME alone — a caller-declared type is only ever compared
 * against this result, never trusted on its own (docs/m36-gap-map.md).
 */
import type { AttachmentKind } from '../shared/wireTypes';

export interface DetectedContent {
  kind: AttachmentKind;
  mimeType: string;
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);
const GIF87_MAGIC = Buffer.from('GIF87a', 'ascii');
const GIF89_MAGIC = Buffer.from('GIF89a', 'ascii');
const PDF_MAGIC = Buffer.from('%PDF-', 'ascii');
// DOCX (and every other OOXML format) is a ZIP archive; the local (non
// data-descriptor) file header signature is the only reliable byte-level
// signal available from a bounded prefix — telling DOCX apart from XLSX/PPTX
// by content requires reading the archive's central directory / [Content_Types].xml,
// which this bounded sniff intentionally does not attempt. The declared
// extension narrows kind selection (see detectContent's `hintExtension`);
// the ZIP magic here is only proof "this is plausibly an OOXML container".
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const ID3_MAGIC = Buffer.from('ID3', 'ascii');
const OGG_MAGIC = Buffer.from('OggS', 'ascii');
const FLAC_MAGIC = Buffer.from('fLaC', 'ascii');

function isWav(buffer: Buffer): boolean {
  return (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WAVE'
  );
}

/** MPEG audio frame sync (11 set bits at the start of a frame) — a bare MP3
 * with no ID3 tag starts directly with a frame, not a container magic. */
function isMp3FrameSync(buffer: Buffer): boolean {
  return buffer.length >= 2 && buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0;
}

/** Only the leading bytes are ever inspected — callers must bound how much of
 * the file they buffer for sniffing (this slice sniffs at most 4096 bytes). */
export const SNIFF_BUFFER_BYTES = 4096;

function startsWith(buffer: Buffer, magic: Buffer): boolean {
  return buffer.length >= magic.length && buffer.subarray(0, magic.length).equals(magic);
}

function isWebp(buffer: Buffer): boolean {
  return (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  );
}

/**
 * Text-likeness check: valid, non-truncated UTF-8 (no lone surrogates or
 * replacement characters from invalid sequences) with a printable-character
 * ratio high enough to exclude arbitrary binary blobs that merely happen not
 * to collide with an image magic number.
 */
function looksLikeText(buffer: Buffer): boolean {
  if (buffer.length === 0) return true;
  // A NUL byte essentially never appears in legitimate text content.
  if (buffer.includes(0)) return false;
  let text: string;
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    text = decoder.decode(buffer);
  } catch {
    return false;
  }
  let printable = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code === 0x09 || code === 0x0a || code === 0x0d || (code >= 0x20 && code !== 0x7f)) printable++;
  }
  return text.length === 0 || printable / text.length >= 0.95;
}

/**
 * Detects content from a bounded prefix of the file. `buffer` should be at
 * most `SNIFF_BUFFER_BYTES` for images/documents/audio (magic numbers are
 * always in the first few dozen bytes) — callers sniffing text should pass a
 * larger bounded prefix so the printable-ratio check is representative of
 * the whole file.
 *
 * `hintExtension` (lowercase, with or without leading dot) is used ONLY to
 * disambiguate a ZIP-container magic number into a specific OOXML document
 * type — bytes alone cannot tell a bare ZIP-signature file apart from DOCX
 * without parsing the archive's internal `[Content_Types].xml`, which this
 * bounded sniff does not do. It is never used to override or substitute for
 * a genuine magic-number match on its own (a `.docx`-named PNG is still
 * detected and rejected as an image, per `contentMatchesDeclaredKind`).
 */
export function detectContent(buffer: Buffer, hintExtension?: string): DetectedContent | null {
  if (startsWith(buffer, PNG_MAGIC)) return { kind: 'image', mimeType: 'image/png' };
  if (startsWith(buffer, JPEG_MAGIC)) return { kind: 'image', mimeType: 'image/jpeg' };
  if (startsWith(buffer, GIF87_MAGIC) || startsWith(buffer, GIF89_MAGIC)) return { kind: 'image', mimeType: 'image/gif' };
  if (isWebp(buffer)) return { kind: 'image', mimeType: 'image/webp' };
  if (startsWith(buffer, PDF_MAGIC)) return { kind: 'document', mimeType: 'application/pdf' };
  if (startsWith(buffer, ZIP_MAGIC) && (hintExtension ?? '').replace(/^\./, '').toLowerCase() === 'docx') {
    return { kind: 'document', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
  }
  if (isWav(buffer)) return { kind: 'audio', mimeType: 'audio/wav' };
  if (startsWith(buffer, ID3_MAGIC) || isMp3FrameSync(buffer)) return { kind: 'audio', mimeType: 'audio/mpeg' };
  if (startsWith(buffer, OGG_MAGIC)) return { kind: 'audio', mimeType: 'audio/ogg' };
  if (startsWith(buffer, FLAC_MAGIC)) return { kind: 'audio', mimeType: 'audio/flac' };
  if (looksLikeText(buffer)) return { kind: 'text', mimeType: 'text/plain' };
  return null;
}

/** The declared kind must agree with what the bytes actually are; a
 * text-declared file that is secretly a PNG (or vice versa) is rejected. */
export function contentMatchesDeclaredKind(detected: DetectedContent, declaredKind: AttachmentKind): boolean {
  return detected.kind === declaredKind;
}
