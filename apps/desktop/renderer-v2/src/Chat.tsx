import React, { useEffect, useRef, useState } from 'react';
import { api, errorText, onDesktopEvent, type ApprovalCard, type BriefAction, type BriefItem, type Snapshot, type TranscriptMessage } from './bridge';
import { Icon, Mark, elapsed, timeOf } from './ui';

interface Props {
  snapshot: Snapshot | null;
  snapshotError: string | null;
  refresh: () => void;
  narrow: boolean;
  openConversationId: string | null;
  onOpenPalette: () => void;
  onOpenBoard: () => void;
}

const ROUTED: Record<string, string> = {
  stopped: 'Stop requested — waiting for the worker to confirm it has stopped.',
  queued: 'Queued behind the running task. It starts when that one finishes.',
  duplicate: 'Already running or queued — not started a second time.',
  steered: 'Added to the running task — it keeps going with your new instruction.',
  side_question: 'Answering alongside the running task — it is not stopped.',
  corrected_queued: 'Corrected — your queued request now says what you just asked for.',
  corrected_restarted: 'Corrected — it had not answered yet, so it restarted on your correction.',
  corrected_steered: 'Corrected — the running task has your correction.',
};

/** Plain words for the governed actions users meet most; anything else falls back to Core's scope text. */
const TOOL_WORDS: Record<string, { title: string; allow: string }> = {
  authorize_mission: { title: 'Change files in this folder', allow: 'Allow file changes in this folder' },
  write_file: { title: 'Write a file', allow: 'Allow writing this file' },
  run_command: { title: 'Run a command', allow: 'Allow running this command' },
  run_check: { title: 'Run a check', allow: 'Allow running this check' },
  send_email: { title: 'Send an email', allow: 'Allow sending this email' },
  gmail_send: { title: 'Send an email', allow: 'Allow sending this email' },
  web_research: { title: 'Search the web', allow: 'Allow this web search' },
  governed_research: { title: 'Search the web', allow: 'Allow this web search' },
};
function humanize(id: string): string { const s = id.replace(/[_-]+/g, ' ').trim(); return s.charAt(0).toUpperCase() + s.slice(1); }

/** Which pending approval (if any) belongs in the conversation right now. */
function pendingDecision(s: Snapshot | null): null | { kind: 'tool' | 'image' | 'weather'; approvalId: string; title: string; rows: Array<[string, string]>; detail: string; allowLabel: string } {
  if (!s) return null;
  if (s.pendingApproval) {
    const a: ApprovalCard = s.pendingApproval;
    const named = TOOL_WORDS[a.toolName];
    const title = named?.title ?? (a.scope || humanize(a.toolName));
    const rows: Array<[string, string]> = [['Action', title], ['Tool', a.toolName]];
    if (a.paths?.length) rows.push(['Affects', a.paths.join('\n')]);
    if (a.gate) rows.push(['Why it asks', a.gate === 'mutation' ? 'It changes files' : a.gate]);
    return { kind: 'tool', approvalId: a.approvalId, title, rows, detail: a.detail, allowLabel: named?.allow ?? `Allow: ${title}` };
  }
  if (s.pendingImageApproval) {
    const r = s.pendingImageApproval.request;
    return { kind: 'image', approvalId: s.pendingImageApproval.approvalId, title: 'Generate image', rows: [['Action', 'Generate an image locally (ComfyUI)']], detail: r?.prompt ?? '', allowLabel: 'Generate image' };
  }
  if (s.pendingWeatherApproval) {
    return { kind: 'weather', approvalId: s.pendingWeatherApproval.approvalId, title: 'Look up weather', rows: [['Action', 'Fetch the weather forecast over the network']], detail: '', allowLabel: 'Look up weather' };
  }
  return null;
}

