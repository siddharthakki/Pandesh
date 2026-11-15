/**
 * Pure helpers for composer attachments. The host stages the files (it never gives the window a path); the window
 * shows what the host reports, lets the person remove a file before sending, and sends the message. No IPC here.
 */

export type AttachmentKind = 'text' | 'image' | 'document' | 'audio';
export interface StagedAttachment { id: string; name: string; byteSize: number; kind: AttachmentKind; mimeType?: string }

/** The same fallback wording the Classic composer sends when a message is only files (apps/desktop/renderer/renderer.js). */
export function goalFor(typed: string, staged: ReadonlyArray<unknown>): string {
  const t = typed.trim();
  if (t) return t;
  if (staged.length === 0) return '';
  return staged.length > 1 ? 'Please look at the attached files.' : 'Please look at the attached file.';
}

export function canSend(typed: string, staged: ReadonlyArray<unknown>): boolean {
  return Boolean(typed.trim()) || staged.length > 0;
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

export const KIND_LABEL: Record<AttachmentKind, string> = { image: 'Image', document: 'Document', audio: 'Audio', text: 'Text' };

/** True when a drag carries files (not text or a link), so the drop overlay appears only for files. */
export function dragHasFiles(types: ReadonlyArray<string> | DOMStringList | undefined | null): boolean {
  return Array.from((types ?? []) as ArrayLike<string>).includes('Files');
}

/** Pasted clipboard files that are images get a name, since a screenshot paste has none worth keeping. */
export function nameForFile(file: { name?: string; type?: string }, index = 0): string {
  const name = (file.name ?? '').trim();
  if (name && !/^image\.(png|jpe?g|gif|webp)$/i.test(name)) return name;
  const ext = /^image\/(png|jpe?g|gif|webp)$/i.exec(file.type ?? '')?.[1]?.replace('jpeg', 'jpg') ?? 'png';
  return `pasted-image${index ? `-${index + 1}` : ''}.${ext}`;
}

/** One line for the message shown while it is being sent, and in the transcript when the text is only the fallback. */
export function summary(list: ReadonlyArray<{ name: string }>): string {
  if (list.length === 0) return '';
  return list.length === 1 ? list[0].name : `${list[0].name} and ${list.length - 1} more`;
}
