import React, { useEffect, useState } from 'react';
import { api, errorText, type ArtifactView, type CommandQueue, type DailyBriefRoutine, type ImageGenerationResult, type ImageStudioStatus, type QueueItem, type Snapshot } from './bridge';
import { RemindersCard } from './Everyday';

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

export function Workspace({ space, narrow, onAskPandesh, snapshot, refresh }: { space: SpaceId; narrow: boolean; onAskPandesh: (text: string) => void; snapshot: Snapshot | null; refresh: () => void }) {
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
      let routine: DailyBriefRoutine | null = null; try { routine = await api.getDailyBriefRoutine(); } catch { /* not configured */ }
      tag({ routines: firstArray(overview?.routines), obligations: firstArray(overview?.obligations), dailyBrief: routine });
    }
    if (space === 'media') {
      let studio: unknown = null; try { studio = await api.probeImageStudio(); } catch (err) { studio = { detail: errorText(err), checkpoints: [] }; }
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
        {current && space === 'media' && <MediaView studio={current.studio as ImageStudioStatus | null} files={current.files as ArtifactView[]} onAskPandesh={onAskPandesh} narrow={narrow} reload={load} setNote={setNote} />}
        {current && space === 'automations' && <AutomationsView data={current} call={call} reload={load} setNote={setNote} snapshot={snapshot} refresh={refresh} />}
      </div>
    </>
  );
}

function ProjectsView({ projects }: { projects: Rec[] }) {
  if (projects.length === 0) return <div className="notice">No projects are recorded in Core yet. Ask Pandesh to create one ("Create a project named … with tasks …"), or start coding work in a folder.</div>;
  const tasksOf = (p: Rec): Rec[] => { const ctx = p.productContext as Rec | null | undefined; return Array.isArray(ctx?.tasks) ? (ctx!.tasks as Rec[]) : []; };
  return <div style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))' }}>{projects.map((p) => {
    const tasks = tasksOf(p);
    // Due date, the priority the user set and a blocker (personalTasks.ts) are shown when a task has them.
    const due = (t: Rec) => { const d = str(t.dueAt); if (!d) return null; const late = new Date(d).getTime() < Date.now() && !['done', 'cancelled'].includes(str(t.status)); return <span className="meta"> · due {d.slice(0, 10)}{late ? ' (overdue)' : ''}</span>; };
    return <RecordCard key={str(p.id)} r={p} extra={tasks.length ? <ul style={{ margin: 0, paddingLeft: 18, fontSize: 14 }}>{tasks.map((t) => <li key={str(t.id ?? t.title)}><span className="meta">{str(t.status)}</span> {str(t.title)}{due(t)}{str(t.priority) === 'high' ? <span className="meta"> · high priority</span> : null}{str(t.blockedBy) ? <span className="meta"> · blocked by {str(t.blockedBy)}</span> : null}</li>)}</ul> : null} />;
  })}</div>;
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

