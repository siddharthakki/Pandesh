/**
 * Host-side staging for composer attachments.
 *
 * Files a person picks, drops or pastes are copied into a private staging
 * folder and described to the renderer (name, size, kind) — the renderer never
 * receives a filesystem path it could abuse, and nothing reaches Core until a
 * message is actually sent. At send time `desktopSession` uploads each staged
 * file through Core's existing attachment pipeline (M36: bounded streaming
 * upload, byte-sniffed kind check, frozen sha256, local document extraction),
 * so this module only decides what is worth staging and keeps the bytes safe.
 *
 * Kinds follow Core's own detection so a mismatch is caught here, in plain
 * words, instead of as a rejected upload later: images (PNG/JPEG/GIF/WebP),
 * PDF and DOCX documents, audio (WAV/MP3/OGG/FLAC) and text-like files.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS_PER_TURN, type AttachmentKind } from '../../../../core/shared/wireTypes';

export interface StagedAttachmentView {
  id: string;
  name: string;
  byteSize: number;
  kind: AttachmentKind;
  mimeType: string;
}

interface StagedAttachment extends StagedAttachmentView {
  filePath: string;
}

export class AttachmentStagingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AttachmentStagingError';
  }
}

const EXTENSION_KIND: Record<string, AttachmentKind> = {
  '.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.gif': 'image', '.webp': 'image',
  '.pdf': 'document', '.docx': 'document',
  '.wav': 'audio', '.mp3': 'audio', '.ogg': 'audio', '.flac': 'audio',
};

const BLOCKED_EXTENSIONS = new Set([
  '.exe', '.dll', '.msi', '.bat', '.cmd', '.ps1', '.com', '.scr', '.zip', '.7z', '.rar', '.iso', '.bin', '.dmg', '.doc', '.xls', '.xlsx', '.ppt', '.pptx',
]);

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff]);

export const SUPPORTED_ATTACHMENTS_HINT = 'Images (PNG, JPG, GIF, WebP), PDF or Word (.docx) documents, audio (WAV, MP3, OGG, FLAC) and plain-text or code files.';

/** Kind and MIME for a file from its name and first bytes; throws a plain-language refusal for anything unsupported. */
export function classifyAttachment(name: string, head: Buffer): { kind: AttachmentKind; mimeType: string } {
  const ext = path.extname(name).toLowerCase();
  if (BLOCKED_EXTENSIONS.has(ext)) {
    throw new AttachmentStagingError(`"${name}" is a ${ext} file, which Panda can't read. ${SUPPORTED_ATTACHMENTS_HINT}`);
  }
  const starts = (magic: Buffer) => head.length >= magic.length && head.subarray(0, magic.length).equals(magic);
  // Bytes decide, as in Core: a renamed file is judged by what it really is.
  if (starts(PNG)) return { kind: 'image', mimeType: 'image/png' };
  if (starts(JPEG)) return { kind: 'image', mimeType: 'image/jpeg' };
  if (head.subarray(0, 6).toString('ascii').startsWith('GIF8')) return { kind: 'image', mimeType: 'image/gif' };
  if (head.length >= 12 && head.subarray(0, 4).toString('ascii') === 'RIFF' && head.subarray(8, 12).toString('ascii') === 'WEBP') return { kind: 'image', mimeType: 'image/webp' };
  if (head.subarray(0, 5).toString('ascii') === '%PDF-') return { kind: 'document', mimeType: 'application/pdf' };
  if (ext === '.docx' && head.length >= 4 && head.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
    return { kind: 'document', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
  }
  if (head.length >= 12 && head.subarray(0, 4).toString('ascii') === 'RIFF' && head.subarray(8, 12).toString('ascii') === 'WAVE') return { kind: 'audio', mimeType: 'audio/wav' };
  if (head.subarray(0, 3).toString('ascii') === 'ID3' || (head.length >= 2 && head[0] === 0xff && (head[1] & 0xe0) === 0xe0)) return { kind: 'audio', mimeType: 'audio/mpeg' };
  if (head.subarray(0, 4).toString('ascii') === 'OggS') return { kind: 'audio', mimeType: 'audio/ogg' };
  if (head.subarray(0, 4).toString('ascii') === 'fLaC') return { kind: 'audio', mimeType: 'audio/flac' };
  const declared = EXTENSION_KIND[ext];
  if (declared && declared !== 'text') {
    throw new AttachmentStagingError(`"${name}" doesn't look like a real ${ext.slice(1).toUpperCase()} file (its contents are something else), so it was not attached.`);
  }
  if (looksLikeText(head)) return { kind: 'text', mimeType: 'text/plain' };
  throw new AttachmentStagingError(`"${name}" isn't a file type Panda can read. ${SUPPORTED_ATTACHMENTS_HINT}`);
}

function looksLikeText(buffer: Buffer): boolean {
  if (buffer.length === 0) return true;
  if (buffer.includes(0)) return false;
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return false;
  }
  let printable = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code === 0x09 || code === 0x0a || code === 0x0d || (code >= 0x20 && code !== 0x7f)) printable += 1;
  }
  return text.length === 0 || printable / text.length >= 0.95;
}

