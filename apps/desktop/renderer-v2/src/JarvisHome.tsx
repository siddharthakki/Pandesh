import React, { useMemo, useState } from 'react';
import { api, errorText, type QueuedCommand, type Snapshot, type TaskRow } from './bridge';
import { buildHome, type DecisionItem, type HomeItem, type HomeTarget, type InFlightItem } from './jarvisModel';
import { useTicker, type OperatorData } from './useOperatorData';
import { Presence } from './Presence';

type Portal = 'ready' | 'flight' | 'decisions' | 'exceptions';

/**
 * Home, the Ambient Field: the presence at the centre, four portals of real work around it (results ready, in flight,
 * decisions, exceptions), lines of light that move only for live work, an intent line and a done → now → planned timeline.
 * Everything is read from Core's records; an empty record shows an empty portal. The presence animates only for a live
 * worker event or a waiting decision, freezes while the local model generates, and is static under reduced motion.
 */
export function JarvisHome({ snapshot, tasks, queued, data, onOpen, onAsk }: {
  snapshot: Snapshot | null; tasks: TaskRow[]; queued: QueuedCommand[]; data: OperatorData;
  onOpen: (t: HomeTarget) => void; onAsk: (text: string) => void | Promise<void>;
}) {
  const [sending, setSending] = useState(false);
  // Tick every second only while a worker has really sent an event in the last two minutes (event ages need it).
  const fresh = data.bridge.some((b) => b.lastEventAt && Date.now() - Date.parse(b.lastEventAt) < 120_000 && !['completed', 'failed', 'cancelled'].includes(b.state)) || data.missions.some((m) => m.status === 'running');
  const now = useTicker(fresh, 1000);
  const home = useMemo(() => buildHome({ missions: data.missions, bridge: data.bridge, approvals: data.approvals, tasks, snapshot, now }), [data.missions, data.bridge, data.approvals, tasks, snapshot, now]);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ id: string; text: string; label?: string; error?: boolean } | null>(null);
  const [ask, setAsk] = useState('');
  const [picked, setPicked] = useState<Portal | null>(null);
  const stale = Boolean(data.error);

  // The portal in front: the owner's pick, else what most needs them.
  const auto: Portal = home.decisions.length ? 'decisions' : home.exceptions.length ? 'exceptions' : home.inFlight.length ? 'flight' : 'ready';
  const focus = picked ?? auto;

  const stopTask = async (x: HomeItem) => {
    if (!x.stopBridgeId) return;
    setBusy(x.id); setNote(null);
    const label = x.title.length > 70 ? `${x.title.slice(0, 70)}…` : x.title;
    try { await api.household('bridgeCancel', { id: x.stopBridgeId }); setNote({ id: x.id, label, text: 'Stopped. Nothing else runs in its place.' }); data.refresh(); }
    catch (err) { setNote({ id: x.id, label, text: `Not stopped: ${errorText(err)}`, error: true }); }
    finally { setBusy(null); }
  };
  const decide = async (d: DecisionItem, allow: boolean) => {
    setBusy(d.id); setNote(null);
    try {
      if (d.kind === 'worker_permission') await api.household('devStoryPermission', { storyId: d.storyId, pendingId: d.pendingId, allow });
      else if (d.kind === 'mission_approval' && d.approvalId) await api.resolveAssistantApproval(d.approvalId, allow ? 'approved' : 'rejected');
      setNote({ id: d.id, label: d.title, text: allow ? 'Allowed once. The worker continues.' : 'Not allowed. The worker was told no.' });
      data.refresh();
    } catch (err) { setNote({ id: d.id, label: d.title, text: `Not recorded: ${errorText(err)}`, error: true }); }
    finally { setBusy(null); }
  };

  const portals: Array<{ id: Portal; title: string; tag: string; count: number; tone: string; live: boolean; body: React.ReactNode }> = [
    {
      id: 'ready', title: 'Ready for you', tone: 'ok', live: false,
      count: home.readyIsOlder ? 0 : home.ready.length,
      tag: home.readyIsOlder ? 'nothing new today · most recent' : `${home.ready.length} result${home.ready.length === 1 ? '' : 's'} · last 24 h`,
      body: home.ready.length ? home.ready.slice(0, 4).map((r) => <Row key={r.id} item={r} onOpen={onOpen} />) : <p className="jv-empty">No finished results yet.</p>,
    },
    {
      id: 'flight', title: 'In flight', tone: 'live', live: home.inFlight.some((f) => f.live),
      count: home.inFlight.length, tag: home.inFlight.some((f) => f.live) ? 'workers sending events' : home.inFlight.length ? 'no live events' : 'nothing running',
      body: home.inFlight.length ? home.inFlight.slice(0, 4).map((f) => <FlightRow key={f.id} item={f} onOpen={onOpen} />) : <p className="jv-empty">Nothing is running.</p>,
    },
    {
      id: 'decisions', title: 'Decisions', tone: 'need', live: home.decisions.length > 0,
      count: home.decisions.length, tag: home.decisions.length ? 'waiting for you' : 'nothing waiting',
      body: home.decisions.length ? home.decisions.slice(0, 3).map((d) => (
        <div key={d.id} className="jv-decision" role="group" aria-label={d.title}>
          <span className="jv-src">{d.source}</span>
          <strong>{d.title}</strong>
          {d.detail && <span className="jv-detail">{d.detail}</span>}
          <div className="jv-actions">
            {(d.kind === 'worker_permission' || d.kind === 'mission_approval') ? (
              <>
                <button type="button" className="btn primary small jv-allow" disabled={busy === d.id} onClick={() => void decide(d, true)}>Allow once</button>
                <button type="button" className="btn small" disabled={busy === d.id} onClick={() => void decide(d, false)}>Don't allow</button>
                <button type="button" className="btn link small" onClick={() => onOpen(d.target)}>Details</button>
              </>
            ) : <button type="button" className="btn primary small jv-allow" onClick={() => onOpen(d.target)}>Review with full details</button>}
          </div>
        </div>
      )) : <p className="jv-empty">Nothing is waiting for your decision.</p>,
    },
    {
      id: 'exceptions', title: 'Exceptions', tone: 'bad', live: false,
      count: home.exceptions.length, tag: home.exceptions.length ? 'need attention' : 'all clear',
      body: home.exceptions.length ? home.exceptions.slice(0, 4).map((x) => (
        <Row key={x.id} item={x} onOpen={onOpen} action="Details" extra={x.stopBridgeId ? <button type="button" className="btn small" disabled={busy === x.id} onClick={() => void stopTask(x)}>Stop task</button> : null} />
      )) : <p className="jv-empty">Nothing failed or stalled in the last 24 hours.</p>,
    },
  ];
  // Anchor points of the four portals in the field's 1000 × 600 space, for the lines of light.
  const anchor: Record<Portal, [number, number]> = { ready: [170, 150], flight: [830, 150], decisions: [170, 450], exceptions: [830, 450] };

  const likely = [
    home.decisions.length ? { label: `Review ${home.decisions.length} decision${home.decisions.length === 1 ? '' : 's'}`, run: () => setPicked('decisions') } : null,
    home.inFlight.length ? { label: 'Watch the execution log', run: () => onOpen({ kind: 'missions', view: 'events' }) } : null,
    { label: 'Open the Board', run: () => onOpen({ kind: 'missions', view: 'board' }) },
  ].filter(Boolean) as Array<{ label: string; run: () => void }>;

  const done = home.ready.slice(0, 2).reverse();
  const planned = queued.slice(0, 2);

  return (
    <div className={`jv-home field ${home.presence}`} data-presence={home.presence}>
      <header className="jv-top">
        <span className="jv-word">pandesh</span>
        <span className="jv-tag"><span className={`jv-blip ${home.presence}`} aria-hidden="true" />{stale ? 'core not answering · last read shown' : home.tag}</span>
        <span className="jv-flex" />
        <span className="jv-telemetry">{snapshot?.model ? snapshot.model.toUpperCase() : 'NO MODEL'}{snapshot?.running ? ' · GENERATING' : ''} · {snapshot?.selectedInferenceProvider === 'ollama' || !snapshot?.selectedInferenceProvider ? 'ON THIS PC' : snapshot.selectedInferenceProvider.toUpperCase()}</span>
      </header>

      <section className="jv-stage" aria-label="What Pandesh is doing">
        <svg className="jv-threads" viewBox="0 0 1000 600" preserveAspectRatio="none" aria-hidden="true">
          {portals.map((p) => {
            const [x, y] = anchor[p.id];
            const d = `M500 300 C ${500 + (x - 500) * 0.45} 300, ${x} ${300 + (y - 300) * 0.3}, ${x} ${y}`;
            return <path key={p.id} d={d} className={`jv-thread ${p.tone}${p.live && p.count ? ' moving' : ''}${p.count ? '' : ' off'}${focus === p.id ? ' focus' : ''}`} />;
          })}
        </svg>
        <div className="jv-center">
          <Presence state={home.presence} />
          <div className="jv-statement">
            <h1>{home.line}</h1>
            <span className="jv-tag">{home.presence === 'thinking' ? 'animation paused while the local model generates' : home.presence === 'idle' ? 'no event, no movement' : home.tag}</span>
          </div>
        </div>
        {portals.map((p) => (
          <section key={p.id} className={`jv-portal ${p.id} ${p.tone}${p.count ? ' has' : ''}${focus === p.id ? ' focus' : ''}`} aria-label={p.title}>
            <button type="button" className="jv-portal-head" aria-pressed={focus === p.id} onClick={() => setPicked(p.id)}>
              <span className={`jv-dot ${p.tone}${p.live ? ' live' : ''}`} aria-hidden="true" />
              <span className="jv-portal-title"><strong>{p.title}</strong><span className="jv-src">{p.tag}</span></span>
              <span className="jv-count">{p.count}</span>
            </button>
            <div className="jv-portal-body">{p.body}</div>
          </section>
        ))}
      </section>

      {note && <p className={`jv-status${note.error ? ' error' : ''}`} role={note.error ? 'alert' : 'status'}>{note.label ? <strong>{note.label}: </strong> : null}{note.text}</p>}

      {/* A wish typed here is sent for real, in a new conversation, and followed in Wish to Reality: never appended to an old chat. */}
      <form className="jv-intent" onSubmit={(e) => {
        e.preventDefault();
        const t = ask.trim();
        if (!t || sending) return;
        setSending(true);
        void Promise.resolve(onAsk(t)).then(() => setAsk('')).catch((err) => setNote({ id: 'intent', text: errorText(err), error: true })).finally(() => setSending(false));
      }}>
        <label className="sr-only" htmlFor="jv-intent">What should Pandesh make real?</label>
        <input id="jv-intent" value={ask} onChange={(e) => setAsk(e.target.value)} placeholder="What should Pandesh make real for you?" autoComplete="off" />
        <button type="submit" className="btn primary" disabled={!ask.trim() || sending}>{sending ? 'Sending…' : 'Make it real'}</button>
      </form>
      <div className="jv-likely"><span className="jv-src">likely next</span>{likely.map((l) => <button key={l.label} type="button" className="jv-chip" onClick={l.run}>{l.label}</button>)}</div>

      <section className="jv-chrono" aria-label="Timeline: done, now, planned">
        <span className="jv-src left">done</span><span className="jv-src right">planned</span>
        <div className="jv-chrono-line" aria-hidden="true" />
        <div className="jv-chrono-items">
          {done.map((r) => <button key={r.id} type="button" className="jv-cdot done" onClick={() => onOpen(r.target)}><span className="pip" /><span className="jv-src">{r.at ? whenShort(r.at) : ''}</span><span className="lbl">{r.title}</span></button>)}
          {!done.length && <span className="jv-cdot empty"><span className="pip" /><span className="lbl">nothing finished yet</span></span>}
          <span className={`jv-cdot now ${home.presence}`}><span className="pip" /><span className="jv-src">now</span><span className="lbl">{home.decisions.length ? `${home.decisions.length} decision${home.decisions.length === 1 ? '' : 's'} waiting` : home.exceptions.length ? `${home.exceptions.length} need${home.exceptions.length === 1 ? 's' : ''} attention` : home.inFlight.length ? `${home.inFlight.length} in flight` : 'all clear'}</span></span>
          {planned.map((q) => <span key={q.id} className="jv-cdot planned"><span className="pip" /><span className="jv-src">queued</span><span className="lbl">{q.title ?? q.instruction ?? 'queued task'}</span></span>)}
          {!planned.length && <span className="jv-cdot empty"><span className="pip" /><span className="lbl">nothing queued</span></span>}
        </div>
      </section>
    </div>
  );
}

