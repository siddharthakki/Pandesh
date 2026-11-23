import React, { useEffect, useMemo, useState } from 'react';
import { api, errorText, onDesktopEvent, type Snapshot, type TaskRow } from './bridge';
import { buildJourneys, JOURNEY, type Journey, type JourneyAction, type ReceiptLite, type TrackedWish } from './journeyModel';
import { buildWish, money, type WishDetailRec, type WishView } from './wishModel';
import type { OperatorData } from './useOperatorData';
import { readTracked, sendWish } from './wishSend';

/**
 * Wish to Reality: "what can Pandesh accomplish for me?". A wish typed here is sent as a real chat message in a new
 * conversation; Pandesh (Core) decides how to do it — answer, a mission of specialist steps, or a coding task on a
 * registered project — under the same permission engine. This screen follows each wish through
 * Wish → Understand → Plan → Permissions → Execute → Verify → Deliver from Core's records, and offers only the real
 * actions those records allow. Pandesh never buys, pays, publishes or contacts anyone; those stay with the owner.
 */


const EXAMPLES = [
  'Make me a one-page checklist for getting my laptop ready for a 3-day work trip, and have the Reviewer check it for gaps',
  'Compare three ways to back up my photos locally and recommend one, with a reviewed summary',
  'In CalcDemo, add a multiply(a, b) function with tests',
];