/** A safe display/file name: no directories, no control characters, bounded. */
export function safeAttachmentName(raw: string): string {
  const base = path.basename(String(raw ?? '').replace(/\\/g, '/')).replace(/[\u0000-\u001f<>:"|?*]/g, '_').trim();
  return (base || 'attachment').slice(0, 120);
}

export class AttachmentStaging {
  private readonly items = new Map<string, StagedAttachment>();

  constructor(private readonly dir: string) {
    fs.mkdirSync(dir, { recursive: true });
    this.sweepStale();
  }

  /** Files left behind by a crashed or force-quit session are never reused. */
  private sweepStale(): void {
    try {
      for (const entry of fs.readdirSync(this.dir)) fs.rmSync(path.join(this.dir, entry), { force: true, recursive: true });
    } catch { /* best effort */ }
  }

  list(): StagedAttachmentView[] {
    return [...this.items.values()].map(({ filePath: _filePath, ...view }) => view);
  }

  private assertRoom(): void {
    if (this.items.size >= MAX_ATTACHMENTS_PER_TURN) {
      throw new AttachmentStagingError(`You can attach up to ${MAX_ATTACHMENTS_PER_TURN} files to one message.`);
    }
  }

  private commit(name: string, bytes: Buffer): StagedAttachmentView {
    this.assertRoom();
    if (bytes.length === 0) throw new AttachmentStagingError(`"${name}" is empty, so it was not attached.`);
    if (bytes.length > MAX_ATTACHMENT_BYTES) {
      throw new AttachmentStagingError(`"${name}" is ${(bytes.length / 1048576).toFixed(1)} MB; the limit is ${MAX_ATTACHMENT_BYTES / 1048576} MB per file.`);
    }
    const classified = classifyAttachment(name, bytes.subarray(0, 4096));
    const id = `stg_${crypto.randomUUID()}`;
    const filePath = path.join(this.dir, id);
    fs.writeFileSync(filePath, bytes, { mode: 0o600 });
    const staged: StagedAttachment = { id, name, byteSize: bytes.length, kind: classified.kind, mimeType: classified.mimeType, filePath };
    this.items.set(id, staged);
    const { filePath: _fp, ...view } = staged;
    return view;
  }

  /** Stage a file chosen in the native picker (the host reads it; the renderer never sees the path). */
  stageFile(sourcePath: string): StagedAttachmentView {
    const name = safeAttachmentName(path.basename(sourcePath));
    let stat: fs.Stats;
    try {
      stat = fs.statSync(sourcePath);
    } catch {
      throw new AttachmentStagingError(`"${name}" could not be read.`);
    }
    if (!stat.isFile()) throw new AttachmentStagingError(`"${name}" is not a file.`);
    if (stat.size > MAX_ATTACHMENT_BYTES) {
      throw new AttachmentStagingError(`"${name}" is ${(stat.size / 1048576).toFixed(1)} MB; the limit is ${MAX_ATTACHMENT_BYTES / 1048576} MB per file.`);
    }
    return this.commit(name, fs.readFileSync(sourcePath));
  }

  /** Stage bytes from a drop or paste. */
  stageBytes(rawName: string, bytes: Uint8Array): StagedAttachmentView {
    return this.commit(safeAttachmentName(rawName), Buffer.from(bytes));
  }

  remove(id: string): void {
    const item = this.items.get(id);
    if (!item) return;
    this.items.delete(id);
    fs.rmSync(item.filePath, { force: true });
  }

  /** Hands everything currently staged to a send; the caller must `release` or `restore` each afterwards. */
  take(): Array<StagedAttachmentView & { filePath: string }> {
    const taken = [...this.items.values()].map((item) => ({ ...item }));
    this.items.clear();
    return taken;
  }

  /** A send failed before the upload finished: put the files back so nothing is lost. */
  restore(items: Array<StagedAttachmentView & { filePath: string }>): void {
    for (const item of items) {
      if (fs.existsSync(item.filePath)) this.items.set(item.id, { ...item });
    }
  }

  /** The send succeeded: the bytes now live in Core. */
  release(items: Array<{ filePath: string }>): void {
    for (const item of items) fs.rmSync(item.filePath, { force: true });
  }

  clear(): void {
    for (const id of [...this.items.keys()]) this.remove(id);
  }
}