function whenShort(at: string): string {
  const d = new Date(at);
  return d.toDateString() === new Date().toDateString() ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString([], { weekday: 'short' }) + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** Today: a time. Earlier: weekday and time, so an older result never reads as new. */
function when(at: string): string {
  const d = new Date(at);
  return d.toDateString() === new Date().toDateString() ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function Row({ item, onOpen, action = 'Open', extra }: { item: HomeItem; onOpen: (t: HomeTarget) => void; action?: string; extra?: React.ReactNode }) {
  return (
    <div className="jv-row">
      <div className="jv-row-main"><span className="jv-src">{item.source}{item.at ? ` · ${when(item.at)}` : ''}</span><strong title={item.title}>{item.title}</strong><span className="jv-detail">{item.detail}</span></div>
      {extra}
      <button type="button" className="btn small" onClick={() => onOpen(item.target)}>{action}</button>
    </div>
  );
}

function FlightRow({ item, onOpen }: { item: InFlightItem; onOpen: (t: HomeTarget) => void }) {
  return (
    <div className="jv-row">
      <span className={`jv-dot${item.live ? ' live' : ''}`} aria-hidden="true" />
      <div className="jv-row-main"><span className="jv-src">{item.engine} · {item.stateLabel}</span><strong title={item.title}>{item.title}</strong><span className={`jv-detail mono${item.live ? '' : ' quiet'}`}>{item.eventText}</span></div>
      <button type="button" className="btn small" onClick={() => onOpen(item.target)}>Watch</button>
    </div>
  );
}
