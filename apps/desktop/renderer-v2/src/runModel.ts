/**
 * The live run model (pure; unit-tested in apps/desktop/test/liveRunModel.test.ts).
 *
 * It folds the Core events the host already forwards (attempt transitions, model passes and phases, tool
 * invocations, approvals, final verification, completion/failure/cancel, plus a token *count*) into one
 * description of the request that is running right now: its phase, the time since the last real signal, and a
 * step list. Every field is set by an event; nothing is inferred from elapsed time. When no event has arrived
 * the phase says so ("waiting for the model's first output") instead of claiming work.
 */
export type RunPhase =
  | 'starting' | 'preparing' | 'loading' | 'waiting' | 'reasoning' | 'writing' | 'selecting_tool' | 'tool' | 'approval' | 'verifying'
  | 'completed' | 'failed' | 'cancelled' | 'interrupted';

export interface RunStep {
  id: string;
  kind: 'model' | 'tool' | 'approval' | 'verification' | 'note';
  label: string;
  state: 'running' | 'ok' | 'failed' | 'blocked' | 'cancelled';
  startedAt: number;
  endedAt?: number;
  /** Tool invocation id, so the panel can attach the title/preview the host recorded for it. */
  invocationId?: string;
  toolName?: string;
  /** Technical, content-free facts (pass number, counts, event names). */
  facts: string[];
}

export interface RunState {
  attemptId: string;
  requestId?: string;
  startedAt: number;
  lastSignalAt: number;
  phase: RunPhase;
  phaseSince: number;
  pass: number;
  passes: number;
  textChunks: number;
  steps: RunStep[];
  /** Set when the run is over. */
  outcome?: 'completed' | 'failed' | 'cancelled' | 'interrupted';
  reason?: string;
  /** True once a final verification event was recorded for this run. */
  verified?: boolean;
  /** True when the last finished model pass produced text and no tool call (the model answered without tools). */
  lastPassToolless?: boolean;
  toolCallsTotal: number;
}

export interface LiveEvent {
  kind: string;
  at: string;
  attemptId?: string;
  requestId?: string;
  eventType?: string;
  domain?: string;
  toolName?: string;
  invocationId?: string;
  invocationStatus?: string;
  summary?: string;
  detail?: { pass?: number; phase?: string; toolCalls?: number; textChars?: number; reasoned?: boolean; ok?: boolean; durationMs?: number | null; reason?: string; kind?: string; to?: string };
}

const MAX_STEPS = 80;

const HIDDEN_TOOLS = new Set(['protocol_correction', 'authorize_mission', 'unknown_tool', 'tool']);

export function newRun(attemptId: string, at: number, requestId?: string): RunState {
  return { attemptId, requestId, startedAt: at, lastSignalAt: at, phase: 'starting', phaseSince: at, pass: 0, passes: 0, textChunks: 0, steps: [], toolCallsTotal: 0 };
}

const ms = (iso: string) => { const t = Date.parse(iso); return Number.isFinite(t) ? t : Date.now(); };

function setPhase(r: RunState, phase: RunPhase, at: number) {
  if (r.phase !== phase) { r.phase = phase; r.phaseSince = at; }
}

function push(r: RunState, step: RunStep) {
  r.steps.push(step);
  if (r.steps.length > MAX_STEPS) r.steps.splice(0, r.steps.length - MAX_STEPS);
}

function openTool(r: RunState): RunStep | undefined {
  return [...r.steps].reverse().find((s) => s.kind === 'tool' && s.state === 'running');
}

/** Phase after something ended: another tool still open wins; otherwise the model is the one working. */
function settleToModel(r: RunState, at: number) {
  if (r.outcome) return;
  if (openTool(r)) setPhase(r, 'tool', at);
  else setPhase(r, 'waiting', at);
}

/**
 * Returns the (mutated copy of the) run an event belongs to, or null when the event is not about a run.
 * `current` is the run the store follows; a new attempt id starts a new run.
 */
