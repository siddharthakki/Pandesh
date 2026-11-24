/**
 * Attached pictures as artifacts.
 *
 * A picture a person attaches to a message reaches the model as image bytes (a vision model sees it), but tools work
 * on Core artifacts: `image_generate` takes `referenceArtifactId`, `video_generate` takes `startArtifactId`, and a
 * tool that takes a list of pictures takes artifact ids. So each attached picture is also registered once as an image
 * artifact of its conversation (source `user_attachment`, the same source the desktop uses when it registers an
 * attached picture for an edit), and the model is told its id.
 *
 * The artifact points at Core's own copy of the attachment, written under the attachment's conversation folder with
 * the picture's real extension (tools and the person's own apps go by extension), and only after the bytes are
 * checked against the digest frozen at upload. The copy's path is derived from the attachment id alone, so it is
 * also the key that makes registration idempotent: a later turn (or a retried one) finds the same artifact.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CoreDatabase } from '../db/connection';
import { getArtifact, registerArtifact } from '../domain/artifacts';
import type { ArtifactRecord } from '../shared/wireTypes';
import { ATTACHMENTS_DIR_NAME, finalPath } from './storage';

/** The artifact source for a picture the person attached (shared with the desktop's own registration). */
export const USER_ATTACHMENT_SOURCE = 'user_attachment';

const PICTURE_EXTENSIONS: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

export interface AttachedPicture {
  conversationId: string;
  attachmentId: string;
  originalName: string;
  mimeType: string;
  /** The digest frozen when the attachment was uploaded. */
  sha256: string;
}

/** Where Core keeps the artifact copy of an attached picture: beside the attachment, with the picture's extension. */
export function pictureCopyPath(dataDir: string, picture: Pick<AttachedPicture, 'conversationId' | 'attachmentId' | 'mimeType'>): string {
  const extension = PICTURE_EXTENSIONS[picture.mimeType.toLowerCase()];
  if (!extension) throw new Error(`"${picture.mimeType}" is not a picture type Core keeps as an artifact`);
  // finalPath() asserts the attachment id stays inside the conversation's attachment folder.
  const attachmentFile = finalPath(dataDir, picture.conversationId, picture.attachmentId);
  const root = path.resolve(dataDir, ATTACHMENTS_DIR_NAME, picture.conversationId, 'pictures');
  const file = path.resolve(root, `${path.basename(attachmentFile, '.bin')}${extension}`);
  if (!file.startsWith(`${root}${path.sep}`)) throw new Error('picture copy path escapes the attachment folder');
  return file;
}

const sha256Of = (bytes: Buffer) => crypto.createHash('sha256').update(bytes).digest('hex');

/** The artifact title: the name the person gave the file, bounded the way artifacts require. */
function pictureTitle(name: string): string {
  const title = name.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 255);
  return title || 'Attached picture';
}

/**
 * The artifact an attached picture is known by to tools, registered on first use. Throws (plain words) when the
 * stored bytes no longer match the digest frozen at upload, or the picture type cannot be kept.
 */
export function ensurePictureArtifact(db: CoreDatabase, dataDir: string, picture: AttachedPicture, actor = 'core:attachments'): ArtifactRecord {
  const copy = pictureCopyPath(dataDir, picture);
  const existing = db.get<{ id: string }>('SELECT id FROM artifacts WHERE absolutePath = ? AND source = ? ORDER BY createdAt ASC LIMIT 1', [copy, USER_ATTACHMENT_SOURCE]);
  if (existing) {
    const known = getArtifact(db, existing.id);
    if (known.availability !== 'missing') return known;
    // The copy was removed (for example by hand): write it again from the attachment; the digest is unchanged.
  }
  const bytes = fs.readFileSync(finalPath(dataDir, picture.conversationId, picture.attachmentId));
  if (sha256Of(bytes) !== picture.sha256) throw new Error(`the stored bytes of "${picture.originalName}" no longer match its upload digest`);
  fs.mkdirSync(path.dirname(copy), { recursive: true });
  if (!fs.existsSync(copy) || sha256Of(fs.readFileSync(copy)) !== picture.sha256) fs.writeFileSync(copy, bytes, { mode: 0o600 });
  if (existing) return getArtifact(db, existing.id);
  return registerArtifact(db, {
    conversationId: picture.conversationId,
    kind: 'image',
    title: pictureTitle(picture.originalName),
    mimeType: picture.mimeType.toLowerCase(),
    absolutePath: copy,
    source: USER_ATTACHMENT_SOURCE,
    metadata: { attachmentId: picture.attachmentId, originalName: picture.originalName.slice(0, 255) },
    actor,
  });
}

/** One line per picture for the model, plus how to use the ids; empty when there are none. */
export function describePictureArtifacts(lines: string[]): string {
  if (lines.length === 0) return '';
  return `${lines.join('')}\n\n(Each attached picture is saved as an artifact. When a tool takes a picture — image_generate referenceArtifactId, video_generate startArtifactId, or a list of pictures — pass these artifact ids; do not ask for file paths.)`;
}
