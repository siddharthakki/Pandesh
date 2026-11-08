import React, { useEffect, useState } from 'react';
import { api, errorText, type ArtifactView } from './bridge';

export type SpaceId = 'projects' | 'wish' | 'social' | 'media' | 'automations';
const TITLES: Record<SpaceId, string> = { projects: 'Projects', wish: 'Wish to Reality', social: 'Social Studio', media: 'Media Studio', automations: 'Automations' };

type Rec = Record<string, unknown>;
const firstArray = (v: unknown): Rec[] => {
  if (Array.isArray(v)) return v as Rec[];
  if (v && typeof v === 'object') for (const x of Object.values(v as Rec)) if (Array.isArray(x)) return x as Rec[];
  return [];
};
const str = (v: unknown) => (v == null ? '' : String(v));
const titleOf = (r: Rec) => str(r.title ?? r.name ?? r.label ?? r.objective ?? r.instruction ?? r.goal ?? r.id);
const statusOf = (r: Rec) => str(r.status ?? r.state ?? '');
const when = (v: unknown) => { const d = v ? new Date(String(v)) : null; return d && !Number.isNaN(d.getTime()) ? d.toLocaleString() : ''; };

function RecordCard({ r, extra, actions }: { r: Rec; extra?: React.ReactNode; actions?: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const scalars = Object.entries(r).filter(([k, v]) => v != null && typeof v !== 'object' && !['id', 'title', 'name', 'label'].includes(k)).slice(0, 14);
  return (
    <div className="card">
      <span className="title">{titleOf(r)}</span>
      <span className="meta">{[statusOf(r), when(r.updatedAt ?? r.createdAt)].filter(Boolean).join(' · ')}</span>
      {extra}
      {actions && <div className="actions">{actions}</div>}
      <button type="button" className="btn link" style={{ alignSelf: 'flex-start' }} aria-expanded={open} onClick={() => setOpen(!open)}>{open ? 'Hide details' : 'Details'}</button>
      {open && <dl style={{ margin: 0, display: 'grid', gridTemplateColumns: '150px 1fr', gap: '4px 10px', fontSize: 13 }}>{scalars.map(([k, v]) => <React.Fragment key={k}><dt style={{ color: 'var(--muted)' }}>{k}</dt><dd style={{ margin: 0, overflowWrap: 'anywhere' }}>{String(v)}</dd></React.Fragment>)}</dl>}
    </div>
  );
}

export function Workspace({ space, narrow, onAskPandesh }: { space: SpaceId; narrow: boolean; onAskPandesh: (text: string) => void }) {
  const [data, setData] = useState<Rec | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const call = async <T,>(action: string, args?: Rec): Promise<T | null> => { try { setError(null); return await api.household(action, args) as T; } catch (err) { setError(errorText(err)); return null; } };

  const load = async () => {
    setData(null);
    const tag = (d: Rec) => setData({ ...d, __space: space });
    if (space === 'projects') tag({ projects: firstArray(await call('projects')) });
    if (space === 'wish') tag({ goals: firstArray(await call('wishes')), business: (await call<Rec>('wishBusiness'))?.business ?? null });
    if (space === 'social') tag((await call<Rec>('socialDrafts')) ?? {});
    if (space === 'automations') {
      const overview = await call<Rec>('overview');
      let routine: unknown = null; try { routine = await (api as unknown as { getDailyBriefRoutine(): Promise<unknown> }).getDailyBriefRoutine(); } catch { /* not configured */ }
      const snap = await api.getSnapshot().catch(() => null) as Rec | null;
      tag({ routines: firstArray(overview?.routines), obligations: firstArray(overview?.obligations), dailyBrief: routine, queue: firstArray((snap?.commandQueue as Rec | undefined)?.items ?? snap?.commandQueue) });
    }
    if (space === 'media') {
      let studio: unknown = null; try { studio = await (api as unknown as { probeImageStudio(): Promise<unknown> }).probeImageStudio(); } catch (err) { studio = { detail: errorText(err) }; }
      const files = await api.listArtifacts().catch(() => [] as ArtifactView[]);
      tag({ studio, files: files.filter((f) => f.kind === 'image' || f.kind === 'video') });
    }
  };
  useEffect(() => { void load(); }, [space]);
  // Never render one space's view with another space's data (the first render after switching still holds the old data).
  const current = data && data.__space === space ? data : null;

  return (
    <>
      <div className="topbar"><span className="title" style={{ color: 'var(--ink)', fontWeight: 600 }}>{TITLES[space]}</span><span className="grow" /><button type="button" className="btn small" onClick={() => void load()}>Refresh</button></div>
      <div className="board" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {error && <div className="notice error" role="alert">{error}</div>}
        {note && <p role="status" style={{ margin: 0, fontSize: 14 }}>{note}</p>}
        {!current && !error && <div className="notice" role="status">Reading from Core…</div>}
        {current && space === 'projects' && <ProjectsView projects={current.projects as Rec[]} />}
        {current && space === 'wish' && <WishView goals={current.goals as Rec[]} business={current.business as Rec | null} />}
        {current && space === 'social' && <SocialView data={current} call={call} reload={load} setNote={setNote} onAskPandesh={onAskPandesh} />}
        {current && space === 'media' && <MediaView studio={current.studio as Rec | null} files={current.files as ArtifactView[]} onAskPandesh={onAskPandesh} narrow={narrow} />}
        {current && space === 'automations' && <AutomationsView data={current} call={call} reload={load} setNote={setNote} />}
      </div>
    </>
  );
}

function ProjectsView({ projects }: { projects: Rec[] }) {
  if (projects.length === 0) return <div className="notice">No projects are recorded in Core yet. Projects appear when you start coding work in a folder or create one in the Classic UI.</div>;
  return <div style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))' }}>{projects.map((p) => <RecordCard key={str(p.id)} r={p} />)}</div>;
}