export function applyEvent(current: RunState | null, e: LiveEvent): RunState | null {
  if (!e.attemptId) return current;
  const at = ms(e.at);
  const r: RunState = current && current.attemptId === e.attemptId ? structuredCloneRun(current) : newRun(e.attemptId, at, e.requestId);
  if (e.requestId && !r.requestId) r.requestId = e.requestId;
  if (r.outcome && e.kind !== 'result' && e.kind !== 'error' && e.kind !== 'cancelled' && e.eventType !== 'attempt_resumed') return current && current.attemptId === e.attemptId ? current : r;

  if (e.kind === 'token') {
    r.textChunks += 1;
    r.lastSignalAt = at;
    if (!openTool(r)) setPhase(r, 'writing', at);
    return r;
  }

  if (e.kind === 'approval') {
    r.lastSignalAt = at;
    if (r.steps.some((x) => x.kind === 'approval' && x.state === 'running')) { setPhase(r, 'approval', at); return r; }
    push(r, { id: `approval-${at}-${r.steps.length}`, kind: 'approval', label: String(e.summary ?? 'Waiting for your approval'), state: 'running', startedAt: at, facts: ['approval requested'] });
    setPhase(r, 'approval', at);
    return r;
  }
  if (e.kind === 'assistant_approval_changed') {
    r.lastSignalAt = at;
    const open = [...r.steps].reverse().find((s) => s.kind === 'approval' && s.state === 'running');
    if (open && (e.summary === 'approval_resolved' || e.summary === 'approval_superseded' || e.summary === 'approval_expired')) {
      open.endedAt = at;
      open.state = e.summary === 'approval_expired' ? 'blocked' : 'ok';
      open.facts.push(e.summary === 'approval_expired' ? 'expired without an answer — nothing approved' : e.summary === 'approval_superseded' ? 'superseded' : 'answered');
      settleToModel(r, at);
    }
    return r;
  }
  if (e.kind === 'result') {
    r.lastSignalAt = at; r.outcome = 'completed';
    closeOpen(r, at, 'ok');
    setPhase(r, 'completed', at);
    return r;
  }
  if (e.kind === 'cancelled') {
    r.lastSignalAt = at; r.outcome = 'cancelled';
    closeOpen(r, at, 'cancelled');
    setPhase(r, 'cancelled', at);
    return r;
  }
  if (e.kind === 'error') {
    r.lastSignalAt = at; r.outcome = 'failed'; r.reason = e.summary;
    closeOpen(r, at, 'failed');
    setPhase(r, 'failed', at);
    return r;
  }
  if (e.kind !== 'activity') return current;

  r.lastSignalAt = at;
  const d = e.detail ?? {};

  if (e.domain === 'tool_invocation' && e.invocationId) {
    // Core's completion event names only the invocation; the tool is known from its start.
    const known = r.steps.find((x) => x.invocationId === e.invocationId);
    const tool = known?.toolName ?? e.toolName ?? 'tool';
    if (HIDDEN_TOOLS.has(tool) && !known) return r;
    if (e.eventType === 'tool_invocation_started') {
      if (r.steps.some((s) => s.invocationId === e.invocationId)) return r;
      r.toolCallsTotal += 1;
      push(r, { id: e.invocationId, kind: 'tool', label: tool.replace(/_/g, ' '), state: 'running', startedAt: at, invocationId: e.invocationId, toolName: tool, facts: [`tool ${tool}`] });
      setPhase(r, 'tool', at);
      return r;
    }
    if (e.eventType === 'tool_invocation_completed' || e.eventType === 'capability_tool_invocation_completed') {
      let s = r.steps.find((x) => x.invocationId === e.invocationId);
      if (!s) { s = { id: e.invocationId, kind: 'tool', label: tool.replace(/_/g, ' '), state: 'running', startedAt: at, invocationId: e.invocationId, toolName: tool, facts: [`tool ${tool}`] }; push(r, s); }
      s.endedAt = at;
      s.state = e.invocationStatus === 'succeeded' ? 'ok' : e.invocationStatus === 'cancelled' ? 'cancelled' : 'failed';
      s.facts.push(`status ${e.invocationStatus ?? 'unknown'}`);
      if (/run_check|workspace_validation|verify_acceptance|run_checks|static_html_check/.test(tool) && s.state === 'ok') setPhase(r, 'verifying', at);
      else settleToModel(r, at);
      return r;
    }
    return r;
  }

  if (e.domain === 'model_invocation') {
    if (e.eventType === 'model_invocation_started') {
      r.passes = Math.max(r.passes, 0);
      push(r, { id: `model-${e.invocationId ?? at}`, kind: 'model', label: 'Model call started', state: 'running', startedAt: at, facts: ['model invocation started'] });
      setPhase(r, 'waiting', at);
    } else if (e.eventType === 'model_invocation_completed') {
      const open = [...r.steps].reverse().find((s) => s.kind === 'model' && s.state === 'running' && s.id.startsWith('model-'));
      if (open) { open.endedAt = at; open.state = e.invocationStatus === 'failed' ? 'failed' : e.invocationStatus === 'cancelled' ? 'cancelled' : 'ok'; open.label = e.invocationStatus === 'failed' ? 'Model call failed' : 'Model call finished'; open.facts.push(`status ${e.invocationStatus ?? 'unknown'}`); }
    }
    return r;
  }

  if (e.domain === 'execution_quality' && e.eventType === 'final_verification_recorded') {
    r.verified = true;
    push(r, { id: `verify-${at}`, kind: 'verification', label: 'Final answer checked against the work recorded', state: 'ok', startedAt: at, endedAt: at, facts: ['final verification recorded'] });
    setPhase(r, 'verifying', at);
    return r;
  }

  if (e.domain === 'attempt') {
    switch (e.eventType) {
      case 'step_start':
        // Core began executing the attempt. Until a model call is recorded this is all that is known.
        if (r.phase === 'starting') setPhase(r, 'preparing', at);
        break;
      case 'model_loading_started':
        setPhase(r, 'loading', at);
        break;
      case 'model_loading_finished':
        if (r.phase === 'loading') setPhase(r, 'preparing', at);
        break;
      case 'model_pass_started':
        r.pass = d.pass ?? r.pass + 1; r.passes = Math.max(r.passes, r.pass);
        if (!openTool(r)) setPhase(r, 'waiting', at);
        break;
      case 'model_pass_phase':
        if (d.phase === 'reasoning') setPhase(r, 'reasoning', at);
        else if (d.phase === 'writing') setPhase(r, 'writing', at);
        else if (d.phase === 'selecting_tool') setPhase(r, 'selecting_tool', at);
        break;
      case 'model_pass_ended': {
        const calls = d.toolCalls ?? 0;
        r.lastPassToolless = calls === 0 && (d.textChars ?? 0) > 0;
        push(r, {
          id: `pass-${r.pass}-${at}`, kind: 'model',
          label: calls > 0 ? `Model pass ${d.pass ?? r.pass}: requested ${calls} tool call${calls === 1 ? '' : 's'}` : `Model pass ${d.pass ?? r.pass}: answered without calling a tool`,
          state: 'ok', startedAt: at - (d.durationMs ?? 0), endedAt: at,
          facts: [`pass ${d.pass ?? r.pass}`, `${calls} tool call${calls === 1 ? '' : 's'}`, `${d.textChars ?? 0} characters of text`, d.reasoned ? 'reasoning present' : 'no separate reasoning'],
        });
        settleToModel(r, at);
        break;
      }
      case 'attempt_transitioned':
        if (d.to === 'waiting_for_approval') setPhase(r, 'approval', at);
        else if (d.to === 'validating') setPhase(r, 'verifying', at);
        else if (d.to === 'completed') { r.outcome = 'completed'; closeOpen(r, at, 'ok'); setPhase(r, 'completed', at); }
        break;
      case 'attempt_failed':
        r.outcome = 'failed'; r.reason = d.reason ?? r.reason; closeOpen(r, at, 'failed'); setPhase(r, 'failed', at);
        break;
      case 'attempt_cancelled':
        r.outcome = 'cancelled'; closeOpen(r, at, 'cancelled'); setPhase(r, 'cancelled', at);
        break;
      case 'attempt_resumed':
        r.outcome = undefined; r.reason = undefined; setPhase(r, 'waiting', at);
        push(r, { id: `resumed-${at}`, kind: 'note', label: 'Resumed after your approval', state: 'ok', startedAt: at, endedAt: at, facts: ['attempt resumed'] });
        break;
      case 'attempt_approval_orphaned':
        r.outcome = 'interrupted'; r.reason = 'Core restarted while waiting; resume it from Tasks'; closeOpen(r, at, 'blocked'); setPhase(r, 'interrupted', at);
        break;
      case 'permission_mode_blocked':
        push(r, { id: `blocked-${at}`, kind: 'note', label: 'An action was blocked by Plan Only; nothing was changed', state: 'blocked', startedAt: at, endedAt: at, facts: ['blocked by permission mode'] });
        break;
      default: break;
    }
  }
  return r;
}