export function Wishes({ snapshot, tasks, data, focus, onOpenConversation, onOpenMissions }: {
  snapshot: Snapshot | null; tasks: TaskRow[]; data: OperatorData; focus?: { id: string; n: number } | null;
  onOpenConversation: (id: string) => void; onOpenMissions: (focusId: string | null) => void;
}) {
  const [tracked, setTracked] = useState<TrackedWish[]>(readTracked);
  const [receipts, setReceipts] = useState<Record<string, ReceiptLite>>({});
  const [goals, setGoals] = useState<WishDetailRec[]>([]);
  const [sel, setSel] = useState<string | null>(focus?.id ?? null);
  // A wish sent from Home arrives with its id: show it, and re-read the list it was just added to.
  useEffect(() => { if (focus) { setTracked(readTracked()); setSel(focus.id); } }, [focus?.n]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ text: string; error?: boolean } | null>(null);

  // Earn-to-buy wishes (the original Wish-to-Reality records), read as before.
  const loadGoals = async () => {
    try {
      const list = (await api.household('wishes')) as { goals?: Array<{ id: string }> };
      setGoals(await Promise.all((list.goals ?? []).map((g) => api.household('wish', { id: g.id }) as Promise<WishDetailRec>)));
    } catch { /* the section just stays empty */ }
  };
  useEffect(() => { void loadGoals(); const off = onDesktopEvent((e) => { if (e.kind === 'result') void loadGoals(); }); return () => off(); }, []);

  // Outcome receipts for finished missions (Core builds them; fetched once each).
  useEffect(() => {
    const missing = data.missions.filter((m) => ['completed', 'completed_with_issues', 'failed', 'cancelled'].includes(m.status) && !receipts[m.id]).slice(0, 6);
    if (!missing.length) return;
    void Promise.all(missing.map(async (m) => { try { return [m.id, ((await api.household('missionReceipt', { id: m.id })) as { receipt: ReceiptLite }).receipt] as const; } catch { return null; } }))
      .then((rs) => setReceipts((r) => ({ ...r, ...Object.fromEntries(rs.filter(Boolean) as Array<readonly [string, ReceiptLite]>) })));
  }, [data.missions]);

  const pending = snapshot?.pendingApproval ? { conversationId: snapshot.selectedConversationId, approvalId: snapshot.pendingApproval.approvalId, detail: snapshot.pendingApproval.detail } : null;
  const journeys = useMemo(() => buildJourneys({ tracked, missions: data.missions, bridge: data.bridge, approvals: data.approvals, tasks, pending, receipts }), [tracked, data.missions, data.bridge, data.approvals, tasks, pending?.approvalId, pending?.conversationId, receipts]);
  const goalViews = useMemo(() => goals.map(buildWish), [goals]);
  const curJ = journeys.find((j) => j.id === sel) ?? (sel?.startsWith('g:') ? null : journeys[0]) ?? null;
  const curG = sel?.startsWith('g:') ? goalViews.find((g) => `g:${g.id}` === sel) ?? null : !curJ ? goalViews[0] ?? null : null;
  const needs = journeys.filter((j) => j.needsYou).length;

  const makeReal = async (e: React.FormEvent) => {
    e.preventDefault();
    const text = draft.trim();
    if (!text || busy) return;
    setBusy('send'); setNote(null);
    try {
      const w = await sendWish(text);
      setTracked(readTracked()); setSel(`c:${w.conversationId}`); setDraft('');
      setNote({ text: 'Sent to Pandesh in a new chat. This page follows it from here.' });
      data.refresh();
    } catch (err) { setNote({ text: errorText(err), error: true }); }
    finally { setBusy(null); }
  };

  const act = async (j: Journey, a: JourneyAction) => {
    setNote(null);
    try {
      if (a.kind === 'allow') { setBusy(a.approvalId); await api.resolveAssistantApproval(a.approvalId, 'approved'); setNote({ text: 'Allowed once. Core continues the step.' }); }
      else if (a.kind === 'review_chat' || a.kind === 'open_chat') onOpenConversation(a.conversationId);
      else if (a.kind === 'open_mission') onOpenMissions(a.missionId);
      else if (a.kind === 'review_task' || a.kind === 'open_task') onOpenMissions(a.taskId);
      else if (a.kind === 'deliver') {
        setBusy(a.taskId);
        const r = await api.household('bridgeDeliver', { id: a.taskId }) as { delivered?: { branch: string } };
        setNote({ text: `In your checkout as branch ${r.delivered?.branch ?? ''}: not checked out, not merged, not pushed.` });
      }
      data.refresh();
    } catch (err) { setNote({ text: errorText(err), error: true }); }
    finally { setBusy(null); }
    void j;
  };
  const deny = async (approvalId: string) => {
    try { setBusy(approvalId); await api.resolveAssistantApproval(approvalId, 'rejected'); setNote({ text: 'Not allowed. Nothing was done for that step.' }); data.refresh(); }
    catch (err) { setNote({ text: errorText(err), error: true }); } finally { setBusy(null); }
  };

  return (
    <div className="jv-wishes">
      <header className="jv-missions-head">
        <h1>Wish to Reality</h1>
        <span className="jv-hint">What Pandesh can accomplish for you · {journeys.filter((j) => !j.finished).length} in progress · {needs} need you · {journeys.filter((j) => j.finished && !j.failed).length} delivered</span>
      </header>

      <form className="jv-wish-intent" onSubmit={makeReal}>
        <label className="sr-only" htmlFor="wish-in">Your wish</label>
        <input id="wish-in" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="What should Pandesh make real for you?" />
        <button type="submit" className="btn small primary" disabled={!draft.trim() || busy === 'send'}>{busy === 'send' ? 'Sending…' : 'Make it real'}</button>
        <span className="jv-src">Sent as a chat message in a new conversation. Pandesh plans it; anything that changes something asks you first. It never buys, pays, publishes or contacts anyone.</span>
      </form>
      {note && <p className={`jv-status${note.error ? ' error' : ''}`} role={note.error ? 'alert' : 'status'}>{note.text}</p>}

      {!journeys.length && !goalViews.length && (
        <section className="jv-wish-empty">
          <h2>No wish yet</h2>
          <p className="jv-detail">Say the outcome you want. Small things are answered in the chat; bigger ones become a mission of specialist steps with a review; code changes run on a registered project in an isolated copy. You see each one move from wish to delivery here.</p>
          <div className="jv-chips">{EXAMPLES.map((s) => <button key={s} type="button" className="jv-chip" onClick={() => setDraft(s)}>{s}</button>)}</div>
        </section>
      )}

      {(journeys.length > 0 || goalViews.length > 0) && (
        <div className="jv-wish-grid">
          <aside className="jv-wish-list" aria-label="Wishes">
            {journeys.map((j) => (
              <button key={j.id} type="button" className={`jv-wish-item${curJ?.id === j.id ? ' on' : ''}${j.needsYou ? ' need' : ''}${j.failed ? ' off' : ''}`} onClick={() => setSel(j.id)}>
                <strong>{j.title}</strong>
                <span className="jv-src">{j.source} · {j.needsYou ? 'needs you' : j.now ? JOURNEY.find(([k]) => k === j.now)?.[1] : j.finished ? 'delivered' : ''}</span>
                <span className="jv-mini-track" aria-hidden="true">{j.stages.map((s) => <i key={s.key} className={s.state} />)}</span>
              </button>
            ))}
            {goalViews.length > 0 && <h3 className="jv-tag" style={{ margin: '10px 0 2px' }}>Earn-to-buy wishes</h3>}
            {goalViews.map((g) => (
              <button key={g.id} type="button" className={`jv-wish-item${curG?.id === g.id ? ' on' : ''}${g.cancelled ? ' off' : ''}`} onClick={() => setSel(`g:${g.id}`)}>
                <strong>{g.title}</strong>
                <span className="jv-src">{g.cancelled ? 'cancelled' : g.stages.find((s) => s.state === 'now')?.label ?? ''}{g.toVerify.length ? ` · ${g.toVerify.length} to verify` : ''}</span>
                <span className="jv-meter small" aria-hidden="true"><span style={{ width: `${Math.round(g.progress * 100)}%` }} /></span>
              </button>
            ))}
          </aside>

          {curJ && <JourneyDetail j={curJ} busy={busy} onAct={(a) => void act(curJ, a)} onDeny={(id) => void deny(id)} receipt={curJ.kind === 'mission' ? receipts[curJ.id.slice(2)] ?? null : null} />}
          {curG && <GoalDetail g={curG} conversationId={goals.find((d) => d.goal.id === curG.id)?.goal.conversationId ?? null} onOpenConversation={onOpenConversation} />}
        </div>
      )}
    </div>
  );
}

