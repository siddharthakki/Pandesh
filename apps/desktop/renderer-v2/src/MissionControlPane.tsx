import React, { useEffect, useState } from 'react';
import { api, errorText } from './bridge';
import { elapsed } from './ui';
import { missionHeadline, missionProgress, describeStep } from './missionModel';
import type { MissionView, StepView } from './missionModel';
import type { BridgeActivityItem } from './Missions';
import { changeCounts, changeFlag, changeStatusLabel, changeSummary, eventAge, eventLabel, groupWorkers, workerControls, type ChangeDiffView, type WorkerEvent } from './workerModel';
import { DiffView } from './Activity';

const DONE = new Set(['completed', 'failed', 'cancelled']);

/**
 * Live panels for Kandev workers (Claude Code, OpenCode), grouped by agent. Every line is an event Kandev recorded from the worker:
 * nothing here is simulated or paraphrased. "Running" is never shown without the newest event and its age; a worker that has
 * been silent for a minute says so. Worker actions held for a person are answered here (Core accepts that from this window only).
 */
export function WorkerPanels({ items, now, onChanged }: { items: BridgeActivityItem[]; now: number; onChanged: () => void }) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [diffOpen, setDiffOpen] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ id: string; text: string; error?: boolean } | null>(null);
  const groups = groupWorkers(items);
  if (!groups.length) return null;
  const decide = async (b: BridgeActivityItem, pendingId: string, allow: boolean) => {
    setBusy(pendingId);
    setNote(null);
    try {
      await api.household('devStoryPermission', { storyId: b.storyId, pendingId, allow });
      setNote({ id: b.id, text: allow ? 'Allowed once. The worker continues.' : 'Not allowed. The worker was told no.' });
      onChanged();
    } catch (err) { setNote({ id: b.id, text: `Not recorded: ${errorText(err)}`, error: true }); }
    finally { setBusy(null); }
  };
  /** A5: approve the reviewed change (KKD commits it to a branch in the private copy), or bring an approved one into the checkout. */
  const changeAction = async (b: BridgeActivityItem, action: 'bridgeApproveChange' | 'bridgeRejectChange' | 'bridgeDeliver') => {
    setBusy(`${b.id}:${action}`);
    setNote(null);
    try {
      const r = await api.household(action, { id: b.id }) as { delivered?: { branch: string } };
      setNote({ id: b.id, text: action === 'bridgeApproveChange' ? 'Approved. Pandesh is committing the change to a branch in the private copy and checking it again.' : action === 'bridgeRejectChange' ? 'Not approved. Nothing was committed or delivered.' : `In your checkout as branch ${r.delivered?.branch ?? ''}: not checked out, not merged, not pushed.` });
      onChanged();
    } catch (err) { setNote({ id: b.id, text: errorText(err), error: true }); }
    finally { setBusy(null); }
  };
  /** Stop ends the task (nothing else runs in its place); Pause keeps the worktree for Resume. Core decides what is allowed. */
  const control = async (b: BridgeActivityItem, action: 'bridgeCancel' | 'bridgePause' | 'bridgeResume') => {
    setBusy(`${b.id}:${action}`);
    setNote(null);
    try {
      await api.household(action, { id: b.id });
      setNote({ id: b.id, text: action === 'bridgeCancel' ? 'Stopped. The work done so far is kept in its worktree.' : action === 'bridgePause' ? 'Paused. Resume continues from the preserved work.' : 'Resuming.' });
      onChanged();
    } catch (err) { setNote({ id: b.id, text: errorText(err), error: true }); }
    finally { setBusy(null); }
  };
  return (
    <div className="worker-panels" aria-label="Agent workers">
      {groups.map((g) => (
        <div key={g.agent} className="worker-group">
          <div className="worker-group-head">{g.label} · {g.items.filter((b) => !DONE.has(b.state)).length} active</div>
          {g.items.map((b) => {
            const age = eventAge(b, now);
            const live = !DONE.has(b.state);
            return (
              <section key={b.id} className={`mission bridge worker ${b.state}`} aria-label={`${g.label}: ${b.instruction}`}>
                <header className="mission-head">
                  <span className="mission-toggle">
                    <span className={`dot ${b.state === 'failed' || b.state === 'stalled' ? 'danger' : b.state === 'completed' ? 'done' : b.state === 'running' && !age.quiet ? 'live' : 'attention'}`} aria-hidden="true" />
                    <span className="mission-title"><strong>{g.label} · {b.stateLabel}</strong><span className="mission-objective">{b.instruction}</span></span>
                  </span>
                  <span className="mission-meta">{b.elapsedMs !== null && live ? `active ${elapsed(b.elapsedMs)}` : ''}</span>
                </header>
                <div className="mission-body">
                  {b.branch && <p className="worker-age" data-testid="worker-branch">Branch {b.branch} · isolated worktree</p>}
                  <p className="worker-latest" data-testid="worker-latest">
                    {b.latest ? <><span className="worker-kind">{eventLabel(b.latest.kind)}</span> {b.latest.text}</> : <span className="muted">No worker event recorded yet.</span>}
                  </p>
                  <p className={`worker-age${age.quiet && live ? ' attention' : ''}`} data-testid="worker-age">{age.text}</p>
                  <p className="mission-summary">{workerOutcome(b)}</p>
                  {b.pendingWorkerActions.map((p) => (
                    <div key={p.pendingId} className="approval worker-action" role="group" aria-label={`The worker asks to: ${p.what}`}>
                      <div className="head"><span className="dot attention" aria-hidden="true" /><span style={{ fontWeight: 600 }}>The worker asks to:</span> <code>{p.what}</code></div>
                      <div className="btns">
                        <button type="button" className="btn primary small" disabled={busy === p.pendingId} onClick={() => void decide(b, p.pendingId, true)}>Allow once</button>
                        <button type="button" className="btn small" disabled={busy === p.pendingId} onClick={() => void decide(b, p.pendingId, false)}>Don't allow</button>
                      </div>
                    </div>
                  ))}
                  {b.codeChange?.awaitingReview && (
                    <div className="approval worker-action" role="group" aria-label={`Review the change to ${b.codeChange.project}`}>
                      <div className="head"><span className="dot attention" aria-hidden="true" /><span style={{ fontWeight: 600 }}>Review the change to {b.codeChange.project} ({b.codeChange.baseRef})</span></div>
                      <div style={{ fontSize: 13 }}>Changed {b.codeChange.changedFiles.length} file{b.codeChange.changedFiles.length === 1 ? '' : 's'}: <code>{b.codeChange.changedFiles.join(', ') || 'none recorded'}</code>. The execution log below shows what the worker did and ran.</div>
                      <ChangeReview taskId={b.id} refreshKey={b.eventCount} open={diffOpen[b.id] === true} onToggle={() => setDiffOpen({ ...diffOpen, [b.id]: !diffOpen[b.id] })} />
                      <div className="btns">
                        <button type="button" className="btn primary small" disabled={busy === `${b.id}:bridgeApproveChange`} onClick={() => void changeAction(b, 'bridgeApproveChange')}>Approve change</button>
                        <button type="button" className="btn small" disabled={busy === `${b.id}:bridgeRejectChange`} onClick={() => void changeAction(b, 'bridgeRejectChange')}>Don't approve</button>
                      </div>
                    </div>
                  )}
                  {b.codeChange?.deliverable && (
                    <div className="worker-controls" role="group" aria-label="Deliver the change">
                      <button type="button" className="btn small" disabled={busy === `${b.id}:bridgeDeliver`} onClick={() => void changeAction(b, 'bridgeDeliver')}>Bring into my checkout as a new branch</button>
                    </div>
                  )}
                  {b.codeChange?.delivered && <p className="worker-age" data-testid="worker-delivered">In your checkout as branch <code>{b.codeChange.delivered.branch}</code> ({b.codeChange.delivered.commit.slice(0, 8)}): not checked out, not merged, not pushed.</p>}
                  {b.codeChange && !b.codeChange.awaitingReview && (b.codeChange.deliverable || b.codeChange.delivered) && (
                    <ChangeReview taskId={b.id} refreshKey={b.eventCount} open={diffOpen[b.id] === true} onToggle={() => setDiffOpen({ ...diffOpen, [b.id]: !diffOpen[b.id] })} />
                  )}
                  {note?.id === b.id && <p className={`mission-note${note.error ? ' error' : ''}`} role={note.error ? 'alert' : 'status'}>{note.text}</p>}
                  {live && (
                    <div className="worker-controls" role="group" aria-label="Worker controls">
                      {workerControls(b).map((c) => (
                        <button key={c.action} type="button" className="btn small" disabled={busy === `${b.id}:${c.action}`} onClick={() => void control(b, c.action)}>{c.label}</button>
                      ))}
                    </div>
                  )}
                  <button type="button" className="btn link small" aria-expanded={open[b.id] === true} onClick={() => setOpen({ ...open, [b.id]: !open[b.id] })}>
                    {open[b.id] ? 'Hide execution log' : `Show full execution log (${b.eventCount} event${b.eventCount === 1 ? '' : 's'})`}
                  </button>
                  {open[b.id] && <WorkerLog taskId={b.id} eventCount={b.eventCount} />}
                </div>
              </section>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/** What the panel says about the result: exactly what was checked, never "verified" for a worker's own report. */
function workerOutcome(b: BridgeActivityItem): string {
  // Core's own account of the requested outcome (code changed and approved, inspection only, made no change, failed a check…).
  if (b.outcome && b.outcome.state !== 'worker_running') return b.outcome.summary;
  if (b.state === 'completed' && b.verification === 'worker-only') return 'Finished. Pandesh checked that no file changed; the result is the worker’s own report, not independently verified.';
  if (b.state === 'completed' && b.verification === 'independent') return 'Finished and verified independently by Pandesh.';
  if (b.state === 'completed' && b.verification === 'human-reviewed') return 'Finished and reviewed by a person.';
  return b.reason;
}

interface ChangeTests { pandesh: { level: string | null; detail: string | null }; worker: Array<{ command: string; status: string; at: string }>; workerSummary: string | null }

/**
 * A5 "View diff": the change as Git sees it, read by Core from the authorized worktree or private copy (host only). Shows the
 * summary, every file with its status and counts, binary / large / unavailable flags, and the test results with who ran them.
 * Viewing approves nothing; the Approve button stays the only way to approve.
 */
function ChangeReview({ taskId, refreshKey, open, onToggle }: { taskId: string; refreshKey: number; open: boolean; onToggle: () => void }) {
  const [data, setData] = useState<{ diff: ChangeDiffView; tests: ChangeTests } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  useEffect(() => {
    if (!open) return;
    let alive = true;
    void (async () => {
      try {
        const r = await api.household('bridgeDiff', { id: taskId }) as { diff: ChangeDiffView; tests: ChangeTests };
        if (alive) { setData(r); setError(null); }
      } catch (err) { if (alive) setError(errorText(err)); }
    })();
    return () => { alive = false; };
  }, [taskId, refreshKey, open]);
  const files = data?.diff.files ?? [];
  const allOpen = files.length > 0 && files.every((f) => expanded[f.path]);
  return (
    <div className="change-review" data-testid="change-review">
      <button type="button" className="btn link small" aria-expanded={open} onClick={onToggle}>{open ? 'Hide diff' : 'View diff'}</button>
      {open && error && <p className="mission-note error" role="alert">Diff not loaded: {error}</p>}
      {open && !error && !data && <p className="muted">Loading the diff…</p>}
      {open && data && (
        <>
          <p className="change-summary" data-testid="change-summary">{changeSummary(data.diff)}</p>
          <div className="change-tests" data-testid="change-tests">
            <div><strong>Pandesh's check:</strong> {data.tests.pandesh.detail ?? 'none recorded yet'}{data.tests.pandesh.level ? ` (${data.tests.pandesh.level})` : ''}</div>
            {data.tests.worker.length
              ? data.tests.worker.map((t, i) => <div key={i}><strong>Worker ran:</strong> <code>{t.command}</code> · {t.status} <span className="muted">(reported by the worker, not re-run by Pandesh)</span></div>)
              : <div><strong>Worker ran:</strong> <span className="muted">no test command recorded</span></div>}
            {data.tests.workerSummary && <div className="muted">Worker's report: {data.tests.workerSummary}</div>}
          </div>
          {files.length > 0 && (
            <button type="button" className="btn link small" onClick={() => setExpanded(Object.fromEntries(files.map((f) => [f.path, !allOpen])))}>{allOpen ? 'Collapse all' : 'Expand full diff'}</button>
          )}
          <ul className="change-files" aria-label="Changed files">
            {files.map((f) => {
              const flag = changeFlag(f);
              const isOpen = expanded[f.path] === true;
              return (
                <li key={f.path} className="change-file">
                  <button type="button" className="change-file-head" aria-expanded={isOpen} onClick={() => setExpanded({ ...expanded, [f.path]: !isOpen })}>
                    <span className={`change-status ${f.status}`}>{changeStatusLabel(f.status)}</span>
                    <code>{f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}</code>
                    <span className="change-counts"><span className="tl-add">{f.binary ? '' : `+${f.additions ?? '?'}`}</span> <span className="tl-del">{f.binary ? '' : `−${f.deletions ?? '?'}`}</span>{f.binary ? changeCounts(f) : ''}</span>
                    {flag && <span className={`change-flag ${flag.kind}`}>{flag.text}</span>}
                  </button>
                  {isOpen && f.note && <p className="muted change-note">{f.note}</p>}
                  {isOpen && f.patch !== null && <div className="change-diff"><DiffView diff={f.patch} /></div>}
                </li>
              );
            })}
          </ul>
          {data.diff.ignored.length > 0 && <p className="muted">Not part of the change (the agent's own settings): {data.diff.ignored.join(', ')}</p>}
        </>
      )}
    </div>
  );
}

/** The recorded event log of one task, read from Core when opened and again whenever a new event is recorded. */
function WorkerLog({ taskId, eventCount }: { taskId: string; eventCount: number }) {
  const [events, setEvents] = useState<WorkerEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const r = await api.household('bridgeTask', { id: taskId }) as { result?: { activity?: WorkerEvent[] } | null };
        if (alive) { setEvents(r.result?.activity ?? []); setError(null); }
      } catch (err) { if (alive) setError(errorText(err)); }
    })();
    return () => { alive = false; };
  }, [taskId, eventCount]);
  if (error) return <p className="mission-note error" role="alert">{error}</p>;
  if (!events) return <p className="muted">Loading the log…</p>;
  if (!events.length) return <p className="muted">No worker events recorded.</p>;
  return (
    <ol className="worker-log" aria-label="Execution log">
      {events.map((e, i) => (
        <li key={e.id ?? i}><time dateTime={e.at}>{new Date(e.at).toLocaleTimeString()}</time> <span className="worker-kind">{eventLabel(e.kind)}</span> {e.text}</li>
      ))}
    </ol>
  );
}

interface Props {
  mission: MissionView;
  onPause?: () => void;
  onStop?: () => void;
  onTakeControl?: () => void;
  onExpandActivity?: () => void;
  onInspectEvidence?: () => void;
  onAllow?: (approvalId: string) => void;
  onDeny?: (approvalId: string) => void;
}

export function MissionControlPane({ mission, onPause, onStop, onTakeControl, onExpandActivity, onInspectEvidence, onAllow, onDeny }: Props) {
  const prog = missionProgress(mission);
  const running = mission.status === 'running';
  return (
    <div className="mission-control">
      <div className="h3" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <span className={`dot ${running ? 'running' : mission.status === 'completed' ? 'verified' : mission.status === 'failed' ? 'failed' : 'paused'}`}></span>
        <span style={{ flex: 1 }}>{mission.objective}</span>
        <span className="muted" style={{ fontSize: '11px', fontFamily: 'var(--font-mono)' }}>{prog.done}/{prog.total}</span>
      </div>
      <div className="progress"><div style={{ width: `${prog.percent}%` }}></div></div>
      <div className="muted" style={{ fontSize: '11px', marginTop: '4px', fontFamily: 'var(--font-mono)' }}>
        {mission.status} · {mission.liveActivity ? `${mission.liveActivity.tool} · ${mission.liveActivity.status}` : 'no live activity'}
      </div>

      <div className="timeline" style={{ marginTop: '10px' }}>
        {mission.steps.map((s) => (
          <div className="step" key={s.id}>
            <div className={`agent ${s.kind === 'review' ? 'reviewer' : 'lead'}`}>{s.agentId.slice(0, 2).toUpperCase()}</div>
            <div>
              <div className="title">{s.title}</div>
              <div className="meta">
                {s.agentId} · {describeStep(s, mission, Date.now()).state} — {describeStep(s, mission, Date.now()).sub}
                {s.evidence && s.evidence.verified.length > 0 && (
                  <span> · {s.evidence.verified.map((v) => `${v.tool}×${v.count}`).join(', ')}</span>
                )}
                {s.evidence && s.evidence.unbacked.length > 0 && (
                  <span style={{ color: 'var(--attention)' }}> · not verified: {s.evidence.unbacked.join(', ')}</span>
                )}
              </div>
              {s.artifacts && s.artifacts.length > 0 && (
                <div className="artifacts" style={{ marginTop: '4px' }}>
                  {s.artifacts.map((a, i) => <span className="artifact" key={i}>{a.kind} {a.path.split(/[\\/]/).pop()}</span>)}
                </div>
              )}
            </div>
            <div className={`dot ${s.status === 'succeeded' ? 'verified' : s.status === 'failed' ? 'failed' : s.status === 'running' ? 'running' : 'paused'}`} style={{ marginTop: '6px' }}></div>
          </div>
        ))}
      </div>

      {mission.pendingApprovals.length > 0 && (
        <div style={{ marginTop: '10px' }}>
          {mission.pendingApprovals.map((a) => (
            <div className="approval" key={a.approvalId} style={{ marginBottom: '8px' }}>
              <div className="head"><span className="dot attention"></span><span style={{ fontWeight: 600 }}>Needs your OK · {a.agentName ?? a.toolName}</span></div>
              <div style={{ fontSize: '12px', marginBottom: '6px' }}>{a.text}</div>
              <div className="btns">
                <button className="btn btn-primary" onClick={() => onAllow?.(a.approvalId)}>Allow</button>
                <button className="btn btn-ghost" onClick={() => onDeny?.(a.approvalId)}>Don't allow</button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', gap: '6px', marginTop: '12px', flexWrap: 'wrap' }}>
        {running && <button className="btn btn-ghost" onClick={onPause}>⏸ Pause</button>}
        {running && <button className="btn btn-ghost" onClick={onStop}>⏹ Stop</button>}
        <button className="btn btn-ghost" onClick={onTakeControl}>👁 Take control</button>
        <button className="btn btn-ghost" onClick={onExpandActivity}>Expand activity</button>
        <button className="btn btn-ghost" onClick={onInspectEvidence}>Inspect evidence</button>
      </div>
      <div className="muted" style={{ fontSize: '10px', marginTop: '8px', fontFamily: 'var(--font-mono)' }}>
        {mission.workspaceRoot ? `Workspace: ${mission.workspaceRoot}` : 'No workspace'} · {mission.agentNames ? Object.keys(mission.agentNames).length : 0} agents
      </div>
    </div>
  );
}