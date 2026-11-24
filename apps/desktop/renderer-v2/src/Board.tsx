import React, { useEffect, useRef, useState } from 'react';
import { api, errorText, onDesktopEvent, type QueuedCommand, type Snapshot, type TaskRow } from './bridge';
import { Icon, elapsed, timeOf } from './ui';
import { columnOf, needsYouCount as countNeeds, type Column } from './boardModel';

/** A worker task (Claude Code, OpenCode…) that failed or waits for review, as Core records it. */
export interface WorkerAttention {
  storyId: string; title: string; agent: string; state: 'failed' | 'awaiting_review'; reason: string; since: string;
  conversationId: string | null; timeline: Array<{ at: string; event: string; text: string }>; canRetry: boolean;
}

export interface Overview { data: { tasks: TaskRow[]; queued: QueuedCommand[]; workers?: WorkerAttention[] } | null; error: string | null; loadedAt: number | null; refresh: () => void }

/** Core's task overview, refreshed on Core events (coalesced) and every 5 s. */
export function useTaskOverview(): Overview {
  const [data, setData] = useState<Overview['data']>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  const pending = useRef(false);
  const refresh = () => {
    if (pending.current) return;
    pending.current = true;
    setTimeout(async () => {
      pending.current = false;
      try {
        // A failed worker task is told to its chat once; this is where it stays visible until someone acts on it.
        const [tasks, workers] = await Promise.all([
          api.getTaskOverview(),
          api.household('workerAttention').then((r) => ((r as { items?: WorkerAttention[] } | null)?.items ?? [])).catch(() => [] as WorkerAttention[]),
        ]);
        setData({ ...tasks, workers }); setError(null); setLoadedAt(Date.now());
      } catch (err) { setError(errorText(err)); }
    }, 120);
  };
  useEffect(() => {
    refresh();
    const off = onDesktopEvent((e) => { if (e.kind !== 'token') refresh(); });
    const t = setInterval(refresh, 5000);
    return () => { off(); clearInterval(t); };
  }, []);
  return { data, error, loadedAt, refresh };
}

export function needsYouCount(tasks: TaskRow[], snapshot: Snapshot | null): number {
  return countNeeds(tasks, Boolean(snapshot?.pendingApproval || snapshot?.pendingImageApproval || snapshot?.pendingWeatherApproval));
}

const COLUMNS: Array<{ id: Column; label: string }> = [
  { id: 'needs', label: 'Needs you' },
  { id: 'running', label: 'Running' },
  { id: 'queued', label: 'Queued' },
  { id: 'blocked', label: 'Blocked' },
  { id: 'completed', label: 'Completed' },
  { id: 'failed', label: 'Failed or stopped' },
];

function blockedReason(t: TaskRow): string {
  if (t.interrupted || ((t.status === 'running' || t.status === 'validating') && !t.live)) return 'The worker holding this task is gone; it is not making progress.';
  if (t.status === 'recovery_required') return 'Needs recovery before it can continue.';
  if (t.status === 'paused') return 'Paused.';
  return t.failureReason ?? 'Blocked.';
}

