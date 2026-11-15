import React, { useEffect, useState } from 'react';
import { api, errorText, type ArtifactView, type ToolPreview, type WorkspaceActivity } from './bridge';
import { elapsed, timeOf } from './ui';
import { describePhase, type RunState } from './runModel';
import { buildTimeline, entryFromActivity, whoIsWorking, type TimelineEntry } from './timelineModel';
import { maskSecrets } from '../../../../core/shared/secretMask';

/**
 * The Activity/Preview aside. One chronological timeline of what Core and the host recorded for the request: model
 * passes, tool calls, approvals (and who decided), the final check and how it ended. A tool row opens to what it was
 * asked and what it returned: command output, a diff, page text, screenshots and files. Nothing is simulated, and any
 * text a tool returned is shown with credentials masked.
 */

const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const hasDetail = (a?: WorkspaceActivity) => Boolean(a && (a.preview || a.detail));

// Image previews, loaded once per artifact (the host verifies the file before it returns the bytes).
const imageCache = new Map<string, string>();
function useArtifactImage(id: string, enabled = true): string | null {
  const [src, setSrc] = useState<string | null>(imageCache.get(id) ?? null);
  useEffect(() => {
    if (!enabled || imageCache.has(id)) { setSrc(imageCache.get(id) ?? null); return; }
    let live = true;
    api.loadArtifactPreview(id).then((p) => { if (p.artifact.kind === 'image') { imageCache.set(id, p.dataUrl); if (live) setSrc(p.dataUrl); } }).catch(() => undefined);
    return () => { live = false; };
  }, [id, enabled]);
  return src;
}

function Shot({ id, title }: { id: string; title: string }) {
  const src = useArtifactImage(id);
  const [big, setBig] = useState(false);
  if (!src) return null;
  return (
    <button type="button" className={`tl-shot${big ? ' big' : ''}`} aria-label={big ? `Shrink ${title}` : `Enlarge ${title}`} aria-pressed={big} onClick={() => setBig((b) => !b)}>
      <img src={src} alt={title} />
    </button>
  );
}

function StepDetail({ a, tech, onOpen }: { a: WorkspaceActivity; tech: boolean; onOpen: (fn: () => Promise<{ opened: boolean }>, what: string) => void }) {
  const p: ToolPreview | null | undefined = a.preview;
  const title = maskSecrets(p?.title ?? a.title ?? '');
  // A failure's reason already shows on the row; repeating it here only adds noise.
  const detail = a.detail && a.state !== 'failed' && a.state !== 'cancelled' ? maskSecrets(a.detail) : null;
  const command = p?.command ? maskSecrets(p.command) : null;
  const excerpt = p?.excerpt ? maskSecrets(p.excerpt) : null;
  const diff = p?.diff ? maskSecrets(p.diff) : null;
  const url = p?.url ? maskSecrets(p.url) : null;
  const anyMasked = [title, detail, command, excerpt, diff, url].some((m) => m?.masked);
  const ids = p?.artifactIds ?? [];
  const hasOutput = Boolean(command || diff || excerpt || ids.length || detail);
  return (
    <div className="tl-detail">
      <div className="tl-block"><span className="tl-h">Asked</span>
        <span>{title.text || (a.capability ?? 'step')}</span>
        {p?.path && <span className="tl-mono">{maskSecrets(p.path).text}</span>}
        {url && <button type="button" className="btn link tl-link" onClick={() => onOpen(() => api.openExternalUrl(p!.url!), 'Page')}>{url.text}</button>}
        {command && <code className="tl-code">{command.text}</code>}
      </div>
      <div className="tl-block"><span className="tl-h">Returned</span>
        {p?.command && <CommandFacts p={p} />}
        {detail && <span className={a.state === 'failed' ? 'tl-bad' : ''}>{detail.text}</span>}
        {diff && <DiffView diff={diff.text} />}
        {excerpt && (
          <details open={!p?.command || p.exitCode !== 0}>
            <summary>{p?.command ? `Output: last ${excerpt.text.split('\n').length} lines, as the command printed them` : 'Text the tool returned (untrusted content)'}</summary>
            <pre className="tl-pre">{excerpt.text}</pre>
          </details>
        )}
        {ids.length > 0 && <div className="tl-shots">{ids.map((id) => <Shot key={id} id={id} title={title.text || 'Tool result'} />)}</div>}
        {!hasOutput && <span className="tl-dim">{a.state === 'running' ? 'Running: Core has not reported a result for this call yet.' : 'The tool returned nothing to preview; it only changed state or answered the model.'}</span>}
        {anyMasked && <span className="tl-dim">Passwords, keys and tokens in this output are masked.</span>}
      </div>
      {tech && <div className="tl-mono tl-dim">invocation {a.id}{a.taskId ? ` · request ${a.taskId}` : ''}</div>}
    </div>
  );
}