function WishView({ goals, business }: { goals: Rec[]; business: Rec | null }) {
  return (
    <>
      <div className="notice" style={{ maxWidth: 'none', margin: 0 }}>Wish to Reality is feature-frozen until you approve it. Nothing here is published, sold or sent; demo or unverified figures are labelled as such in each record.</div>
      <div className="card"><span className="title">Business authorization</span><span className="meta">{business ? [str(business.status ?? business.state), when(business.updatedAt ?? business.authorizedAt)].filter(Boolean).join(' · ') || 'Recorded' : 'Not recorded — outward actions stay disabled.'}</span></div>
      {goals.length === 0 && <div className="notice">No wishes recorded.</div>}
      <div style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))' }}>{goals.map((g) => <RecordCard key={str(g.id)} r={g} extra={g.demo === true || g.isDemo === true ? <span className="failure">Demo data</span> : null} />)}</div>
    </>
  );
}

function SocialView({ data, call, reload, setNote, onAskPandesh }: { data: Rec; call: <T>(a: string, args?: Rec) => Promise<T | null>; reload: () => Promise<void>; setNote: (s: string) => void; onAskPandesh: (t: string) => void }) {
  const [channel, setChannel] = useState('instagram');
  const [text, setText] = useState('');
  const [notes, setNotes] = useState<Record<string, string>>({});
  const drafts = firstArray(data.drafts);
  const decide = async (id: string, decision: 'approve' | 'reject' | 'revise') => {
    const r = await call('socialDecide', { id, decision, note: notes[id] ?? '' });
    if (r) { setNote(decision === 'approve' ? 'Approved. It is NOT published — no publishing connector exists.' : decision === 'reject' ? 'Rejected with your reason.' : 'Sent back for revision with your note.'); await reload(); }
  };
  return (
    <>
      <div className="notice" style={{ maxWidth: 'none', margin: 0 }}>{str(data.publishing) || 'No publishing connector exists.'} Drafts and your decisions are stored locally.</div>
      <div className="card">
        <span className="title">New draft</span>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <label className="sr-only" htmlFor="sd-ch">Channel</label>
          <select id="sd-ch" value={channel} onChange={(e) => setChannel(e.target.value)} style={{ height: 34, border: '1px solid var(--line)', borderRadius: 8, background: 'var(--canvas)' }}>{['instagram', 'linkedin', 'facebook', 'x', 'tiktok', 'youtube', 'other'].map((c) => <option key={c}>{c}</option>)}</select>
          <button type="button" className="btn small" onClick={() => onAskPandesh(`Draft a short ${channel} post about: `)}>Ask Pandesh to draft</button>
        </div>
        <label className="sr-only" htmlFor="sd-text">Draft text</label>
        <textarea id="sd-text" rows={4} value={text} onChange={(e) => setText(e.target.value)} placeholder="Write or paste the post…" style={{ width: '100%', padding: 10, border: '1px solid var(--line)', borderRadius: 10, background: 'var(--canvas)', resize: 'vertical' }} />
        <div className="actions"><button type="button" className="btn small primary" disabled={!text.trim()} onClick={async () => { if (await call('socialCreate', { channel, text })) { setText(''); setNote('Draft saved.'); await reload(); } }}>Save draft</button></div>
      </div>
      {drafts.length === 0 && <div className="empty" style={{ color: 'var(--faint)' }}>No drafts yet.</div>}
      {drafts.map((d) => (
        <div key={str(d.id)} className={`card${d.status === 'draft' ? ' needs-you' : ''}`}>
          <span className="meta">{str(d.channel)} · {str(d.status).replace(/_/g, ' ')} · revision {str(d.revision)} · {when(d.updatedAt)}</span>
          <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{str(d.text)}</p>
          {d.decisionNote ? <span className="meta">Note: {str(d.decisionNote)}</span> : null}
          {(d.status === 'draft' || d.status === 'needs_revision') && (
            <>
              <label className="sr-only" htmlFor={`sd-n-${d.id}`}>Note</label>
              <input id={`sd-n-${d.id}`} value={notes[str(d.id)] ?? ''} onChange={(e) => setNotes({ ...notes, [str(d.id)]: e.target.value })} placeholder="Note (required to reject)" style={{ height: 32, padding: '0 10px', border: '1px solid var(--line)', borderRadius: 8, background: 'var(--canvas)' }} />
              <div className="actions">
                <button type="button" className="btn small primary" onClick={() => void decide(str(d.id), 'approve')}>Approve (not published)</button>
                <button type="button" className="btn small" onClick={() => void decide(str(d.id), 'revise')}>Ask for revision</button>
                <button type="button" className="btn small" disabled={!(notes[str(d.id)] ?? '').trim()} onClick={() => void decide(str(d.id), 'reject')}>Reject</button>
              </div>
            </>
          )}
        </div>
      ))}
    </>
  );
}

