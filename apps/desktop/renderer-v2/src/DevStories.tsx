import React, { useEffect, useState } from 'react';
import { api, errorText, type DevStories as DevStoriesData, type DevStory } from './bridge';

/**
 * Development stories run by Kandev workers. A worker that wants to run something waits for a person: the banner shows
 * every held request on every view (Allow once / Deny), and the Projects space lists each story with its real state.
 */
const supported = () => typeof (api as Partial<typeof api>).getDevStories === 'function';

/** Every held worker request, oldest story first. */
export function pendingWorkerRequests(data: DevStoriesData | null): Array<{ story: DevStory; pendingId: string; what: string }> {
  const out: Array<{ story: DevStory; pendingId: string; what: string }> = [];
  for (const s of data?.stories ?? []) for (const p of s.pendingApprovals ?? []) out.push({ story: s, pendingId: p.pendingId, what: p.what });
  return out;
}

function useDevStories(intervalMs: number): { data: DevStoriesData | null; reload: () => void } {
  const [data, setData] = useState<DevStoriesData | null>(null);
  const reload = () => { if (supported()) api.getDevStories().then(setData).catch(() => setData(null)); };
  useEffect(() => {
    reload();
    const t = setInterval(() => { if (!document.hidden) reload(); }, intervalMs);
    return () => clearInterval(t);
  }, []);
  return { data, reload };
}

export function WorkerApprovalsBanner() {
  const { data, reload } = useDevStories(4000);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const pending = pendingWorkerRequests(data);
  if (!pending.length && !error) return null;
  const decide = async (storyId: string, pendingId: string, allow: boolean) => {
    setBusy(pendingId); setError('');
    try { await api.decideDevStoryPermission(storyId, pendingId, allow); } catch (err) { setError(errorText(err)); } finally { setBusy(null); reload(); }
  };
  return (
    <div className="worker-banner" role="region" aria-label="Worker requests waiting for you">
      {pending.map(({ story, pendingId, what }) => (
        <div key={pendingId} className="worker-request">
          <span className="dot attention" aria-hidden="true" />
          <span style={{ flex: '1 1 220px', minWidth: 0 }}>
            <span>{String(story.title || '').split(' · ')[0]} worker wants to run:</span>{' '}
            <code style={{ overflowWrap: 'anywhere' }}>{what}</code>
          </span>
          <button type="button" className="btn small primary" disabled={busy === pendingId} onClick={() => void decide(story.id, pendingId, true)}>Allow once</button>
          <button type="button" className="btn small" disabled={busy === pendingId} onClick={() => void decide(story.id, pendingId, false)}>Deny</button>
        </div>
      ))}
      {error && <div className="notice error" role="alert" style={{ margin: 0 }}>{error}</div>}
    </div>
  );
}