function closeOpen(r: RunState, at: number, state: RunStep['state']) {
  for (const s of r.steps) if (s.state === 'running') { s.state = state === 'ok' ? 'ok' : state; s.endedAt = at; }
}

function structuredCloneRun(r: RunState): RunState {
  return { ...r, steps: r.steps.map((s) => ({ ...s, facts: [...s.facts] })) };
}

/** One human sentence for the phase, with the real facts behind it. */
export function describePhase(r: RunState, now: number): { label: string; sub: string; stalled: boolean } {
  const quiet = Math.max(0, now - r.lastSignalAt);
  const quietText = quiet >= 5000 ? ` · no new signal for ${fmt(quiet)}` : '';
  const pass = r.pass > 0 ? `pass ${r.pass}` : '';
  switch (r.phase) {
    case 'starting': return { label: 'Starting the request', sub: `Core has not reported the first step yet${quietText}`, stalled: quiet > 30_000 };
    case 'preparing': return { label: 'Preparing the request', sub: `Core started the work · no model call recorded yet${quietText}`, stalled: quiet > 120_000 };
    case 'loading': return { label: 'Loading the model', sub: `Core asked the model server to load the model into memory (it can wait behind other model work)${quietText}`, stalled: quiet > 300_000 };
    case 'waiting': return { label: 'Waiting for the model', sub: [pass, `no output from the model yet${r.pass > 0 ? ' in this pass' : ''}`].filter(Boolean).join(' · ') + quietText, stalled: quiet > 120_000 };
    case 'reasoning': return { label: 'Model is reasoning', sub: [pass, 'thinking, no tool called yet'].filter(Boolean).join(' · ') + quietText, stalled: quiet > 120_000 };
    case 'writing': return { label: 'Model is writing the reply', sub: [pass, 'no tool call in this pass'].filter(Boolean).join(' · '), stalled: false };
    case 'selecting_tool': return { label: 'Model is choosing a tool', sub: [pass, 'preparing a tool call'].filter(Boolean).join(' · ') + quietText, stalled: false };
    case 'tool': { const t = openTool(r); return { label: t ? `Running ${t.label}` : 'Running a tool', sub: t ? `started ${fmt(now - t.startedAt)} ago · waiting for the tool to report` : 'waiting for the tool to report', stalled: t ? now - t.startedAt > 300_000 : false }; }
    case 'approval': return { label: 'Waiting for your permission', sub: 'Nothing runs until you answer', stalled: false };
    case 'verifying': return { label: 'Checking the result', sub: 'Core is verifying before the answer is final', stalled: false };
    case 'completed': return { label: 'Completed', sub: r.verified ? 'Checked against the work recorded' : 'Core reported the request done', stalled: false };
    case 'failed': return { label: 'Failed', sub: r.reason ?? 'Core reported a failure', stalled: false };
    case 'cancelled': return { label: 'Stopped', sub: 'You stopped this request; nothing further ran', stalled: false };
    case 'interrupted': return { label: 'Interrupted', sub: r.reason ?? 'The task was interrupted', stalled: false };
  }
}

function fmt(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return `${m} min ${s % 60} s`;
}
