import React, { useEffect, useState } from 'react';
import { api, errorText, type ArtifactView, type WorkspaceActivity } from './bridge';
import { elapsed, timeOf } from './ui';

/**
 * Phase 2e — the Activity/Preview aside. Every row is a step Core recorded for
 * this conversation (tool invocations and host capability calls); every
 * preview is what the tool itself published: command output, a unified diff,
 * page text, artifacts. Nothing is simulated or reconstructed.
 */
import { groupActivities } from './boardModel';
import { describePhase, type RunState, type RunStep } from './runModel';

const stepTime = (a: WorkspaceActivity) => (a.preview?.durationMs != null ? a.preview.durationMs : a.startedAt && a.endedAt ? new Date(a.endedAt).getTime() - new Date(a.startedAt).getTime() : null);

function StepRow({ a, selected, onSelect, indent }: { a: WorkspaceActivity; selected: boolean; onSelect: () => void; indent?: boolean }) {
  const ms = stepTime(a);
  const exit = a.preview?.command ? (a.preview.timedOut ? 'timed out' : a.preview.exitCode != null ? `exit ${a.preview.exitCode}` : '') : '';
  return (
    <button type="button" onClick={onSelect} aria-current={selected ? 'true' : undefined}
      style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 8, padding: `7px 8px 7px ${indent ? 26 : 8}px`, border: 0, borderRadius: 8, background: selected ? 'var(--raised)' : 'transparent', textAlign: 'left', fontSize: 14 }}>
      <span className={`dot ${a.state === 'failed' ? 'danger' : a.state === 'running' ? '' : 'muted'}`} aria-hidden="true" style={a.state === 'completed' ? { background: 'var(--verified)' } : undefined} />
      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.title ?? a.capability}</span>
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: a.state === 'failed' || (a.preview?.exitCode ?? 0) !== 0 ? 'var(--danger)' : 'var(--muted)' }}>{[a.state === 'running' ? 'running' : a.state, exit, ms != null ? elapsed(ms) : ''].filter(Boolean).join(' · ')}</span>
    </button>
  );
}