function MediaView({ studio, files, onAskPandesh, narrow, reload, setNote }: { studio: ImageStudioStatus | null; files: ArtifactView[]; onAskPandesh: (t: string) => void; narrow: boolean; reload: () => Promise<void>; setNote: (s: string) => void }) {
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  useEffect(() => { for (const f of files.slice(0, 24)) if (f.kind === 'image' && f.availability === 'ready') api.loadArtifactPreview(f.id).then((p) => setThumbs((m) => ({ ...m, [f.id]: p.dataUrl }))).catch(() => undefined); }, [files.length]);
  const checkpoints = studio?.checkpoints ?? [];
  const [prompt, setPrompt] = useState('');
  const [size, setSize] = useState('1024x1024');
  const [steps, setSteps] = useState(20);
  const [checkpoint, setCheckpoint] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [approval, setApproval] = useState<{ approvalId: string; presentation: Record<string, unknown> | null } | null>(null);
  useEffect(() => { if (!checkpoint && checkpoints[0]) setCheckpoint(checkpoints[0].name); }, [checkpoints.length]);

  const handle = async (r: ImageGenerationResult) => {
    if (r.outcome === 'approval_required') { setApproval({ approvalId: r.approvalId, presentation: r.presentation }); setStatus('Check the exact request before generation starts.'); return; }
    setApproval(null);
    setStatus(r.outcome === 'executed' ? r.message : r.reason);
    if (r.outcome === 'executed') await reload();
  };
  const generate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!prompt.trim() || !checkpoint) return;
    const [width, height] = size.split('x').map(Number);
    setBusy(true); setStatus('Preparing the request…');
    try { await handle(await api.generateImage({ prompt: prompt.trim(), width, height, steps, checkpoint, outputCount: 1 })); }
    catch (err) { setStatus(errorText(err)); } finally { setBusy(false); }
  };
  const decide = async (resolution: 'approved' | 'rejected') => {
    if (!approval) return;
    const id = approval.approvalId;
    setApproval(null);
    setBusy(resolution === 'approved');
    setStatus(resolution === 'approved' ? 'Generating on this PC…' : 'Not generated.');
    try {
      const r = await api.resolveImageApproval(id, resolution);
      if (resolution === 'approved' && r && typeof r === 'object' && 'outcome' in (r as Rec)) await handle(r as ImageGenerationResult);
      else if (resolution === 'approved') await reload();
    } catch (err) { setStatus(errorText(err)); } finally { setBusy(false); }
  };
  type FileResult = { opened?: boolean; saved?: boolean; path?: string | null };
  const fileAction = async (work: () => Promise<FileResult>, done: (r: FileResult) => string) => {
    try { setNote(done(await work())); } catch (err) { setNote(errorText(err)); }
  };
  const ready = Boolean(studio?.comfyui || studio?.studio) && checkpoints.length > 0;
  return (
    <>
      <div className="card">
        <span className="title">Local image studio</span>
        <span className="meta">{studio ? `Image Studio ${studio.studio ? 'running' : 'not running'} · ComfyUI ${studio.comfyui ? 'answering' : 'not answering'} · Ollama ${studio.ollama ? `answering${studio.ollamaVersion ? ` (v${str(studio.ollamaVersion)})` : ''}` : 'not answering'}` : 'Status unknown'}</span>
        {studio?.detail ? <span style={{ fontSize: 14 }}>{str(studio.detail)}</span> : null}
        <form style={{ display: 'flex', flexDirection: 'column', gap: 6 }} onSubmit={(e) => void generate(e)}>
          <label className="sr-only" htmlFor="img-prompt">Describe the image</label>
          <textarea id="img-prompt" className="field" rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Describe the image you want…" disabled={busy || Boolean(approval)} />
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            <label className="sr-only" htmlFor="img-model">Image model</label>
            <select id="img-model" className="field" value={checkpoint} onChange={(e) => setCheckpoint(e.target.value)} disabled={!checkpoints.length}>
              {checkpoints.length === 0 && <option value="">No image model found</option>}
              {checkpoints.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
            </select>
            <label className="sr-only" htmlFor="img-size">Size</label>
            <select id="img-size" className="field" value={size} onChange={(e) => setSize(e.target.value)}>
              {['1024x1024', '1152x896', '896x1152', '1344x768', '768x1344', '512x512'].map((x) => <option key={x}>{x}</option>)}
            </select>
            <label style={{ fontSize: 14, display: 'flex', gap: 6, alignItems: 'center' }}>Steps <input className="field" type="number" min={1} max={80} value={steps} onChange={(e) => setSteps(Math.max(1, Math.min(80, Number(e.target.value) || 20)))} style={{ width: 70 }} /></label>
            <button type="submit" className="btn small primary" disabled={!ready || busy || Boolean(approval) || !prompt.trim()}>Generate</button>
            {busy && <button type="button" className="btn small" onClick={() => void api.cancelImageGeneration().then(() => setStatus('Cancel requested.')).catch((err) => setStatus(errorText(err)))}>Cancel</button>}
            <button type="button" className="btn small" onClick={() => onAskPandesh('Generate an image of ')}>Ask Pandesh instead</button>
          </div>
        </form>
        {approval && (
          <section className="approval" aria-label="Approval needed: generate image" style={{ margin: 0 }}>
            <div className="approval-head"><span className="dot attention" aria-hidden="true" /><span className="title">Needs your OK · Generate image</span></div>
            <div className="detail" style={{ whiteSpace: 'pre-wrap', fontFamily: 'var(--font-mono)', fontSize: 12.5 }}>{JSON.stringify(approval.presentation ?? { prompt, size, checkpoint, steps }, null, 2)}</div>
            <div className="actions"><button type="button" className="btn primary" onClick={() => void decide('approved')}>Generate image</button><button type="button" className="btn" onClick={() => void decide('rejected')}>Don't allow</button></div>
            <div className="foot">Generation runs on this PC only. Core records your decision.</div>
          </section>
        )}
        {status && <span role="status" style={{ fontSize: 14 }}>{status}</span>}
        <div className="actions"><button type="button" className="btn small" onClick={() => void api.openExternalUrl('http://127.0.0.1:8989/').catch((err) => setStatus(errorText(err)))}>Open the Studio web page</button></div>
      </div>
      <h2 style={{ margin: 0, fontSize: 15 }}>Images and videos Pandesh made ({files.length})</h2>
      {files.length === 0 && <div className="empty" style={{ color: 'var(--faint)' }}>None yet.</div>}
      <div style={{ display: 'grid', gap: 10, gridTemplateColumns: `repeat(auto-fill, minmax(${narrow ? 140 : 200}px, 1fr))` }}>
        {files.map((f) => (
          <div key={f.id} className="card" style={{ padding: 8 }}>
            {thumbs[f.id] ? <img src={thumbs[f.id]} alt={f.title || f.fileName} style={{ width: '100%', borderRadius: 8 }} /> : <div style={{ height: 120, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--muted)', fontSize: 13 }}>{f.kind}</div>}
            <span style={{ fontSize: 13, overflowWrap: 'anywhere' }}>{f.title || f.fileName}</span>
            <span className="meta">{f.availability === 'ready' ? 'verified on disk' : f.availability}</span>
            {f.availability === 'ready' && (
              <div className="actions">
                <button type="button" className="btn small" onClick={() => void api.openArtifactFile(f.id)}>Open</button>
                <button type="button" className="btn small" onClick={() => void fileAction(() => api.saveArtifactCopy(f.id), (r) => (r.saved ? `Saved a copy to ${r.path}` : 'Not saved.'))}>Save a copy…</button>
                {f.kind === 'image' && <button type="button" className="btn small" onClick={() => void fileAction(() => api.openArtifactInStudio(f.id), (r) => (r.opened ? 'Opened in the Studio.' : 'The Studio did not open it.'))}>Open in Studio</button>}
                {f.kind === 'image' && <button type="button" className="btn small" title="Opens the Studio with this picture as the reference for a new image" onClick={() => void fileAction(() => api.useArtifactAsReference(f.id), (r) => (r.opened ? 'Opened in the Studio as the reference picture.' : 'The Studio did not open it.'))}>Use as reference</button>}
              </div>
            )}
          </div>
        ))}
      </div>
    </>
  );
}

function localInput(d: Date): string {
  const p = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function AutomationsView({ data, call, reload, setNote, snapshot, refresh }: { data: Rec; call: <T>(a: string, args?: Rec) => Promise<T | null>; reload: () => Promise<void>; setNote: (s: string) => void; snapshot: Snapshot | null; refresh: () => void }) {
  const routines = firstArray(data.routines); const queue: CommandQueue | null = snapshot?.commandQueue ?? null; const daily = data.dailyBrief as DailyBriefRoutine | null;
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const tools = snapshot?.everydayTools;
  const timers = (tools?.activeTimers ?? []).filter((t) => t.state === 'running' || t.state === 'paused');
  const control = async (id: string, op: string) => { if (await call('routine', { id, op })) { setNote(`Routine ${op === 'run' ? 'started' : op + 'd'}.`); await reload(); } };
  const [time, setTime] = useState(daily?.dailyTime ?? '08:00');
  const [instruction, setInstruction] = useState('');
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [postponing, setPostponing] = useState<{ id: string; at: string } | null>(null);
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const act = async (work: () => Promise<unknown>, done: string): Promise<boolean> => {
    try { await work(); setNote(done); return true; } catch (err) { setNote(errorText(err)); return false; } finally { refresh(); await reload(); }
  };
  const confirming = queue?.confirming ?? null;
  const item = (q: QueueItem) => (
    <div key={q.id} className="card">
      {editing?.id === q.id ? (
        <form style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }} onSubmit={(e) => { e.preventDefault(); if (!editing.text.trim()) return; void act(() => api.editQueuedCommand(q.id, editing.text.trim()), 'Queued instruction changed.').then((ok) => { if (ok) setEditing(null); }); }}>
          <label className="sr-only" htmlFor={`qe-${q.id}`}>Queued instruction</label>
          <input id={`qe-${q.id}`} className="field" style={{ flex: '1 1 260px' }} autoFocus value={editing.text} onChange={(e) => setEditing({ id: q.id, text: e.target.value })} />
          <button type="submit" className="btn small primary">Save</button><button type="button" className="btn small" onClick={() => setEditing(null)}>Cancel</button>
        </form>
      ) : <span className="title">{q.ordinal}. {q.title || q.instruction}</span>}
      <span className="meta">{q.status.replace(/_/g, ' ')}{q.postponedUntil ? ` until ${new Date(q.postponedUntil).toLocaleString()}` : ''}{q.dependsOnId ? ' · waits for an earlier one' : ''}{q.lastError ? ` · ${q.lastError}` : ''}</span>
      {postponing?.id === q.id && (
        <form style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }} onSubmit={(e) => { e.preventDefault(); const at = new Date(postponing.at); if (Number.isNaN(at.getTime())) return; void act(() => api.postponeCommand(q.id, at.toISOString()), 'Postponed.').then((ok) => { if (ok) setPostponing(null); }); }}>
          <label className="sr-only" htmlFor={`qp-${q.id}`}>Postpone until</label>
          <input id={`qp-${q.id}`} className="field" type="datetime-local" value={postponing.at} onChange={(e) => setPostponing({ id: q.id, at: e.target.value })} />
          <button type="submit" className="btn small primary">Postpone</button><button type="button" className="btn small" onClick={() => setPostponing(null)}>Cancel</button>
        </form>
      )}
      <div className="actions">
        <button type="button" className="btn small" onClick={() => setEditing({ id: q.id, text: q.instruction })}>Edit</button>
        <button type="button" className="btn small" disabled={q.ordinal <= 1} onClick={() => void act(() => api.reorderQueuedCommand(q.id, Math.max(1, q.ordinal - 1)), 'Moved up.')}>Up</button>
        <button type="button" className="btn small" onClick={() => void act(() => api.reorderQueuedCommand(q.id, q.ordinal + 1), 'Moved down.')}>Down</button>
        <button type="button" className="btn small" onClick={() => setPostponing({ id: q.id, at: localInput(new Date(Date.now() + 3600_000)) })}>Postpone…</button>
        <button type="button" className="btn small" onClick={() => void act(() => api.skipCommand(q.id), 'Skipped.')}>Skip</button>
        <button type="button" className="btn small" onClick={() => void act(() => api.removeQueuedCommand(q.id), 'Removed from the queue.')}>Remove</button>
      </div>
    </div>
  );
  return (
    <>
      <div className="card">
        <span className="title">Daily brief</span>
        <span className="meta">{daily ? `${daily.enabled ? 'On' : 'Off'} · daily at ${str(daily.dailyTime)} (${str(daily.timezone)})${daily.nextRunAt ? ` · next ${when(daily.nextRunAt)}` : ''}${daily.lastRunAt ? ` · last ${when(daily.lastRunAt)}` : ''}` : 'Not set up.'}</span>
        <form style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }} onSubmit={(e) => { e.preventDefault(); void act(() => api.configureDailyBriefRoutine({ dailyTime: time, timezone: tz, enabled: true }), `Daily brief set for ${time} every day.`); }}>
          <label htmlFor="db-time" style={{ fontSize: 14 }}>Every day at</label>
          <input id="db-time" className="field" type="time" value={time} onChange={(e) => setTime(e.target.value)} required />
          <button type="submit" className="btn small primary">{daily?.enabled ? 'Change time' : 'Turn on'}</button>
          {daily?.enabled && <button type="button" className="btn small" onClick={() => void act(() => api.configureDailyBriefRoutine({ dailyTime: daily.dailyTime, timezone: daily.timezone, enabled: false }), 'Daily brief turned off.')}>Turn off</button>}
        </form>
        <span className="meta">The brief arrives as a chat from Pandesh at that time, while Pandesh runs.</span>
      </div>
      {tools && <RemindersCard tools={tools} timers={timers} now={now} run={async (w, done) => { await act(w, done ?? 'Done.'); }} />}
      <h2 style={{ margin: 0, fontSize: 15 }}>Routines ({routines.length})</h2>
      {routines.length === 0 && <div className="empty" style={{ color: 'var(--faint)' }}>No routines. Ask Pandesh to set one up ("every Friday, check my folders").</div>}
      {routines.map((r) => (
        <RecordCard key={str(r.id)} r={r} extra={<span className="meta">{r.nextRunAt ? `Next ${when(r.nextRunAt)}` : ''}{r.lastRunAt ? ` · last ${when(r.lastRunAt)}` : ''}</span>}
          actions={<><button type="button" className="btn small" onClick={() => void control(str(r.id), 'run')}>Run now</button>{statusOf(r) === 'paused' ? <button type="button" className="btn small" onClick={() => void control(str(r.id), 'resume')}>Resume</button> : <button type="button" className="btn small" onClick={() => void control(str(r.id), 'pause')}>Pause</button>}</>} />
      ))}
      <h2 style={{ margin: 0, fontSize: 15 }}>Command queue</h2>
      <form className="card" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }} onSubmit={(e) => { e.preventDefault(); if (!instruction.trim()) return; void act(() => api.enqueueCommand(instruction.trim()), 'Added to the queue.').then((ok) => { if (ok) setInstruction(''); }); }}>
        <label className="sr-only" htmlFor="q-new">Instruction to queue</label>
        <input id="q-new" className="field" style={{ flex: '1 1 260px' }} value={instruction} onChange={(e) => setInstruction(e.target.value)} placeholder="Queue an instruction to run after the current work…" />
        <button type="submit" className="btn small primary" disabled={!instruction.trim()}>Add to queue</button>
      </form>
      {confirming && (
        <section className="approval" aria-label="Confirm the next queued instruction" style={{ margin: 0 }}>
          <div className="approval-head"><span className="dot attention" aria-hidden="true" /><span className="title">Needs your OK · Run the next queued instruction</span></div>
          <div className="detail">{confirming.title || confirming.instruction}{confirming.title && confirming.title !== confirming.instruction ? ` — ${confirming.instruction}` : ''}{confirming.confirmationExpiresAt ? ` (confirm before ${new Date(confirming.confirmationExpiresAt).toLocaleTimeString()})` : ''}</div>
          <div className="actions">
            <button type="button" className="btn primary" disabled={!confirming.confirmationToken} onClick={() => void act(() => api.confirmCommandRun(confirming.id, confirming.confirmationToken ?? '', confirming.revision || 1), 'Running it now.')}>Run it</button>
            <button type="button" className="btn" onClick={() => void act(() => api.skipCommand(confirming.id), 'Skipped.')}>Skip</button>
          </div>
        </section>
      )}
      {queue?.active && <div className="notice" role="status" style={{ margin: 0, maxWidth: 'none' }}>Running now: {queue.active.title || queue.active.instruction}</div>}
      {(queue?.waiting ?? []).length === 0 && !confirming && <div className="empty" style={{ color: 'var(--faint)' }}>Nothing is waiting.</div>}
      {(queue?.waiting ?? []).map(item)}
      {(queue?.recentTerminal ?? []).length > 0 && (
        <>
          <h3 style={{ margin: 0, fontSize: 14 }}>Recently finished</h3>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 14 }}>{[...(queue?.recentTerminal ?? [])].reverse().map((q) => <li key={q.id}>{q.status.replace(/_/g, ' ')}: {q.title || q.instruction}{q.outcome ? ` (${q.outcome})` : ''}</li>)}</ul>
        </>
      )}
    </>
  );
}
