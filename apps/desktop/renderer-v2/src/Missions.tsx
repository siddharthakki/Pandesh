import React, { useEffect, useRef, useState } from 'react';
import { api, errorText, onDesktopEvent } from './bridge';
import { elapsed } from './ui';
import { describeStep, missionActiveMs, missionHeadline, missionHeartbeatMs, missionProgress, visibleMissions, type MissionView, type StepView } from './missionModel';

/** One task relayed from the browser (Panda bridge), as Core's activity feed reports it. Same vocabulary as missions. */
export interface BridgeActivityItem {
  id: string; origin: { kind?: string; client: string; title: string | null; via: string | null }; instruction: string; executor: string | null;
  state: string; stateLabel: string; reason: string; progress: string | null; elapsedMs: number | null; heartbeatAgeMs: number | null;
  verification: string | null; conversationId: string | null; createdAt: string;
}
const BRIDGE_DONE = new Set(['completed', 'failed', 'cancelled']);

/** A cloud agent the browser asked for, waiting for the owner. Everything the owner needs to decide is here, from Core's own record. */
export interface BridgeApproval {
  requestId: string; taskId: string; executor: string; agentLabel: string; provider: string; model: string | null;
  project: { name: string; branch: string; commit: string; access: string; uncommittedFiles: number } | null;
  accessLevel: string; exposure: string[]; instruction: string; sensitivity: 'normal' | 'confidential'; sensitivityReasons: string[];
  includeContext: boolean; requestedBy: string; requestedAt: string; expiresAt: string;
}

/**
 * Missions in the conversation: background work Core is running (or ran) for this chat, shown where the person is
 * talking. One card per mission: which specialist is on which step, the tool it is running right now, what needs the
 * person's OK, the files it left, and Stop / Continue. Everything shown is Core's record (GET /v1/missions); the card
 * never shows an agent's own words as a status.
 */