export function ActivityAside({ activities, conversationId, narrow, onClose, run, running, now, currentTaskId }: { activities: WorkspaceActivity[]; conversationId: string | null; narrow: boolean; onClose: () => void; run?: RunState | null; running?: boolean; now?: number; currentTaskId?: string | null }) {
  const [sel, setSel] = useState<string | null>(null);
  const [tech, setTech] = useState(false);
  const [artifacts, setArtifacts] = useState<ArtifactView[]>([]);
  const [images, setImages] = useState<Record<string, string>>({});
  const [note, setNote] = useState('');
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
  // The request that is running (or ran last) is shown on its own; every earlier request is folded under "Earlier requests".
  const taskOf = (a: WorkspaceActivity) => a.taskId ?? '';
  const lastTask = currentTaskId ?? [...activities].reverse().find((a) => a.taskId)?.taskId ?? null;
  const currentSteps = lastTask ? activities.filter((a) => taskOf(a) === lastTask) : activities;
  const earlierByTask = lastTask ? activities.filter((a) => taskOf(a) !== lastTask) : [];
  const earlier: Array<{ task: string; items: WorkspaceActivity[] }> = [];
  for (const a of earlierByTask) { const t = taskOf(a); const last = earlier[earlier.length - 1]; if (last && last.task === t) last.items.push(a); else earlier.push({ task: t, items: [a] }); }
  const groups = groupActivities(currentSteps);
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
        <span style={{ fontSize: 13, color: 'var(--muted)' }}>{running ? 'Live' : `${activities.length} step${activities.length === 1 ? '' : 's'} recorded by Core`}</span>
        <span style={{ flex: 1 }} />
        <button type="button" className="btn small" title="Open the selected folder in Explorer" onClick={() => void open(() => api.openWorkspaceFolder(), 'Folder')}>Show folder</button>
        <button type="button" className="btn small" onClick={onClose}>Close</button>
      </div>
      {run && <LiveRun run={run} activities={activities} now={now ?? Date.now()} tech={tech} onTech={() => setTech((t) => !t)} onSelect={setSel} selectedId={selected?.id ?? null} />}
      {!run && currentSteps.length > 0 && <div style={{ padding: '8px 14px 0', fontSize: 12, color: 'var(--muted)', letterSpacing: '0.04em' }}>{running ? 'CURRENT REQUEST' : 'LAST REQUEST'}</div>}
      {!run && currentSteps.length > 0 && <div style={{ flex: '0 0 auto', maxHeight: '40%', overflowY: 'auto', borderBottom: '1px solid var(--line)' }}>
        <ol style={{ listStyle: 'none', margin: 0, padding: 6 }}>
          {groups.map((g) => {
            if (g.items.length === 1) return <li key={g.items[0].id}><StepRow a={g.items[0]} selected={selected?.id === g.items[0].id} onSelect={() => setSel(g.items[0].id)} /></li>;
            const gid = g.items[0].id;
            const failed = g.items.filter((a) => a.state === 'failed').length;
            const running = g.items.some((a) => a.state === 'running');
            const isOpen = openGroups[gid] ?? (failed > 0 || g.items.some((a) => a.id === selected?.id));
            const total = g.items.reduce((t, a) => t + (stepTime(a) ?? 0), 0);
            return (
              <li key={gid}>
                <button type="button" aria-expanded={isOpen} onClick={() => setOpenGroups((m) => ({ ...m, [gid]: !isOpen }))}
                  style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 8, padding: '7px 8px', border: 0, borderRadius: 8, background: 'transparent', textAlign: 'left', fontSize: 14 }}>
                  <span aria-hidden="true" style={{ width: 10, fontSize: 10, color: 'var(--muted)' }}>{isOpen ? '▾' : '▸'}</span>
                  <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{g.key.replace(/_/g, ' ')} <span style={{ color: 'var(--muted)' }}>× {g.items.length}</span></span>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: failed ? 'var(--danger)' : 'var(--muted)' }}>{[running ? 'running' : failed ? `${failed} failed` : 'completed', total ? elapsed(total) : ''].filter(Boolean).join(' · ')}</span>
                </button>
                {isOpen && <ol style={{ listStyle: 'none', margin: 0, padding: 0 }}>{g.items.map((a) => <li key={a.id}><StepRow a={a} indent selected={selected?.id === a.id} onSelect={() => setSel(a.id)} /></li>)}</ol>}
              </li>
            );
          })}
        </ol>
      </div>}
      {earlier.length > 0 && (
        <details style={{ flex: '0 0 auto', borderBottom: '1px solid var(--line)', padding: '6px 14px', maxHeight: '28%', overflowY: 'auto' }}>
          <summary style={{ cursor: 'pointer', fontSize: 13, color: 'var(--muted)' }}>Earlier requests in this chat ({earlier.length})</summary>
          {[...earlier].reverse().map((r) => {
            const failed = r.items.filter((a) => a.state === 'failed').length;
            const first = r.items[0];
            return (
              <details key={r.task || first.id} style={{ marginTop: 6 }}>
                <summary style={{ cursor: 'pointer', fontSize: 13.5 }}>Request at {timeOf(first.startedAt)} · {r.items.length} step{r.items.length === 1 ? '' : 's'}{failed ? ` · ${failed} failed` : ''}</summary>
                <ol style={{ listStyle: 'none', margin: 0, padding: 0 }}>{r.items.map((a) => <li key={a.id}><StepRow a={a} selected={selected?.id === a.id} onSelect={() => setSel(a.id)} /></li>)}</ol>
              </details>
            );
          })}
        </details>
      )}
      <div style={{ flex: '1 1 auto', minHeight: 0, overflowY: 'auto', padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {note && <p role="status" style={{ margin: 0, fontSize: 13.5 }}>{note}</p>}
        {!selected && !run && <p style={{ margin: 0, color: 'var(--muted)' }}>No steps yet.</p>}
        {selected && (
          <>
            <div style={{ fontSize: 13, color: 'var(--muted)' }}>{selected.capability ?? 'step'} · started {timeOf(selected.startedAt)}{selected.endedAt ? ` · ended ${timeOf(selected.endedAt)}` : ''}</div>
            <div style={{ fontWeight: 600 }}>{selected.preview?.title ?? selected.title}</div>
            {selected.detail && <p style={{ margin: 0, fontSize: 14 }}>{selected.detail}</p>}
            {selected.preview?.path && <div style={{ fontFamily: 'var(--font-mono)', fontSize: 13 }}>{selected.preview.path}</div>}
            {selected.preview?.url && <button type="button" className="btn link" style={{ alignSelf: 'flex-start', overflowWrap: 'anywhere' }} onClick={() => void open(() => api.openExternalUrl(selected.preview!.url!), 'Page')}>{selected.preview.url}</button>}
            {selected.preview?.command && <CommandFacts p={selected.preview} />}
            {selected.preview?.diff && <DiffView diff={selected.preview.diff} />}
            {selected.preview?.excerpt && (
              <details open={!selected.preview.command || selected.preview.exitCode !== 0} style={{ margin: 0 }}>
                <summary style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 4, cursor: 'pointer' }}>{selected.preview.command ? `Output — last ${selected.preview.excerpt.split('\n').length} lines, as the command printed them` : selected.preview.kind === 'code' ? 'Output (last lines, as the command printed them)' : 'Text the tool returned (untrusted content)'}</summary>
                <pre style={{ margin: 0, padding: 10, borderRadius: 8, background: 'var(--canvas)', border: '1px solid var(--line)', fontFamily: 'var(--font-mono)', fontSize: 12.5, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 360, overflow: 'auto' }}>{selected.preview.excerpt}</pre>
              </details>
            )}
            {wanted.map((id) => images[id] ? <img key={id} src={images[id]} alt="Tool result" style={{ maxWidth: '100%', borderRadius: 8, border: '1px solid var(--line)' }} /> : null)}
            {!selected.preview && !selected.detail && <p style={{ margin: 0, color: 'var(--muted)', fontSize: 14 }}>{selected.state === 'running' ? 'Running — Core has not reported a result for this call yet.' : `Core recorded this call as ${selected.state}${stepTime(selected) != null ? ` after ${elapsed(stepTime(selected)!)}` : ''}. The tool returned nothing to preview (it only changed state or answered the model), so there is no output to show.`}</p>}
            {tech && <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--muted)', overflowWrap: 'anywhere' }}>invocation {selected.id}{selected.taskId ? ` · request ${selected.taskId}` : ''}</div>}
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

function CommandFacts({ p }: { p: NonNullable<WorkspaceActivity['preview']> }) {
  const ok = !p.timedOut && p.exitCode === 0;
  const t = p.tests;
  const chip = (label: string, tone: string) => <span style={{ padding: '2px 9px', borderRadius: 999, background: 'var(--raised)', color: tone, fontSize: 13 }}>{label}</span>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <code style={{ fontFamily: 'var(--font-mono)', fontSize: 13, padding: '6px 8px', borderRadius: 6, background: 'var(--canvas)', border: '1px solid var(--line)', overflowWrap: 'anywhere' }}>{p.command}</code>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
        {chip(p.timedOut ? 'Timed out' : p.exitCode == null ? 'Exit code not reported' : `Exit code ${p.exitCode}`, ok ? 'var(--verified)' : 'var(--danger)')}
        {p.durationMs != null && chip(elapsed(p.durationMs), 'var(--muted)')}
        {t?.passed != null && chip(`${t.passed} passed`, 'var(--verified)')}
        {t?.failed != null && chip(`${t.failed} failed`, t.failed ? 'var(--danger)' : 'var(--muted)')}
        {t?.skipped != null && chip(`${t.skipped} skipped`, 'var(--muted)')}
        {t?.total != null && chip(`${t.total} total`, 'var(--muted)')}
      </div>
      {t && <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>Counts from the runner's own line: <code style={{ fontFamily: 'var(--font-mono)' }}>{t.line}</code></span>}
    </div>
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

const dotFor = (st: string) => (st === 'failed' ? 'danger' : st === 'blocked' ? 'attention' : st === 'running' ? '' : 'muted');

function LiveRun({ run, activities, now, tech, onTech, onSelect, selectedId }: { run: RunState; activities: WorkspaceActivity[]; now: number; tech: boolean; onTech: () => void; onSelect: (id: string) => void; selectedId: string | null }) {
  const live = !run.outcome;
  const d = describePhase(run, now);
  const end = run.outcome ? run.lastSignalAt : now;
  const tone = run.phase === 'failed' ? 'var(--danger)' : run.phase === 'completed' ? 'var(--verified)' : 'var(--ink)';
  const byInv = new Map(activities.map((a) => [a.id, a]));
  // Model-call bookkeeping rows appear only in the technical view; the per-pass rows ("answered without calling a tool") always show.
  const steps = run.steps.filter((s: RunStep) => s.kind !== 'model' || tech || s.id.startsWith('pass-'));
  return (
    <section aria-label={live ? 'Current request' : 'Last request'} style={{ flex: '0 0 auto', padding: '10px 14px', borderBottom: '1px solid var(--line)', display: 'flex', flexDirection: 'column', gap: 6, maxHeight: '55%', overflowY: 'auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 12, color: 'var(--muted)', letterSpacing: '0.04em' }}>{live ? 'CURRENT REQUEST' : 'LAST REQUEST'}</span>
        <span style={{ flex: 1 }} />
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5, color: 'var(--muted)' }}>{elapsed(Math.max(0, end - run.startedAt))}</span>
      </div>
      <div role="status" aria-live="polite" style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <span className={`dot ${run.phase === 'failed' ? 'danger' : run.phase === 'approval' ? 'attention' : live ? '' : 'muted'}`} aria-hidden="true" style={run.phase === 'completed' ? { background: 'var(--verified)' } : undefined} />
        <span style={{ fontWeight: 600, color: tone }}>{d.label}</span>
      </div>
      <div style={{ fontSize: 13, color: d.stalled ? 'var(--danger)' : 'var(--muted)', overflowWrap: 'anywhere' }}>{d.sub}{d.stalled ? ' — unusually long; you can stop the request.' : ''}</div>
      {live && run.toolCallsTotal === 0 && run.phase !== 'starting' && <div style={{ fontSize: 13, color: 'var(--muted)' }}>No tool has been called in this request so far.</div>}
      {run.outcome === 'completed' && run.toolCallsTotal === 0 && <div style={{ fontSize: 13, color: 'var(--muted)' }}>The model answered directly; it called no tools.</div>}
      {steps.length > 0 && (
        <ol style={{ listStyle: 'none', margin: '4px 0 0', padding: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
          {steps.map((s) => {
            const act = s.invocationId ? byInv.get(s.invocationId) : undefined;
            const title = act?.title ?? s.label;
            const state = act ? (act.state === 'completed' ? 'ok' : act.state) : s.state;
            const stop = s.endedAt ?? (state === 'running' ? now : undefined);
            const err = state === 'failed' || state === 'cancelled' ? act?.detail : null;
            return (
              <li key={s.id}>
                <button type="button" disabled={!act} onClick={() => act && onSelect(act.id)} aria-current={act && selectedId === act.id ? 'true' : undefined}
                  style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 8, padding: '4px 6px', border: 0, borderRadius: 6, background: act && selectedId === act.id ? 'var(--raised)' : 'transparent', textAlign: 'left', fontSize: 13.5, cursor: act ? 'pointer' : 'default' }}>
                  <span className={`dot ${dotFor(state)}`} aria-hidden="true" style={state === 'ok' ? { background: 'var(--verified)' } : undefined} />
                  <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</span>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: state === 'failed' ? 'var(--danger)' : 'var(--muted)' }}>{[state === 'running' ? 'running' : state === 'ok' ? 'done' : state, stop != null ? elapsed(Math.max(0, stop - s.startedAt)) : ''].filter(Boolean).join(' · ')}</span>
                </button>
                {err && <div style={{ fontSize: 12.5, color: 'var(--danger)', padding: '0 6px 2px 24px', overflowWrap: 'anywhere' }}>{err}</div>}
                {tech && <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--muted)', padding: '0 6px 4px 24px', overflowWrap: 'anywhere' }}>{s.facts.join(' · ')}</div>}
              </li>
            );
          })}
        </ol>
      )}
      <button type="button" className="btn small" style={{ alignSelf: 'flex-start' }} aria-pressed={tech} onClick={onTech}>{tech ? 'Hide technical details' : 'Technical details'}</button>
    </section>
  );
}
