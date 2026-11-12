import React, { useEffect, useRef, useState } from 'react';
import { api, errorText, type AttachmentKind, type Snapshot } from './bridge';

/**
 * Composer attachments. The host stages each file (the page never sees a path) and sends the staged files to Core with
 * the next message: picked with the paperclip, dropped on the window, or pasted as an image. Size and type limits are
 * the host's; its refusal is shown as it gave it.
 */
const KIND_LABEL: Record<AttachmentKind, string> = { image: 'Image', document: 'Document', audio: 'Audio', text: 'Text' };

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  if (n < 1024 ** 3) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

/** The message sent when files go without typed text (the same words as before). */
export function defaultAttachmentText(count: number): string {
  return count > 1 ? 'Please look at the attached files.' : 'Please look at the attached file.';
}

/** Chromium names every pasted picture "image.png"; give it a name that says when it was pasted. */
export function pastedName(name: string, at = new Date()): string {
  if (name && name !== 'image.png') return name;
  const p = (x: number) => String(x).padStart(2, '0');
  return `pasted-${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}-${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}.png`;
}

export function AttachmentChips({ items, onRemove }: { items: Array<{ id: string; name: string; kind: AttachmentKind; byteSize: number }>; onRemove?: (id: string) => void }) {
  if (!items.length) return null;
  return (
    <ul className="attach-list" aria-label={onRemove ? 'Files attached to your next message' : 'Attached files'}>
      {items.map((a) => (
        <li key={a.id} className="attach-chip" data-kind={a.kind}>
          <span className="attach-kind">{KIND_LABEL[a.kind] ?? 'File'}</span>
          <span className="attach-name" title={a.name}>{a.name}</span>
          <span className="attach-size">{formatBytes(a.byteSize)}</span>
          {onRemove && <button type="button" className="attach-remove" aria-label={`Remove ${a.name}`} title="Remove" onClick={() => onRemove(a.id)}>×</button>}
        </li>
      ))}
    </ul>
  );
}

export function useAttachments(opts: { snapshot: Snapshot | null; refresh: () => void; disabled: boolean; onDropped?: () => void }) {
  const { snapshot, refresh, disabled } = opts;
  const staged = snapshot?.stagedAttachments ?? [];
  const [staging, setStaging] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;
  const onDroppedRef = useRef(opts.onDropped);
  onDroppedRef.current = opts.onDropped;

  const stageFiles = async (files: File[]) => {
    if (!files.length) return;
    setError(null);
    setStaging((n) => n + files.length);
    const errors: string[] = [];
    for (const file of files) {
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const r = await api.stageAttachmentBytes(pastedName(file.name), bytes);
        if (!r?.ok) errors.push(r?.error || `“${file.name}” could not be attached.`);
      } catch (err) { errors.push(errorText(err)); } finally { setStaging((n) => n - 1); }
    }
    if (errors.length) setError(errors.join('\n'));
    refresh();
  };
  const stageRef = useRef(stageFiles);
  stageRef.current = stageFiles;

  const pick = async () => {
    setError(null);
    try {
      const r = await api.pickAttachments();
      if (r?.errors?.length) setError(r.errors.join('\n'));
    } catch (err) { setError(errorText(err)); }
    refresh();
  };
  const remove = async (id: string) => {
    setError(null);
    try { await api.removeAttachment(id); } catch (err) { setError(errorText(err)); }
    refresh();
  };
  const onPaste = (e: React.ClipboardEvent) => {
    const files = Array.from(e.clipboardData?.files ?? []);
    if (!files.length || disabledRef.current) return; // a plain text paste stays as it is
    e.preventDefault();
    void stageFiles(files);
  };

  // Files dropped anywhere on the window go to the next message.
  useEffect(() => {
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
    const enter = (e: DragEvent) => { if (!hasFiles(e) || disabledRef.current) return; e.preventDefault(); depth.current += 1; setDragging(true); };
    const over = (e: DragEvent) => { if (!hasFiles(e) || disabledRef.current) return; e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; };
    const leave = (e: DragEvent) => { if (!hasFiles(e)) return; depth.current = Math.max(0, depth.current - 1); if (depth.current === 0) setDragging(false); };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth.current = 0;
      setDragging(false);
      if (disabledRef.current) return;
      onDroppedRef.current?.();
      void stageRef.current(Array.from(e.dataTransfer?.files ?? []));
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragover', over);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragover', over);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
    };
  }, []);

  const chips = staged.length || staging || error ? (
    <div className="attach-strip">
      <AttachmentChips items={staged} onRemove={(id) => void remove(id)} />
      {staging > 0 && <span role="status" className="meta">Attaching {staging} file{staging === 1 ? '' : 's'}…</span>}
      {error && <div className="notice error" role="alert" style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{error} <button type="button" className="btn link" style={{ minHeight: 0, padding: 0 }} onClick={() => setError(null)}>OK</button></div>}
    </div>
  ) : null;
  const overlay = dragging ? <div className="drop-overlay" aria-hidden="true"><span>Drop files to attach them to your next message</span></div> : null;

  return { staged, staging: staging > 0, chips, overlay, pick, onPaste };
}