export function MissionDock({ conversationId, narrow, onReport }: { conversationId: string | null; narrow: boolean; onReport: (missionId?: string) => void }) {
  const [missions, setMissions] = useState<MissionView[]>([]);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [hidden, setHidden] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ id: string; text: string; error?: boolean } | null>(null);
  const [now, setNow] = useState(Date.now());
  const [bridge, setBridge] = useState<BridgeActivityItem[]>([]);
  const [approvals, setApprovals] = useState<BridgeApproval[]>([]);
  const [override, setOverride] = useState<Record<string, boolean>>({});
  const lastStatus = useRef<Record<string, string>>({});

  const load = async () => {
    try {
      const r = await api.household('missions', { conversationId: conversationId ?? undefined }) as { missions: MissionView[] };
      const list = r.missions ?? [];
      // A mission that just ended has written its report into the conversation: show it.
      for (const m of list) {
        const before = lastStatus.current[m.id];
        if (before === 'running' && m.status !== 'running' && m.conversationId === conversationId) onReport(m.id);
        lastStatus.current[m.id] = m.status;
      }
      setMissions(list);
    } catch { /* Core is restarting; the next tick reads it again */ }
    try {
      const b = await api.household('bridgeActivity') as { items: BridgeActivityItem[] };
      setBridge(b.items ?? []);
    } catch { /* an older Core has no activity feed; the missions above still show */ }
    try {
      const a = await api.household('bridgeApprovals') as { approvals: BridgeApproval[] };
      setApprovals(a.approvals ?? []);
    } catch { /* an older Core has no approvals; nothing is waiting */ }
  };

  /** The owner's decision. Allow starts exactly this agent for exactly this task; Don't allow ends the task and nothing else runs in its place. */
  const decideApproval = async (a: BridgeApproval, decision: 'approve' | 'refuse') => {
    setBusy(a.requestId);
    setNote(null);
    try {
      await api.household('bridgeApprove', { id: a.taskId, requestId: a.requestId, decision, confidentialOverride: override[a.requestId] === true });
      setNote({ id: a.taskId, text: decision === 'approve' ? `Allowed. ${a.agentLabel} is starting on this task only.` : `Not allowed. Nothing was sent to ${a.agentLabel} and the task was stopped.` });
      await load();
    } catch (err) { setNote({ id: a.taskId, text: `Not recorded: ${errorText(err)}`, error: true }); await load(); }
    finally { setBusy(null); }
  };

  const anyRunning = missions.some((m) => m.status === 'running') || bridge.some((b) => !BRIDGE_DONE.has(b.state));
  useEffect(() => { void load(); }, [conversationId]);
  useEffect(() => {
    const t = setInterval(() => { setNow(Date.now()); void load(); }, anyRunning ? 2000 : 15000);
    return () => clearInterval(t);
  }, [anyRunning, conversationId]);
  useEffect(() => onDesktopEvent((e) => { if (e.kind === 'result' || e.kind === 'conversation_message' || e.kind === 'activity') void load(); }), [conversationId]);

  const act = async (m: MissionView, action: 'missionCancel' | 'missionContinue') => {
    setBusy(m.id);
    setNote(null);
    try { await api.household(action, { id: m.id }); await load(); setNote({ id: m.id, text: action === 'missionCancel' ? 'Stop requested. Steps that already finished are kept.' : 'Continuing from the first unfinished step.' }); }
    catch (err) { setNote({ id: m.id, text: errorText(err), error: true }); }
    finally { setBusy(null); }
  };
  const decide = async (m: MissionView, approvalId: string, resolution: 'approved' | 'rejected') => {
    setBusy(approvalId);
    try { await api.resolveAssistantApproval(approvalId, resolution); await load(); }
    catch (err) { setNote({ id: m.id, text: `Not recorded: ${errorText(err)}`, error: true }); }
    finally { setBusy(null); }
  };
  const openFile = async (m: MissionView, path: string | null, reveal: boolean) => {
    try { await api.household('missionOpen', { id: m.id, path, reveal }); } catch (err) { setNote({ id: m.id, text: errorText(err), error: true }); }
  };

  const shown = visibleMissions(missions, conversationId, now).filter((m) => !hidden[m.id]);
  const bridgeShown = [...bridge.filter((b) => !BRIDGE_DONE.has(b.state)), ...bridge.filter((b) => BRIDGE_DONE.has(b.state)).slice(0, 2)].filter((b) => !hidden[b.id]);
  if (!shown.length && !bridgeShown.length && !approvals.length && !note) return null;
  const openTask = async (b: BridgeActivityItem) => {
    if (!b.conversationId) return;
    try { await api.openConversation(b.conversationId, true); } catch (err) { setNote({ id: b.id, text: errorText(err), error: true }); }
  };

  return (
    <div className="missions" aria-label="Missions">
      {approvals.map((a) => (
        <section key={a.requestId} className="mission bridge attention approval-card" aria-label={`Approval needed: send a task to ${a.agentLabel}`}>
          <header className="mission-head">
            <span className="mission-toggle">
              <span className="dot attention" aria-hidden="true" />
              <span className="mission-title"><strong>Allow {a.agentLabel} to work on this task?</strong><span className="mission-objective">Asked from your browser · nothing has been sent yet</span></span>
            </span>
          </header>
          <div className="mission-body">
            <dl className="approval-facts">
              <dt>Agent</dt><dd>{a.agentLabel}{a.model ? ` (${a.model})` : ''}</dd>
              <dt>Receives your data</dt><dd>{a.provider}</dd>
              <dt>Project</dt><dd>{a.project ? `${a.project.name} · branch ${a.project.branch} at ${a.project.commit}` : 'none (an empty isolated workspace)'}</dd>
              {a.project && (<><dt>Project access</dt><dd>{a.project.access === 'read' ? 'Read-only' : 'Read and write'}</dd></>)}
              <dt>What it may do</dt><dd>{a.accessLevel}</dd>
              <dt>What leaves this PC</dt><dd><ul>{a.exposure.map((line, i) => <li key={i}>{line}</li>)}</ul></dd>
              <dt>Task</dt><dd><pre className="approval-instruction">{a.instruction}</pre></dd>
            </dl>
            <p className="mission-summary">Your decision applies to this task only and expires {new Date(a.expiresAt).toLocaleTimeString()}. If you do not allow it, the task stops: no other agent is tried.</p>
            {a.sensitivity === 'confidential' && (
              <label className="approval-override"><input type="checkbox" checked={override[a.requestId] === true} onChange={(e) => setOverride({ ...override, [a.requestId]: e.target.checked })} /> This task looks confidential ({a.sensitivityReasons.join(', ')}). I confirm sending it to {a.provider}.</label>
            )}
            {note?.id === a.taskId && <p className={`mission-note${note.error ? ' error' : ''}`} role={note.error ? 'alert' : 'status'}>{note.text}</p>}
            <div className="mission-approval-actions">
              <button type="button" className="btn primary small" disabled={busy === a.requestId || (a.sensitivity === 'confidential' && override[a.requestId] !== true)} onClick={() => void decideApproval(a, 'approve')}>Allow {a.agentLabel} for this task</button>
              <button type="button" className="btn small" disabled={busy === a.requestId} onClick={() => void decideApproval(a, 'refuse')}>Don't allow</button>
            </div>
          </div>
        </section>
      ))}
      {note && !approvals.length && !shown.length && !bridgeShown.length && <p className={`mission-note${note.error ? ' error' : ''}`} role="status">{note.text}</p>}
      {bridgeShown.map((b) => (
        <section key={b.id} className={`mission bridge ${b.state}`} aria-label={`From ${b.origin.client}: ${b.instruction}`}>
          <header className="mission-head">
            <span className="mission-toggle">
              <span className={`dot ${b.state === 'failed' || b.state === 'stalled' ? 'danger' : b.state === 'completed' ? 'done' : ['running'].includes(b.state) ? 'live' : 'attention'}`} aria-hidden="true" />
              <span className="mission-title"><strong>{b.origin.kind === 'workflow' ? 'Workflow step' : 'From ChatGPT'} · {b.stateLabel}</strong><span className="mission-objective">{b.instruction}</span></span>
            </span>
            <span className="mission-meta">{b.executor ?? 'no executor yet'}{b.elapsedMs !== null && !BRIDGE_DONE.has(b.state) ? ` · active ${elapsed(b.elapsedMs)}` : ''}{b.heartbeatAgeMs !== null && !BRIDGE_DONE.has(b.state) ? ` · heartbeat ${elapsed(b.heartbeatAgeMs)} ago` : ''}</span>
            {b.conversationId && <button type="button" className="btn small" onClick={() => void openTask(b)}>Open</button>}
            {BRIDGE_DONE.has(b.state) && <button type="button" className="ghost-icon" title="Hide this card" aria-label="Hide task card" onClick={() => setHidden({ ...hidden, [b.id]: true })}>×</button>}
          </header>
          <div className="mission-body"><p className="mission-summary">{b.reason}{b.progress ? ` Latest: ${b.progress}` : ''}{b.verification === 'independent' ? ' Verified independently.' : b.verification === 'human-reviewed' ? ' Reviewed by a person.' : b.verification === 'worker-only' ? ' Not independently verified (the executor’s own report).' : ''}</p>{note?.id === b.id && <p className="mission-note error" role="alert">{note.text}</p>}</div>
        </section>
      ))}
      {shown.map((m) => {
        const progress = missionProgress(m);
        const expanded = open[m.id] ?? (m.status === 'running' || m.pendingApprovals.length > 0);
        const elsewhere = m.conversationId !== conversationId;
        const files = m.steps.flatMap((s) => s.artifacts.filter((a) => a.exists));
        const unique = [...new Map(files.map((f) => [f.path.toLowerCase(), f])).values()];
        const primary = unique.filter((f) => f.kind === 'video' || f.kind === 'document' || f.kind === 'subtitles' || (f.kind === 'image' && !/[\\/]assets[\\/]/i.test(f.path))).slice(0, 8);
        return (
          <section key={m.id} className={`mission ${m.status}`} aria-label={`Mission: ${m.objective}`}>
            <header className="mission-head">
              <button type="button" className="mission-toggle" aria-expanded={expanded} onClick={() => setOpen({ ...open, [m.id]: !expanded })}>
                <span className={`dot ${m.pendingApprovals.length ? 'attention' : m.status === 'failed' ? 'danger' : m.status === 'running' ? 'live' : m.status === 'completed' ? 'done' : 'attention'}`} aria-hidden="true" />
                <span className="mission-title"><strong>{missionHeadline(m)}</strong><span className="mission-objective">{m.objective}</span></span>
              </button>
              <span className="mission-meta">{progress.done}/{progress.total}{m.status === 'running' ? ` · ${missionActiveMs(m, now) === null ? 'between steps' : `active ${elapsed(missionActiveMs(m, now) as number)}`} · last activity ${elapsed(missionHeartbeatMs(m, now))} ago` : ''}{elsewhere ? ' · other chat' : ''}</span>
              {m.status === 'running' && <button type="button" className="btn small" disabled={busy === m.id || Boolean(m.cancelRequestedAt)} onClick={() => void act(m, 'missionCancel')}>{m.cancelRequestedAt ? 'Stopping…' : 'Stop'}</button>}
              {(m.status === 'failed' || m.status === 'cancelled' || m.status === 'interrupted') && <button type="button" className="btn small" disabled={busy === m.id} onClick={() => void act(m, 'missionContinue')}>Continue</button>}
              {m.status !== 'running' && <button type="button" className="ghost-icon" title="Hide this card (the report stays in the chat)" aria-label="Hide mission card" onClick={() => setHidden({ ...hidden, [m.id]: true })}>×</button>}
            </header>
            <div className="mission-bar" role="progressbar" aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.done}><span style={{ width: `${progress.percent}%` }} /></div>
            {expanded && (
              <div className="mission-body">
                <ol className="mission-steps">
                  {m.steps.map((s) => <StepRow key={s.id} step={s} mission={m} now={now} />)}
                </ol>
                {m.pendingApprovals.map((a) => (
                  <div key={a.approvalId} className="mission-approval" role="group" aria-label="Needs your OK">
                    <div className="mission-approval-text"><span className="dot attention" aria-hidden="true" /><span><strong>Needs your OK{a.agentName ? ` · ${a.agentName} agent` : ''}</strong><br />{a.text}</span></div>
                    <div className="mission-approval-actions">
                      <button type="button" className="btn primary small" disabled={busy === a.approvalId} onClick={() => void decide(m, a.approvalId, 'approved')}>Allow</button>
                      <button type="button" className="btn small" disabled={busy === a.approvalId} onClick={() => void decide(m, a.approvalId, 'rejected')}>Don't allow</button>
                    </div>
                  </div>
                ))}
                {primary.length > 0 && (
                  <div className="mission-files">
                    <span className="label">Files on disk</span>
                    {primary.map((f) => (
                      <button key={f.path} type="button" className="mission-file" title={`${f.path}\nClick to open`} onClick={() => void openFile(m, f.path, false)}>
                        <span className={`kind ${f.kind}`} aria-hidden="true">{f.kind === 'video' ? '▶' : f.kind === 'image' ? '▣' : f.kind === 'audio' ? '♪' : '≡'}</span>{f.path.split(/[\\/]/).pop()}
                      </button>
                    ))}
                    {m.workspaceRoot && <button type="button" className="btn link" onClick={() => void openFile(m, null, true)}>Open folder</button>}
                  </div>
                )}
                {m.resultSummary && m.status !== 'running' && <p className="mission-summary">{m.resultSummary}{!narrow && m.reportMessageId ? ' The full report is in the chat above.' : ''}</p>}
                {note?.id === m.id && <p className={`mission-note${note.error ? ' error' : ''}`} role={note.error ? 'alert' : 'status'}>{note.text}</p>}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

function StepRow({ step, mission, now }: { step: StepView; mission: MissionView; now: number }) {
  const d = describeStep(step, mission, now);
  return (
    <li className={`mission-step ${step.status}`}>
      <span className={`step-mark ${d.mark}`} aria-hidden="true">{d.mark === 'done' ? '✓' : d.mark === 'warn' ? '!' : d.mark === 'fail' ? '×' : d.mark === 'run' ? '' : ''}</span>
      <span className="step-main">
        <span className="step-line"><span className="agent">{d.agent}</span><span className="step-title">{step.title}</span></span>
        <span className="step-sub">{d.sub}</span>
      </span>
      <span className="step-state">{d.state}</span>
    </li>
  );
}