const COUNT_LABELS: Array<[string, string]> = [['running', 'running'], ['completed', 'completed'], ['ready', 'ready'], ['waiting', 'waiting'], ['verifying', 'verifying'], ['blocked', 'blocked'], ['review', 'awaiting your review'], ['approval', 'waiting for approval']];
const PROOF: Record<string, string> = { independent: 'independently verified', 'human-reviewed': 'reviewed by you', 'worker-only': 'worker tests only' };
const when = (iso?: string) => (iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');

export function DevStoriesPanel() {
  const { data, reload } = useDevStories(6000);
  const [note, setNote] = useState<{ text: string; error?: boolean } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [showEvidence, setShowEvidence] = useState<string | null>(null);
  const stories = data?.stories ?? [];
  if (!supported() || stories.length === 0) return null;
  const act = async (key: string, work: () => Promise<unknown>, done?: (r: unknown) => string) => {
    setBusy(key); setNote(null);
    try { const r = await work(); if (done) setNote({ text: done(r) }); } catch (err) { setNote({ text: errorText(err), error: true }); } finally { setBusy(null); reload(); }
  };
  const c = data?.counts ?? {};
  const counts = COUNT_LABELS.filter(([k]) => (c[k] ?? 0) > 0).map(([k, label]) => `${c[k]} ${label}`).join(' · ');
  const live = stories.some((s) => !['done', 'ready', 'blocked'].includes(s.status));
  return (
    <section aria-label="Development stories" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0, fontSize: 15 }}>Development stories ({stories.length})</h2>
        <span className="meta">{data?.available ? '' : 'Kandev is not running · '}{counts}</span>
        <span className="grow" />
        {live && <button type="button" className="btn small" disabled={busy === 'stop'} onClick={() => void act('stop', () => api.stopAllDevStories(), (r) => { const x = r as { stopped: string[]; stillRunning: string[] }; return `Stopped ${x.stopped.length} stories${x.stillRunning.length ? ` · ${x.stillRunning.length} worker(s) still running` : ' · no worker running'}.`; })}>{busy === 'stop' ? 'Stopping…' : 'Stop all'}</button>}
      </div>
      {note && <div className={`notice${note.error ? ' error' : ''}`} role={note.error ? 'alert' : 'status'} style={{ margin: 0, maxWidth: 'none' }}>{note.text}</div>}
      {stories.map((s) => {
        const detail = [s.waitingReason, s.dependsOn?.length ? `depends on ${s.dependsOn.join(', ')}` : null, s.commit ? `commit ${s.commit}` : s.branch ? `branch ${s.branch}` : null].filter(Boolean).join(' · ');
        return (
          <div key={s.id} className={`card${s.pendingApprovals?.length || s.status === 'delivery_approval' ? ' needs-you' : ''}`}>
            <span className="title">{s.title}</span>
            <span className="meta">{[s.agent, s.status === 'done' ? 'completed' : s.phase, PROOF[s.verification ?? ''], s.updatedAt ? `updated ${when(s.updatedAt)}` : null].filter(Boolean).join(' · ')}</span>
            {detail && <span className="meta">{detail}</span>}
            {s.activity?.length ? (
              <div className="meta" style={{ display: 'flex', flexDirection: 'column', gap: 2, fontFamily: 'var(--font-mono)', fontSize: 12.5 }}>
                {s.activity.map((a, i) => <span key={i}>{new Date(a.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })} · {a.kind === 'message' ? 'says' : a.kind} · {a.text}</span>)}
              </div>
            ) : null}
            {s.pendingApprovals?.map((p) => (
              <div key={p.pendingId} className="actions" style={{ alignItems: 'center' }}>
                <code style={{ flex: '1 1 200px', overflowWrap: 'anywhere' }}>{p.what}</code>
                <button type="button" className="btn small primary" disabled={busy === p.pendingId} onClick={() => void act(p.pendingId, () => api.decideDevStoryPermission(s.id, p.pendingId, true))}>Allow once</button>
                <button type="button" className="btn small" disabled={busy === p.pendingId} onClick={() => void act(p.pendingId, () => api.decideDevStoryPermission(s.id, p.pendingId, false))}>Deny</button>
              </div>
            ))}
            <div className="actions">
              {s.status === 'delivery_approval' && <button type="button" className="btn small primary" disabled={busy === `a:${s.id}`} onClick={() => void act(`a:${s.id}`, () => api.approveDevStoryReview(s.id), () => 'Approved after your review.')}>Approve after review</button>}
              {(s.status === 'blocked' || s.status === 'implementing') && s.branch && (
                <button type="button" className="btn small" disabled={busy === `v:${s.id}`} title="Stops the worker for good, runs the normal checks on the work in its worktree, and integrates it only if every check passes. No worker is started."
                  onClick={() => { if (window.confirm(`Verify the existing work for “${s.title}”? The worker is stopped (not restarted) and its worktree is checked and, if everything passes, integrated.`)) void act(`v:${s.id}`, () => api.verifyExistingDevStory(s.id), (r) => { const x = r as { outcome: string; reason: string | null; commit: string | null }; return `Verification: ${x.outcome}${x.commit ? ` · commit ${x.commit}` : ''}${x.reason ? ` · ${x.reason}` : ''}`; }); }}>Verify existing work</button>
              )}
              {(s.status === 'blocked' || s.status === 'delivery_approval') && <button type="button" className="btn small" disabled={busy === `r:${s.id}`} onClick={() => void act(`r:${s.id}`, () => api.retryDevStory(s.id), () => (s.phase === 'stopped' ? 'Resumed.' : 'Retrying.'))}>{s.phase === 'stopped' ? 'Resume' : 'Retry'}</button>}
              {s.evidence && <button type="button" className="btn link" aria-expanded={showEvidence === s.id} onClick={() => setShowEvidence(showEvidence === s.id ? null : s.id)}>{showEvidence === s.id ? 'Hide evidence' : 'Evidence'}</button>}
            </div>
            {showEvidence === s.id && s.evidence && <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontSize: 12.5, maxHeight: 280, overflow: 'auto' }}>{s.evidence}</pre>}
          </div>
        );
      })}
    </section>
  );
}