function Row({ e, now, tech, open, onToggle, onOpen }: { e: TimelineEntry; now: number; tech: boolean; open: boolean; onToggle: () => void; onOpen: (fn: () => Promise<{ opened: boolean }>, what: string) => void }) {
  const expandable = hasDetail(e.activity);
  const end = e.endedAt ?? (e.state === 'running' ? now : undefined);
  const tail = [e.state === 'running' ? 'running' : e.state === 'ok' ? 'done' : e.state, end !== undefined && e.kind !== 'outcome' ? elapsed(Math.max(0, end - e.at)) : ''].filter(Boolean).join(' · ');
  const body = (
    <>
      <span className="tl-time">{e.at ? clock(e.at) : ''}</span>
      <span className={`tl-dot ${e.state}`} aria-hidden="true" />
      <span className="tl-label">{e.label}</span>
      <span className={`tl-state ${e.state}`}>{tail}</span>
      {expandable && <span className="tl-chev" aria-hidden="true">{open ? '▾' : '▸'}</span>}
    </>
  );
  return (
    <li className={`tl-item ${e.kind}`}>
      {expandable
        ? <button type="button" className="tl-row" aria-expanded={open} onClick={onToggle}>{body}</button>
        : <div className="tl-row static">{body}</div>}
      {e.reason && (e.state === 'failed' || e.state === 'blocked' || e.state === 'cancelled') && <div className="tl-reason">{maskSecrets(e.reason).text}</div>}
      {tech && e.facts.length > 0 && <div className="tl-mono tl-dim tl-facts">{e.facts.join(' · ')}</div>}
      {open && expandable && e.activity && <StepDetail a={e.activity} tech={tech} onOpen={onOpen} />}
    </li>
  );
}

