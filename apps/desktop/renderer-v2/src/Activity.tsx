import React, { useEffect, useState } from 'react';
import { api, errorText, type ArtifactView, type WorkspaceActivity } from './bridge';
import { elapsed, timeOf } from './ui';

/**
 * Phase 2e — the Activity/Preview aside. Every row is a step Core recorded for
 * this conversation (tool invocations and host capability calls); every
 * preview is what the tool itself published: command output, a unified diff,
 * page text, artifacts. Nothing is simulated or reconstructed.
 */
export function ActivityAside({ activities, conversationId, narrow, onClose }: { activities: WorkspaceActivity[]; conversationId: string | null; narrow: boolean; onClose: () => void }) {
  const [sel, setSel] = useState<string | null>(null);
  const [artifacts, setArtifacts] = useState<ArtifactView[]>([]);
  const [images, setImages] = useState<Record<string, string>>({});
  const [note, setNote] = useState('');
  const selected = activities.find((a) => a.id === sel) ?? [...activities].reverse().find((a) => a.preview) ?? activities[activities.length - 1] ?? null;

  useEffect(() => {
    if (!conversationId) { setArtifacts([]); return; }
    api.listArtifacts(conversationId).then(setArtifacts).catch(() => setArtifacts([]));
  }, [conversationId, activities.length]);

  const wanted = selected?.preview?.artifactIds ?? [];
  useEffect(() => {
    for (const id of wanted) if (!images[id]) {
      api.loadArtifactPreview(id).then((p) => { if (p.artifact.kind === 'image') setImages((m) => ({ ...m, [id]: p.dataUrl })); }).catch(() => undefined);
    }
  }, [wanted.join(',')]);

  const open = async (fn: () => Promise<{ opened: boolean }>, what: string) => { try { const r = await fn(); setNote(r.opened ? `${what} opened.` : `${what} could not be opened.`); } catch (err) { setNote(errorText(err)); } };

  return (
    <aside aria-label="Activity and preview" style={{ flex: narrow ? '1 1 auto' : '0 0 420px', width: narrow ? '100%' : 420, minWidth: 0, display: 'flex', flexDirection: 'column', borderLeft: narrow ? 0 : '1px solid var(--line)', background: 'var(--surface)', position: narrow ? 'absolute' : 'relative', inset: narrow ? 0 : undefined, zIndex: narrow ? 25 : undefined }}>
      <div style={{ height: 52, display: 'flex', alignItems: 'center', gap: 8, padding: '0 14px', borderBottom: '1px solid var(--line)' }}>
        <span style={{ fontWeight: 600 }}>Activity</span>
        <span style={{ fontSize: 13, color: 'var(--muted)' }}>{activities.length} step{activities.length === 1 ? '' : 's'} recorded by Core</span>
        <span style={{ flex: 1 }} />
        <button type="button" className="btn small" title="Open the selected folder in Explorer" onClick={() => void open(() => api.openWorkspaceFolder(), 'Folder')}>Show folder</button>
        <button type="button" className="btn small" onClick={onClose}>Close</button>
      </div>
      <div style={{ flex: '0 0 auto', maxHeight: '40%', overflowY: 'auto', borderBottom: '1px solid var(--line)' }}>
        <ol style={{ listStyle: 'none', margin: 0, padding: 6 }}>
          {activities.map((a) => (
            <li key={a.id}>
              <button type="button" onClick={() => setSel(a.id)} aria-current={selected?.id === a.id ? 'true' : undefined}
                style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 8, padding: '7px 8px', border: 0, borderRadius: 8, background: selected?.id === a.id ? 'var(--raised)' : 'transparent', textAlign: 'left', fontSize: 14 }}>
                <span className={`dot ${a.state === 'failed' ? 'danger' : a.state === 'running' ? '' : 'muted'}`} aria-hidden="true" style={a.state === 'completed' ? { background: 'var(--verified)' } : undefined} />
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.title ?? a.capability}</span>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--muted)' }}>{a.state === 'running' ? 'running' : a.state}{a.startedAt && a.endedAt ? ` · ${elapsed(new Date(a.endedAt).getTime() - new Date(a.startedAt).getTime())}` : ''}</span>
              </button>
            </li>
          ))}
        </ol>
      </div>
      <div style={{ flex: '1 1 auto', minHeight: 0, overflowY: 'auto', padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {note && <p role="status" style={{ margin: 0, fontSize: 13.5 }}>{note}</p>}
        {!selected && <p style={{ margin: 0, color: 'var(--muted)' }}>No steps yet.</p>}
        {selected && (
          <>
            <div style={{ fontSize: 13, color: 'var(--muted)' }}>{selected.capability ?? 'step'} · started {timeOf(selected.startedAt)}{selected.endedAt ? ` · ended ${timeOf(selected.endedAt)}` : ''}</div>
            <div style={{ fontWeight: 600 }}>{selected.preview?.title ?? selected.title}</div>
            {selected.detail && <p style={{ margin: 0, fontSize: 14 }}>{selected.detail}</p>}
            {selected.preview?.path && <div style={{ fontFamily: 'var(--font-mono)', fontSize: 13 }}>{selected.preview.path}</div>}
            {selected.preview?.url && <button type="button" className="btn link" style={{ alignSelf: 'flex-start', overflowWrap: 'anywhere' }} onClick={() => void open(() => api.openExternalUrl(selected.preview!.url!), 'Page')}>{selected.preview.url}</button>}
            {selected.preview?.diff && <DiffView diff={selected.preview.diff} />}
            {selected.preview?.excerpt && (
              <figure style={{ margin: 0 }}>
                <figcaption style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 4 }}>{selected.preview.kind === 'code' ? 'Output (last lines, as the command printed them)' : 'Text the tool returned (untrusted content)'}</figcaption>
                <pre style={{ margin: 0, padding: 10, borderRadius: 8, background: 'var(--canvas)', border: '1px solid var(--line)', fontFamily: 'var(--font-mono)', fontSize: 12.5, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 360, overflow: 'auto' }}>{selected.preview.excerpt}</pre>
              </figure>
            )}
            {wanted.map((id) => images[id] ? <img key={id} src={images[id]} alt="Tool result" style={{ maxWidth: '100%', borderRadius: 8, border: '1px solid var(--line)' }} /> : null)}
            {!selected.preview && !selected.detail && <p style={{ margin: 0, color: 'var(--muted)', fontSize: 14 }}>This step published no preview.</p>}
          </>
        )}
        {artifacts.length > 0 && (
          <section aria-label="Files from this conversation" style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 }}>
            <h3 style={{ margin: 0, fontSize: 13, color: 'var(--muted)', letterSpacing: '0.04em' }}>FILES ({artifacts.length})</h3>
            {artifacts.map((f) => (
              <div key={f.id} className="card" style={{ padding: '8px 10px' }}>
                <span style={{ fontSize: 14, overflowWrap: 'anywhere' }}>{f.title || f.fileName}</span>
                <span className="meta">{f.kind} · {Math.max(1, Math.round(f.byteSize / 1024))} KB · {f.availability === 'ready' ? 'verified on disk' : f.availability}</span>
                {f.availability === 'ready' && <div className="actions"><button type="button" className="btn small" onClick={() => void open(() => api.openArtifactFile(f.id), 'File')}>Open</button><button type="button" className="btn small" onClick={() => void open(() => api.openArtifactFolder(f.id), 'Folder')}>Show in folder</button></div>}
              </div>
            ))}
          </section>
        )}
      </div>
    </aside>
  );
}

function DiffView({ diff }: { diff: string }) {
  return (
    <pre aria-label="Changes to the file" style={{ margin: 0, padding: 10, borderRadius: 8, background: 'var(--canvas)', border: '1px solid var(--line)', fontFamily: 'var(--font-mono)', fontSize: 12.5, overflow: 'auto', maxHeight: 360 }}>
      {diff.split('\n').map((l, i) => (
        <div key={i} style={{ color: l.startsWith('+') && !l.startsWith('+++') ? 'var(--verified)' : l.startsWith('-') && !l.startsWith('---') ? 'var(--danger)' : l.startsWith('@@') ? 'var(--muted)' : 'var(--ink)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{l || ' '}</div>
      ))}
    </pre>
  );
}