function MediaView({ studio, files, onAskPandesh, narrow }: { studio: Rec | null; files: ArtifactView[]; onAskPandesh: (t: string) => void; narrow: boolean }) {
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  useEffect(() => { for (const f of files.slice(0, 24)) if (f.kind === 'image' && f.availability === 'ready') api.loadArtifactPreview(f.id).then((p) => setThumbs((m) => ({ ...m, [f.id]: p.dataUrl }))).catch(() => undefined); }, [files.length]);
  return (
    <>
      <div className="card">
        <span className="title">Local image studio</span>
        <span className="meta">{studio ? `Image Studio ${studio.studio ? 'running' : 'not running'} · ComfyUI ${studio.comfyui ? 'answering' : 'not answering'} · Ollama ${studio.ollama ? `answering${studio.ollamaVersion ? ` (v${str(studio.ollamaVersion)})` : ''}` : 'not answering'}` : 'Status unknown'}</span>
        {studio?.detail ? <span style={{ fontSize: 14 }}>{str(studio.detail)}</span> : null}
        <div className="actions"><button type="button" className="btn small" onClick={() => onAskPandesh('Generate an image of ')}>Ask Pandesh for an image</button></div>
        <span className="meta">Generation runs locally and asks for your approval first.</span>
      </div>
      <h2 style={{ margin: 0, fontSize: 15 }}>Images and videos Pandesh made ({files.length})</h2>
      {files.length === 0 && <div className="empty" style={{ color: 'var(--faint)' }}>None yet.</div>}
      <div style={{ display: 'grid', gap: 10, gridTemplateColumns: `repeat(auto-fill, minmax(${narrow ? 140 : 200}px, 1fr))` }}>
        {files.map((f) => (
          <div key={f.id} className="card" style={{ padding: 8 }}>
            {thumbs[f.id] ? <img src={thumbs[f.id]} alt={f.title || f.fileName} style={{ width: '100%', borderRadius: 8 }} /> : <div style={{ height: 120, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--muted)', fontSize: 13 }}>{f.kind}</div>}
            <span style={{ fontSize: 13, overflowWrap: 'anywhere' }}>{f.title || f.fileName}</span>
            <span className="meta">{f.availability === 'ready' ? 'verified on disk' : f.availability}</span>
            {f.availability === 'ready' && <div className="actions"><button type="button" className="btn small" onClick={() => void api.openArtifactFile(f.id)}>Open</button></div>}
          </div>
        ))}
      </div>
    </>
  );
}

function AutomationsView({ data, call, reload, setNote }: { data: Rec; call: <T>(a: string, args?: Rec) => Promise<T | null>; reload: () => Promise<void>; setNote: (s: string) => void }) {
  const routines = firstArray(data.routines); const queue = firstArray(data.queue); const daily = data.dailyBrief as Rec | null;
  const control = async (id: string, op: string) => { if (await call('routine', { id, op })) { setNote(`Routine ${op === 'run' ? 'started' : op + 'd'}.`); await reload(); } };
  return (
    <>
      <div className="card"><span className="title">Daily brief</span><span className="meta">{daily ? `${daily.enabled ? 'On' : 'Off'} · daily at ${str(daily.dailyTime)} (${str(daily.timezone)})${daily.nextRunAt ? ` · next ${when(daily.nextRunAt)}` : ''}${daily.lastRunAt ? ` · last ${when(daily.lastRunAt)}` : ''}` : 'Not set up.'}</span></div>
      <h2 style={{ margin: 0, fontSize: 15 }}>Routines ({routines.length})</h2>
      {routines.length === 0 && <div className="empty" style={{ color: 'var(--faint)' }}>No routines. Ask Pandesh to set one up ("every Friday, check my folders").</div>}
      {routines.map((r) => (
        <RecordCard key={str(r.id)} r={r} extra={<span className="meta">{r.nextRunAt ? `Next ${when(r.nextRunAt)}` : ''}{r.lastRunAt ? ` · last ${when(r.lastRunAt)}` : ''}</span>}
          actions={<><button type="button" className="btn small" onClick={() => void control(str(r.id), 'run')}>Run now</button>{statusOf(r) === 'paused' ? <button type="button" className="btn small" onClick={() => void control(str(r.id), 'resume')}>Resume</button> : <button type="button" className="btn small" onClick={() => void control(str(r.id), 'pause')}>Pause</button>}</>} />
      ))}
      <h2 style={{ margin: 0, fontSize: 15 }}>Command queue ({queue.length})</h2>
      {queue.length === 0 && <div className="empty" style={{ color: 'var(--faint)' }}>Empty.</div>}
      {queue.map((q) => <RecordCard key={str(q.id)} r={q} />)}
    </>
  );
}
