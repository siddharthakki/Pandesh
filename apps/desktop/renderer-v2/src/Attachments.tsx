import React, { useEffect, useRef, useState } from 'react';
import { api, errorText, type Snapshot } from './bridge';
import { Icon } from './ui';
import { KIND_LABEL, dragHasFiles, formatBytes, nameForFile, type StagedAttachment } from './attachmentModel';

type Notice = { text: string; error?: boolean } | null;

/** File chips: removable in the composer, plain in a sent message. Shows what the host reports, nothing more. */
export function AttachmentChips({ items, onRemove }: { items: ReadonlyArray<{ id: string; name: string; kind: StagedAttachment['kind']; byteSize: number }>; onRemove?: (id: string) => void }) {
  if (items.length === 0) return null;
  return (
    <ul className={onRemove ? 'attach-list' : 'attach-list sent'} aria-label={onRemove ? 'Files attached to your next message' : 'Files sent with this message'}>
      {items.map((a) => (
        <li key={a.id} className="attach-chip" data-kind={a.kind}>
          <span className="attach-kind">{KIND_LABEL[a.kind] ?? 'File'}</span>
          <span className="attach-name" title={a.name}>{a.name}</span>
          <span className="attach-size">{formatBytes(a.byteSize)}</span>
          {onRemove && <button type="button" className="attach-x" aria-label={`Remove ${a.name}`} title="Remove" onClick={() => onRemove(a.id)}>×</button>}
        </li>
      ))}
    </ul>
  );
}

/**
 * Attach by paperclip (the host's native file dialog), drag and drop onto the window, or paste an image. Bytes of
 * dropped and pasted files go to the host, which validates size and count and stages them; the window never holds a
 * path. The staged list always comes from the host snapshot, so what is shown is what will be sent.
 */
export function useAttachments(opts: { snapshot: Snapshot | null; refresh: () => void; onNotice: (n: Notice) => void; disabled: boolean }) {
  const { snapshot, refresh, onNotice, disabled } = opts;
  const staged = snapshot?.stagedAttachments ?? [];
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const depth = useRef(0);

  const stageFiles = async (files: File[]) => {
    if (files.length === 0) return;
    setBusy(true);
    const errors: string[] = [];
    for (const [i, file] of files.entries()) {
      try {
        const res = await api.stageAttachmentBytes(nameForFile(file, i), new Uint8Array(await file.arrayBuffer()));
        if (!res?.ok) errors.push(res?.error || `"${file.name}" could not be attached.`);
      } catch (err) { errors.push(errorText(err)); }
    }
    setBusy(false);
    onNotice(errors.length ? { text: errors.join(' '), error: true } : null);
    refresh();
  };

  const pick = async () => {
    setBusy(true);
    onNotice(null);
    try {
      const r = await api.pickAttachments();
      if (r?.errors?.length) onNotice({ text: r.errors.join(' '), error: true });
    } catch (err) { onNotice({ text: errorText(err), error: true }); } finally { setBusy(false); refresh(); }
  };

  const remove = (id: string) => {
    void api.removeAttachment(id).catch((err) => onNotice({ text: errorText(err), error: true })).finally(refresh);
  };

  // Files dropped anywhere on the window; text and links dragged over it are left alone.
  useEffect(() => {
    if (disabled) return undefined;
    const enter = (e: DragEvent) => { if (!dragHasFiles(e.dataTransfer?.types)) return; e.preventDefault(); depth.current += 1; setDragging(true); };
    const over = (e: DragEvent) => { if (!dragHasFiles(e.dataTransfer?.types)) return; e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; };
    const leave = (e: DragEvent) => { if (!dragHasFiles(e.dataTransfer?.types)) return; depth.current = Math.max(0, depth.current - 1); if (depth.current === 0) setDragging(false); };
    const drop = (e: DragEvent) => {
      if (!dragHasFiles(e.dataTransfer?.types)) return;
      e.preventDefault(); depth.current = 0; setDragging(false);
      void stageFiles(Array.from(e.dataTransfer?.files ?? []));
    };
    window.addEventListener('dragenter', enter); window.addEventListener('dragover', over); window.addEventListener('dragleave', leave); window.addEventListener('drop', drop);
    return () => { window.removeEventListener('dragenter', enter); window.removeEventListener('dragover', over); window.removeEventListener('dragleave', leave); window.removeEventListener('drop', drop); };
  }, [disabled]);

  /** Plain-text paste is untouched; pasted files (a screenshot, a copied image) are staged instead. */
  const onPaste = (e: React.ClipboardEvent) => {
    const files = Array.from(e.clipboardData?.files ?? []);
    if (files.length === 0) return;
    e.preventDefault();
    void stageFiles(files);
  };

  const button = (
    <button type="button" className="icon-btn" aria-label="Attach files" title="Attach files, or drop or paste them here" disabled={disabled || busy} onClick={() => void pick()}><Icon name="attach" /></button>
  );
  const strip = <AttachmentChips items={staged} onRemove={remove} />;
  const overlay = dragging ? <div className="drop-overlay" role="status" aria-live="polite">Drop files to attach them to your next message</div> : null;
  return { staged, button, strip, overlay, onPaste, busy };
}