export function Board({ overview, narrow, onOpenPalette, onOpenConversation }: { overview: Overview; narrow: boolean; onOpenPalette: () => void; onOpenConversation: (id: string) => void }) {
  const [notes, setNotes] = useState<Record<string, string>>({});
  // While Core is not answering, the last read is history, not live state:
  // nothing may still claim to be running.
  const stale = Boolean(overview.error);
  const tasks = (overview.data?.tasks ?? []).map((t) => (stale ? { ...t, live: false, cancellable: false } : t));
  const queued = overview.data?.queued ?? [];
  const byCol = (c: Column) => tasks.filter((t) => columnOf(t) === c);

  const stop = async (t: TaskRow) => {
    try {
      const r = await api.cancelTask(t.attemptId);
      setNotes((n) => ({ ...n, [t.attemptId]: r.requested ? 'Stop requested — waiting for Core to confirm.' : 'Core says it can no longer be stopped.' }));
    } catch (err) { setNotes((n) => ({ ...n, [t.attemptId]: errorText(err) })); }
    overview.refresh();
  };
  const workers = overview.data?.workers ?? [];
  const retryWorker = async (w: WorkerAttention) => {
    setNotes((n) => ({ ...n, [w.storyId]: 'Retry requested…' }));
    try { await api.household('devStoryRetry', { storyId: w.storyId }); setNotes((n) => ({ ...n, [w.storyId]: 'Retry requested. If it fails again it comes back here with the new reason.' })); }
    catch (err) { setNotes((n) => ({ ...n, [w.storyId]: `Retry did not start: ${errorText(err)}` })); }
    overview.refresh();
  };
  const resume = async (t: TaskRow) => {
    try { await api.resumeTask(t.attemptId); setNotes((n) => ({ ...n, [t.attemptId]: 'Resume requested.' })); } catch (err) { setNotes((n) => ({ ...n, [t.attemptId]: errorText(err) })); }
    overview.refresh();
  };

  return (
    <>
      <div className="topbar">
        <span className="title" style={{ color: 'var(--ink)', fontWeight: 600 }}>Board</span>
        <span className="grow" />
        <button type="button" className="search-btn" title="Search everything (Ctrl K)" onClick={onOpenPalette}><Icon name="search" size={16} /><span>Search</span>{!narrow && <kbd>Ctrl K</kbd>}</button>
      </div>
      <div className="board">
        <div className="board-head">
          <span className="muted">From Core task records{overview.loadedAt ? ` · updated ${timeOf(new Date(overview.loadedAt).toISOString())}` : ''}. Running means a worker holds the task right now.</span>
        </div>
        {overview.error && <div className="notice error" role="alert" style={{ marginBottom: 12 }}>Could not read tasks from Core: {overview.error} Showing the last known state; nothing below is confirmed as running.</div>}
        {!overview.data && !overview.error && <div className="notice" role="status">Reading tasks from Core…</div>}
        {overview.data && (
          <div className="columns">
            {COLUMNS.map((c) => {
              const items = byCol(c.id);
              const extra = c.id === 'queued' ? queued : [];
              const waiting = c.id === 'needs' ? workers : [];
              return (
                <section key={c.id} className="column" aria-label={c.label}>
                  <h2>{c.label} <span className="count">{items.length + extra.length + waiting.length}</span></h2>
                  {items.length + extra.length + waiting.length === 0 && <div className="empty">None</div>}
                  {waiting.map((w) => (
                    <article key={w.storyId} className="card needs-you" data-story-id={w.storyId} data-status={w.state}>
                      <span className="title">{w.title || 'Worker task'}</span>
                      <span className="meta"><span>{w.agent} worker</span><span>· {w.state === 'failed' ? 'stopped and needs you since' : 'waiting for your review since'} {timeOf(w.since)} {new Date(w.since).toLocaleDateString()}</span></span>
                      <span className="failure">{w.reason}</span>
                      {w.timeline.length > 0 && (
                        <details>
                          <summary className="meta">What happened ({w.timeline.length} recorded events)</summary>
                          {w.timeline.map((e, i) => <span key={i} className="evidence" style={{ display: 'block' }}>{timeOf(e.at)} · {e.event.replace(/-/g, ' ')}{e.text ? `: ${e.text}` : ''}</span>)}
                        </details>
                      )}
                      {notes[w.storyId] && <span className="meta" role="status">{notes[w.storyId]}</span>}
                      <div className="actions">
                        {w.canRetry && w.state === 'failed' && <button type="button" className="btn small" onClick={() => void retryWorker(w)}>Retry</button>}
                        {w.conversationId && <button type="button" className="btn small" onClick={() => onOpenConversation(w.conversationId!)}>{w.state === 'failed' ? 'Open chat' : 'Review in chat'}</button>}
                      </div>
                    </article>
                  ))}
                  {items.map((t) => (
                    <article key={t.attemptId} className={`card${c.id === 'needs' ? ' needs-you' : ''}`} data-attempt-id={t.attemptId} data-status={t.status}>
                      <span className="title">{t.title || 'Untitled task'}</span>
                      <span className="meta">
                        <span>{t.worker}</span>
                        {t.model && <span>· {t.model}</span>}
                        <span>· {c.id === 'running' ? `running ${elapsed(t.elapsedMs)}` : c.id === 'completed' || c.id === 'failed' ? `${t.status} ${timeOf(t.completedAt)}` : `since ${timeOf(t.createdAt)}`}</span>
                      </span>
                      {t.activity && !(t.failureReason && t.failureReason.startsWith(t.activity.slice(0, 40))) && t.activity.toLowerCase() !== t.status && <span className="evidence">{t.activity}{t.lastEventAt ? ` · ${timeOf(t.lastEventAt)}` : ''}</span>}
                      {c.id === 'blocked' && <span className="failure">{stale && ['running', 'validating', 'cancelling'].includes(t.status) ? `Core is not answering — last seen running at ${timeOf(overview.loadedAt ? new Date(overview.loadedAt).toISOString() : null)}. Status unknown until it reconnects.` : blockedReason(t)}</span>}
                      {c.id === 'failed' && t.failureReason && <span className="failure">{t.failureReason}</span>}
                      {notes[t.attemptId] && <span className="meta" role="status">{notes[t.attemptId]}</span>}
                      <div className="actions">
                        {t.conversationId && <button type="button" className="btn small" onClick={() => onOpenConversation(t.conversationId!)}>{c.id === 'needs' ? 'Review in chat' : 'Open chat'}</button>}
                        {t.cancellable && !t.cancelRequestedAt && <button type="button" className="btn small" onClick={() => void stop(t)}>Stop</button>}
                        {t.cancelRequestedAt && c.id !== 'failed' && <span className="meta">Stop requested {timeOf(t.cancelRequestedAt)}</span>}
                        {(t.resumable || t.status === 'recovery_required' || t.interrupted) && <button type="button" className="btn small" onClick={() => void resume(t)}>Resume</button>}
                      </div>
                    </article>
                  ))}
                  {extra.map((q) => (
                    <article key={q.id} className="card" data-command-id={q.id}>
                      <span className="title">{String(q.instruction ?? q.title ?? 'Queued command')}</span>
                      <span className="meta">Command queue{q.state ? ` · ${String(q.state)}` : ''}</span>
                    </article>
                  ))}
                </section>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}
