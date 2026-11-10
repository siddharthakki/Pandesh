import React, { useEffect, useRef, useState } from 'react';
import { api, errorText, onDesktopEvent, type ApprovalCard, type BriefAction, type BriefItem, type Snapshot, type TranscriptMessage } from './bridge';
import { Icon, Mark, elapsed, timeOf } from './ui';
import { ActivityAside } from './Activity';
import { Markdown } from './markdown';
import { useVoice } from './voice';
import type { WakeWord } from './wake';
import { useComposerControls } from './ComposerControls';
import { modelLabel as describeModel } from './composerModel';

interface Props {
  snapshot: Snapshot | null;
  snapshotError: string | null;
  refresh: () => void;
  narrow: boolean;
  openConversationId: string | null;
  onOpenPalette: () => void;
  onOpenBoard: () => void;
  /** Text to place in the composer (from a workspace's "Ask Pandesh"). */
  draft?: string | null;
  onDraftUsed?: () => void;
  /** The wake word's state and switches. Its microphone lives in App, so it listens on every view. */
  wake?: WakeWord;
  /** Set when the host heard the wake word: start a voice turn, then call onWakeTurnTaken. */
  wakeTurn?: { id: number } | null;
  onWakeTurnTaken?: () => void;
  /** True while a voice turn captures, transcribes or speaks, or a message is being sent: the wake microphone pauses. */
  onVoiceBusy?: (busy: boolean) => void;
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

const AGENT_NAMES: Record<string, string> = { personal: 'Personal', coding: 'Coding', research: 'Research', operations: 'Operations', voice: 'Voice' };

/** Plain words for the governed actions users meet most; anything else falls back to Core's scope text. */
const TOOL_WORDS: Record<string, { title: string; allow: string; why?: string }> = {
  delegate_to_agent: { title: 'Let an agent use the internet', allow: 'Allow internet for this task', why: 'The agent will go online (public web only)' },
  run_checks: { title: 'Run a command in this folder', allow: 'Allow running this command', why: 'It runs code in this folder' },
  delegate_to_opencode: { title: 'Let OpenCode work in this folder', allow: 'Allow OpenCode in this folder', why: 'OpenCode can create and change files and run commands there' },
  delegate_to_coding_agent: { title: 'Let a coding agent work in this folder', allow: 'Allow this coding agent here', why: 'It can create and change files there; the card says whether it runs locally or in the cloud' },
  authorize_mission: { title: 'Change files in this folder', allow: 'Allow file changes in this folder' },
  write_file: { title: 'Write a file', allow: 'Allow writing this file' },
  run_command: { title: 'Run a command', allow: 'Allow running this command' },
  run_check: { title: 'Run a check', allow: 'Allow running this check' },
  send_email: { title: 'Send an email', allow: 'Allow sending this email' },
  gmail_send: { title: 'Send an email', allow: 'Allow sending this email' },
  web_research: { title: 'Search the web', allow: 'Allow this web search', why: 'It goes online (public web only)' },
  governed_research: { title: 'Search the web', allow: 'Allow this web search', why: 'It goes online (public web only)' },
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
    const why = named?.why ?? (/^(?:write_file|authorize_mission|propose_)/.test(a.toolName) ? 'It changes files' : /^(?:run_|delegate_to_opencode)/.test(a.toolName) ? 'It runs code' : /^(?:browser_|inspect_page|gmail_|calendar_)/.test(a.toolName) ? 'It acts outside this PC' : a.gate === 'mutation' ? 'It acts outside this chat' : a.gate);
    if (why) rows.push(['Why it asks', why]);
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

export function Chat({ snapshot, snapshotError, refresh, narrow, openConversationId, onOpenPalette, onOpenBoard, draft, onDraftUsed, wake, wakeTurn, onWakeTurnTaken, onVoiceBusy }: Props) {
  const [messages, setMessages] = useState<TranscriptMessage[]>([]);
  const [loadedFor, setLoadedFor] = useState<string | null | undefined>(undefined);
  const [live, setLive] = useState<{ attemptId: string | null; text: string }>({ attemptId: null, text: '' });
  const [pendingUser, setPendingUser] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [deciding, setDeciding] = useState(false);
  const [closedFor, setClosedFor] = useState<string | null>(null);
  const [forcedOpen, setForcedOpen] = useState(false);
  const [declined, setDeclined] = useState(false);
  const [routeOpen, setRouteOpen] = useState(false);
  const [brief, setBrief] = useState<BriefItem[] | null>(null);
  const [briefOpen, setBriefOpen] = useState(false);
  const [briefNote, setBriefNote] = useState('');
  const [now, setNow] = useState(Date.now());
  const runStart = useRef<{ attemptId: string | null; at: number } | null>(null);
  const scroller = useRef<HTMLDivElement | null>(null);
  const textarea = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => { if (draft) { setText(draft); onDraftUsed?.(); setTimeout(() => textarea.current?.focus(), 0); } }, [draft]);
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

  // Elapsed time counts from when Core started the attempt (not from when this window first noticed it).
  useEffect(() => {
    if (runningHere) {
      if (!runStart.current || runStart.current.attemptId !== snapshot?.attemptId) {
        const attemptId = snapshot?.attemptId ?? null;
        runStart.current = { attemptId, at: Date.now() };
        if (attemptId) void api.getTaskOverview().then(({ tasks }) => {
          const row = tasks.find((t) => t.attemptId === attemptId);
          const at = Date.parse(row?.startedAt ?? row?.createdAt ?? '');
          if (Number.isFinite(at) && runStart.current?.attemptId === attemptId) { runStart.current = { attemptId, at }; setNow(Date.now()); }
        }).catch(() => undefined);
      }
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

  /** The transcript last put in the composer for review, with its voice turn: sent unchanged, it is still speech. */
  const heldTranscript = useRef<{ text: string; voiceTurnId: string } | null>(null);
  const send = async (spoken?: string, voiceTurnId?: string) => {
    const goal = (spoken ?? text).trim();
    if (!goal || busy) return;
    const held = heldTranscript.current;
    heldTranscript.current = null;
    // Core is told a message was spoken, so it can ask about a misheard word instead of acting on it.
    const turnId = voiceTurnId ?? (spoken === undefined && held && held.text.trim() === goal ? held.voiceTurnId : undefined);
    setBusy(true);
    setNotice(null);
    setDeclined(false);
    setPendingUser(goal);
    setText('');
    if (textarea.current) textarea.current.style.height = 'auto';
    try {
      const r = turnId ? await api.submitTask(goal, undefined, turnId) : await api.submitTask(goal);
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
  // "Approved … Core runs it now" is true only while the turn runs; once it ends the answer speaks for itself.
  const approvedNotice = useRef(false);
  useEffect(() => {
    if (!approvedNotice.current || runningHere) return;
    approvedNotice.current = false;
    setNotice((n) => (n && n.text.startsWith('Approved:') ? null : n));
  }, [runningHere]);

  const resolve = async (resolution: 'approved' | 'rejected') => {
    if (!decision) return;
    setDeciding(true);
    try {
      if (decision.kind === 'tool') await api.resolveApproval(decision.approvalId, resolution);
      else if (decision.kind === 'image') await api.resolveImageApproval(decision.approvalId, resolution);
      else await api.resolveWeatherApproval(decision.approvalId, resolution);
      setDeclined(resolution === 'rejected');
      approvedNotice.current = resolution === 'approved';
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
  // The aside opens by itself once per task, when that task first shows a viewable step; closed stays closed for that task.
  const activeTaskKey = [...activities].reverse().find((a) => a.taskId)?.taskId ?? convId ?? 'none';
  const viewable = activities.some((a) => a.preview || a.state === 'running');
  const asideOpen = (forcedOpen || (viewable && closedFor !== activeTaskKey)) && activities.length > 0;
  const step = [...activities].reverse().find((a) => a.state === 'running');
  const modelLabel = describeModel(snapshot);
  const isLocal = (snapshot?.provider ?? snapshot?.selectedInferenceProvider ?? 'ollama') === 'ollama';
  const routeLabel = `${isLocal ? 'Local' : 'Cloud'} · ${modelLabel}`;
  const coreDown = snapshot && snapshot.coreState !== 'connected' && snapshot.coreState !== 'ready';
  const needs = brief?.length ?? 0;
  const [controlNotice, setControlNotice] = useState<{ text: string; error?: boolean } | null>(null);
  const controls = useComposerControls({ snapshot, refresh, onNotice: setControlNotice, disabled: Boolean(coreDown) || !snapshot });

  const awaitingSpokenAnswer = useRef<string | null>(null);
  const voice = useVoice({
    onTranscript: (t, needsReview, reasons, voiceTurnId) => {
      if (needsReview) {
        heldTranscript.current = { text: t, voiceTurnId };
        setText(t); setNotice({ text: `Check what was heard before sending${reasons.length ? `: ${reasons.join(', ')}` : ''}.` }); textarea.current?.focus(); return;
      }
      awaitingSpokenAnswer.current = t;
      void send(t, voiceTurnId);
    },
  });
  // Speak the answer to a spoken turn when Speak replies is on (existing voice mode).
  useEffect(() => {
    const asked = awaitingSpokenAnswer.current;
    if (!asked || runningHere || !snapshot?.voiceMode) return;
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    const lastAnswer = [...messages].reverse().find((m) => m.role === 'assistant');
    if (lastUser?.content.trim() === asked.trim() && lastAnswer && messages.indexOf(lastAnswer) > messages.indexOf(lastUser)) {
      awaitingSpokenAnswer.current = null;
      void voice.speak(lastAnswer.content.replace(/```[\s\S]*?```/g, ' code block ').replace(/[*_`#>]/g, '').slice(0, 1200));
    }
  }, [messages.length, runningHere, snapshot?.voiceMode]);
  const speechReady = snapshot?.localSpeech?.capability === 'available';
  const speechBlocker = String((snapshot?.localSpeech as { blocker?: string } | undefined)?.blocker ?? 'Local speech recognition is not available.');

  // The host heard the wake word: the question is an ordinary voice turn (VAD capture, local Whisper, sent with its
  // voice turn id so Core knows it was spoken). Classic UI: beginVadUtterance('wake').
  useEffect(() => {
    if (!wakeTurn) return;
    onWakeTurnTaken?.();
    if (voice.state === 'listening' || voice.state === 'transcribing') return;
    // The footer notice shows on the home screen too (the transcript notice does not).
    if (!speechReady) { setControlNotice({ text: `Heard the wake word, but local speech recognition is not available: ${speechBlocker}`, error: true }); return; }
    void voice.listen('wake');
  }, [wakeTurn?.id]);
  const voiceBusy = busy || voice.state === 'listening' || voice.state === 'transcribing' || voice.state === 'speaking';
  useEffect(() => { onVoiceBusy?.(voiceBusy); }, [voiceBusy]);
  useEffect(() => () => onVoiceBusy?.(false), []);
  const wakeStatus = wake?.status;
  /** The wake failure the person already dismissed (shown again only if the reason changes). */
  const [wakeFailureSeen, setWakeFailureSeen] = useState<string | null>(null);
  const wakeAction = (work: () => Promise<void>) => { void work().catch((err) => setControlNotice({ text: `Wake word: ${errorText(err)}`, error: true })); };

  const composer = (
    <div className={`composer${text.trim() ? ' has-text' : ''}`}>
      <label className="sr-only" htmlFor="v2-ask">Message Pandesh</label>
      <textarea id="v2-ask" ref={textarea} rows={1} value={text} placeholder={wakeStatus?.kind === 'listening' ? `Ask Pandesh… or say “${wakeStatus.phrase}”` : 'Ask Pandesh…'} disabled={Boolean(coreDown)}
        onChange={(e) => { setText(e.target.value); e.target.style.height = 'auto'; e.target.style.height = `${Math.min(e.target.scrollHeight, 200)}px`; }}
        onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }} />
      <button type="button" className="icon-btn" aria-label="Talk to Pandesh" title={speechReady ? 'Talk to Pandesh (local speech recognition)' : speechBlocker} disabled={!speechReady || Boolean(coreDown)} onClick={() => void voice.listen()}><Icon name="mic" /></button>
      {runningHere && <button type="button" className="icon-btn" title="Stop the running task" aria-label="Stop the running task" onClick={() => void stop()}><Icon name="stop" /></button>}
      <button type="button" className={`icon-btn send-btn${text.trim() ? ' ready' : ''}`} title="Send (Enter)" aria-label="Send" disabled={!text.trim() || busy} onClick={() => void send()}><Icon name="send" /></button>
    </div>
  );

  const route = (
    <div className="route-wrap">
      <button type="button" className="route-btn" aria-expanded={routeOpen} title="How this chat is routed" onClick={() => setRouteOpen(!routeOpen)}>
        <span className="dot" style={{ width: 6, height: 6, background: snapshot?.modelServerReachable === false ? 'var(--danger)' : 'var(--pulse)' }} aria-hidden="true" />
        <span>{routeLabel}</span>
      </button>
      {routeOpen && (
        <div className="popover" role="dialog" aria-label="How this chat is routed" style={{ bottom: 34, right: 0, width: 360 }}>
          <div className="kv"><span className="k">Provider</span><span>{isLocal ? 'Local · Ollama on this PC' : `Cloud · ${snapshot?.provider}`} (in use now)</span></div>
          <div className="kv"><span className="k">Model</span><span>{modelLabel}</span></div>
          <div className="kv"><span className="k">Context</span><span>{snapshot?.contextEnvelope ? `${Math.round(snapshot.contextEnvelope / 1024)}K tokens` : 'Not reported'}</span></div>
          <div className="kv"><span className="k">Model server</span><span>{snapshot?.modelServerReachable === false ? 'Not answering' : snapshot?.modelServerReachable ? 'Answering' : 'Unknown'}</span></div>
          <div className="kv"><span className="k">Outward actions</span><span>{snapshot?.permission?.mode === 'plan' ? 'None: Plan only changes nothing' : snapshot?.permission?.mode === 'auto' ? 'Ask you first, except what Auto covers' : 'Ask you first (approval rules)'}</span></div>
          <div className="kv"><span className="k">Speech</span><span>{speechReady ? `Local recognition ready${(snapshot?.localSpeech as { engine?: string } | undefined)?.engine ? ` (${(snapshot?.localSpeech as { engine?: string }).engine})` : ''}` : speechBlocker}</span></div>
          <div className="kv"><span className="k">Speak replies</span><span><button type="button" className="btn small" onClick={() => void voice.setVoiceMode(!snapshot?.voiceMode).then(refresh)}>{snapshot?.voiceMode ? 'On — turn off' : 'Off — turn on'}</button></span></div>
          {wake && snapshot?.wakeWord && (
            <div className="kv"><span className="k">Wake word</span>
              <span style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
                <span>{wake.status.text}</span>
                {wake.status.kind !== 'unavailable' && (
                  <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {wake.status.kind === 'off'
                      ? <button type="button" className="btn small" onClick={() => wakeAction(() => wake.setEnabled(true))}>Turn on</button>
                      : <>
                          <button type="button" className="btn small" onClick={() => wakeAction(() => wake.setMuted(!wake.status.muted))}>{wake.status.muted ? 'Unmute' : 'Mute'}</button>
                          <button type="button" className="btn small" onClick={() => wakeAction(() => wake.setEnabled(false))}>Turn off</button>
                        </>}
                  </span>
                )}
              </span>
            </div>
          )}
          {snapshot?.modelNote && <div className="kv"><span className="k">Note</span><span>{snapshot.modelNote}</span></div>}
        </div>
      )}
    </div>
  );

  return (
    <div style={{ flex: '1 1 auto', minHeight: 0, display: 'flex', position: 'relative' }}>
    <div style={{ flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column' }}>
      <div className="topbar">
        <button type="button" className="ghost-icon" title="Chats (Ctrl K)" aria-label="Open chats" onClick={onOpenPalette}><Icon name="chats" size={18} /></button>
        <span className="title">{idle ? 'New chat' : 'Chat'}</span>
        {snapshot?.selectedAgentId && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '2px 4px 2px 10px', border: '1px solid var(--pulse)', borderRadius: 999, fontSize: 13 }}>
            Talking to {AGENT_NAMES[snapshot.selectedAgentId] ?? snapshot.selectedAgentId}
            <button type="button" className="btn small" style={{ height: 26 }} onClick={() => void api.household('selectAgent', { agentId: null }).then(refresh)}>Back to Pandesh</button>
          </span>
        )}
        <span className="grow" />
        {activities.length > 0 && !asideOpen && <button type="button" className="btn small" title="Show what Pandesh did in this chat" onClick={() => { setClosedFor(null); setForcedOpen(true); }}>Workspace · {activities.length}</button>}
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
                      <Markdown text={m.content} />
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
            {!showDecisionBar && controls.panel}
            {controlNotice && <div className={`notice${controlNotice.error ? ' error' : ''}`} role={controlNotice.error ? 'alert' : 'status'} style={{ margin: 0 }}>{controlNotice.text} <button type="button" className="btn link" style={{ minHeight: 0, padding: 0 }} onClick={() => setControlNotice(null)}>OK</button></div>}
            {wakeStatus?.kind === 'failed' && wakeFailureSeen !== wakeStatus.reason && <div className="notice error" role="alert" style={{ margin: 0 }}>The wake word is not listening: {wakeStatus.reason}. <button type="button" className="btn link" style={{ minHeight: 0, padding: 0 }} onClick={() => setWakeFailureSeen(wakeStatus.reason ?? null)}>OK</button></div>}
            {showDecisionBar && decision ? (
              <div className="decision-bar" role="group" aria-label={`Decide: ${decision.title}`}>
                <button type="button" className="btn primary" disabled={deciding} onClick={() => void resolve('approved')}>{decision.allowLabel}</button>
                <div className="row"><button type="button" className="btn" disabled={deciding} onClick={() => void resolve('rejected')}>Don't allow</button></div>
              </div>
            ) : voice.state === 'listening' || voice.state === 'transcribing' ? (
              <div className="composer" role="status" aria-live="polite" style={{ borderColor: 'var(--pulse)', alignItems: 'center', flexWrap: 'wrap', gap: '10px 14px', padding: '12px 14px' }}>
                <span aria-hidden="true" style={{ display: 'flex', gap: 3, alignItems: 'center', height: 22 }}>{[8, 18, 12, 22, 10].map((h, i) => <span key={i} style={{ width: 3, height: voice.heard ? h : 4, borderRadius: 2, background: 'var(--pulse)' }} />)}</span>
                <span style={{ flex: '1 1 160px', display: 'flex', flexDirection: 'column' }}><strong style={{ fontWeight: 500 }}>{voice.state === 'listening' ? 'Listening…' : 'Transcribing on this PC…'}</strong><span style={{ fontSize: 14, color: 'var(--muted)' }}>{voice.state === 'listening' ? (voice.heard ? 'Stops when you pause' : voice.source === 'wake' ? `Heard “${wakeStatus?.phrase ?? 'Hey Jarvis'}”. Ask your question.` : 'Speak now') : 'Local Whisper'}</span></span>
                <button type="button" className="btn small" onClick={() => { void voice.stopListening(); textarea.current?.focus(); }}>Type instead</button>
                {voice.state === 'listening' && <button type="button" className="btn small" onClick={() => void voice.stopListening()}>Stop listening</button>}
              </div>
            ) : voice.state === 'speaking' ? (
              <div className="composer" role="status" aria-live="polite" style={{ alignItems: 'center', flexWrap: 'wrap', gap: '10px 14px', padding: '12px 14px' }}>
                <span className="dot" aria-hidden="true" style={{ width: 10, height: 10 }} />
                <span style={{ flex: '1 1 160px', display: 'flex', flexDirection: 'column' }}><strong style={{ fontWeight: 500 }}>Speaking</strong><span style={{ fontSize: 14, color: 'var(--muted)' }}>{(snapshot as { speechInterrupt?: { spokenBargeIn?: boolean } } | null)?.speechInterrupt?.spokenBargeIn ? 'Talk over me or press Stop.' : 'Press Stop to interrupt.'}</span></span>
                <button type="button" className="btn small" onClick={() => voice.stopSpeaking()}>Stop speaking</button>
              </div>
            ) : (
              <>
                {voice.state === 'interrupted' && <div role="status" style={{ alignSelf: 'flex-start', display: 'flex', alignItems: 'center', gap: 8, padding: '4px 12px', borderRadius: 999, background: 'var(--raised)', fontSize: 14 }}>Stopped speaking. <button type="button" className="btn link" style={{ minHeight: 0, padding: 0 }} onClick={() => voice.clear()}>OK</button></div>}
                {voice.state === 'error' && <div role="alert" className="notice error" style={{ margin: 0 }}>{voice.detail} <button type="button" className="btn link" style={{ minHeight: 0, padding: 0 }} onClick={() => voice.clear()}>OK</button></div>}
                {voice.state === 'idle' && voice.detail && <div role="status" style={{ fontSize: 14, color: 'var(--muted)' }}>{voice.detail}</div>}
                {composer}
              </>
            )}
            {!showDecisionBar && (
              <div className="composer-controls">
                {controls.controls}
                <span className="grow" />
                {route}
              </div>
            )}
          </div>
        </div>
        <div className="spacer-v" />
      </div>
    </div>
    {asideOpen && <ActivityAside activities={activities} conversationId={convId} narrow={narrow} onClose={() => { setClosedFor(activeTaskKey); setForcedOpen(false); }} />}
    </div>
  );
}

function greeting(): string {
  const h = new Date().getHours();
  return h < 5 ? 'Good evening.' : h < 12 ? 'Good morning.' : h < 18 ? 'Good afternoon.' : 'Good evening.';
}