function JourneyDetail({ j, busy, onAct, onDeny, receipt }: { j: Journey; busy: string | null; onAct: (a: JourneyAction) => void; onDeny: (approvalId: string) => void; receipt: ReceiptLite | null }) {
  const label = (a: JourneyAction) => a.kind === 'allow' ? 'Allow once' : a.kind === 'open_chat' ? 'Open its chat' : a.kind === 'open_mission' ? 'Open in Missions' : a.kind === 'open_task' ? 'Open the worker log' : a.text;
  const primary = j.actions.filter((a) => a.kind === 'allow' || a.kind === 'review_chat' || a.kind === 'review_task' || a.kind === 'deliver');
  const secondary = j.actions.filter((a) => !(primary as JourneyAction[]).includes(a));
  return (
    <section className="jv-wish-main" aria-label={j.title}>
      <div className="jv-wish-head">
        <div><span className="jv-src">{j.source}{j.live ? ' · live' : ''}</span><h2>{j.title}</h2></div>
        <div className="jv-actions">{secondary.map((a, i) => <button key={i} type="button" className="btn small" onClick={() => onAct(a)}>{label(a)}</button>)}</div>
      </div>

      <ol className="jv-journey" aria-label="From wish to delivery">
        {j.stages.map((s) => (
          <li key={s.key} className={s.state} aria-current={s.state === 'now' ? 'step' : undefined}>
            <span className="jv-stage-dot" aria-hidden="true" />
            <strong>{s.label}</strong>
            <span className="jv-src">{s.state === 'now' ? 'now' : s.state === 'skip' ? 'not needed' : s.state === 'warn' ? 'with a caveat' : s.state === 'fail' ? 'stopped' : s.state === 'done' ? 'done' : 'next'}</span>
            {s.detail && <span className="jv-stage-detail">{s.detail}</span>}
          </li>
        ))}
      </ol>

      <div className={`jv-wish-next${j.needsYou ? ' need' : j.finished && !j.failed ? ' ready' : ''}`}>
        <span className="jv-tag">{j.needsYou ? 'Your decision' : 'Where it stands'}</span>
        <p>{j.headline}</p>
        {primary.map((a, i) => a.kind === 'allow' ? (
          <span key={i} className="jv-allow">
            <span className="jv-detail">{a.text}</span>
            <button type="button" className="btn small primary" disabled={busy === a.approvalId} onClick={() => onAct(a)}>Allow once</button>
            <button type="button" className="btn small" disabled={busy === a.approvalId} onClick={() => onDeny(a.approvalId)}>Don't allow</button>
          </span>
        ) : <button key={i} type="button" className="btn small primary" disabled={busy === ('taskId' in a ? a.taskId : '')} onClick={() => onAct(a)}>{label(a)}</button>)}
      </div>

      {receipt && (
        <div className="jv-wish-cols">
          <section aria-label="What was verified">
            <h3 className="jv-tag">Receipt · {receipt.headline}</h3>
            {receipt.verifiedOutputs.length === 0 && <p className="jv-empty">No output was confirmed by a tool.</p>}
            {receipt.verifiedOutputs.slice(0, 8).map((o, i) => <div key={i} className="jv-wish-row verified">{typeof o === 'string' ? o : o.text ?? o.label ?? o.path}</div>)}
          </section>
          <section aria-label="Files">
            <h3 className="jv-tag">Files · {receipt.artifacts.length}</h3>
            {receipt.artifacts.length === 0 && <p className="jv-empty">No files were produced.</p>}
            {receipt.artifacts.slice(0, 8).map((f) => <div key={f.path} className={`jv-wish-row${f.exists ? '' : ' rejected'}`}><span className="mono">{f.path}</span>{!f.exists && <span className="jv-src">missing now</span>}</div>)}
          </section>
          <section aria-label="Next">
            <h3 className="jv-tag">Next</h3>
            <p className="jv-detail">{receipt.nextAction ?? 'Nothing more is needed.'}</p>
            {receipt.partialOrFailed.length > 0 && <p className="jv-detail quiet">{receipt.partialOrFailed.length} part{receipt.partialOrFailed.length === 1 ? '' : 's'} not finished or not verified: see Missions.</p>}
          </section>
        </div>
      )}
    </section>
  );
}