export function Chat({ snapshot, snapshotError, refresh, narrow, openConversationId, onOpenPalette, onOpenBoard }: Props) {
  const [messages, setMessages] = useState<TranscriptMessage[]>([]);
  const [loadedFor, setLoadedFor] = useState<string | null | undefined>(undefined);
  const [live, setLive] = useState<{ attemptId: string | null; text: string }>({ attemptId: null, text: '' });
  const [pendingUser, setPendingUser] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [deciding, setDeciding] = useState(false);
  const [declined, setDeclined] = useState(false);
  const [routeOpen, setRouteOpen] = useState(false);
  const [brief, setBrief] = useState<BriefItem[] | null>(null);
  const [briefOpen, setBriefOpen] = useState(false);
  const [briefNote, setBriefNote] = useState('');
  const [now, setNow] = useState(Date.now());
  const runStart = useRef<{ attemptId: string | null; at: number } | null>(null);
  const scroller = useRef<HTMLDivElement | null>(null);
  const textarea = useRef<HTMLTextAreaElement | null>(null);

  const convId = openConversationId ?? snapshot?.selectedConversationId ?? null;
  const runningHere = Boolean(snapshot?.running) && (snapshot?.activeConversationId ?? null) === convId;

  // Open the conversation the user picked so the next send goes there.
  useEffect(() => {
    if (openConversationId) void api.openConversation(openConversationId, true).then(() => refresh()).catch((err) => setNotice({ text: errorText(err), error: true }));
  }, [openConversationId]);

  const loadTranscript = async (id: string | null) => {
    if (!id) { setMessages([]); setLoadedFor(null); return; }
    try {
      const opened = await api.openConversation(id, false);
      setMessages(opened.messages.filter((m) => m.role !== 'system'));
      setLoadedFor(id);
    } catch (err) {
      setNotice({ text: `Could not load this chat: ${errorText(err)}`, error: true });
    }
  };
  useEffect(() => { if (convId !== loadedFor) void loadTranscript(convId); }, [convId]);

  useEffect(() => onDesktopEvent((e) => {
    if (e.kind === 'token') {
      if (e.conversationId && e.conversationId !== convId) return;
      setLive((cur) => (cur.attemptId === e.attemptId ? { attemptId: cur.attemptId, text: cur.text + (e.text ?? '') } : { attemptId: e.attemptId ?? null, text: e.text ?? '' }));
      return;
    }
    if (e.kind === 'result' || e.kind === 'error' || e.kind === 'cancelled' || (e.kind === 'conversation_message' && (!e.conversationId || e.conversationId === convId))) {
      void loadTranscript(convId).then(() => { setLive({ attemptId: null, text: '' }); setPendingUser(null); });
    }
    if (e.kind === 'assistant_approval_changed') void loadBrief();
  }), [convId]);

  // Elapsed time counts from when this window saw the turn start.
  useEffect(() => {
    if (runningHere) {
      if (!runStart.current || runStart.current.attemptId !== snapshot?.attemptId) runStart.current = { attemptId: snapshot?.attemptId ?? null, at: Date.now() };
      const t = setInterval(() => setNow(Date.now()), 1000);
      return () => clearInterval(t);
    }
    runStart.current = null;
    return undefined;
  }, [runningHere, snapshot?.attemptId]);

  // Drop the pending user bubble once the durable transcript has it.
  useEffect(() => {
    if (pendingUser && messages.some((m) => m.role === 'user' && m.content.trim() === pendingUser.trim())) setPendingUser(null);
  }, [messages]);

  useEffect(() => { const el = scroller.current; if (el) el.scrollTop = el.scrollHeight; }, [messages.length, live.text, pendingUser, runningHere, snapshot?.pendingApproval?.approvalId]);

  const loadBrief = async () => {
    try { const b = await api.getAssistantBrief({ external: false }); setBrief(b.home ?? []); } catch { setBrief(null); }
  };
  // Core may still be starting at mount: read the brief again once it connects and after each turn.
  useEffect(() => { if (snapshot?.coreState === 'connected') void loadBrief(); }, [snapshot?.coreState, snapshot?.lastTurnOutcome]);

  const idle = messages.length === 0 && !pendingUser && !runningHere && !live.text;
  const decision = pendingDecision(snapshot);
  const showDecisionBar = narrow && Boolean(decision) && !deciding;

  const send = async () => {
    const goal = text.trim();
    if (!goal || busy) return;
    setBusy(true);
    setNotice(null);
    setDeclined(false);
    setPendingUser(goal);
    setText('');
    try {
      const r = await api.submitTask(goal);
      if (r?.routed && ROUTED[r.routed]) setNotice({ text: ROUTED[r.routed] });
      refresh();
    } catch (err) {
      setPendingUser(null);
      setText(goal);
      setNotice({ text: `Not sent: ${errorText(err)}`, error: true });
    } finally {
      setBusy(false);
      textarea.current?.focus();
    }
  };

  const stop = async () => {
    // Set before the request: Core can confirm the cancel before cancel() resolves.
    stopRequested.current = true;
    setNotice({ text: 'Stop requested — waiting for the worker to confirm.' });
    try { await api.cancel(); refresh(); } catch (err) { stopRequested.current = false; setNotice({ text: errorText(err), error: true }); }
  };
  const stopRequested = useRef(false);
  // Replace "Stop requested" with what Core actually recorded once the turn ends.
  useEffect(() => {
    if (!stopRequested.current || runningHere || !snapshot?.lastTurnOutcome) return;
    stopRequested.current = false;
    const o = snapshot?.lastTurnOutcome;
    setNotice({ text: o === 'cancelled' ? 'Stopped. Core recorded the task as cancelled.' : o ? `It finished before it could stop (${o}).` : 'Stop requested; Core has not reported the outcome yet.' });
  }, [runningHere, snapshot?.lastTurnOutcome]);

  const resolve = async (resolution: 'approved' | 'rejected') => {
    if (!decision) return;
    setDeciding(true);
    try {
      if (decision.kind === 'tool') await api.resolveApproval(decision.approvalId, resolution);
      else if (decision.kind === 'image') await api.resolveImageApproval(decision.approvalId, resolution);
      else await api.resolveWeatherApproval(decision.approvalId, resolution);
      setDeclined(resolution === 'rejected');
      setNotice({ text: resolution === 'approved' ? `Approved: ${decision.title}. Core runs it now.` : `Declined: ${decision.title}. Nothing was run.` });
    } catch (err) {
      setNotice({ text: `The decision was not recorded: ${errorText(err)}`, error: true });
    } finally {
      setDeciding(false);
      refresh();
    }
  };

  const runBrief = async (item: BriefItem, action: BriefAction) => {
    try {
      if (action.kind === 'resolve_approval' && action.approvalId) {
        const rejecting = /reject|deny|decline|don't/i.test(action.label);
        await api.resolveAssistantApproval(action.approvalId, rejecting ? 'rejected' : 'approved');
        setBriefNote(`${item.title}: ${rejecting ? 'declined' : 'approved'}.`);
      } else if (action.kind === 'open_conversation' && action.conversationId) {
        await api.openConversation(action.conversationId, true); refresh(); setBriefNote('');
      } else if (action.kind === 'stop_task' && action.attemptId) {
        const r = await api.cancelTask(action.attemptId); setBriefNote(r.requested ? 'Stop requested.' : 'It could not be stopped any more.');
      } else if (action.kind === 'resume_task' && action.attemptId) {
        await api.resumeTask(action.attemptId); setBriefNote('Resumed.');
      } else if (action.kind === 'refresh_brief') {
        setBriefNote('');
      } else {
        onOpenBoard(); return;
      }
    } catch (err) {
      setBriefNote(`${item.title}: ${errorText(err)}`);
    }
    await loadBrief();
  };

  const activities = (snapshot?.workspaceActivities ?? []).filter((a) => a.conversationId === convId);
  const step = [...activities].reverse().find((a) => a.state === 'running');
  const modelLabel = snapshot?.model ? (snapshot.modelIsAuto ? `${snapshot.model} (auto)` : snapshot.model) : 'model not chosen';
  const isLocal = (snapshot?.provider ?? snapshot?.selectedInferenceProvider ?? 'ollama') === 'ollama';
  const routeLabel = `${isLocal ? 'Local' : 'Cloud'} · ${modelLabel}`;
  const coreDown = snapshot && snapshot.coreState !== 'connected' && snapshot.coreState !== 'ready';
  const needs = brief?.length ?? 0;

  const composer = (
    <div className={`composer${text.trim() ? ' has-text' : ''}`}>
      <label className="sr-only" htmlFor="v2-ask">Message Pandesh</label>
      <textarea id="v2-ask" ref={textarea} rows={1} value={text} placeholder="Ask Pandesh…" disabled={Boolean(coreDown)}
        onChange={(e) => { setText(e.target.value); e.target.style.height = 'auto'; e.target.style.height = `${Math.min(e.target.scrollHeight, 200)}px`; }}
        onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }} />
      {runningHere && <button type="button" className="icon-btn" title="Stop the running task" aria-label="Stop the running task" onClick={() => void stop()}><Icon name="stop" /></button>}
      <button type="button" className={`icon-btn send-btn${text.trim() ? ' ready' : ''}`} title="Send (Enter)" aria-label="Send" disabled={!text.trim() || busy} onClick={() => void send()}><Icon name="send" /></button>
    </div>
  );

  const route = (
    <div style={{ position: 'relative', display: 'flex', justifyContent: 'center' }}>
      <button type="button" className="route-btn" aria-expanded={routeOpen} title="How this chat is routed" onClick={() => setRouteOpen(!routeOpen)}>
        <span className="dot" style={{ width: 6, height: 6, background: snapshot?.modelServerReachable === false ? 'var(--danger)' : 'var(--pulse)' }} aria-hidden="true" />
        <span>{routeLabel}</span>
      </button>
      {routeOpen && (
        <div className="popover" role="dialog" aria-label="How this chat is routed" style={{ bottom: 34, left: '50%', transform: 'translateX(-50%)', width: 360 }}>
          <div className="kv"><span className="k">Provider</span><span>{isLocal ? 'Local · Ollama on this PC' : `Cloud · ${snapshot?.provider}`} (in use now)</span></div>
          <div className="kv"><span className="k">Model</span><span>{modelLabel}</span></div>
          <div className="kv"><span className="k">Context</span><span>{snapshot?.contextEnvelope ? `${Math.round(snapshot.contextEnvelope / 1024)}K tokens` : 'Not reported'}</span></div>
          <div className="kv"><span className="k">Model server</span><span>{snapshot?.modelServerReachable === false ? 'Not answering' : snapshot?.modelServerReachable ? 'Answering' : 'Unknown'}</span></div>
          <div className="kv"><span className="k">Outward actions</span><span>Ask you first (approval rules)</span></div>
          {snapshot?.modelNote && <div className="kv"><span className="k">Note</span><span>{snapshot.modelNote}</span></div>}
        </div>
      )}
    </div>
  );

  return (
    <>
      <div className="topbar">
        <button type="button" className="ghost-icon" title="Chats (Ctrl K)" aria-label="Open chats" onClick={onOpenPalette}><Icon name="chats" size={18} /></button>
        <span className="title">{idle ? 'New chat' : 'Chat'}</span>
        <span className="grow" />
        <button type="button" className="ghost-icon" title="New chat" aria-label="New chat" onClick={() => { void api.newConversation().then(() => { setMessages([]); setLoadedFor(null); refresh(); }); }}><Icon name="plus" size={18} /></button>
        <button type="button" className="search-btn" title="Search everything (Ctrl K)" onClick={onOpenPalette}><Icon name="search" size={16} /><span>Search</span>{!narrow && <kbd>Ctrl K</kbd>}</button>
      </div>

      <div className={`body${idle && !narrow ? ' idle-wide' : ''}`}>
        <div className="spacer-v" />
        {coreDown && (
          <div className="notice error" role="alert" style={{ marginBottom: 12 }}>
            Pandesh Core is {snapshot?.coreState}{snapshot?.coreDetail ? ` — ${snapshot.coreDetail}` : ''}. <button type="button" className="btn link" onClick={() => void api.retryCoreConnection().then(refresh)}>Try again</button>
          </div>
        )}
        {snapshotError && <div className="notice error" role="alert">{snapshotError}</div>}

        {idle ? (
          <div className="hero-wrap">
            <div className="hero">
              <div className="dateline"><Mark size={28} /><span>{new Date().toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' })}</span></div>
              <h1>{greeting()}</h1>
              {brief === null && <p>Ask me anything. I use local models by default; you decide what else is allowed.</p>}
              {brief && needs === 0 && <p>Nothing needs you right now.</p>}
              {brief && needs > 0 && (
                <button type="button" className="btn" style={{ alignSelf: 'flex-start', borderRadius: 19, display: 'flex', alignItems: 'center', gap: 10 }} aria-expanded={briefOpen} onClick={() => setBriefOpen(!briefOpen)}>
                  <span className="dot attention" aria-hidden="true" />{needs === 1 ? '1 thing needs you' : `${needs} things need you`}<span style={{ color: 'var(--muted)', fontSize: 14 }}>{briefOpen ? 'Hide' : 'Show'}</span>
                </button>
              )}
              {brief && briefOpen && needs > 0 && (
                <ul style={{ listStyle: 'none', margin: 0, padding: 0, border: '1px solid var(--line)', borderRadius: 12, background: 'var(--surface)' }}>
                  {brief.map((item, i) => (
                    <li key={item.id} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '10px 12px', padding: '12px 14px', borderBottom: i < brief.length - 1 ? '1px solid var(--line)' : 0 }}>
                      <span className={`dot ${item.stance === 'fact' && /fail|error/i.test(item.state) ? 'danger' : 'attention'}`} aria-hidden="true" />
                      <div style={{ flex: '1 1 200px', minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                        <span style={{ fontWeight: 500 }}>{item.title}</span>
                        <span style={{ fontSize: 13.5, color: 'var(--muted)' }}>{item.detail} · {item.source.label}, checked {timeOf(item.source.checkedAt)}</span>
                      </div>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        {item.actions.map((a) => <button key={a.kind + a.label} type="button" className="btn small" onClick={() => void runBrief(item, a)}>{a.label}</button>)}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              <p role="status" aria-live="polite" style={{ margin: 0, fontSize: 14, minHeight: 1 }}>{briefNote}</p>
            </div>
          </div>
        ) : (
          <div className="transcript" ref={scroller}>
            <div className="transcript-inner">
              <div />
              {messages.map((m) => m.role === 'user'
                ? <div key={m.id} className="msg-user">{m.content}</div>
                : (
                  <div key={m.id} className="msg-assistant">
                    <Mark />
                    <div className="content">
                      <p className="text">{m.content}</p>
                      <div className="meta">{[m.model, timeOf(m.createdAt)].filter(Boolean).join(' · ')}</div>
                    </div>
                  </div>
                ))}
              {pendingUser && <div className="msg-user" aria-label="Sending">{pendingUser}</div>}
              {runningHere && (
                <div className="msg-assistant" aria-live="polite">
                  <Mark />
                  <div className="content">
                    {live.text ? <p className="text">{live.text}</p> : null}
                    <div className="thinking">
                      <div className="row">
                        <span className="dot" aria-hidden="true" />
                        <span style={{ fontWeight: 500 }}>{snapshot?.awaitingApproval ? 'Waiting for your decision' : step ? step.title : live.text ? 'Writing' : 'Thinking'}</span>
                        <span className="elapsed">{runStart.current ? elapsed(now - runStart.current.at) : ''}</span>
                        <button type="button" className="btn small" onClick={() => void stop()}>Stop</button>
                      </div>
                      {step?.capability ? <span className="meta" style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--muted)' }}>Step reported by Core · {String(step.capability)}</span> : null}
                    </div>
                  </div>
                </div>
              )}
              {!runningHere && !declined && snapshot?.lastTurnOutcome === 'failed' && snapshot.activeConversationId === convId && (
                <div className="notice error" role="status">The last turn failed{snapshot.blockedReason ? `: ${snapshot.blockedReason}` : '.'}</div>
              )}
              {decision && (
                <section className="approval" aria-label={`Approval needed: ${decision.title}`}>
                  <div className="approval-head"><span className="dot attention" aria-hidden="true" /><span className="title">Needs your OK · {decision.title}</span></div>
                  <dl>{decision.rows.map(([k, v]) => <React.Fragment key={k}><dt>{k}</dt><dd className={k === 'Affects' ? 'code' : undefined} style={{ whiteSpace: 'pre-wrap' }}>{v}</dd></React.Fragment>)}</dl>
                  {decision.detail && <div className="detail">{decision.detail}</div>}
                  {!narrow && (
                    <div className="actions">
                      <button type="button" className="btn primary" disabled={deciding} onClick={() => void resolve('approved')}>{decision.allowLabel}</button>
                      <button type="button" className="btn" disabled={deciding} onClick={() => void resolve('rejected')}>Don't allow</button>
                    </div>
                  )}
                  <div className="foot">Nothing runs until you choose. Core records the decision.</div>
                </section>
              )}
              {notice && <div className={`notice${notice.error ? ' error' : ''}`} role={notice.error ? 'alert' : 'status'}>{notice.text}</div>}
            </div>
          </div>
        )}

        <div className="footer">
          <div className="footer-inner">
            {showDecisionBar && decision ? (
              <div className="decision-bar" role="group" aria-label={`Decide: ${decision.title}`}>
                <button type="button" className="btn primary" disabled={deciding} onClick={() => void resolve('approved')}>{decision.allowLabel}</button>
                <div className="row"><button type="button" className="btn" disabled={deciding} onClick={() => void resolve('rejected')}>Don't allow</button></div>
              </div>
            ) : composer}
            {!showDecisionBar && route}
          </div>
        </div>
        <div className="spacer-v" />
      </div>
    </>
  );
}

function greeting(): string {
  const h = new Date().getHours();
  return h < 5 ? 'Good evening.' : h < 12 ? 'Good morning.' : h < 18 ? 'Good afternoon.' : 'Good evening.';
}