export function ActivityAside({ activities, conversationId, narrow, onClose, run, running, now, currentTaskId }: { activities: WorkspaceActivity[]; conversationId: string | null; narrow: boolean; onClose: () => void; run?: RunState | null; running?: boolean; now?: number; currentTaskId?: string | null }) {
  const [tech, setTech] = useState(false);
  const [artifacts, setArtifacts] = useState<ArtifactView[]>([]);
  const [note, setNote] = useState('');
  const [opened, setOpened] = useState<Record<string, boolean>>({});
  const tick = now ?? Date.now();
  // The request that is running (or ran last) is shown on its own; every earlier request is folded under "Earlier requests".
  const taskOf = (a: WorkspaceActivity) => a.taskId ?? '';
  const lastTask = currentTaskId ?? [...activities].reverse().find((a) => a.taskId)?.taskId ?? null;
  const currentSteps = lastTask ? activities.filter((a) => taskOf(a) === lastTask) : activities;
  const earlierByTask = lastTask ? activities.filter((a) => taskOf(a) !== lastTask) : [];
  const earlier: Array<{ task: string; items: WorkspaceActivity[] }> = [];
  for (const a of earlierByTask) { const t = taskOf(a); const last = earlier[earlier.length - 1]; if (last && last.task === t) last.items.push(a); else earlier.push({ task: t, items: [a] }); }
  const { entries, liveEventsMissing } = buildTimeline(run ?? null, currentSteps, { technical: tech });
  const live = Boolean(run && !run.outcome);
  // A failed step opens by itself: what went wrong is the first thing to read. A person's own toggle wins.
  const isOpen = (e: TimelineEntry) => opened[e.id] ?? (e.state === 'failed' && hasDetail(e.activity));

  useEffect(() => {
    if (!conversationId) { setArtifacts([]); return; }
    api.listArtifacts(conversationId).then(setArtifacts).catch(() => setArtifacts([]));
  }, [conversationId, activities.length]);

  const open = async (fn: () => Promise<{ opened: boolean }>, what: string) => { try { const r = await fn(); setNote(r.opened ? `${what} opened.` : `${what} could not be opened.`); } catch (err) { setNote(errorText(err)); } };
  const images = artifacts.filter((f) => f.kind === 'image' && f.availability === 'ready').slice(0, 8);

  return (
    <aside className={`tl${narrow ? ' narrow' : ''}`} aria-label="Activity and preview">
      <div className="tl-head">
        <span className="tl-title">Activity</span>
        <span className="tl-dim">{running ? 'Live' : `${activities.length} step${activities.length === 1 ? '' : 's'} recorded by Core`}</span>
        <span className="tl-grow" />
        <button type="button" className="btn small" title="Open the selected folder in Explorer" onClick={() => void open(() => api.openWorkspaceFolder(), 'Folder')}>Show folder</button>
        <button type="button" className="btn small" onClick={onClose}>Close</button>
      </div>
      {run && <Banner run={run} now={tick} tech={tech} onTech={() => setTech((t) => !t)} />}
      <div className="tl-body">
        {note && <p role="status" className="tl-note">{note}</p>}
        <section aria-label={live ? 'Current request' : 'Last request'}>
          {(entries.length > 0 || !run) && <div className="tl-kicker">{live ? 'CURRENT REQUEST' : 'LAST REQUEST'}</div>}
          {liveEventsMissing && <p className="tl-dim tl-note">These are the tool calls Pandesh saved. The model, approval and timing events are kept only while the window is open, so they are not listed here.</p>}
          {entries.length === 0 && <p className="tl-dim">{run ? 'Nothing has been recorded for this request yet.' : 'No steps yet.'}</p>}
          <ol className="tl-list">
            {entries.map((e) => <Row key={e.id} e={e} now={tick} tech={tech} open={isOpen(e)} onToggle={() => setOpened((m) => ({ ...m, [e.id]: !isOpen(e) }))} onOpen={open} />)}
          </ol>
          {!run && <button type="button" className="btn small tl-tech" aria-pressed={tech} onClick={() => setTech((t) => !t)}>{tech ? 'Hide technical details' : 'Technical details'}</button>}
        </section>

        {earlier.length > 0 && (
          <details className="tl-earlier">
            <summary>Earlier requests in this chat ({earlier.length})</summary>
            {[...earlier].reverse().map((r) => {
              const failed = r.items.filter((a) => a.state === 'failed').length;
              const first = r.items[0];
              return (
                <details key={r.task || first.id} className="tl-req">
                  <summary>Request at {timeOf(first.startedAt)} · {r.items.length} step{r.items.length === 1 ? '' : 's'}{failed ? ` · ${failed} failed` : ''}</summary>
                  <ol className="tl-list">{r.items.map(entryFromActivity).map((e) => <Row key={e.id} e={e} now={tick} tech={tech} open={isOpen(e)} onToggle={() => setOpened((m) => ({ ...m, [e.id]: !isOpen(e) }))} onOpen={open} />)}</ol>
                </details>
              );
            })}
          </details>
        )}

        {artifacts.length > 0 && (
          <section aria-label="Files from this conversation" className="tl-files">
            <h3 className="tl-kicker">FILES ({artifacts.length})</h3>
            {images.length > 0 && <div className="tl-shots">{images.map((f) => <Shot key={f.id} id={f.id} title={f.title || f.fileName} />)}</div>}
            {artifacts.map((f) => (
              <div key={f.id} className="card tl-file">
                <span className="tl-wrap">{f.title || f.fileName}</span>
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

function Banner({ run, now, tech, onTech }: { run: RunState; now: number; tech: boolean; onTech: () => void }) {
  const live = !run.outcome;
  const d = describePhase(run, now);
  const w = whoIsWorking(run);
  const end = run.outcome ? run.lastSignalAt : now;
  return (
    <section className="tl-banner" aria-label="Status">
      <div className="tl-banner-top">
        <span className={`tl-pill ${w.actor}`}>{live ? w.text : d.label}</span>
        <span className="tl-grow" />
        <span className="tl-mono tl-dim">{elapsed(Math.max(0, end - run.startedAt))}</span>
      </div>
      <div role="status" aria-live="polite" className="tl-banner-label">{d.label}</div>
      <div className={`tl-banner-sub${d.stalled ? ' bad' : ''}`}>{d.sub}{d.stalled ? ': unusually long; you can stop the request.' : ''}</div>
      {live && run.toolCallsTotal === 0 && run.phase !== 'starting' && <div className="tl-dim">No tool has been called in this request so far.</div>}
      {run.outcome === 'completed' && run.toolCallsTotal === 0 && <div className="tl-dim">The model answered directly; it called no tools.</div>}
      <button type="button" className="btn small tl-tech" aria-pressed={tech} onClick={onTech}>{tech ? 'Hide technical details' : 'Technical details'}</button>
    </section>
  );
}

function CommandFacts({ p }: { p: ToolPreview }) {
  const ok = !p.timedOut && p.exitCode === 0;
  const t = p.tests;
  const chip = (label: string, tone: 'ok' | 'bad' | 'dim') => <span className={`tl-chip ${tone}`}>{label}</span>;
  return (
    <div className="tl-facts-row">
      {chip(p.timedOut ? 'Timed out' : p.exitCode == null ? 'Exit code not reported' : `Exit code ${p.exitCode}`, ok ? 'ok' : 'bad')}
      {p.durationMs != null && chip(elapsed(p.durationMs), 'dim')}
      {t?.passed != null && chip(`${t.passed} passed`, 'ok')}
      {t?.failed != null && chip(`${t.failed} failed`, t.failed ? 'bad' : 'dim')}
      {t?.skipped != null && chip(`${t.skipped} skipped`, 'dim')}
      {t?.total != null && chip(`${t.total} total`, 'dim')}
      {t && <span className="tl-dim">Counts from the runner's own line: <code className="tl-mono">{maskSecrets(t.line).text}</code></span>}
    </div>
  );
}

function DiffView({ diff }: { diff: string }) {
  return (
    <pre className="tl-pre" aria-label="Changes to the file">
      {diff.split('\n').map((l, i) => (
        <div key={i} className={l.startsWith('+') && !l.startsWith('+++') ? 'tl-add' : l.startsWith('-') && !l.startsWith('---') ? 'tl-del' : l.startsWith('@@') ? 'tl-dim' : ''}>{l || ' '}</div>
      ))}
    </pre>
  );
}