function GoalDetail({ g, conversationId, onOpenConversation }: { g: WishView; conversationId: string | null; onOpenConversation: (id: string) => void }) {
  return (
    <section className="jv-wish-main" aria-label={g.title}>
      <div className="jv-wish-head">
        <div><span className="jv-src">Earn-to-buy · {g.wish}</span><h2>{g.title}</h2></div>
        {g.hasDemo && <span className="jv-flag">Contains demonstration money: never counted</span>}
      </div>
      <ol className="jv-stage-track" aria-label="Journey">
        {g.stages.map((s) => <li key={s.id} className={s.state} aria-current={s.state === 'now' ? 'step' : undefined}><span className="jv-stage-dot" aria-hidden="true" />{s.label}</li>)}
      </ol>
      <div className="jv-wish-money">
        <div className="jv-meter" role="img" aria-label={`${money(g.availableCents, g.currency)} verified of ${money(g.priceCents, g.currency)}`}><span style={{ width: `${Math.round(g.progress * 100)}%` }} /></div>
        <dl className="jv-money-facts">
          <div><dt>Verified by you</dt><dd>{money(g.availableCents, g.currency)}</dd></div>
          <div><dt>Waiting for you (not counted)</dt><dd className="attn">{money(g.unverifiedCents, g.currency)}</dd></div>
          <div><dt>Still to earn</dt><dd>{money(g.shortfallCents, g.currency)}</dd></div>
          <div><dt>Price to pay</dt><dd>{money(g.priceCents, g.currency)}<small> · target {money(g.targetCents, g.currency)}</small></dd></div>
        </dl>
      </div>
      <div className={`jv-wish-next${g.plan ? ' ready' : g.toVerify.length ? ' need' : ''}`}>
        <span className="jv-tag">Next</span><p>{g.next}</p>
        {conversationId && <button type="button" className="btn small" onClick={() => onOpenConversation(conversationId)}>{g.toVerify.length ? 'Verify in its chat' : 'Open its chat'}</button>}
      </div>
      {g.plan && <div className="jv-wish-plan"><span className="jv-tag">Purchase prepared · not executed · you buy it yourself</span><ol>{g.plan.steps.map((s) => <li key={s}>{s}</li>)}</ol></div>}
      <div className="jv-wish-cols">
        <section aria-label="Offers"><h3 className="jv-tag">Real price</h3>{g.offers.map((o) => <div key={o.id} className={`jv-wish-row${o.matchLevel === 'exact' ? '' : ' quiet'}`}><strong>{money(o.priceCents, o.currency)}</strong><span>{o.sourceTitle ?? o.sourceUrl}</span><span className="jv-src">{o.matchLevel === 'exact' ? 'exact model' : 'related page'}</span></div>)}{!g.offers.length && <p className="jv-empty">Not researched yet.</p>}</section>
        <section aria-label="Ways to earn"><h3 className="jv-tag">Ways to earn</h3>{g.ways.map((w) => <div key={w.title} className={`jv-wish-row ${w.status}`}><strong>{w.title}</strong><span>{w.note}</span></div>)}{!g.ways.length && <p className="jv-empty">Not assessed yet.</p>}</section>
        <section aria-label="Money"><h3 className="jv-tag">Money</h3>{g.ledger.map((e) => <div key={e.id} className={`jv-wish-row ${e.status}${e.mode === 'demo' ? ' demo' : ''}`}><strong>{e.kind === 'expense' ? '−' : '+'}{money(e.amountCents, e.currency)}</strong><span>{e.description}</span><span className="jv-src">{e.mode === 'demo' ? 'demo · never counted' : e.status === 'claimed' ? 'waits for you' : e.status}</span></div>)}{!g.ledger.length && <p className="jv-empty">No money recorded.</p>}</section>
      </div>
    </section>
  );
}
